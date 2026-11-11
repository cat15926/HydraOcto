import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RoomMemberInstance } from '../../shared/collaboration.js';
import type { Obligation } from '../../shared/obligations.js';
import type { MaterialBasis, PackageVersion, VersionPackageView } from '../../shared/version-packages.js';
import { AppError, now } from '../store.js';
import { textDigest } from './visibility.js';
import { stringField } from './artifacts.js';
import type { CollaborationStore } from './store.js';

interface Authorship { invocationId:string; sourceId:string; revision:number; instanceId:string }
interface Version extends PackageVersion { origin?:Authorship }
interface Material {key:string;name:string;versions:Version[]}
interface Review {id:string;versionId:string;verdict:'accept'|'changes_requested';note:string;origin:Authorship}
interface Submission extends Version {basis?:MaterialBasis[];reviews:Review[]}
interface Part {key:string;label:string;dependsOn?:string[];writer?:RoomMemberInstance;reviewer?:RoomMemberInstance;submissions:Submission[];headVersionId?:string}
interface Edition {id:string;publisher:Authorship;parts:{key:string;versionId:string;reviewId:string}[]}
interface Package {
  id:string;conversationId:string;obligationId:string;title:string;revision:number;
  materials:Material[];parts:Part[];editions:Edition[];
}
export function migrateVersionPackages(db:DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS cc_version_packages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES cc_conversations(id),value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS cc_packages_room ON cc_version_packages(conversation_id);
    CREATE TABLE IF NOT EXISTS cc_version_package_reads(invocation_id TEXT NOT NULL REFERENCES cc_invocations(id),package_id TEXT NOT NULL REFERENCES cc_version_packages(id),
      version_id TEXT NOT NULL, PRIMARY KEY(invocation_id,package_id,version_id));`);
}
function conflict(message:string):never {throw new AppError(409,message,'version_package_conflict');}
function unavailable():never {throw new AppError(404,'资料包不可用。','not_found');}
function key(value:unknown){return stringField(value,'分项标识',120);}
function body(value:unknown) {
  const content=stringField(value,'正文',32768);
  if(Buffer.byteLength(content)>32768 || content.includes('\0'))throw new AppError(400,'正文须为 32 KiB 以内的文本。');
  return content;
}
function records(value:unknown,label:string,allowEmpty=false):Record<string,unknown>[]{
  if(!Array.isArray(value)||(!allowEmpty&&!value.length)||value.length>32||value.some(v=>!v||typeof v!=='object'||Array.isArray(v)))throw new AppError(400,label+'无效。');
  return value;
}
function unique(values:string[]){if(new Set(values).size!==values.length)throw new AppError(400,'存在重复的材料或分项标识。');return values;}
function last<T>(values:T[]):T{return values[values.length-1]!;}
function version(content:string,number:number,origin?:Authorship):Version{
  return {versionId:randomUUID(),number,content,digest:textDigest(content),createdAt:now(),origin};
}

export class VersionPackageService {
  constructor(private readonly store:CollaborationStore){}
  private get data(){return this.store.artifacts;}
  private root(p:Package){return this.data.get<Obligation>('cc_obligations',p.obligationId);}
  hasPackage(id:string){return !!this.store.db.prepare('SELECT 1 FROM cc_version_packages WHERE id=?').get(id);}
  private load(cid:string,id:unknown){
    const row=this.store.db.prepare('SELECT value FROM cc_version_packages WHERE id=? AND conversation_id=?').get(key(id),cid) as {value:string}|undefined;
    if(!row)unavailable();
    const p:Package=JSON.parse(row.value);
    if(!this.accessible(p))unavailable();
    return p;
  }
  private accessible(p:Package){
    const root=this.root(p),source=this.store.visibility.primary(root.originInvocationId);
    return !source.withdrawnAt && !source.visibility && source.conversationId===p.conversationId && !this.store.workbench.conversation(p.conversationId).deletedAt;
  }
  private editable(p:Package){
    const room=this.store.workbench.conversation(p.conversationId);
    return this.accessible(p) && !room.archivedAt && !room.importedFor && !['cancelled','delivered'].includes(this.root(p).state);
  }
  private save(p:Package,event:string){
    p.revision++;
    this.data.save('cc_version_packages',p,'package.'+event);
  }
  private actor(id:string):Authorship{
    const c=this.store.contract(id),s=this.store.visibility.primary(id),i=this.store.invocation(id);
    if(c.coordinationPolicy!=='decision-material-v1'||c.visibility||s.visibility||s.crossRef||s.actionRef||s.withdrawnAt||c.projectWork||c.projectReview||
       !c.roomMember || !this.store.roomMembers.isCurrent(c.roomMember))throw new AppError(403,'该执行不能处理公开资料包。');
    this.store.visibility.validateInvocation(id);
    this.data.origin(i.conversationId,id);
    return {invocationId:id,sourceId:s.id,revision:s.revision,instanceId:c.roomMember.id};
  }
  private validOrigin(origin?:Authorship,settledExcept?:string){
    if(!origin)return true;
    const run=this.store.invocation(origin.invocationId),s=this.store.visibility.primary(run.id);
    if(s.id!==origin.sourceId||s.revision!==origin.revision||s.withdrawnAt||s.visibility||run.cancelRevision||run.acceptance!=='accepted'||run.roomMember?.id!==origin.instanceId)return false;
    return (run.status==='succeeded'&&run.teardown==='confirmed') || (run.status==='running' && (settledExcept===undefined || settledExcept===run.id));
  }
  private available(v:Version,cid:string,settledExcept?:string) {
    if(textDigest(v.content)!==v.digest||!this.validOrigin(v.origin,settledExcept))return false;
    if(!v.artifactVersionId)return true;
    try{
      const {version,content}=this.data.content(v.artifactVersionId,cid);
      const author=version.origin.actor;
      if(author.kind==='agent'&&this.store.visibility.primary(author.invocationId).withdrawnAt)return false;
      return (version.state==='published'||version.state==='proposed') && version.digest===v.digest && content===v.content && !this.data.originReason(version.origin,cid);
    }catch{return false;}
  }
  private member(p:Package,instance?:RoomMemberInstance) {
    if(instance)return instance;
    const owner=this.root(p).owner, current=this.store.roomMembers.resolve(p.conversationId,owner.memberId);
    if(current.id!==owner.instanceId)conflict('负责人实例已变化，请在原委托复核。');
    return current;
  }
  private instance(cid:string,id:unknown) {
    if(id===undefined)return;
    const mid=key(id);
    this.data.target(cid,mid);
    return this.store.roomMembers.resolve(cid,mid);
  }
  private requireMember(p:Package,origin:Authorship,instance?:RoomMemberInstance){
    const allowed=this.member(p,instance);
    if(origin.instanceId!==allowed.id || !this.store.roomMembers.isCurrent(allowed))throw new AppError(403,'仅该分项约定的房间成员可操作。');
  }
  private readVersion(origin:Authorship,p:Package,id:string) {
    const row=this.store.db.prepare('SELECT 1 FROM cc_version_package_reads WHERE invocation_id=? AND package_id=? AND version_id=?').get(origin.invocationId,p.id,id);
    if(!row)conflict('请先用 package_list 读取本轮要使用的准确版本。');
  }
  private matches(p:Package,part:Part,s:Submission){
    if(!part.dependsOn||!s.basis||s.basis.length!==part.dependsOn.length)return false;
    return part.dependsOn.every(k=>{
      const m=p.materials.find(m=>m.key===k),v=m&&last(m.versions);
      return v && this.available(v,p.conversationId) && s.basis!.some(b=>b.key===k && b.versionId===v.versionId);
    });
  }
  private readableSubmission(p:Package,s:Submission,settledExcept?:string) {
    if (!this.available(s,p.conversationId,settledExcept)) return false;
    if (!s.basis) return p.materials.every(m=>m.versions.every(v=>this.available(v,p.conversationId)));
    return s.basis.every(b=>{
      const material=p.materials.find(m=>m.key===b.key);
      const source=material?.versions.find(v=>v.versionId===b.versionId);
      return source && this.available(source,p.conversationId,settledExcept);
    });
  }
  private selected(p:Package,part:Part){
    // A late delivery of old work stays auditable and cannot displace newer work.
    const head=part.submissions.find(s=>s.versionId===part.headVersionId);
    return head && this.matches(p,part,head) ? head : undefined;
  }
  private review(s:Submission){return s.reviews.at(-1);}
  private projectPart(p:Package,part:Part):VersionPackageView['parts'][number]{
    const selected=this.selected(p,part),s=selected??part.submissions.find(item=>item.versionId===part.headVersionId)??part.submissions.at(-1),valid=s&&this.readableSubmission(p,s);
    const review=s&&this.review(s);
    const currentReview=review&&this.validOrigin(review.origin);
    let state:VersionPackageView['parts'][number]['state']='missing', reason:string|undefined;
    if(!part.dependsOn || s&&!s.basis || s&&!valid){state='unknown';reason='依据待核实';}
    else if(s&&!selected){
      state='needs_review';
      const changed=part.dependsOn.filter(k=>!s.basis?.some(b=>b.key===k&&b.versionId===last(p.materials.find(m=>m.key===k)!.versions).versionId));
      reason=changed.length ? '所用材料已改版：'+changed.map(k=>p.materials.find(m=>m.key===k)!.name).join('、') : '材料已不可核验。';
    }
    else if(s&&currentReview&&review.verdict==='changes_requested'){state='needs_review';reason='评审要求修改。';}
    else if(s&&currentReview&&review.verdict==='accept')state='accepted';
    else if(s)state='pending';
    return {key:part.key,label:part.label,dependsOn:part.dependsOn,memberId:part.writer?.memberId??this.root(p).owner.memberId,
      reviewerMemberId:part.reviewer?.memberId??this.root(p).owner.memberId,state,reason,
      ...(valid&&s && {versionId:s.versionId,number:s.number,content:s.content,basis:s.basis?.filter(b=>p.materials.find(m=>m.key===b.key)?.versions.some(v=>v.versionId===b.versionId&&this.available(v,p.conversationId)))}),
      ...(state==='accepted'&&review && {evidenceId:review.id}),
      history:part.submissions.filter(x=>this.readableSubmission(p,x)).flatMap(x=>{
        const reviews=x.reviews.filter(r=>this.validOrigin(r.origin));
        return (reviews.length?reviews:[undefined]).map(r=>({versionId:x.versionId,submissionId:x.versionId,number:x.number,
          ...(r&&{reviewId:r.id,verdict:r.verdict,note:r.note}),current:state==='accepted'&&r?.id===review?.id&&selected?.versionId===x.versionId}));
      })
    };
  }
  private view(p:Package,origin?:Authorship):VersionPackageView{
    const parts=p.parts.map(part=>this.projectPart(p,part));
    const materials=p.materials.map(m=>{
      const v=last(m.versions),visible=this.available(v,p.conversationId);
      return {key:m.key,name:m.name,versionId:visible?v.versionId:'',number:v.number,content:visible?v.content:'依据待核实',
        history:m.versions.filter(v=>this.available(v,p.conversationId)).map(({versionId,number})=>({versionId,number}))};
    });
    const edition=p.editions.at(-1);
    const current=edition && this.validOrigin(edition.publisher) && parts.every(part=>part.state==='accepted' && edition.parts.some(x=>x.key===part.key && x.versionId===part.versionId && x.reviewId===part.evidenceId));
    if(origin){
      const save=this.store.db.prepare('INSERT OR IGNORE INTO cc_version_package_reads VALUES(?,?,?)');
      for(const item of [...materials,...parts])if(item.versionId)save.run(origin.invocationId,p.id,item.versionId);
    }
    return {id:p.id,obligationId:p.obligationId,title:p.title,revision:p.revision,editable:this.editable(p),
      state:current?'published':edition || parts.some(x=>x.state==='needs_review')?'needs_review':'draft',
      materials,parts,...(current&&{edition:{id:edition.id,parts:edition.parts}})};
  }
  list(cid:string) {return this.data.rows<Package>('cc_version_packages',cid).filter(p=>this.accessible(p)).map(p=>this.view(p));}
  private notify(p:Package,parts:Part[],role:'writer'|'reviewer',reason:string,skip?:string) {
    const recipients=new Set<string>();
    for(const part of parts){
      const member=this.member(p,part[role]);
      if(member.id===skip || member.id===this.root(p).owner.instanceId || !this.store.roomMembers.isCurrent(member))continue;
      recipients.add(member.memberId);
    }
    for(const member of recipients)this.store.admitSource({conversationId:p.conversationId,kind:'job_result',requestedTargets:[member],depth:0,
      coordinationOriginSourceId:this.root(p).originSourceId,content:reason+'。资料包 '+p.id+'。使用 package_list 查阅你的分项、当前正文和版本，再用 '+(role==='writer'?'package_submit':'package_review')+' 登记。'});
  }
  private open(id:string,origin:Authorship,args:Record<string,unknown>){
    const {o}=this.store.obligations.authorize(id,args.obligationId);
    if(o.parentId||o.state!=='open'||this.hasPackage(o.id))conflict('只可在开放主委托创建一次资料包。');
    const materials=records(args.materials,'材料').map(m=>{
      let v:Version;
      if(m.artifactVersionId!==undefined){
        if(m.content!==undefined)conflict('请使用正文或准确产物版本之一。');
        const aid=key(m.artifactVersionId),a=this.data.content(aid,o.conversationId);
        v={...version(body(a.content),1,origin),artifactVersionId:aid};
        if(!this.available(v,o.conversationId))conflict('材料版本不可用。');
      }else v=version(body(m.content),1,origin);
      return {key:key(m.key),name:stringField(m.name,'材料名称'),versions:[v]};
    });
    const keys=unique(materials.map(m=>m.key));
    const parts=records(args.parts,'分项').map(x=>{
      let dependencies:string[]|undefined;
      if(x.dependsOn!==undefined){
        if(!Array.isArray(x.dependsOn))conflict('依据列表无效。');
        dependencies=unique(x.dependsOn.map(key));
        if(dependencies.some(k=>!keys.includes(k)))conflict('依据材料未登记。');
      }
      return {key:key(x.key),label:stringField(x.label,'分项名称'),writer:this.instance(o.conversationId,x.memberId),
        reviewer:this.instance(o.conversationId,x.reviewerMemberId),dependsOn:dependencies,submissions:[]};
    });
    unique(parts.map(p=>p.key));
    const p:Package={id:o.id,obligationId:o.id,conversationId:o.conversationId,title:stringField(args.title,'资料包名称'),materials,parts,editions:[],revision:0};
    this.save(p,'opened'); this.notify(p,parts,'writer','你收到一项资料制作委托',origin.instanceId);
    return this.view(p,origin);
  }
  private changeInput(p:Package,args:Record<string,unknown>,origin?:Authorship){
    if(Object.keys(args).some(k=>!['key','content','expectedRevision','requestId','packageId'].includes(k)))throw new AppError(400,'材料修订参数无效。');
    if(!this.editable(p)||p.revision!==args.expectedRevision)conflict('资料包已变化，请重新核对。');
    const material=p.materials.find(m=>m.key===args.key);
    if(!material)unavailable();
    const text=body(args.content);
    if(text===last(material.versions).content)return this.view(p,origin);
    material.versions.push(version(text,material.versions.length+1,origin));
    this.save(p,'material_changed');
    this.notify(p,p.parts.filter(part=>part.dependsOn?.includes(material.key)),'writer','依据材料已改版，请复核受影响的分项',origin?.instanceId);
    if (this.view(p).state !== 'published') this.store.obligations.reopenPackage(this.root(p));
    return this.view(p,origin);
  }
  change(cid:string,packageId:string,args:Record<string,unknown>){
    return this.data.port.tx(()=>{
      this.data.port.command('package-owner-change:'+cid+':'+stringField(args.requestId,'请求标识'),{packageId,args},()=>this.changeInput(this.load(cid,packageId),args).id);
      return this.view(this.load(cid,packageId));
    });
  }
  private submit(p:Package,args:Record<string,unknown>,origin:Authorship){
    const part=p.parts.find(x=>x.key===args.key);if(!part)unavailable();
    this.requireMember(p,origin,part.writer);
    const current=this.projectPart(p,part);
    if (current.versionId && args.expectedPartVersionId!==current.versionId) conflict('该分项已有交付。请先用 package_list 读取分项自己的 versionId，并把它作为 expectedPartVersionId。');
    // Some native tool bridges serialize an explicit JSON null as text.
    if (!current.versionId && args.expectedPartVersionId!=null && args.expectedPartVersionId!=='null') conflict('这是该分项的首次提交，请省略 expectedPartVersionId。材料版本只放在 basis。');
    let basis:MaterialBasis[]|undefined;
    if(args.basis!==undefined){
      basis=records(args.basis,'依据',true).map(b=>{
        const k=key(b.key),v=key(b.versionId),material=p.materials.find(m=>m.key===k);
        if(!material?.versions.some(x=>x.versionId===v && this.available(x,p.conversationId)))conflict('依据版本不可核验。');
        this.readVersion(origin,p,v);
        return {key:k,versionId:v};
      });
      const keys=unique(basis.map(b=>b.key));
      if(part.dependsOn && (keys.length!==part.dependsOn.length || part.dependsOn.some(k=>!keys.includes(k))))conflict('依据与该分项约定不符。');
      part.dependsOn??=keys;
    }
    const s:Submission={...version(body(args.content),part.submissions.length+1,origin),basis,reviews:[]};
    part.submissions.push(s);
    if(!s.basis || this.matches(p,part,s) || !part.headVersionId)part.headVersionId=s.versionId;
    this.save(p,'submitted');
    if(this.matches(p,part,s))this.notify(p,[part],'reviewer','待评审分项已有新版本',origin.instanceId);
    return this.view(p,origin);
  }
  private sign(p:Package,args:Record<string,unknown>,origin:Authorship){
    const part=p.parts.find(x=>x.key===args.key);if(!part)unavailable();
    this.requireMember(p,origin,part.reviewer);
    const s=part.submissions.find(s=>s.versionId===args.versionId);
    if(!s||!this.readableSubmission(p,s))conflict('提交版本不可核验。');
    this.readVersion(origin,p,s.versionId);
    if(args.verdict!=='accept'&&args.verdict!=='changes_requested')conflict('评审结论无效。');
    if(s.reviews.length)conflict('此版本已有评审，请对新的修订进行核对。');
    s.reviews.push({id:randomUUID(),versionId:s.versionId,verdict:args.verdict,note:stringField(args.note,'验收依据',4000),origin});
    this.save(p,'reviewed');
    if(args.verdict==='changes_requested'&&this.selected(p,part)?.versionId===s.versionId)this.notify(p,[part],'writer','评审要求修改分项',origin.instanceId);
    return this.view(p,origin);
  }
  private verify(p:Package,except:string){
    for(const part of p.parts){
      const s=this.selected(p,part),r=s&&this.review(s);
      if(!s||!this.available(s,p.conversationId,except)||r?.verdict!=='accept'||!this.validOrigin(r.origin,except))
        conflict('需要当前版本的有效验收：'+part.label);
      for(const k of part.dependsOn??[]){
        const m=p.materials.find(x=>x.key===k)!;
        if(!this.available(last(m.versions),p.conversationId,except))conflict('依据未获核实：'+m.name);
      }
    }
  }
  private publish(p:Package,args:Record<string,unknown>,origin:Authorship){
    if(p.revision!==args.expectedRevision)conflict('资料包已变化，请重新核对。');
    this.verify(p,origin.invocationId);
    const old=this.view(p,origin);
    if(old.edition)return old;
    const parts=old.parts.map(part=>({key:part.key,versionId:part.versionId!,reviewId:part.evidenceId!}));
    p.editions.push({id:randomUUID(),parts,publisher:origin});
    this.save(p,'published');
    return this.view(p,origin);
  }
  deliveryProof(obligationId:string){
    if(!this.hasPackage(obligationId))return;
    const p=this.data.get<Package>('cc_version_packages',obligationId);
    if(!this.accessible(p))conflict('资料包不可继续交付。');
    const edition=last(p.editions);
    if(!edition || this.view(p).edition?.id!==edition.id)conflict('资料包仍有待核验的版本。');
    this.verify(p,edition.publisher.invocationId);
    return edition.id;
  }
  assertDelivery(obligationId:string,edition?:string){
    if(this.deliveryProof(obligationId)!==edition)conflict('交付所依据的资料包版本已变化。');
  }
  readyToReview(o:Obligation){
    if(!this.hasPackage(o.id))return false;
    const p=this.load(o.conversationId,o.id);
    return p.parts.every(part=>{
      const v=this.projectPart(p,part);
      const s=this.selected(p,part);
      if (!s || !this.available(s,p.conversationId,'')) return false;
      if (v.state==='accepted') return this.validOrigin(this.review(s)?.origin,'');
      return v.state==='pending' && this.member(p,part.reviewer).id===o.owner.instanceId;
    });
  }
  tool(id:string,name:string,args:Record<string,unknown>,callId:string):unknown{
    const origin=this.actor(id),cid=this.store.invocation(id).conversationId;
    return this.data.port.tx(()=>{
      if(name==='package_list'){
        const packages=args.packageId?[this.load(cid,args.packageId)]:this.data.rows<Package>('cc_version_packages',cid).filter(p=>this.accessible(p));
        return {packages:packages.map(p=>this.view(p,origin))};
      }
      const receipt=this.data.port.command('package-tool:'+id+':'+stringField(callId,'调用编号'),{name,args},()=>{
        if(name==='package_open')return this.open(id,origin,args).id;
        const p=this.load(cid,args.packageId);
        if(!this.editable(p))conflict('资料包已结束。');
        if(name==='package_submit')return this.submit(p,args,origin).id;
        if(name==='package_review')return this.sign(p,args,origin).id;
        this.store.obligations.authorize(id,p.obligationId);
        if(name==='package_change')return this.changeInput(p,args,origin).id;
        if(name==='package_publish')return this.publish(p,args,origin).id;
        throw new AppError(400,'未知资料工具。');
      });
      return this.view(this.load(cid,receipt.result),origin);
    });
  }
}
