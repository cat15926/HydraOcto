/** Explicit live CLI verification with caller-supplied keys. No credentials enter reports. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server/index.js';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';
import { loadSuppliedKeys } from './runtime/key-file.js';
import type { ConversationDetail, Member } from '../shared/collaboration.js';

const outputDir = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/cli-api-live');
const mode = process.argv[2] ?? 'collaboration';
if (!['codex', 'claude', 'collaboration'].includes(mode)) throw new Error('Expected codex, claude, or collaboration.');
const supplied = await loadSuppliedKeys(process.argv[3] ?? '/Users/ruhonglin/lhz/apikey.log');
// Official GET /models maps this supported API name to DeepSeek-V4.1-Flash.
const codexModel = supplied.deepseek.requestedModel === 'deepseek-v4.1' ? 'deepseek-flash' : supplied.deepseek.requestedModel;
const claudeModel = supplied.glm.requestedModel;
const runId = randomUUID();
const dataDir = resolve('.local-data', `live-cli-api-${mode}-${runId}`);
const workspace = resolve(dataDir, 'workspace');
await mkdir(workspace, { recursive: true });
await writeFile(resolve(workspace, 'acceptance-fixture.txt'), '合成验收材料：项目代号 ORBIT-37。单价 7，数量 3，总价 21。复核时检查 7 × 3 = 21。\n');
const runtime = createCollaborationRuntime({ timeoutMs: 240_000 });
let app = await createApplication({ dataDir, workspace, port: 0, startWorker: false, collaborationRuntime: runtime });
let conversationId: string | undefined;
const checks: string[] = [];
let errorMessage: string | undefined;
const clean = (value: string) => [supplied.deepseek.key, supplied.glm.key].reduce((text, key) => text.split(key).join('[redacted]'), value);
function check(name: string, condition: unknown) { assert.ok(condition, name); checks.push(name); }
async function settle(count: number): Promise<ConversationDetail> {
  const end = Date.now() + 500_000;
  while (Date.now() < end) {
    const detail = app.collaborationStore.detail(conversationId!);
    const active = detail.invocations.some(i => ['prepared', 'running', 'cancel_requested'].includes(i.status));
    const queued = detail.deliveries.some(d => d.status === 'pending');
    if (!active && !queued && detail.invocations.length) {
      check(`expected at least ${count} invocations`, detail.invocations.length >= count);
      return detail;
    }
    await new Promise(wait => setTimeout(wait, 250));
  }
  throw new Error('Live run did not settle; exact execution evidence retained, no automatic resend.');
}
function verifyRuns(detail: ConversationDetail) {
  for (const i of detail.invocations) {
    check(`${i.memberId}/${i.id}: successful`, i.status === 'succeeded');
    check(`${i.memberId}/${i.id}: accepted`, i.acceptance === 'accepted');
    check(`${i.memberId}/${i.id}: observed native exit`, i.teardown === 'confirmed' && detail.evidence.some(e => e.invocationId === i.id && e.kind === 'process_exit'));
    check(`${i.memberId}/${i.id}: native identity`, Boolean(i.nativeSessionId));
    check(`${i.memberId}/${i.id}: CLI carrier`, i.member.carrier === (i.memberId === 'codex' ? 'codex-app-server' : 'claude-cli'));
    check(`${i.memberId}/${i.id}: pinned provider model`, i.member.model === (i.memberId === 'codex' ? codexModel : claudeModel));
  }
}
try {
  const store = app.collaborationStore;
  store.saveAccount({ id: 'codex-deepseek-key', name: 'Codex CLI · DeepSeek API', provider: 'codex', auth: 'api', apiKeyEnv: 'COLLAB_DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com' });
  store.saveAccount({ id: 'claude-glm-key', name: 'Claude Code · 智谱 API', provider: 'claude', auth: 'api', apiKeyEnv: 'COLLAB_GLM_API_KEY', baseUrl: 'https://open.bigmodel.cn/api/anthropic' });
  for (const original of store.members()) {
    const member: Member = { ...original, accountId: original.id === 'codex' ? 'codex-deepseek-key' : 'claude-glm-key', model: original.id === 'codex' ? codexModel : claudeModel,
      instructions: '这是本平台真实CLI验收。只处理当前合成材料；用平台workspace_read读取指定文件。需要交接仅调用一次collaboration_request并用准确成员ID，工具成功表示已排队。不得通过最终文字@重复交接。除非用户明确要求协作，直接回复并结束；失败回报只说明原因，不自动重试。' };
    store.saveMember(member);
  }
  const conversation = store.create({ title: `CLI API实机验收 · ${mode}`, memberIds: ['codex', 'claude'], defaultMemberId: mode === 'claude' ? 'claude' : 'codex', requestId: `create-${runId}` }).conversation;
  conversationId = conversation.id; app.collaborationEngine.start();
  const firstMessage = mode === 'collaboration'
    ? '请先用workspace_read读取 acceptance-fixture.txt。然后调用一次collaboration_request，targets=["claude"]，content="请用workspace_read读取acceptance-fixture.txt，复核项目代号、单价×数量和总价，回复项目代号与核对结果，不要发起其他协作。"。成功排队后简短告知并结束。'
    : `请调用workspace_read读取 acceptance-fixture.txt，然后仅回复 ${mode === 'codex' ? 'CODEX_DEEPSEEK' : 'CLAUDE_GLM'}_API_OK、文件中的项目代号和总价，不请求其他成员。`;
  const command = { content: firstMessage, requestId: `message-${runId}` };
  const source = store.send(conversation.id, command).source; app.collaborationEngine.kick();
  let detail = await settle(mode === 'collaboration' ? 2 : 1); verifyRuns(detail);
  check('real workspace_read completed through native tool', detail.evidence.some(e => e.kind === 'tool' && e.detail.name === 'workspace_read' && e.detail.state === 'completed'));
  check('synthetic fixture value returned', detail.responses.some(r => /ORBIT-37/.test(r.content) && /21/.test(r.content)));
  const count = detail.invocations.length;
  check('user request replay reuses source', store.send(conversation.id, command).source.id === source.id);
  app.collaborationEngine.kick();
  check('user replay does not create invocation', store.detail(conversation.id).invocations.length === count);
  if (mode === 'collaboration') {
    check('forward A2A is one source', detail.sources.filter(s => s.kind === 'a2a').length === 1);
    check('ordinary success does not auto-wake caller', detail.invocations.length === 2);
    check('both native carriers read fixture', ['codex', 'claude'].every(id => detail.evidence.some(e => e.kind === 'tool' && e.detail.name === 'workspace_read' && e.detail.state === 'completed' && detail.invocations.find(i => i.id === e.invocationId)?.memberId === id)));
    store.send(conversation.id, { content: '@claude 根据上一轮核对结果，调用一次collaboration_request，targets=["codex"]，content="请根据会话中已经核对的ORBIT-37项目结果，简短给出最终总结，不再请求其他成员。"。排队后简短回复并结束。', requestId: `reverse-${runId}` }); app.collaborationEngine.kick();
    detail = await settle(4); verifyRuns(detail);
    check('reverse A2A is independently admitted', detail.sources.filter(s => s.kind === 'a2a').length === 2);
    check('reverse uses Claude CLI then Codex CLI', detail.invocations[2]?.memberId === 'claude' && detail.invocations[3]?.memberId === 'codex');
    store.send(conversation.id, { content: '根据已有会话历史，只回复项目代号与总价，不调用工具、不请求其他成员。', requestId: `followup-${runId}` }); app.collaborationEngine.kick();
    detail = await settle(5); verifyRuns(detail);
    check('natural follow-up uses persistent context', /ORBIT-37/.test(detail.responses.at(-1)!.content) && /21/.test(detail.responses.at(-1)!.content));
  }
  const persisted = detail.invocations.map(i => i.id);
  await app.close();
  app = await createApplication({ dataDir, workspace, port: 0, startWorker: false, collaborationRuntime: runtime });
  app.collaborationEngine.start();
  const restored = app.collaborationStore.detail(conversationId);
  check('restart preserves exact invocations', JSON.stringify(restored.invocations.map(i => i.id)) === JSON.stringify(persisted));
  check('restart does not requeue delivered inputs', restored.deliveries.every(d => d.status === 'consumed'));
} catch (error) { errorMessage = clean(error instanceof Error ? error.message : 'CLI API verification failed'); process.exitCode = 1; }
finally {
  await app.collaborationEngine.stop();
  const detail = conversationId ? app.collaborationStore.detail(conversationId) : undefined;
  const report = { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()), runId, mode, passed: !errorMessage, error: errorMessage, syntheticInputOnly: true,
    profiles: { codex: { carrier: 'codex-app-server', auth: 'api', service: 'DeepSeek', requestedModel: supplied.deepseek.requestedModel, model: codexModel }, claude: { carrier: 'claude-cli', auth: 'api', service: '智谱', requestedModel: supplied.glm.requestedModel, model: claudeModel } },
    checks, detail };
  const output = resolve(outputDir, `cli-api-live-${mode}.json`); await mkdir(outputDir, { recursive: true });
  const serialized = JSON.stringify(report, null, 2); const redacted = clean(serialized);
  await writeFile(output, redacted + '\n');
  console.log(JSON.stringify({ mode, passed: !errorMessage, error: errorMessage, checks: checks.length, invocations: detail?.invocations.map(i => ({ member: i.memberId, carrier: i.member.carrier, model: i.member.model, status: i.status, acceptance: i.acceptance, teardown: i.teardown })), report: output }, null, 2));
  await app.close();
}
