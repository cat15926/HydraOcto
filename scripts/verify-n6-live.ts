/** Three bounded real CLI/API calls in an isolated database and synthetic workspace. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { CollaborationEngine } from '../server/collaboration/engine.js';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';
import type { CollaborationBootstrap, CollaborationRuntime } from '../shared/collaboration.js';
const output = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/n6-live/' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(join(output, 'workspace'), { recursive: true }); const workspace = await realpath(join(output, 'workspace'));
const boot = await (await fetch((process.env.PLATFORM_URL || 'http://127.0.0.1:4310') + '/api/collaboration/bootstrap')).json() as CollaborationBootstrap;
const owner = new Store(join(output, 'acceptance.sqlite')), store = new CollaborationStore(owner, { workspace, artifactDir: join(output, 'objects') });
for (const id of ['codex', 'claude']) {
  const m = boot.members.find(m => m.id === id)!, a = boot.accounts.find(a => a.id === m.accountId)!;
  assert.ok(m.enabled && m.model && a.auth === 'api' && a.configured && a.apiKeyEnv && process.env[a.apiKeyEnv], 'Existing configured API account required: ' + id);
  store.saveAccount(a); store.saveMember(m);
}
const native = createCollaborationRuntime({ timeoutMs: 240000 }); let calls = 0;
const tools: { memberId: string; invocationId: string; name: string }[] = [];
const waiting = new Map<string, () => void>();
const runtime: CollaborationRuntime = { ...native, invoke: async r => {
  assert.ok(++calls <= 3, 'Three real calls maximum');
  return native.invoke({ ...r, onToolCall: async (name, args, callId) => { tools.push({ memberId: r.member.id, invocationId: r.invocationId, name }); console.log(JSON.stringify({ member: r.member.id, tool: name })); if (name === 'conversation_pending') await new Promise<void>(resolve => { waiting.set(r.member.id, resolve); r.signal.addEventListener('abort', () => resolve(), { once: true }); }); return r.onToolCall(name, args, callId); } });
} };
const engine = new CollaborationEngine(store, runtime, { workspace });
const c = store.create({ title: 'N6 exact live append and queued fallback', memberIds: ['codex', 'claude'], defaultMemberId: 'codex', requestId: randomUUID() }).conversation;
const checks: string[] = [], check = (label: string, ok: unknown) => { assert.ok(ok, label); checks.push(label); };
const until = async (predicate: () => boolean) => { const end = Date.now() + 245000; while (!predicate()) { const failed = store.invocations(c.id).find(i => ['failed', 'interrupted', 'cancelled'].includes(i.status)); assert.ok(!failed, 'Native failure: ' + failed?.error); if (Date.now() > end) throw new Error('N6 live timeout'); await new Promise(r => setTimeout(r, 300)); } };
const send = (content: string) => { const source = store.send(c.id, { requestId: randomUUID(), content }).source; engine.kick(); return source; };
const question = (member: string) => '@' + member + ' 有界实机验收：首先只调用一次 conversation_pending，参数为空对象。工具返回后立即完成简短回复。不要读取目录中的待办，不再调用其他工具，不要在最终文字 @成员。若本轮收到新增用户信息，最终回复必须包括新增信息中的标记；没有新增信息就仅回复 READY。';
let passed = false, error: string | undefined;
try {
  send(question('codex')); engine.start();
  await until(() => waiting.has('codex'));
  const initial = store.invocations(c.id)[0]!, token = 'N6_CODEX_' + randomUUID();
  const added = send('@codex 请在当前轮最终回复中输出标记 ' + token + '。不再调用工具。');
  await until(() => store.cooperation.handoffs(c.id).some(h => h.sourceId === added.id && ['accepted', 'read'].includes(h.state)));
  const h = store.cooperation.handoffs(c.id).find(h => h.sourceId === added.id)!;
  check('real Codex turn/steer accepted exact active native turn', h.invocationId === initial.id && h.nativeTurnId === initial.nativeTurnId && !h.requiresCompletion);
  waiting.get('codex')!(); waiting.delete('codex');
  await until(() => store.invocation(initial.id).status === 'succeeded');
  check('Codex final response incorporated added marker', store.response(initial.responseId).content.includes(token));
  check('append consumed by original response without a second invocation', store.response(initial.responseId).inputSourceIds.includes(added.id) && store.invocations(c.id).length === 1);
  check('exact native userMessage read evidence observed', store.cooperation.handoffs(c.id)[0]!.state === 'read');
  send(question('claude'));
  await until(() => waiting.has('claude'));
  const claude = store.invocations(c.id).find(i => i.memberId === 'claude')!, nextToken = 'N6_CLAUDE_' + randomUUID();
  const queued = send('@claude 这是下一条独立消息，请只回复 ' + nextToken + '，不调用工具，不提及其他成员。');
  const d = store.detail(c.id).deliveries.find(d => d.sourceId === queued.id)!;
  check('Claude unsupported append falls back to pending next turn', d.status === 'pending' && d.continuation?.fallback && d.continuation.invocationId === claude.id && store.cooperation.handoffs(c.id).length === 1);
  waiting.get('claude')!(); waiting.delete('claude');
  await until(() => store.invocations(c.id).length === 3 && store.invocations(c.id).every(i => i.status === 'succeeded'));
  const final = store.invocations(c.id).at(-1)!;
  check('queued Claude source executed exactly once after original exited', final.memberId === 'claude' && final.id !== claude.id && store.response(final.responseId).inputSourceIds.includes(queued.id) && store.response(final.responseId).content.includes(nextToken));
  check('all three actual calls have acceptance and confirmed exit', calls === 3 && store.invocations(c.id).every(i => i.acceptance === 'accepted' && i.teardown === 'confirmed'));
  check('no implicit A2A, group or task side effects', store.detail(c.id).sources.every(s => s.kind === 'user') && store.tasks.list(c.id).length === 0);
  passed = true;
} catch (e) { error = e instanceof Error ? e.message : 'Native validation failed'; }
finally {
  for (const release of waiting.values()) release();
  await engine.stop(); await writeFile(join(output, 'result.json'), JSON.stringify({ passed, error, testedAt: new Date().toISOString(), runtime: 'real CLI with existing API accounts', maximumNativeCalls: 3, calls, checks, tools, detail: store.detail(c.id) }, null, 2)); owner.close();
  console.log(JSON.stringify({ passed, error, calls, checks: checks.length, output }));
}
if (!passed) process.exitCode = 1;
