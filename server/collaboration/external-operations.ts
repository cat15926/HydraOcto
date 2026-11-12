import type {ExternalScope, ExternalTarget} from '../../shared/obligations.js';

export type ExternalActor = Omit<ExternalScope,'targets'>;
export interface ExternalReceipt {operationId:string; targetId:string; receipt:string}

/** Trusted domain adapter. Target IDs identify immutable actions and objects; both operations
 * are scoped to the original room member. Neither entry point may schedule platform work. */
export function externalTargets(adapter:ExternalOperationAdapter,actor:ExternalActor):ExternalTarget[] {
  try {
    const targets=adapter.targets({conversationId:actor.conversationId,memberId:actor.memberId,instanceId:actor.instanceId});
    if(!Array.isArray(targets) || targets.length>32 || new Set(targets.map(t=>t.id)).size!==targets.length) return [];
    if(targets.some(t=>typeof t.id!=='string' || !t.id.trim() || t.id.length>128 ||
      typeof t.title!=='string' || !t.title.trim() || t.title.length>160)) return [];
    return targets.map(({id,title})=>({id,title}));
  } catch { return []; }
}
export interface ExternalOperationAdapter {
  targets(actor:ExternalActor):ExternalTarget[];
  issue(actor:ExternalActor,target:ExternalTarget,operationId:string):Promise<ExternalReceipt|undefined>;
  lookup(actor:ExternalActor,target:ExternalTarget,operationId:string):Promise<ExternalReceipt|undefined>;
}
