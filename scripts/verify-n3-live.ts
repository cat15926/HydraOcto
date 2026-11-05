/** Four bounded API-backed CLI invocations, synthetic private markers and isolated SQLite. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { CollaborationEngine } from '../server/collaboration/engine.js';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';
import type { CollaborationBootstrap, ConversationDetail } from '../shared/collaboration.js';

const base = process.env.PLATFORM_URL || 'http://127.0.0.1:4310';
const output = resolve(process.env.VALIDATION_OUTPUT_DIR || `.local-data/validation/n3-live/${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(join(output, 'workspace'), { recursive: true });
const workspace = await realpath(join(output, 'workspace'));
const response = await fetch(`${base}/api/collaboration/bootstrap`); assert.ok(response.ok);
const boot = await response.json() as CollaborationBootstrap;
const members = ['codex', 'claude'].map(id => {
  const m = boot.members.find(m => m.id === id)!;
  const a = boot.accounts.find(a => a.id === m?.accountId)!;
  assert.ok(m?.enabled && m.model && a?.auth === 'api' && a.configured && a.apiKeyEnv && process.env[a.apiKeyEnv]?.trim(), `${id}: existing API account must be configured`);
  return { member: m, account: a };
});
let owner: Store | undefined, store: CollaborationStore, engine: CollaborationEngine | undefined;
const open = () => {
  owner = new Store(join(output, 'acceptance.sqlite')); store = new CollaborationStore(owner, { workspace });
  engine = new CollaborationEngine(store, createCollaborationRuntime({ timeoutMs: 240_000 }), { workspace });
};
open();
for (const { member, account } of members) { store!.saveAccount(account); store!.saveMember(member); }
const conversation = store!.create({ title: 'N3 isolated native recall acceptance', memberIds: members.map(m => m.member.id), defaultMemberId: 'codex', requestId: randomUUID() }).conversation;
const checks: string[] = [], markers = new Map<string, string>();
const check = (label: string, ok: unknown) => { assert.ok(ok, label); checks.push(label); };
const snapshot = () => store.detail(conversation.id);
async function settled(expected: number) {
  const end = Date.now() + 300_000;
  while (Date.now() < end) {
    const d = snapshot(); checkCount(d, expected);
    const failed = d.invocations.find(i => ['failed', 'cancelled', 'interrupted'].includes(i.status));
    assert.ok(!failed, `Invocation ended ${failed?.status}: ${failed?.error}`);
    if (d.invocations.length === expected && d.invocations.every(i => i.status === 'succeeded' && i.teardown === 'confirmed')) return d;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Live timeout; existing execution is retained and not resent.');
}
function checkCount(d: ConversationDetail, expected: number) { assert.ok(d.invocations.length <= expected, 'Unexpected extra native invocation'); }
let count = 0;
try {
  engine!.start();
  for (const { member } of members) {
    const marker = `N3_${randomBytes(12).toString('hex')}`; markers.set(member.id, marker);
    await writeFile(join(workspace, `${member.id}-marker.txt`), marker);
    store.send(conversation.id, { requestId: randomUUID(), content: `@${member.id} 这是合成原生记忆验收。只用 workspace_read 工具读取 ${member.id}-marker.txt，把文件内完整随机标记记在你自己的原生上下文。不要在公共回复中泄露或重述标记，不请求其他成员，不写文件。最终只回复 N3_STORED。` }); engine!.kick();
    const d = await settled(++count), i = d.invocations.at(-1)!;
    check(`${member.id}: first native execution is fresh and accepted`, i.continuity === 'fresh' && i.acceptance === 'accepted');
    check(`${member.id}: private workspace tool was actually read`, d.evidence.some(e => e.invocationId === i.id && e.kind === 'tool' && e.detail.name === 'workspace_read' && e.detail.state === 'completed'));
    check(`${member.id}: marker absent from platform prompt and public response`, !store.prompt(i.id).includes(marker) && !d.responses.find(r => r.id === i.responseId)!.content.includes(marker));
    check(`${member.id}: exact native history anchor makes binding ready`, d.nativeSessions?.find(s => s.lastInvocationId === i.id)?.status === 'ready');
    console.log(JSON.stringify({ phase: 'stored', member: member.id, continuity: i.continuity, nativeSessionId: i.nativeSessionId }));
  }
  await engine!.stop(); owner!.close(); engine = undefined; owner = undefined;
  for (const id of markers.keys()) await rm(join(workspace, `${id}-marker.txt`));
  // A fresh Store and fresh adapters exercise persistence, not an in-process session cache.
  open(); engine!.start();
  for (const { member } of members) {
    const previous = snapshot().invocations.find(i => i.memberId === member.id)!;
    store.send(conversation.id, { requestId: randomUUID(), content: `@${member.id} 继续合成原生记忆验收。不要调用任何工具或请求其他成员。回忆你上一轮亲自从 ${member.id}-marker.txt 读取、但没有公开的完整随机标记。只回复 N3_RECALL=后接该完整标记。不要从其他成员的消息推测。` }); engine!.kick();
    const d = await settled(++count), i = d.invocations.at(-1)!, answer = d.responses.find(r => r.id === i.responseId)!.content;
    check(`${member.id}: after service restart the same native session resumes`, i.continuity === 'resumed' && i.nativeSessionId === previous.nativeSessionId && i.sessionPlan?.mode === 'resume');
    check(`${member.id}: recalls hidden random marker with file removed`, answer.includes(markers.get(member.id)!));
    check(`${member.id}: second input does not contain own private marker`, !store.prompt(i.id).includes(markers.get(member.id)!));
    check(`${member.id}: recall makes no tool calls`, !d.evidence.some(e => e.invocationId === i.id && e.kind === 'tool'));
    check(`${member.id}: current invocation owns new native history proof`, d.evidence.some(e => e.invocationId === i.id && e.kind === 'session' && e.detail.historyVerified === true && e.detail.previousAnchor === i.sessionPlan?.previousAnchor));
    console.log(JSON.stringify({ phase: 'recalled', member: member.id, continuity: i.continuity, nativeSessionId: i.nativeSessionId }));
  }
  const d = snapshot(); check('only four native invocations; no automatic success return', count === 4 && d.invocations.length === 4 && d.sources.length === 4);
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, testedAt: new Date().toISOString(), version: '0.4.0-n3', checks, runtimeInvocations: count, providerRequestCount: 'not_measured', conversationId: conversation.id,
    markerDigests: Object.fromEntries([...markers].map(([id, marker]) => [id, createHash('sha256').update(marker).digest('hex')])), records: d.invocations, sessions: d.nativeSessions,
    evidence: d.evidence.filter(e => ['session', 'session_replaced', 'usage', 'accepted', 'process_exit'].includes(e.kind)), limitations: ['API-authenticated CLI combinations only; official subscription authentication not live tested.', 'Platform prompt is captured; provider internal request count and billing are not measured.', 'Native continuity does not recover an unknown in-flight execution.'] }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, checks: checks.length, runtimeInvocations: count, output }));
} catch (error) {
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: false, testedAt: new Date().toISOString(), checks, conversationId: conversation.id, error: error instanceof Error ? error.message : String(error), records: snapshot().invocations, sessions: snapshot().nativeSessions }, null, 2) + '\n');
  console.error(JSON.stringify({ passed: false, output, error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1;
} finally { await engine?.stop(); owner?.close(); }
