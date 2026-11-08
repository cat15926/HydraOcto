/** One real Hermes execution in a throwaway platform database. Use only the selected, existing API endpoint. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { CollaborationBootstrap, Member } from '../shared/collaboration.js';
import { createApplication } from '../server/index.js';
const output = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/n10b/live');
await mkdir(output, { recursive: true });
const boot = await (await fetch('http://127.0.0.1:4310/api/collaboration/bootstrap')).json() as CollaborationBootstrap;
const source = boot.members.find(m => m.id === 'codex')!;
const account = boot.accounts.find(a => a.id === source.accountId)!;
assert(account.auth === 'api' && account.provider === 'codex' && account.baseUrl && source.model, '需要既有 Codex 兼容 API 测试账户');
const root = await mkdtemp(join(tmpdir(), 'n10b-live-'));
const workspace = join(root, 'project');
await mkdir(workspace);
const marker = randomUUID(), answer = randomUUID();
await writeFile(join(workspace, 'acceptance.txt'), marker);
const app = await createApplication({ port: 0, dataDir: join(root, 'private'), workspace });
let sent = 0;
try {
  const store = app.collaborationStore;
  const member: Member = { id: 'hermes', name: 'Hermes', carrier: 'hermes-agent', accountId: account.id, model: source.model, enabled: true,
    instructions: '使用平台工具读取用户指定的文件，按要求向用户提问。' };
  store.saveAccount(account); store.saveMember(member);
  const c = store.create({ title: 'Hermes 验收', memberIds: [member.id], defaultMemberId: member.id, requestId: randomUUID() }).conversation;
  const { url } = await app.start();
  async function post(path: string, body: unknown) {
    const r = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': app.csrfToken }, body: JSON.stringify(body) });
    assert(r.ok, '验收命令失败，HTTP ' + r.status);
  }
  sent++;
  await post('/api/conversations/' + c.id + '/messages', { content: '@Hermes 请调用 workspace_read 读取 acceptance.txt，再用 user_question 问我一个问题，问题 ID 为 code、内容为“验收代号？”。我回答后，最终答复只写文件里的标记和我回答的代号。', requestId: randomUUID() });
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const pending = store.detail(c.id).interactions?.find(i => i.state === 'pending');
    if (pending) await post('/api/runtime-interactions/' + pending.id + '/answer', { requestId: randomUUID(), expectedRevision: pending.revision, payloadDigest: pending.payloadDigest, answers: Object.fromEntries(pending.questions!.map(q => [q.id, answer])) });
    if (store.invocations(c.id).some(i => !['running','prepared'].includes(i.status))) break;
    await new Promise(r => setTimeout(r, 200));
  }
  const d = store.detail(c.id), inv = d.invocations[0];
  assert.equal(inv?.status, 'succeeded');
  assert.equal(inv.acceptance, 'accepted'); assert.equal(inv.teardown, 'confirmed');
  assert.equal(d.invocations.length, 1);
  assert(d.interactions?.some(i => i.invocationId === inv.id && i.state === 'answered'));
  assert(d.responses.some(r => r.content.includes(marker) && r.content.includes(answer)));
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, runtime: member.carrier, version: '0.18.2', model: member.model,
    executions: sent, acceptance: inv.acceptance, teardown: inv.teardown, exactFileAndAnswer: true, interactionReturned: true }, null, 2));
  console.log('Hermes real execution passed');
} catch (error) {
  await writeFile(join(output, 'failed.json'), JSON.stringify({ executions: sent, passed: false,
    states: app.collaborationStore.invocations().map(i => ({ status:i.status, acceptance:i.acceptance, teardown:i.teardown })) }, null, 2));
  throw error;
} finally { await app.close(); await rm(root, { recursive: true, force: true }); }
