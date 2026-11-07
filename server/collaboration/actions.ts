import { randomUUID } from 'node:crypto';
import type { ActionCandidate, ActionRecord, ActionVerdict, ActionWait, ArtifactVersion, CollaborationInvocation, ConditionEvidence, ManagedJob, MessageExcerpt, OrdinaryTask, SourceWork, WaitCondition } from '../../shared/collaboration.js';
import { AppError, now } from '../store.js';
import type { CollaborationStore } from './store.js';
import { conflict, endpointEqual, field, fields } from './cross.js';
import { textDigest } from './visibility.js';

const terminal = new Set(['succeeded','failed','cancelled','interrupted']);
const ended = new Set(['completed','cancelled','blocked']);
/** Explicit obligations only. Ordinary messages never acquire an Action or automatic successor. */
export class ActionService {
  constructor(readonly store:CollaborationStore) {}
  get data(){return this.store.artifacts;} get port(){return this.data.port;} get cross(){return this.store.cross;}
  list(){return this.data.rows<ActionRecord>('cc_actions');}
  get(id:string){return this.data.get<ActionRecord>('cc_actions',id);}
  waits(){return this.data.rows<ActionWait>('cc_action_waits');}
  candidates(){return this.data.rows<ActionCandidate>('cc_action_candidates');}
  save(a:ActionRecord,type:string){a.revision++;a.updatedAt=now();this.data.save('cc_actions',a,type);if(a.holder.conversationId!==a.conversationId)this.port.event(a.holder.conversationId,type,{actionId:a.id,generation:a.generation});}
  saveWait(w:ActionWait){w.revision++;this.data.save('cc_action_waits',w,`condition.${w.state}`);}
  version(a:ActionRecord,input:Record<string,unknown>){if(a.revision!==input.expectedRevision||a.generation!==input.expectedGeneration)conflict('Action 修订或责任代次已变化。');}
  released(id?:string){if(!id)return true;const i=this.store.invocation(id);return terminal.has(i.status)&&i.teardown==='confirmed';}
  task(a:ActionRecord){
    if(!a.taskId)return;
    const t=this.store.tasks.getTask(a.taskId);
    if(t.delegationId!==a.id||t.ownerRevision!==a.taskOwnerRevision||t.ownerMemberId!==a.home.memberId||t.status==='done'||t.disposition||t.pendingHandoffId)conflict('主任务委托锚点、负责人或状态已变化。');
    return t;
  }
  saveTask(t:OrdinaryTask,type:string){t.revision++;t.updatedAt=now();this.store.visibility.put('cc_ordinary_tasks',t);this.port.event(t.conversationId,type,{taskId:t.id,delegationId:t.delegationId,ownerRevision:t.ownerRevision});}
  authorized(a:ActionRecord){this.cross.valid(this.cross.grant(a.grantId),a.grantRevision);this.cross.checkOrigin(a.origin);this.cross.refs(a.conversationId,a.refs);this.cross.endpoint(a.holder);if(!ended.has(a.state))this.task(a);}
  material(s:SourceWork){if(!s.actionRef)return s.content;const a=this.get(s.actionRef.actionId);this.authorized(a);if(s.withdrawnAt)conflict('Action 来源已撤回。');return s.content+(a.refs.length?'\n获准公开选段：\n'+this.store.visibility.resolveRefs(a.conversationId,a.refs):'');}
  admissionReason(s:SourceWork):string|undefined{
    if(!s.actionRef)return;
    try{const a=this.get(s.actionRef.actionId);this.authorized(a);if(a.generation!==s.actionRef.generation||a.currentSourceId!==s.id||a.state!=='queued'||a.executionId||s.requestedTargets.length!==1||s.requestedTargets[0]!==a.holder.memberId||s.conversationId!==a.holder.conversationId)conflict('Action 来源代次或执行位置已变化。');}
    catch(e){return e instanceof Error?e.message:'Action 不能准入。';}
  }
  bind(s:SourceWork,i:CollaborationInvocation){if(!s.actionRef)return;const a=this.get(s.actionRef.actionId);if(this.admissionReason(s))conflict('Action 不能重复绑定。');a.executionId=i.id;a.state='active';this.save(a,'action.execution_bound');}
  validateInvocation(id:string,tools=false){
    const i=this.store.invocation(id),s=this.store.visibility.primary(id);if(!s.actionRef)return;
    const a=this.get(s.actionRef.actionId);this.authorized(a);
    if(s.withdrawnAt||a.generation!==s.actionRef.generation||a.currentSourceId!==s.id||a.executionId!==id||!endpointEqual(a.holder,{conversationId:i.conversationId,memberId:i.memberId})||!['active','candidate'].includes(a.state))conflict('Action 已换代、等待、退回或停止，旧执行不能继续。');
    if(tools && (i.status!=='running'||i.acceptance!=='accepted'||i.cancelRevision))conflict('Action 回调缺少准确运行权限。');
  }
  actor(id:string,actionId:string){this.cross.actor(id);this.validateInvocation(id,true);const a=this.get(actionId);if(a.executionId!==id)throw new AppError(403,'不能操作其他 Action。');return a;}
  dispatch(a:ActionRecord,kind:'initial'|'return'|'retry'|'wake',reason:string){
    this.authorized(a);if(!this.released(a.executionId)||!this.released(a.priorInvocationId))conflict('先等待准确执行终态和退出证据。');
    if(a.currentSourceId){const old=this.data.get<SourceWork>('cc_sources',a.currentSourceId);this.cross.withdraw(old);}
    if(kind!=='initial')a.generation++;
    a.lastExecutionId=a.executionId??a.lastExecutionId;delete a.executionId;delete a.candidateId;delete a.waitId;
    const s=this.store.admitSource({conversationId:a.holder.conversationId,kind:'action',requestedTargets:[a.holder.memberId],depth:0,actionRef:{actionId:a.id,generation:a.generation},content:`专用责任 ${a.id} · 第 ${a.generation} 代\n${a.title}\n${a.content}\n本次原因：${reason}\n主会话负责人 ${a.home.memberId}；当前执行成员 ${a.holder.memberId}。使用 action_list 读取修订；完成需要 action_candidate 提交候选，不能仅以回复结束代替。${a.completion==='human_acceptance'?'候选等待用户接受。':'候选需指定本会话已发布产物的 versionId 与 digest，等待服务端核验。'}`});
    a.currentSourceId=s.id;a.state='queued';a.reason=reason;this.save(a,`action.${kind}_queued`);this.store.publishSource(s);
  }
  create(cid:string,input:Record<string,unknown>,invocationId?:string){
    fields(input,['requestId','grantId','title','content','completion','refs','taskId','expectedTaskRevision','expectedOwnerRevision']);
    const origin=invocationId?this.cross.actor(invocationId):undefined;
    return this.port.tx(()=>this.port.command(`action-create:${cid}:${field(input.requestId,'请求标识')}`,{input,origin},()=>{
      const g=this.cross.grant(field(input.grantId,'授权'));this.cross.valid(g);if(g.home.conversationId!==cid)throw new AppError(403,'新责任只能从授权主会话创建。');
      if(origin&&(this.store.invocation(origin.invocationId).conversationId!==cid||origin.memberId!==g.home.memberId))throw new AppError(403,'当前成员不是授权负责人。');
      if(!['human_acceptance','artifact_published'].includes(String(input.completion)))throw new AppError(400,'完成规则无效。');
      if(this.list().filter(a=>a.conversationId===cid&&!ended.has(a.state)).length>=50)conflict('本会话未结束 Action 达到上限。');
      const a:ActionRecord={id:randomUUID(),conversationId:cid,grantId:g.id,grantRevision:g.revision,home:g.home,holder:g.target,predecessor:g.home,generation:1,revision:1,state:'preparing',completion:input.completion as ActionRecord['completion'],title:field(input.title,'责任名称',200),content:field(input.content,'责任说明',12000),refs:this.cross.refs(cid,input.refs),origin,createdAt:now(),updatedAt:now()};
      if(input.taskId!==undefined){
        const t=this.store.tasks.getTask(field(input.taskId,'任务'));
        if(t.conversationId!==cid||t.ownerMemberId!==g.home.memberId||t.revision!==input.expectedTaskRevision||t.ownerRevision!==input.expectedOwnerRevision||t.delegationId||t.pendingHandoffId||t.status==='done'||t.disposition||a.completion!=='human_acceptance')conflict('委托需要当前主任务版本、负责人以及用户验收规则。');
        if(origin)this.store.tasks.executionAuthority(t.id,origin);
        a.taskId=t.id;a.taskOwnerRevision=t.ownerRevision;a.priorInvocationId=t.executionRef?.invocationId;
        if(t.currentSourceId&&!t.executionRef)this.cross.withdraw(this.data.get<SourceWork>('cc_sources',t.currentSourceId));
        t.delegationId=a.id;this.saveTask(t,'task.delegation_prepared');a.taskRevision=t.revision;
      }
      this.data.save('cc_actions',a,'action.created');if(this.released(a.priorInvocationId))this.dispatch(a,'initial','用户明确建立专用责任');return a;
    }));
  }
  candidate(id:string,input:Record<string,unknown>,invocationId:string){
    fields(input,['requestId','expectedRevision','expectedGeneration','summary','artifactVersionId','artifactDigest']);const a0=this.actor(invocationId,id);
    return this.port.tx(()=>this.port.command(`action-candidate:${id}:${field(input.requestId,'请求标识')}`,{input,invocationId},()=>{
      const a=this.get(a0.id);this.version(a,input);if(a.candidateId)conflict('本代次已有候选；请等待验收或明确重派。');
      const i=this.store.invocation(invocationId),s=this.store.visibility.primary(invocationId),r=this.store.response(i.responseId);
      const c:ActionCandidate={id:randomUUID(),conversationId:a.conversationId,actionId:a.id,generation:a.generation,revision:1,invocationId,responseId:i.responseId,inputRevision:r.inputRevision,sourceId:s.id,sourceRevision:s.revision,sourceDigest:this.store.sourceDigest(s),summary:field(input.summary,'候选结果',12000),digest:'',createdAt:now()};
      if(a.completion==='artifact_published'){c.artifactVersionId=field(input.artifactVersionId,'产物版本');c.artifactDigest=field(input.artifactDigest,'产物摘要');const v=this.data.get<ArtifactVersion>('cc_artifact_versions',c.artifactVersionId);if(v.conversationId!==a.holder.conversationId||v.digest!==c.artifactDigest)conflict('候选产物不属于当前执行会话或摘要不匹配。');}
      c.digest=textDigest(JSON.stringify(c));this.data.save('cc_action_candidates',c,'action.candidate_recorded');a.candidateId=c.id;a.state='candidate';this.save(a,'action.awaiting_verdict');return {action:a,candidate:c};
    }));
  }
  verify(a:ActionRecord,input:Record<string,unknown>){
    this.authorized(a);if(a.state!=='candidate'||!a.candidateId||input.candidateId!==a.candidateId)conflict('候选已变化。');
    const c=this.data.get<ActionCandidate>('cc_action_candidates',a.candidateId!),i=this.store.invocation(c.invocationId),s=this.data.get<SourceWork>('cc_sources',c.sourceId),r=this.store.response(i.responseId);
    if(!this.released(i.id)||i.status!=='succeeded'||i.cancelRevision||i.acceptance!=='accepted'||c.generation!==a.generation||a.lastExecutionId!==i.id||c.sourceId!==a.currentSourceId||s.withdrawnAt||s.revision!==c.sourceRevision||this.store.sourceDigest(s)!==c.sourceDigest||r.inputRevision!==c.inputRevision)conflict('候选执行、来源或退出证据不足，不能确认完成。');
    if(textDigest(JSON.stringify({...c,digest:''}))!==c.digest)conflict('候选摘要不匹配。');
    let evidence:Record<string,unknown>={candidateId:c.id,candidateDigest:c.digest,acceptedBy:'local-user'};
    if(a.completion==='artifact_published'){
      const v=this.data.get<ArtifactVersion>('cc_artifact_versions',c.artifactVersionId!),material=this.store.artifacts.content(v.id);
      if(v.conversationId!==a.holder.conversationId||v.state!=='published'||v.digest!==c.artifactDigest||textDigest(material.content)!==v.digest)conflict('服务端尚无准确产物发布事实。');
      evidence={versionId:v.id,digest:v.digest,jobId:v.jobId};
    }
    const verdict:ActionVerdict={id:randomUUID(),conversationId:a.conversationId,actionId:a.id,generation:a.generation,candidateId:c.id,candidateDigest:c.digest,authority:a.completion,evidence,createdAt:now()};
    this.data.save('cc_action_verdicts',verdict,'action.verified');
    const t=this.task(a);if(t){t.status='done';t.statusReason='用户接受准确委托候选';delete t.delegationId;this.saveTask(t,'task.delegation_completed');}
    a.state='completed';this.save(a,'action.completed');return {action:a,verdict};
  }
  command(id:string,input:Record<string,unknown>,invocationId?:string){
    fields(input,['requestId','expectedRevision','expectedGeneration','operation','reason','candidateId']);
    if(invocationId){this.actor(invocationId,id);if(input.operation!=='return')throw new AppError(403,'完成验收、取消和重派由用户决定。');}
    return this.port.tx(()=>this.port.command(`action-command:${id}:${field(input.requestId,'请求标识')}`,{input,invocationId},()=>{
      const a=this.get(id);this.version(a,input);const op=input.operation;
      if(op==='verify')return this.verify(a,input);
      if(op==='cancel'){
        if(ended.has(a.state))conflict('责任已经结束。');a.state='cancelled';a.reason=field(input.reason,'取消说明',2000);this.cancelWait(a);if(a.currentSourceId)this.cross.withdraw(this.data.get<SourceWork>('cc_sources',a.currentSourceId));this.save(a,'action.cancelled');this.releaseTask(a);return {action:a};
      }
      this.authorized(a);a.reason=field(input.reason,'操作说明',2000);
      if(op==='return') {if(!['active','candidate','replaceable'].includes(a.state))conflict('当前责任不能退回。');a.state='returning';this.save(a,'action.return_requested');this.reconcile();return {action:this.get(id)};}
      if(op==='retry') {if(!['replaceable','candidate'].includes(a.state)||!this.released(a.executionId))conflict('需要已确认退出的责任后才能重派。');this.dispatch(a,'retry',a.reason);return {action:a};}
      throw new AppError(400,'Action 操作无效。');
    }));
  }
  private cancelWait(a:ActionRecord){if(!a.waitId)return;const w=this.data.get<ActionWait>('cc_action_waits',a.waitId);if(['waiting','ready'].includes(w.state)){w.state='cancelled';this.saveWait(w);}}
  private releaseTask(a:ActionRecord){if(!a.taskId||!this.released(a.executionId)||!this.released(a.priorInvocationId))return;const t=this.store.tasks.getTask(a.taskId);if(t.delegationId===a.id){delete t.delegationId;this.saveTask(t,'task.delegation_released');}}
  wait(id:string,input:Record<string,unknown>,invocationId?:string){
    fields(input,['requestId','expectedRevision','expectedGeneration','condition','deadline','cooldownMs']);if(invocationId)this.actor(invocationId,id);
    return this.port.tx(()=>this.port.command(`action-wait:${id}:${field(input.requestId,'请求标识')}`,{input,invocationId},()=>{
      const a=this.get(id);this.version(a,input);this.authorized(a);if(a.state!=='active'||!a.executionId||a.waitId)conflict('只有当前活动责任可注册等待。');this.validateInvocation(a.executionId!,true);
      const condition=input.condition;if(!condition||typeof condition!=='object'||Array.isArray(condition))throw new AppError(400,'等待条件无效。');const c=condition as Record<string,unknown>;
      const deadline=field(input.deadline,'等待截止时间'),end=Date.parse(deadline),cooldown=input.cooldownMs??0;
      if(!Number.isFinite(end)||end<=this.cross.clock()||end>this.cross.clock()+30*86400000||!Number.isSafeInteger(cooldown)||Number(cooldown)<0||Number(cooldown)>3600000)throw new AppError(400,'等待期限或冷却间隔无效。');
      if(c.kind==='timer'){fields(c,['kind','at']);if(!Number.isFinite(Date.parse(String(c.at)))||Date.parse(String(c.at))>=end)throw new AppError(400,'定时时点应早于截止时间。');}
      else if(c.kind==='signal'){fields(c,['kind','name']);field(c.name,'信号名称',120);}
      else if(c.kind==='job_succeeded'){fields(c,['kind','jobId']);const j=this.data.get<ManagedJob>('cc_managed_jobs',field(c.jobId,'作业'));if(j.conversationId!==a.holder.conversationId)throw new AppError(403,'不能等待其他会话作业。');}
      else if(c.kind==='artifact_published'){fields(c,['kind','versionId','digest']);const v=this.data.get<ArtifactVersion>('cc_artifact_versions',field(c.versionId,'产物版本'));if(v.conversationId!==a.holder.conversationId||v.digest!==c.digest)throw new AppError(403,'产物范围或摘要不匹配。');}
      else throw new AppError(400,'不支持该等待条件。');
      const w:ActionWait={id:randomUUID(),conversationId:a.conversationId,actionId:a.id,generation:a.generation,episode:this.waits().filter(x=>x.actionId===a.id).length+1,revision:1,invocationId:a.executionId!,sourceId:a.currentSourceId!,condition:c as unknown as WaitCondition,state:'waiting',deadline,notBefore:new Date(this.cross.clock()+Number(cooldown)).toISOString(),createdAt:now()};
      this.data.save('cc_action_waits',w,'condition.registered');a.state='waiting';a.waitId=w.id;this.save(a,'action.waiting');return {action:a,wait:w};
    }));
  }
  evidence(w:ActionWait,eventId:string,authority:ConditionEvidence['authority'],detail:Record<string,unknown>){
    const e:ConditionEvidence={id:randomUUID(),conversationId:w.conversationId,waitId:w.id,episode:w.episode,eventId,authority,detail,createdAt:now()};
    this.store.db.prepare('INSERT INTO cc_condition_event_keys VALUES(?,?,?)').run(w.id,eventId,e.id);this.data.save('cc_condition_evidence',e,'condition.evidence');w.evidenceId=e.id;w.state='ready';this.saveWait(w);
  }
  conditionCommand(id:string,input:Record<string,unknown>){
    fields(input,['requestId','expectedRevision','episode','operation','eventId','name']);
    return this.port.tx(()=>this.port.command(`condition-command:${id}:${field(input.requestId,'请求标识')}`,input,()=>{
      const w=this.data.get<ActionWait>('cc_action_waits',id),a=this.get(w.actionId);
      if(w.revision!==input.expectedRevision||w.episode!==input.episode||w.generation!==a.generation||a.waitId!==w.id||a.state!=='waiting'||!['waiting','ready'].includes(w.state))conflict('等待修订或 episode 已变化。');
      this.authorized(a);
      if(input.operation==='cancel'){w.state='cancelled';this.saveWait(w);a.state='replaceable';delete a.waitId;this.save(a,'action.wait_cancelled');return w;}
      if(input.operation!=='signal'||w.condition.kind!=='signal'||input.name!==w.condition.name||Date.parse(w.deadline)<=this.cross.clock())conflict('信号类型、名称或期限不匹配。');
      if(w.state==='waiting')this.evidence(w,field(input.eventId,'信号事件标识'),'human_signal',{name:input.name,confirmedBy:'local-user'});return w;
    }));
  }
  private probe(w:ActionWait,a:ActionRecord){
    if(w.state!=='waiting')return;const c=w.condition;
    if(c.kind==='timer'&&this.cross.clock()>=Date.parse(c.at))this.evidence(w,'timer:'+c.at,'platform_timer',{at:c.at});
    if(c.kind==='job_succeeded'){const j=this.data.get<ManagedJob>('cc_managed_jobs',c.jobId);if(j.conversationId===a.holder.conversationId&&j.state==='succeeded'&&j.receiptDigest){const material=this.store.artifacts.content(j.versionId);this.evidence(w,'job:'+j.id+':'+j.revision,'managed_job',{jobId:j.id,receiptDigest:j.receiptDigest,versionId:j.versionId,contentDigest:textDigest(material.content)});}}
    if(c.kind==='artifact_published'){const v=this.data.get<ArtifactVersion>('cc_artifact_versions',c.versionId);if(v.conversationId===a.holder.conversationId&&v.state==='published'&&v.digest===c.digest){const material=this.store.artifacts.content(v.id);if(textDigest(material.content)===c.digest)this.evidence(w,'artifact:'+v.id,'artifact_receipt',{versionId:v.id,digest:v.digest,jobId:v.jobId});}}
  }
  reconcile(){this.port.tx(()=>{
    for(const a of this.list()){
      if(a.executionId&&this.released(a.executionId)){a.lastExecutionId=a.executionId;delete a.executionId;if(a.state==='active'){a.state='replaceable';a.reason='执行已退出但没有完成候选，等待明确后续。';}this.save(a,'action.execution_released');}
      if(ended.has(a.state)){this.releaseTask(a);continue;}
      try{this.authorized(a);if(a.currentSourceId&&this.data.get<SourceWork>('cc_sources',a.currentSourceId).withdrawnAt)conflict('原来源已撤回。');}
      catch(e){a.state='blocked';a.reason=e instanceof Error?e.message:'授权失效';this.cancelWait(a);if(a.currentSourceId)this.cross.withdraw(this.data.get<SourceWork>('cc_sources',a.currentSourceId));this.save(a,'action.blocked');this.store.visibility.changed(a.conversationId);this.releaseTask(a);continue;}
      if(a.state==='preparing'&&this.released(a.priorInvocationId))this.dispatch(a,'initial','原主任务执行已确认释放');
      else if(a.state==='returning'&&!a.executionId){const previous=a.holder;a.holder=a.predecessor;a.predecessor=previous;this.dispatch(a,'return',a.reason??'退回前任');}
      else if(a.state==='waiting'&&a.waitId){
        const w=this.data.get<ActionWait>('cc_action_waits',a.waitId);
        if(w.generation!==a.generation||w.sourceId!==a.currentSourceId){w.state='cancelled';this.saveWait(w);a.state='blocked';this.save(a,'action.wait_stale');continue;}
        if(Date.parse(w.deadline)<=this.cross.clock()){w.state='expired';this.saveWait(w);a.state='replaceable';delete a.waitId;this.save(a,'action.wait_expired');continue;}
        try{this.probe(w,a);}catch{continue;} // Missing receipt is never treated as a completed condition.
        if(w.state==='ready'&&!a.executionId&&Date.parse(w.notBefore)<=this.cross.clock()){
          const evidence=this.data.get<ConditionEvidence>('cc_condition_evidence',w.evidenceId!);if(evidence.waitId!==w.id||evidence.episode!==w.episode)conflict('条件证据身份不匹配。');
          this.dispatch(a,'wake',`条件 ${w.condition.kind} 已满足，证据 ${evidence.id}`);w.state='fired';w.wakeSourceId=a.currentSourceId;this.saveWait(w);
        }
      }
    }
  });}
  detail(cid:string){const actions=this.list().filter(a=>a.conversationId===cid||a.holder.conversationId===cid||this.cross.grant(a.grantId).target.conversationId===cid),ids=new Set(actions.map(a=>a.id));return {actions,actionCandidates:this.candidates().filter(c=>ids.has(c.actionId)),actionVerdicts:this.data.rows<ActionVerdict>('cc_action_verdicts').filter(v=>ids.has(v.actionId)),actionWaits:this.waits().filter(w=>ids.has(w.actionId)),conditionEvidence:this.data.rows<ConditionEvidence>('cc_condition_evidence').filter(e=>actions.some(a=>a.id===this.data.get<ActionWait>('cc_action_waits',e.waitId).actionId))};}
  tool(id:string,name:string,input:Record<string,unknown>,callId:string){
    this.cross.actor(id);const i=this.store.invocation(id),requestId=`${id}:${callId}`;
    if(name==='action_list'){fields(input,[]);return {actions:this.list().filter(a=>{try{this.authorized(a);return endpointEqual(a.home,{conversationId:i.conversationId,memberId:i.memberId})||endpointEqual(a.holder,{conversationId:i.conversationId,memberId:i.memberId});}catch{return false;}})};}
    if(name==='action_create')return this.create(i.conversationId,{...input,requestId},id);
    const {actionId,...args}=input;const key=field(actionId,'Action');
    if(name==='action_candidate')return this.candidate(key,{...args,requestId},id);
    if(name==='action_return')return this.command(key,{...args,requestId,operation:'return'},id);
    if(name==='action_wait')return this.wait(key,{...args,requestId},id);
    throw new AppError(400,'Action 工具不存在。');
  }
}
