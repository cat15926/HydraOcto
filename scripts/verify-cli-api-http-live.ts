/** Live acceptance against the configured local workbench. Leaves a reviewable conversation. */
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { CollaborationBootstrap, ConversationDetail } from '../shared/collaboration.js';
const outputDir = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/cli-api-http-live');
const base = 'http://127.0.0.1:4310';
const boot = await (await fetch(base + '/api/collaboration/bootstrap')).json() as CollaborationBootstrap;
const post = async (path: string, body: unknown) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': boot.csrfToken }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Local acceptance command failed (${response.status}).`);
  return response.json() as Promise<any>;
};
for (const memberId of ['codex', 'claude']) {
  const member = boot.members.find(m => m.id === memberId)!;
  const account = boot.accounts.find(a => a.id === member.accountId)!;
  assert.equal(account.auth, 'api'); assert.equal(account.configured, true);
  assert.equal(member.carrier, memberId === 'codex' ? 'codex-app-server' : 'claude-cli');
}
const nonce = randomUUID();
const fixture = `cli-api-acceptance-${nonce}.txt`;
assert.equal(resolve(boot.workspace), resolve('.local-data/workspace'), 'Only write the managed platform test workspace.');
await writeFile(resolve(boot.workspace, fixture), '实机验收材料：项目代号 ORBIT-37，单价7、数量3、总价21。仅用于API认证CLI协作验证。\n', { flag: 'wx' });
const created = await post('/api/conversations', { title: 'API 密钥 · 双 CLI 实机验收', memberIds: ['codex', 'claude'], defaultMemberId: 'codex', requestId: `cli-api-http-${nonce}` });
const conversationId = created.conversation.id as string;
let passed = false; let error: string | undefined;
const read = async () => (await (await fetch(`${base}/api/conversations/${conversationId}`)).json()) as ConversationDetail;
async function wait(expected: number) {
  const deadline = Date.now() + 420_000;
  while (Date.now() < deadline) {
    const d = await read();
    if (d.invocations.length && !d.invocations.some(i => ['prepared', 'running', 'cancel_requested'].includes(i.status)) && !d.deliveries.some(t => t.status === 'pending')) {
      assert.equal(d.invocations.length, expected);
      assert.ok(d.invocations.every(i => i.status === 'succeeded' && i.acceptance === 'accepted' && i.teardown === 'confirmed'));
      return d;
    }
    await new Promise(done => setTimeout(done, 300));
  }
  throw new Error('Live workbench acceptance timed out; no automatic retry was performed.');
}
try {
  const message = { requestId: `message-${nonce}`, content: `这是一项合成验收。请用workspace_read读取 ${fixture}，然后调用一次collaboration_request，targets=["claude"]，content="请用workspace_read读取 ${fixture}，复核ORBIT-37的总价，回复项目代号和核对结果。不要请求其他成员。"。成功排队后简短告知并结束，不用最终@文字重复交接。` };
  const sent = await post(`/api/conversations/${conversationId}/messages`, message);
  const d = await wait(2);
  assert.deepEqual(d.invocations.map(i => i.memberId), ['codex', 'claude']);
  assert.ok(['codex', 'claude'].every(id => d.evidence.some(e => e.kind === 'tool' && e.detail.name === 'workspace_read' && e.detail.state === 'completed' && d.invocations.find(i => i.id === e.invocationId)?.memberId === id)));
  const replay = await post(`/api/conversations/${conversationId}/messages`, message); assert.equal(replay.source.id, sent.source.id);
  await post(`/api/conversations/${conversationId}/messages`, { requestId: `followup-${nonce}`, content: '根据既有会话中的复核结果，只给出项目代号和总价，不调用工具，不请求成员。' });
  const done = await wait(3);
  assert.match(done.responses.at(-1)!.content, /ORBIT-37/); assert.match(done.responses.at(-1)!.content, /21/);
  passed = true;
} catch (cause) { error = cause instanceof Error ? cause.message : 'Live HTTP acceptance failed'; process.exitCode = 1; }
finally {
  const detail = await read();
  const report = { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()), version: boot.version, passed, error, conversationId, title: detail.conversation.title, syntheticInputOnly: true, realNativeCarriers: true, detail };
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, 'cli-api-http-live.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed, error, conversationId, title: detail.conversation.title, invocations: detail.invocations.map(i => ({ memberId: i.memberId, carrier: i.member.carrier, model: i.member.model, status: i.status, acceptance: i.acceptance, teardown: i.teardown })) }, null, 2));
}
