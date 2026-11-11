import type { CollaborationStore } from './store.js';
import type { ExecutionContractSnapshot, MemberContextMode, MemberContextSnapshot, RuntimeMemberContextMode, RoomMemberInstance, SourceWork } from '../../shared/collaboration.js';
import { AppError, canonical } from '../store.js';

const text = {type:'string', minLength:1};
const read = {name:'member_context_read', description:'Read the work record frozen for this room member and this action.', inputSchema:{type:'object',properties:{},additionalProperties:false}};
const write = {name:'member_note_write', description:'Save a short personal working note in this private conversation. Supply source factor IDs from your current work record when referring to evidence.',inputSchema:{type:'object',properties:{content:{...text,maxLength:2000},parentIds:{type:'array',items:text,maxItems:16}},required:['content'],additionalProperties:false}};

const select = {
  name: 'member_expression_select',
  description: 'Choose the approved public wording that matches your independent assessment. Use the observation ID and a 1-based option number from your private record.',
  inputSchema: {type:'object', properties:{observationId:text, choice:{type:'integer',minimum:1,maximum:8}}, required:['observationId','choice'],additionalProperties:false},
};

export function runtimeMemberContextMode(state?: MemberContextSnapshot): RuntimeMemberContextMode|undefined {
  return state?.mode === 'public' && state.factors.length > 0 ? 'writing' : state?.mode;
}

export function requiresFreshMemberContext(state?: MemberContextSnapshot) {
  const mode = runtimeMemberContextMode(state);
  return mode === 'private' || mode === 'writing';
}

export function memberContextTools(mode?: RuntimeMemberContextMode) {
  return mode === 'private' ? [read, write, select] : mode ? [read] : [];
}

export function memberContextToolAllowed(mode: RuntimeMemberContextMode|undefined, name:string) {
  if (mode === 'private' || mode === 'writing' || name === read.name || name === write.name || name === select.name) {
    return memberContextTools(mode).some(t => t.name === name);
  }
  return true;
}

function materials(store:CollaborationStore, member:RoomMemberInstance, mode:MemberContextMode, cutoff:number) {
  return store.factors.snapshot(member.conversationId,member,mode,cutoff)
    .map(({id, version, kind, content, parentIds, sourceRef, issuer, expressionOptions}) => ({
      id, version, kind, content, parentIds, sourceRef, issuer, ...(expressionOptions && {expressionOptions}),
    }));
}

export function freezeMemberContext(store:CollaborationStore, member:RoomMemberInstance|undefined, source:SourceWork, cutoff?:number): MemberContextSnapshot|undefined {
  if (!member || !member.active || member.conversationId!==source.conversationId || !Number.isSafeInteger(cutoff) ||
      source.memberContextPolicy!=='member-context-v1' || source.projectWork || source.projectReview || source.projectRepair ||
      source.projectCiRepair || source.crossRef || source.actionRef || source.excerptRefs?.length) return;
  const scope = source.visibility;
  const mode = scope?.kind==='private' && !scope.revealedAt ? 'private' : 'public';
  if (mode==='private' && (scope!.memberIds.length!==1 || scope!.memberIds[0]!==member.memberId)) return;
  const factors = materials(store,member,mode,cutoff!);
  if (mode==='private' && factors.length===0) return;
  const obligations = store.obligations.list(member.conversationId)
    .filter(o => o.owner.instanceId===member.id && o.owner.generation===member.generation && o.state!=='cancelled' && o.state!=='delivered')
    .map(o => ({id:o.id,revision:o.revision,goal:o.goal,state:o.state,...(o.wait && o.state==='waiting' && {wait:o.wait.condition})}));
  if (factors.length === 0 && obligations.length === 0) return;
  return {mode,instanceId:member.id,generation:member.generation,cutoff:cutoff!,factors,obligations};
}

/** The public speaker receives approved wording with no handles into the personal record. */
export function visibleMemberRecord(snapshot: MemberContextSnapshot) {
  const factors = snapshot.mode === 'private' ? snapshot.factors : snapshot.factors.map(({kind, content}) => ({kind, content}));
  return {factors, obligations: snapshot.obligations};
}

export function validateMemberContext(store:CollaborationStore, contract:ExecutionContractSnapshot) {
  const snap=contract.memberContext;
  if (!snap) return;
  const member=contract.roomMember;
  if (!member || member.id!==snap.instanceId || member.generation!==snap.generation || !store.roomMembers.isCurrent(member) ||
      canonical(materials(store,member,snap.mode,snap.cutoff)) !== canonical(snap.factors)) {
    throw new AppError(409,'成员资料的授权已变化，请从当前会话重新开始。','member_context_changed');
  }
}

export function memberContextTool(store:CollaborationStore, invocationId:string, name:string, args:Record<string,unknown>, callId:string) {
  const contract = store.contract(invocationId);
  const state = contract.memberContext;
  const run = store.invocation(invocationId);
  if (!state || !memberContextToolAllowed(runtimeMemberContextMode(state),name) || run.status!=='running' || run.acceptance!=='accepted' || (run.cancelRevision??0)!==0) {
    throw new AppError(403,'当前执行不能读写这份工作记录。');
  }
  store.visibility.validateInvocation(invocationId);
  validateMemberContext(store,contract);
  if (name===read.name && Object.keys(args).length===0) return visibleMemberRecord(state);
  if (name === select.name) {
    const {observationId,choice} = args;
    const observation = state.factors.find(f => f.id === observationId && f.kind === 'observation');
    if (Object.keys(args).length !== 2 || !observation?.expressionOptions || typeof choice !== 'number' ||
        !Number.isSafeInteger(choice) || choice < 1 || choice > observation.expressionOptions.length) {
      throw new AppError(400,'只能从本轮私密材料所列的观点中选择。');
    }
    return store.factors.select(invocationId,{requestId:callId, observationId:observation.id, choice});
  }
  if (name!==write.name || Object.keys(args).some(k=>!['content','parentIds'].includes(k)) || typeof args.content!=='string' ||
      !args.content.trim() || args.content.length>2000 || !callId || callId.length>160) throw new AppError(400,'工作笔记参数无效。');
  const parents=args.parentIds;
  if (parents!==undefined && (!Array.isArray(parents) || parents.length>16 || parents.some(id=>typeof id!=='string' || !state.factors.some(f=>f.id===id)))) {
    throw new AppError(400,'工作笔记只能引用本轮有权使用的材料。');
  }
  return store.factors.note(invocationId,{requestId:callId,content:args.content,...(parents && {parentIds:parents as string[]})});
}
