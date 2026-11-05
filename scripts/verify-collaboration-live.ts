/** Explicit opt-in live smoke. Sends only synthetic task text; never prints credentials. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server/index.js';
import type { ConversationDetail } from '../shared/collaboration.js';

const outputDir = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/round1-live');
const mode = process.argv[2] ?? 'codex';
if (!['codex', 'handoff', 'claude-unavailable'].includes(mode)) throw new Error('Mode must be codex, handoff, or claude-unavailable.');
const dataDir = resolve('.local-data', `live-round1-${mode}-${randomUUID()}`);
const app = await createApplication({ dataDir, port: 0, startWorker: false });
let conversationId: string | undefined;
let outcome: Record<string, unknown> = {};
async function settle(expected: number): Promise<ConversationDetail> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const d = app.collaborationStore.detail(conversationId!);
    if (d.invocations.length >= expected && d.invocations.every(i => ['succeeded', 'failed', 'interrupted', 'cancelled'].includes(i.status))) return d;
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error('Live validation timed out; persisted invocation evidence is retained in the private data directory.');
}
try {
  const store = app.collaborationStore;
  const codex = store.members().find(m => m.id === 'codex')!;
  store.saveMember({ ...codex, instructions: '这是集成验收，仅处理当前合成任务。不读取文件，不执行命令。如果输入是 a2a_failure，简短说明失败并结束，不再次调用工具。请求其他成员只能调用一次 collaboration_request；除非用户明确要求，不追加其他协作。' });
  let memberIds = ['codex'];
  if (mode === 'handoff') {
    const base = process.env.ANTHROPIC_BASE_URL?.replace(/\/+$/, '');
    const model = process.env.LIVE_API_MODEL;
    assert.ok(base && model && process.env.ANTHROPIC_API_KEY, 'Explicit API environment and LIVE_API_MODEL required.');
    store.saveAccount({ id: 'live-api', name: '现有 Anthropic 兼容 API（非 Claude 登录）', auth: 'api', provider: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrl: base.endsWith('/v1') ? base : `${base}/v1` });
    store.saveMember({ id: 'api-reviewer', name: 'API 复核员', instructions: '只核对当前合成算式，简短回复结果，不请求其他成员。不读取文件。', carrier: 'anthropic-api', accountId: 'live-api', model, enabled: true });
    memberIds.push('api-reviewer');
  } else if (mode === 'claude-unavailable') memberIds.push('claude');
  const c = store.create({ title: `真实运行时验收 ${mode}`, memberIds, defaultMemberId: 'codex', requestId: `conversation-${mode}` }).conversation;
  conversationId = c.id;
  app.collaborationEngine.start();
  const content = mode === 'codex' ? '这是合成验收。只回复 CODEX_RUNTIME_OK，不调用任何工具。'
    : mode === 'handoff' ? '这是合成协作验收。请调用一次 collaboration_request，targets=["api-reviewer"]，content="请核对 2+3=5，回复算式和核对结果，不需要其他协作。"。成功排队后简短回复，不要等待或再次请求。'
    : '这是失败回报验收。请调用一次 collaboration_request，targets=["claude"]，content="只回复 CLAUDE_RUNTIME_OK。"。排队后结束，不要重试；收到失败回报时仅说明原因并结束。';
  const sent = store.send(c.id, { content, requestId: `input-${mode}` }); app.collaborationEngine.kick();
  const d = await settle(mode === 'codex' ? 1 : mode === 'handoff' ? 2 : 3);
  assert.equal(store.send(c.id, { content, requestId: `input-${mode}` }).source.id, sent.source.id);
  const first = d.invocations.find(i => i.memberId === 'codex')!;
  assert.equal(first.status, 'succeeded'); assert.equal(first.acceptance, 'accepted'); assert.equal(first.teardown, 'confirmed'); assert.ok(first.nativeSessionId);
  if (mode === 'codex') assert.match(d.responses[0]!.content, /CODEX_RUNTIME_OK/);
  if (mode === 'handoff') {
    assert.equal(d.invocations.length, 2); assert.ok(d.invocations.every(i => i.status === 'succeeded' && i.acceptance === 'accepted' && i.teardown === 'confirmed'));
    assert.equal(d.sources.filter(s => s.kind === 'a2a').length, 1); assert.equal(d.sources.filter(s => s.kind === 'a2a_failure').length, 0);
    store.send(c.id, { content: '根据历史中的复核结果，直接给出一句总结，不调用工具。', requestId: 'followup' }); app.collaborationEngine.kick();
    const continued = await settle(3); assert.equal(continued.invocations.length, 3); assert.ok(continued.invocations.every(i => i.status === 'succeeded'));
  }
  if (mode === 'claude-unavailable') { assert.equal(d.sources.filter(s => s.kind === 'a2a_failure').length, 1); assert.equal(d.invocations.find(i => i.memberId === 'claude')!.acceptance, 'not_accepted'); }
  outcome = { passed: true };
} catch (error) {
  outcome = { passed: false, error: error instanceof Error ? error.message : 'Live validation failed' };
  process.exitCode = 1;
} finally {
  await app.collaborationEngine.stop();
  const detail = conversationId ? app.collaborationStore.detail(conversationId) : undefined;
  const report = { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()), mode, ...outcome, syntheticInputOnly: true, apiIsClaude: false,
    invocations: detail?.invocations.map(i => ({ id: i.id, memberId: i.memberId, carrier: i.member.carrier, model: i.member.model, status: i.status, acceptance: i.acceptance, continuity: i.continuity, teardown: i.teardown, nativeSessionId: i.nativeSessionId, nativeTurnId: i.nativeTurnId })),
    sources: detail?.sources.map(s => ({ id: s.id, kind: s.kind, targets: s.requestedTargets })),
    evidence: detail?.evidence, responses: detail?.responses.map(r => ({ id: r.id, invocationId: r.invocationId, status: r.status, content: r.content })),
  };
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, `round1-live-${mode}.json`), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ mode, ...outcome, invocations: report.invocations, report: resolve(outputDir, `round1-live-${mode}.json`) }, null, 2));
  await app.close();
}
