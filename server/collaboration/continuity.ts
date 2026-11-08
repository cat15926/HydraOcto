import { createHash } from 'node:crypto';
import type { ExecutionContractSnapshot, NativeSessionIdentity, RuntimeUsage } from '../../shared/collaboration.js';
import { canonical } from '../store.js';

export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function sessionFingerprint(contract: ExecutionContractSnapshot, identity: NativeSessionIdentity, imageInvocationId?: string): string {
  const m = contract.memberSnapshot, a = contract.accountMetadataSnapshot;
  return digest({ carrier: m.carrier, account: a, model: m.model, effort: m.effort, instructions: m.instructions,
    ...(imageInvocationId ? { imageInvocationId } : {}),
    ...(contract.visibilityEpoch !== undefined ? { visibility: contract.visibility, visibilityEpoch: contract.visibilityEpoch } : {}),
    ...(contract.workspaceGrant?.mode === 'project-work' ? {
      project: { mode: contract.projectWork ? 'project-work' : 'read-only', revision: contract.workspaceGrant.revision,
        device: contract.workspaceGrant.device, inode: contract.workspaceGrant.inode, binding: contract.workspaceGrant.memberBindings?.[m.id] },
    } : {}),
    ...(contract.projectContinuity ? { projectContinuity:'vm-checkpoint-v1' } : {}),
    ...(contract.projectReview ? {reviewSource:contract.primarySourceId} : {}),
    ...(contract.mayRunProjectNpmTest ? {projectNpmTest:contract.projectNpmChecks ? 2 : 1} : {}),
    ...(contract.webResearch ? {webResearch:true} : {}),
    ...(contract.gitDelivery ? {gitDelivery:true} : {}),
    ...(contract.mayExportProjectFile ? {projectExportTool:true} : {}),
    ...(contract.mayRequestProjectReview ? {projectReviewTool:true} : {}),
    ...(contract.mayProposeProject ? { mayProposeProject: true } : {}),
    workspace: contract.workspaceScope, tools: contract.toolPolicyVersion,
    adapter: contract.adapterCapabilityVersion, runtime: identity.fingerprint });
}
export function nativeUsage(value: Record<string, unknown>): RuntimeUsage | undefined {
  if (typeof value.source !== 'string' || !['invocation', 'last_model_request'].includes(String(value.scope))) return;
  const result: RuntimeUsage = { source: value.source.slice(0, 100), scope: value.scope as RuntimeUsage['scope'] };
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'totalTokens', 'costUsd'] as const) {
    const n = value[key];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0 && (key === 'costUsd' || Number.isSafeInteger(n))) result[key] = n;
  }
  return Object.keys(result).length > 2 ? result : undefined;
}
