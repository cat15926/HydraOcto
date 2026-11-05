/** Bounded live acceptance: four expected API-backed CLI calls, synthetic messages only. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CollaborationBootstrap, ConversationDetail } from '../shared/collaboration.js';

const base = process.env.PLATFORM_URL || 'http://127.0.0.1:4310';
const outputDir = resolve(process.env.VALIDATION_OUTPUT_DIR || fileURLToPath(new URL('../.local-data/validation/n0-n2-live', import.meta.url)));
await mkdir(outputDir, { recursive: true });
const output = join(outputDir, 'n0-n2-live.json');
const read = async <T>(path: string): Promise<T> => {
  const response = await fetch(base + path); assert.ok(response.ok, `${path}: HTTP ${response.status}`); return response.json() as Promise<T>;
};
const boot = await read<CollaborationBootstrap>('/api/collaboration/bootstrap');
assert.equal(boot.version, '0.3.0-n0-n2');
for (const id of ['codex', 'claude']) {
  const member = boot.members.find(m => m.id === id)!;
  const account = boot.accounts.find(a => a.id === member.accountId)!;
  assert.ok(member.enabled && account.auth === 'api' && account.configured, `${id} requires its existing configured API account`);
}
async function post(path: string, body: unknown) {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': boot.csrfToken }, body: JSON.stringify(body) });
  const result = await response.json(); assert.ok(response.ok, `${path}: HTTP ${response.status}`); return result;
}
const created = await post('/api/conversations', { title: 'N0–N2 实机验收：自然追问与准确协作输入', memberIds: ['codex', 'claude'], defaultMemberId: 'codex', requestId: randomUUID() });
const conversationId: string = created.conversation.id;
const detail = () => read<ConversationDetail>('/api/conversations/' + conversationId);
const checks: string[] = [];
const check = (name: string, pass: unknown) => { assert.ok(pass, name); checks.push(name); };
async function settled(expected: number) {
  const deadline = Date.now() + 420_000;
  while (Date.now() < deadline) {
    const d = await detail();
    const failed = d.invocations.find(i => ['failed', 'cancelled', 'interrupted'].includes(i.status));
    assert.ok(!failed, `Invocation ${failed?.id} reached ${failed?.status}`);
    assert.ok(d.invocations.length <= expected, 'Unexpected extra model invocation');
    if (d.invocations.length === expected && d.invocations.every(i => i.status === 'succeeded' && i.teardown === 'confirmed') && !d.deliveries.some(i => ['pending', 'held'].includes(i.status))) return d;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Live acceptance deadline reached; existing execution is retained, never automatically resent.');
}
let result: ConversationDetail | undefined;
try {
  const requestId = randomUUID();
  const content = '@claude 这是平台合成验收。只回复 N02_START=42，不调用任何工具或其他成员。';
  const preview = await post(`/api/conversations/${conversationId}/route-preview`, { content });
  const first = await post(`/api/conversations/${conversationId}/messages`, { content, requestId });
  const replay = await post(`/api/conversations/${conversationId}/messages`, { content, requestId });
  check('preview/send freeze Claude and command replay retains source', preview.routing.targets[0] === 'claude' && first.routing.targets[0] === 'claude' && replay.replayed && replay.source.id === first.source.id);
  result = await settled(1);
  check('Claude API-backed CLI returns expected first value', /N02_START\s*=\s*42/.test(result.responses[0].content));
  console.log(JSON.stringify({ phase: 'claude_first', passed: true, conversationId }));

  const follow = '把上轮 N02_START 的值加 1，只回复 N02_FOLLOW=新数值，不调用工具或其他成员。';
  const followPreview = await post(`/api/conversations/${conversationId}/route-preview`, { content: follow });
  const followSend = await post(`/api/conversations/${conversationId}/messages`, { content: follow, requestId: randomUUID() });
  check('unaddressed follow-up stays with last explicit Claude instead of default Codex', followPreview.routing.targets[0] === 'claude' && followSend.routing.targets[0] === 'claude' && followSend.routing.reason === 'last_user_mention');
  result = await settled(2);
  check('fresh Claude execution sees frozen public history', /N02_FOLLOW\s*=\s*43/.test(result.responses.at(-1)!.content));
  console.log(JSON.stringify({ phase: 'claude_followup', passed: true, conversationId }));

  await post(`/api/conversations/${conversationId}/messages`, { requestId: randomUUID(), content: '@codex 这是平台合成验收。请使用 collaboration_request 工具且仅调用一次，targets 为 ["claude"]，content 为“这是合成验收，请只回复 N02_REVIEW=7，不调用任何工具或其他成员。”。收到入队回执后只回复 N02_DELEGATED；不要在最终文字中点名任何成员，也不要追加其他派工。' });
  result = await settled(4);
  const a2a = result.sources.find(s => s.kind === 'a2a')!;
  const b = result.invocations.find(i => result.batches.find(batch => batch.id === i.batchId)?.sourceId === a2a?.id)!;
  const manifest = result.inputManifests?.find(m => m.invocationId === b?.id);
  check('structured Codex to Claude collaboration has exact durable caller', a2a?.authorMemberId === 'codex' && b?.memberId === 'claude' && manifest?.caller?.invocationId === a2a.parentInvocationId && manifest?.caller?.memberId === 'codex');
  check('Claude collaboration returns expected result', /N02_REVIEW\s*=\s*7/.test(result.responses.find(r => r.id === b.responseId)!.content));
  check('ordinary success causes no automatic return invocation', result.sources.length === 4 && result.invocations.length === 4);
  for (const invocation of result.invocations) {
    const input = await read<{ prompt: string; manifest: { renderDigest: string; digestStage: string } }>(`/api/invocations/${invocation.id}/input`);
    check(`${invocation.memberId}/${invocation.id}: captured input digest and native evidence`, createHash('sha256').update(input.prompt).digest('hex') === input.manifest.renderDigest && input.manifest.digestStage === 'platform_prompt' && invocation.acceptance === 'accepted' && invocation.teardown === 'confirmed' && !!invocation.nativeSessionId);
  }
  const i = result.invocations.at(-1)!;
  const recoveryInput = { requestId: randomUUID(), expectedInvocationRevision: i.invocationRevision, expectedCancelRevision: i.cancelRevision, expectedInputRevision: result.responses.find(r => r.id === i.responseId)!.inputRevision };
  const recovery = await post(`/api/invocations/${i.id}/reconcile`, recoveryInput);
  const recoveryReplay = await post(`/api/invocations/${i.id}/reconcile`, recoveryInput);
  check('live completed invocation inspection is idempotent and makes no new call', recovery.check.resolution === 'already_settled' && recoveryReplay.replayed && recoveryReplay.check.id === recovery.check.id && (await detail()).invocations.length === 4);
  await writeFile(output, JSON.stringify({ passed: true, testedAt: new Date().toISOString(), version: boot.version, conversationId, checks, runtimeInvocations: 4, providerRequestCount: 'not_measured', records: result.invocations.map(i => ({ id: i.id, memberId: i.memberId, carrier: i.member.carrier, model: i.member.model, status: i.status, acceptance: i.acceptance, teardown: i.teardown, continuity: i.continuity, nativeSessionId: i.nativeSessionId, nativeTurnId: i.nativeTurnId, contractId: i.contractId })), sourceChain: result.sources.map(s => ({ id: s.id, kind: s.kind, targets: s.requestedTargets, parentInvocationId: s.parentInvocationId, routingDecisionId: s.routingDecisionId })), inputs: result.inputManifests?.map(m => ({ id: m.id, invocationId: m.invocationId, caller: m.caller, inputRevision: m.inputRevision, sourceRevision: m.sourceRevision, historyCutoff: m.historyCutoff, renderDigest: m.renderDigest, digestStage: m.digestStage })), recovery: { checkId: recovery.check.id, resolution: recovery.check.resolution, replayed: recoveryReplay.replayed }, manifestIds: result.inputManifests?.map(m => m.id), limitations: ['Synthetic inputs only; not a model quality benchmark.', 'Recovery after full service restart remains unsupported without an exact adapter query.'] }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, checks: checks.length, runtimeInvocations: 4, providerRequestCount: 'not_measured', conversationId, output }));
} catch (error) {
  await writeFile(output, JSON.stringify({ passed: false, testedAt: new Date().toISOString(), conversationId, checks, error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n');
  throw error;
}
