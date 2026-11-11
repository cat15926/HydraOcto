import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '../store.js';
import type { SourceWork } from '../../shared/collaboration.js';
import type { Obligation } from '../../shared/obligations.js';
import type { OpinionRound, SignedOpinion } from '../../shared/opinions.js';
import type { CollaborationStore } from './store.js';
import type { ObligationService } from './obligations.js';
import { opinionTools } from './opinion-tools.js';
import { privateScope, textDigest } from './visibility.js';

export function migrateOpinions(db:DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS cc_opinion_rounds (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES cc_conversations(id), value TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS cc_opinion_room ON cc_opinion_rounds(conversation_id);`);
}
function requireText(input:unknown,label:string,max=4000):string {
  if (typeof input!=='string' || !input.trim() || input.length>max) throw new AppError(400,label+'无效。');
  return input.trim();
}
function conflict(reason:string):never { throw new AppError(409,reason,'opinion_conflict'); }
const closed = (r:OpinionRound)=>r.state==='locked'||r.state==='cancelled'||r.state==='expired';

export class OpinionService {
  constructor(private readonly store:CollaborationStore,private readonly obligations:ObligationService) {}
  private clock(){ return this.store.options.clock?.() ?? Date.now(); }
  list(cid:string){ return this.store.artifacts.rows<OpinionRound>('cc_opinion_rounds',cid).map(r=>this.project(r)); }
  private project(r:OpinionRound):OpinionRound {
    return {...r,resolutions:r.resolutions.map(check=>{
      const opinion=r.opinions.find(v=>v.id===check.opinionId);
      if(opinion && this.validCheck(r,check,opinion))return {...check,valid:true};
      return {opinionId:check.opinionId,invocationId:check.invocationId,valid:false};
    })};
  }
  private get(cid:string,id:unknown) {
    const row=this.store.db.prepare('SELECT value FROM cc_opinion_rounds WHERE id=? AND conversation_id=?')
      .get(requireText(id,'征询编号',100),cid) as {value:string}|undefined;
    if (!row) throw new AppError(404,'找不到这次征询。');
    return JSON.parse(row.value) as OpinionRound;
  }
  private save(r:OpinionRound) {
    r.revision++;
    this.store.artifacts.save('cc_opinion_rounds',r,'opinion.changed');
  }
  private activeInstance(cid:string,memberId:string,instanceId:string) {
    try { return this.store.roomMembers.resolve(cid,memberId).id===instanceId &&
      this.store.members().some(m=>m.id===memberId && m.enabled && !m.deletedAt); }
    catch(e) { if(e instanceof AppError)return false;throw e; }
  }
  private qualified(r:OpinionRound) {
    const valid=new Set(r.participants.filter(p=>this.activeInstance(r.conversationId,p.memberId,p.instanceId) &&
      !this.store.artifacts.get<SourceWork>('cc_sources',p.sourceId).withdrawnAt).map(p=>p.instanceId));
    return r.opinions.filter(o=>!o.late && valid.has(o.instanceId));
  }
  private freeze(r:OpinionRound,opinions:SignedOpinion[]) {
    const latest=new Map(opinions.map(o=>[o.instanceId,o.id]));
    r.lockedOpinionIds=[...latest.values()];
    // Revising a vote does not silently erase a signed, outstanding concern.
    r.objectionIds=opinions.filter(o=>o.objection).map(o=>o.id);
    r.state='locked';
  }
  reconcileRound(r:OpinionRound,o:Obligation) {
    if (closed(r)) return;
    if (o.state==='cancelled' || o.owner.instanceId!==r.decider.instanceId || o.ownerRevision!==r.ownerRevision ||
        !this.activeInstance(r.conversationId,r.decider.memberId,r.decider.instanceId) ||
        this.store.visibility.primary(r.originInvocationId).withdrawnAt) {
      r.state='cancelled'; r.reason='原执行或接回成员已失效。';
      this.save(r); this.obligations.blockOpinion(o,r.reason); return;
    }
    const qualified=this.qualified(r);
    const count=new Set(qualified.map(v=>v.instanceId)).size;
    let changed=count!==r.validCount;
    r.validCount=count;
    const due=this.clock()>=Date.parse(r.deadline);
    if (due && count<r.minimum) {
      r.state='expired'; r.reason='已到截止时间，有效意见人数不足。';
      this.save(r); this.obligations.blockOpinion(o,r.reason); return;
    }
    if (due) { this.freeze(r,qualified); changed=true; }
    if (!due && r.lockMode==='early' && count>=r.minimum && r.state==='collecting') {r.state='ready';changed=true;}
    if ((r.state==='ready'||r.state==='locked') && !r.wakeSourceId) {
      r.wakeSourceId=this.obligations.returnOpinion(o,r); changed=true;
    }
    if(changed)this.save(r);
  }
  reconcile(o:Obligation) {
    if(o.decisionRoundId)this.reconcileRound(this.get(o.conversationId,o.decisionRoundId),o);
  }
  cancel(o:Obligation) {
    if(!o.decisionRoundId)return;
    const r=this.get(o.conversationId,o.decisionRoundId);
    if(closed(r))return;
    r.state='cancelled';r.reason='原委托已取消。';this.save(r);
  }
  private evidence(r:OpinionRound,messageId:string|undefined,opinion:SignedOpinion) {
    if(!messageId || !this.activeInstance(r.conversationId,r.decider.memberId,r.decider.instanceId))return;
    const msg=this.store.visibility.readable(r.conversationId,r.decider.memberId,'public').find(m=>m.id===messageId);
    if(!msg || privateScope(this.store.visibility.messageScope(msg)) || msg.author==='system' || msg.excerptRefs?.length ||
       msg.responseId===this.store.invocation(opinion.invocationId).responseId)return;
    return msg;
  }
  private validCheck(r:OpinionRound,check:OpinionRound['resolutions'][number],opinion:SignedOpinion) {
    const msg=this.evidence(r,check.evidenceMessageId,opinion);
    return !!msg && check.evidenceRevision===(msg.revision??1) && check.evidenceDigest===textDigest(msg.content);
  }
  assertDelivery(o:Obligation) {
    if(!o.decisionRoundId)return;
    const r=this.get(o.conversationId,o.decisionRoundId);
    if(r.state!=='locked')conflict('请先锁定本次征询的合资格意见。');
    const previous=this.store.artifacts.rows<OpinionRound>('cc_opinion_rounds',o.conversationId)
      .filter(round=>round.obligationId===o.id && round.state==='locked');
    for (const round of previous)this.assertChecks(round);
  }
  private assertChecks(r:OpinionRound) {
    for (const id of r.objectionIds??[]) {
      const opinion=r.opinions.find(v=>v.id===id)!;
      if(!r.resolutions.some(v=>v.opinionId===id && this.validCheck(r,v,opinion)))
        conflict('仍有署名异议缺少有效的核查依据。');
    }
  }
  private open(id:string,args:Record<string,unknown>) {
    const {o,run,source}=this.obligations.authorize(id,args.obligationId);
    if(o.parentId || o.state!=='open' || o.activeGroupId)conflict('请在当前开放的主委托上发起意见收集。');
    if(o.decisionRoundId) {
      const prior=this.get(o.conversationId,o.decisionRoundId);
      if(!closed(prior))conflict('本委托有一轮尚未锁定的意见。');
      if(prior.state==='locked')this.assertChecks(prior);
    }
    const targets=args.targets;
    if(!Array.isArray(targets) || targets.length<2 || targets.length>8 || new Set(targets).size!==targets.length ||
      targets.some(v=>typeof v!=='string'||v===run.memberId))conflict('请指定二至八位不同的受邀同伴。');
    if(!Number.isSafeInteger(args.minimum)||Number(args.minimum)<1||Number(args.minimum)>targets.length)conflict('有效意见人数超出受邀范围。');
    const deadline=Date.parse(requireText(args.deadline,'截止时间',64));
    if(!Number.isFinite(deadline)||deadline<=this.clock()||(args.lockMode!=='early'&&args.lockMode!=='deadline'))conflict('请指定未来的截止时间与锁定方式。');
    if((o.groupCount??0)>=16)conflict('本委托的征询轮次已达上限。');
    const r:OpinionRound={id:randomUUID(),conversationId:o.conversationId,obligationId:o.id,originInvocationId:id,originSourceId:source.id,
      decider:{...o.owner},ownerRevision:o.ownerRevision!,question:requireText(args.question,'问题'),minimum:Number(args.minimum),
      lockMode:args.lockMode,deadline:new Date(deadline).toISOString(),participants:[],opinions:[],resolutions:[],validCount:0,state:'collecting',revision:0};
    for (const target of targets as string[]) {
      this.store.artifacts.target(o.conversationId,target);
      const member=this.store.roomMembers.resolve(o.conversationId,target);
      const invite=this.store.admitSource({conversationId:o.conversationId,kind:'job_result',parentInvocationId:id,authorMemberId:run.memberId,requestedTargets:[target],depth:source.depth+1,
        content:`征询 ${r.id}：${r.question}\n请用 opinion_submit 提交本人意见，标出需要核查的异议。截止 ${r.deadline}。`});
      r.participants.push({memberId:target,instanceId:member.id,generation:member.generation,sourceId:invite.id});
    }
    this.save(r);this.obligations.beginOpinion(o,r);return r;
  }
  tool(id:string,name:string,args:Record<string,unknown>,callId:string) {
    const spec=opinionTools.find(tool=>tool.name===name);
    if(!spec || Object.keys(args).some(key=>!Object.hasOwn(spec.inputSchema.properties,key)))throw new AppError(400,'征询参数无效。');
    this.store.visibility.assertTool(id,name);
    const {run,member,source}=this.obligations.opinionActor(id);
    const c=this.store.contract(id);
    if(c.coordinationPolicy!=='decision-material-v1' || c.visibility || c.projectWork || c.projectReview)
      throw new AppError(403,'本次执行未获准处理公开意见。');
    const port=this.store.artifacts.port;
    return port.tx(()=>{
      if(name==='opinion_open')return port.command('opinion:'+id+':'+requireText(callId,'调用标识',160),{name,args},()=>this.open(id,args)).result;
      const r=this.get(run.conversationId,args.roundId);
      const issuer=r.decider.instanceId===member.instanceId;
      const invited=r.participants.find(p=>p.instanceId===member.instanceId && p.sourceId===source.id);
      if(!issuer && !invited)throw new AppError(403,'只有本次征询已绑定的参与成员可使用。');
      const root=this.obligations.list(r.conversationId).find(o=>o.id===r.obligationId)!;
      this.reconcileRound(r,root);
      if(name==='opinion_read')return issuer?this.project(r):{id:r.id,question:r.question,deadline:r.deadline,state:r.state,opinions:r.opinions.filter(v=>v.instanceId===member.instanceId)};
      const receipt = port.command('opinion:'+id+':'+requireText(callId,'调用标识',160),{name,args},()=>{
        if(name==='opinion_submit') {
          if(!invited || typeof args.objection!=='boolean' || r.state==='cancelled' || root.state==='cancelled')conflict('本次执行不能签署这份意见。');
          const own=r.opinions.filter(v=>v.instanceId===member.instanceId);
          const vote:SignedOpinion={id:randomUUID(),memberId:run.memberId,instanceId:member.instanceId,invocationId:id,version:own.length+1,
            text:requireText(args.text,'意见'),objection:args.objection,late:closed(r),createdAt:new Date(this.clock()).toISOString()};
          r.opinions.push(vote);this.save(r);this.reconcileRound(r,root);return vote;
        }
        this.obligations.authorize(id,r.obligationId);
        if(!issuer)conflict('只有负责决策的成员可锁定或完成核查。');
        if(name==='opinion_lock') {
          if(r.state==='locked')return r;
          if(r.lockMode!=='early' || r.state!=='ready' || r.validCount<r.minimum || r.revision!==args.expectedRevision)
            conflict('意见版本或人数与决定条件不符，请重新读取。');
          this.freeze(r,this.qualified(r));this.save(r);return r;
        }
        const opinion=r.opinions.find(v=>v.id===args.opinionId);
        if(!opinion || !r.objectionIds?.includes(opinion.id) || r.state!=='locked')conflict('只能核查已锁定的署名异议。');
        const ref=requireText(args.evidenceMessageId,'公开证据编号',120);
        const evidence=this.evidence(r,ref,opinion);
        if(!evidence)conflict('请选择同房可读且独立于异议发言的证据消息。');
        const prev=r.resolutions.find(v=>v.opinionId===opinion.id && this.validCheck(r,v,opinion));
        if(prev)conflict('此异议已有有效核查。');
        r.resolutions.push({opinionId:opinion.id,evidenceMessageId:ref,evidenceRevision:evidence.revision??1,evidenceDigest:textDigest(evidence.content),finding:requireText(args.finding,'核查结论'),invocationId:id});
        this.save(r);return r;
      }).result;
      return name==='opinion_submit'?receipt:this.project(receipt as OpinionRound);
    });
  }
}
