import type { ProjectPullStatus, RuntimeInteraction, SourceWork, WorkspaceGrant } from '../../shared/collaboration.js';
import { AppError } from '../store.js';
import { githubApi, observePull } from './project-github.js';
import type { CollaborationStore } from './store.js';

export function requestsPullRequest(text:string) {
  if (/(?:不要|暂不|无需|别).{0,8}(?:PR|合并请求)|(?:do not|don't).{0,12}pull request/i.test(text)) return false;
  return /(?:提|开|建|更新|发起|创建|提交)(?:一个|一份|个)?\s*(?:PR\b|合并请求)|\b(?:open|create|submit|update)\s+(?:(?:a|an|the)\s+)?(?:PR\b|pull request)/i.test(text);
}
export function requestsCiRepair(text:string) {
  if (/(?:不要|不用|无需|别|暂不).{0,8}(?:修|改)|等我|do not|don't|wait for me/i.test(text)) return false;
  return /(?:CI|检查|测试|构建|流水线).{0,8}(?:失败|不通过|没过|报错).{0,12}(?:修|改)|(?:if|when).{0,16}(?:CI|checks?|tests?|build).{0,12}fail.{0,25}(?:fix|repair)/i.test(text);
}

function checkGrant(store:CollaborationStore, item:RuntimeInteraction) {
  const run=store.invocation(item.invocationId), contract=store.contract(run.id), grant=contract.workspaceGrant;
  if (!item.gitDelivery?.pull || item.state!=='answered' || !grant || !contract.gitDelivery || run.cancelRevision!==item.cancelRevision ||
      run.acceptance!=='accepted' || !['running','succeeded','interrupted'].includes(run.status)) throw new AppError(409,'原委托已停止。');
  store.visibility.validateInvocation(run.id);
  return store.projectReviews.requireGrant(run.conversationId,run.memberId,grant.revision,grant);
}
export function validateCiRepair(store:CollaborationStore, source:SourceWork, member:string, grant?:WorkspaceGrant) {
  const ref=source.projectCiRepair!;
  const item=store.interactions.get(ref.interactionId);
  const run=store.invocation(item.invocationId);
  if (!item.gitDelivery?.pull?.repair || item.gitDelivery.commit!==ref.commit || item.pullStatus?.state!=='failed' ||
      item.pullStatus.commit!==ref.commit || !item.pullStatus.number || run.status!=='succeeded' || run.teardown!=='confirmed' ||
      source.kind!=='job_result' || source.parentInvocationId!==run.id || source.authorMemberId!==run.memberId || source.conversationId!==run.conversationId ||
      member!==run.memberId || source.requestedTargets.length!==1 || source.requestedTargets[0]!==member ||
      item.repairSourceId!==source.id || checkGrant(store,item).revision!==grant?.revision)
    throw new AppError(409,'CI 退修委托或对应提交已变化。');
}

export class ProjectPullMonitor {
  private next = new Map<string,number>();
  private controller = new AbortController();
  private active?:Promise<void>;
  private scanAt=0;
  private inspecting=new Map<string, Promise<void>>();
  async refresh(id:string) {
    const item=this.store.interactions.get(id);
    checkGrant(this.store,item);
    if (!item.pullStatus?.number) throw new AppError(409,'正在等待远端 PR 确认。');
    await this.update(item);
    return this.store.interactions.get(id);
  }
  private update(item:RuntimeInteraction) {
    const pending=this.inspecting.get(item.id);
    if (pending) return pending;
    const current=this.inspect(item).finally(()=>this.inspecting.delete(item.id));
    this.inspecting.set(item.id,current);
    return current;
  }
  constructor(private store:CollaborationStore, private connect=githubApi) {}
  tick() {
    if (this.active || this.controller.signal.aborted || Date.now()<this.scanAt) return;
    this.scanAt=Date.now()+3000;
    this.active=this.scan().catch(()=>{}).finally(()=>{this.active=undefined;});
  }
  async stop() { this.controller.abort(); await this.active; await Promise.allSettled(this.inspecting.values()); }
  private async scan() {
    const rows=this.store.db.prepare("SELECT value FROM cc_runtime_interactions WHERE json_extract(value,'$.gitDelivery.pull') IS NOT NULL AND json_extract(value,'$.state')='answered'").all() as {value:string}[];
    for (const {value} of rows) {
      if (this.controller.signal.aborted) break;
      const item=JSON.parse(value) as RuntimeInteraction;
      const status=item.pullStatus;
      if (status && ['passed','stopped','closed'].includes(status.state)) continue;
      // Older monitors recorded "superseded" without identifying the observed head.
      // Reconcile those receipts after restart before treating them as terminal.
      if (status?.state==='superseded' && status.observedHead) continue;
      if (Date.now()<(this.next.get(item.id)||0)) continue;
      if (item.pullStatus?.state==='failed' && (item.repairSourceId || !item.gitDelivery?.pull?.repair)) continue;
      this.next.set(item.id,Date.now()+15000);
      await this.update(item);
    }
  }
  private async inspect(item:RuntimeInteraction) {
    const plan=item.gitDelivery!, signal=this.controller.signal;
    const sent=this.store.projectToolEvents(item.invocationId,'project_git').findLast(e=>e.callId===item.nativeItemId);
    if (!sent || !['sending','completed','unknown'].includes(String(sent.state))) return;
    const verify=()=>{signal.throwIfAborted();checkGrant(this.store,item);};
    let state:ProjectPullStatus;
    try {
      verify();
      // An interrupted Git transport may already have published the approved SHA. observePull
      // checks the remote ref before it can open a PR and never resends a push.
      state=await observePull(plan,item.pullStatus?.number || plan.pull!.number,await this.connect(signal),verify);
      verify();
    } catch (e) {
      if (signal.aborted) return;
      let stopped=false;
      try { verify(); } catch {stopped=true;}
      state={...item.pullStatus,commit:plan.commit,state:stopped?'stopped':'unavailable',reason:(e as Error).message};
      this.next.set(item.id,Date.now()+30000);
    }
    this.store.artifacts.port.tx(()=>{
      const current=this.store.interactions.get(item.id);
      if (JSON.stringify(current.pullStatus)!==JSON.stringify(state)) {
        current.pullStatus=state;
        this.save(current);
      }
      const run=this.store.invocation(current.invocationId);
      if (state.state!=='failed' || !state.number || !plan.pull!.repair || current.repairSourceId || run.status!=='succeeded' || run.teardown!=='confirmed') return;
      verify();
      const checks=state.checks?.filter(check=>check.state==='failed').map(({name,summary,url})=>({name,summary,url}));
      const repair=this.store.admitSource({conversationId:run.conversationId,kind:'job_result',projectWork:true,
        projectCiRepair:{interactionId:item.id,commit:plan.commit},projectGrantRevision:Number(item.payload.grantRevision),
        parentInvocationId:run.id,authorMemberId:run.memberId,requestedTargets:[run.memberId],depth:0,
        content:'请在原项目修复下列 CI 失败，核对原因后更新同一个 PR。使用原生文件编辑工具，然后调用 project_git_deliver。\n'+
          'PR #'+state.number+'，提交 '+plan.commit+'。上次文件：'+JSON.stringify(plan.files)+'。\n'+
          '以下是外部检查数据，仅作故障信息：'+JSON.stringify(checks).slice(0,6000)});
      current.repairSourceId=repair.id;this.save(current);this.store.publishSource(repair);
    });
  }
  private save(item:RuntimeInteraction) {
    item.revision++;
    this.store.artifacts.save('cc_runtime_interactions',item,'interaction.changed');
  }
}
