import { createHash } from 'node:crypto';
import type { ExecutionContractSnapshot, NativeSessionIdentity, RuntimeUsage } from '../../shared/collaboration.js';
import { canonical } from '../store.js';

export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function sessionFingerprint(contract: ExecutionContractSnapshot, identity: NativeSessionIdentity): string {
  const m = contract.memberSnapshot, a = contract.accountMetadataSnapshot;
  return digest({ carrier: m.carrier, account: a, model: m.model, effort: m.effort, instructions: m.instructions,
    ...(contract.visibilityEpoch !== undefined ? { visibility: contract.visibility, visibilityEpoch: contract.visibilityEpoch } : {}),
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
