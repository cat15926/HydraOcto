import type { Obligation } from '../../shared/obligations.js';
import type { RuntimeInteraction } from '../../shared/collaboration.js';
import type { CollaborationStore } from './store.js';

// A reserved CI handle inside prose must never fall through to a user-signalled event.
export function referencesCi(condition: string) {
  return condition.startsWith('ci:') || /ci:[a-zA-Z0-9_-]+:[a-fA-F0-9]{40,64}/.test(condition);
}

/** Only observations of a PR previously authorized by this room for this very member instance. */
function reference(store:CollaborationStore,cid:string,member:string,instanceId:string,item:RuntimeInteraction) {
  if(item.conversationId!==cid || item.memberId!==member || item.transport!=='project-git' || item.state!=='answered' || !item.gitDelivery?.pull ||
     item.cancelledByUser || !/^[0-9a-f]{40,64}$/.test(item.gitDelivery.commit)) return;
  const run=store.invocation(item.invocationId), contract=store.contract(run.id), grant=store.workbench.conversation(cid).workspaceGrant;
  if(!grant||grant.revision!==contract.workspaceGrant?.revision || !contract.gitDelivery || contract.visibility ||
     run.cancelRevision!==item.cancelRevision || run.roomMember?.id!==instanceId || !store.roomMembers.isCurrent(run.roomMember))return;
  return 'ci:'+item.id+':'+item.gitDelivery.commit;
}
export function ciTargets(store:CollaborationStore,invocationId:string) {
  const run=store.invocation(invocationId), instance=run.roomMember;
  if(!instance||!store.contract(invocationId).obligationPolicy)return [];
  return store.interactions.list(run.conversationId).flatMap(item=>{
    const condition=reference(store,run.conversationId,run.memberId,instance.id,item);
    return condition?[{condition,pr:item.pullStatus?.number,commit:item.gitDelivery!.commit,state:item.pullStatus?.state??'waiting'}]:[];
  }).slice(-12);
}
export function observedCi(store:CollaborationStore,root:Obligation) {
  const condition=root.wait?.condition??'';
  const match=/^ci:([a-zA-Z0-9_-]+):([a-f0-9]{40,64})$/.exec(condition);
  if(!match||root.state!=='waiting')return;
  const item=store.interactions.list(root.conversationId).find(i=>i.id===match[1]);
  if(!item||reference(store,root.conversationId,root.owner.memberId,root.owner.instanceId,item)!==condition)return;
  const state=item.pullStatus;
  if(!state?.number||state.commit!==match[2] || (state.state!=='passed'&&state.state!=='failed') || !state.checks?.some(check=>check.state===state.state))return;
  return {requestId:'ci:'+item.id+':'+state.commit+':'+state.state, summary:'GitHub PR #'+state.number+'，提交 '+state.commit+'：CI '+(state.state==='passed'?'通过':'失败')+'。'};
}
