import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import type { Bootstrap, TaskDetail, CreateTask, Task } from '../shared/contracts.js';

const project = resolve(import.meta.dirname, '..');
async function freePort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
async function eventually<T>(read: () => Promise<T>, match: (value: T) => boolean, label: string, ms = 12000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try { const value = await read(); last = value; if (match(value)) return value; } catch (error) { last = String(error); }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`等待 ${label} 超时: ${JSON.stringify(last)}`);
}
async function harness(extra: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'multi-agent-http-'));
  const workspace = join(dir, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'brief.txt'), '测试材料：每个交付物必须经过人工验收。');
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let logs = '';
  let bootstrap: Bootstrap;
  const api = async (path: string, body?: unknown, headers?: Record<string, string>) => {
    const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? headers : { 'content-type': 'application/json', 'x-csrf-token': bootstrap?.csrfToken ?? '', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json();
    return { response, data };
  };
  const start = async () => {
    logs = '';
    child = spawn(process.execPath, ['dist/server/index.js'], { cwd: project, env: { ...process.env, APP_PORT: String(port), APP_DATA_DIR: join(dir, 'data'), APP_WORKSPACE: workspace, MODEL_API_KEY: '', MODEL_BASE_URL: '', MODEL_NAME: '', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', b => { logs += String(b); });
    child.stderr?.on('data', b => { logs += String(b); });
    try {
      await eventually(async () => {
        if (child?.exitCode !== null) throw new Error(logs);
        return (await fetch(url + '/health')).status;
      }, status => status === 200, 'HTTP 服务启动');
      bootstrap = (await api('/api/bootstrap')).data as Bootstrap;
    } catch (error) { throw new Error(`${error}\n服务输出: ${logs}`); }
  };
  const stop = async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child?.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timeout);
    }
  };
  const close = async () => { await stop(); await rm(dir, { recursive: true, force: true }); };
  const detail = async (id: string) => (await api(`/api/tasks/${id}`)).data as TaskDetail;
  const create = async (overrides: Partial<CreateTask> = {}) => {
    const body: CreateTask = { title: 'HTTP 集成验收', goal: '读取工作区材料并形成协作说明', acceptance: '产物包含目标和验收标准，经过复核', roleIds: bootstrap.roles.map(role => role.id), mode: 'demo', requestId: crypto.randomUUID(), ...overrides };
    const result = await api('/api/tasks', body);
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    return { task: result.data.task as Task, body };
  };
  await start();
  return { api, start, stop, close, detail, create, url, dir, get bootstrap() { return bootstrap; } };
}

test('HTTP：任务去重、审批重放、真实产物、事件恢复和人工验收', { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    assert.equal(h.bootstrap.meta.apiConfigured, false);
    const { task, body } = await h.create();
    const replay = await h.api('/api/tasks', body);
    assert.equal(replay.response.status, 200);
    assert.equal(replay.data.task.id, task.id);
    const conflict = await h.api('/api/tasks', { ...body, goal: '变更后的目标' });
    assert.equal(conflict.response.status, 409);
    let d = await eventually(() => h.detail(task.id), d => d.task.status === 'waiting_approval', '等待具体操作审批');
    assert.equal(d.artifacts.length, 0, '批准前不生成产物');
    const approval = d.approvals.find(a => a.status === 'pending')!;
    assert.ok(approval);
    assert.equal(approval.toolName, 'artifact_write');
    const approve = await h.api(`/api/approvals/${approval.id}/decision`, { decision: 'approve' });
    assert.equal(approve.response.status, 200);
    assert.equal((await h.api(`/api/approvals/${approval.id}/decision`, { decision: 'approve' })).response.status, 200);
    assert.equal((await h.api(`/api/approvals/${approval.id}/decision`, { decision: 'reject' })).response.status, 409);
    d = await eventually(() => h.detail(task.id), d => d.task.status === 'needs_review', '等待人工验收');
    assert.equal(d.artifacts.length, 1);
    assert.ok(d.steps.filter(s => s.runId === d.task.latestRunId).every(s => s.status === 'completed'));
    const artifactResponse = await fetch(h.url + d.artifacts[0].url);
    assert.equal(artifactResponse.status, 200);
    assert.ok((await artifactResponse.text()).length > 30);
    const controller = new AbortController();
    const events = await fetch(`${h.url}/api/events?after=0`, { signal: controller.signal });
    assert.match(events.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = events.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(chunk, /id: \d+/);
    controller.abort();
    await reader.cancel().catch(() => {});
    const accepted = await h.api(`/api/tasks/${task.id}/accept`, {});
    assert.equal(accepted.data.task.status, 'completed');
    await h.stop();
    await h.start();
    const persisted = await h.detail(task.id);
    assert.equal(persisted.task.status, 'completed');
    assert.equal(persisted.artifacts.length, 1);
  } finally { await h.close(); }
});

test('HTTP：待审批重启保留、拒绝无副作用、重做保留历史及取消失效审批', { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const { task } = await h.create();
    let d = await eventually(() => h.detail(task.id), d => d.task.status === 'waiting_approval', '审批');
    const firstApproval = d.approvals.find(a => a.status === 'pending')!;
    await h.stop(); await h.start();
    d = await h.detail(task.id);
    assert.equal(d.task.status, 'waiting_approval');
    assert.equal((await h.api(`/api/approvals/${firstApproval.id}/decision`, { decision: 'reject' })).response.status, 200);
    d = await eventually(() => h.detail(task.id), d => d.task.status === 'failed', '拒绝后终止');
    assert.equal(d.artifacts.length, 0);
    assert.equal((await h.api(`/api/tasks/${task.id}/retry`, {})).response.status, 200);
    d = await eventually(() => h.detail(task.id), d => d.task.status === 'waiting_approval', '新批次审批');
    assert.equal(d.runs.length, 2);
    const secondApproval = d.approvals.find(a => a.status === 'pending')!;
    assert.notEqual(secondApproval.runId, firstApproval.runId);
    assert.equal((await h.api(`/api/tasks/${task.id}/cancel`, {})).data.task.status, 'cancelled');
    assert.equal((await h.api(`/api/approvals/${secondApproval.id}/decision`, { decision: 'approve' })).response.status, 409);
    assert.equal((await h.detail(task.id)).artifacts.length, 0);
  } finally { await h.close(); }
});

test('HTTP：写接口拒绝跨站或缺少CSRF，配置不足的API任务被拒绝', { timeout: 20000 }, async () => {
  const h = await harness();
  try {
    const role = { name: '审计员', description: '只读核查', instructions: '核对已有材料', tools: ['workspace_read'] };
    assert.equal((await h.api('/api/roles', role, { 'x-csrf-token': '' })).response.status, 403);
    assert.equal((await h.api('/api/roles', role, { origin: 'https://foreign.example' })).response.status, 403);
    const created = await h.api('/api/roles', role);
    assert.equal(created.response.status, 201);
    assert.deepEqual(created.data.role.tools, ['workspace_read']);
    const invalid = await h.api('/api/tasks', { title: '未配置模型', goal: 'test', acceptance: 'test', roleIds: [created.data.role.id], mode: 'api', requestId: crypto.randomUUID() });
    assert.ok(invalid.response.status >= 400 && invalid.response.status < 500);
    assert.ok(!JSON.stringify(h.bootstrap).includes('MODEL_API_KEY'));
  } finally { await h.close(); }
});

test('兼容模型HTTP：工具提议经过审批，回传工具结果和取消迟到响应', { timeout: 30000 }, async () => {
  const requests: any[] = [];
  let slow = false;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer test-only-token');
    if (slow) await new Promise(resolve => setTimeout(resolve, 500));
    const hasTool = body.messages.some((message: any) => message.role === 'tool');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: hasTool || slow ? { role: 'assistant', content: '交付已完成，请按验收条件核对。' } : { role: 'assistant', content: null, tool_calls: [{ id: 'provider-call-1', type: 'function', function: { name: 'artifact_write', arguments: JSON.stringify({ name: 'delivery.md', content: '# 测试交付\n这份内容来自模拟兼容模型的工具调用。' }) } }] } }] }));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const port = (provider.address() as { port: number }).port;
  const h = await harness({ MODEL_BASE_URL: `http://127.0.0.1:${port}/v1`, MODEL_NAME: 'protocol-test-model', MODEL_API_KEY: 'test-only-token' });
  try {
    const role = h.bootstrap.roles.find(r => r.tools.includes('artifact_write'))!;
    const { task } = await h.create({ mode: 'api', roleIds: [role.id] });
    let d = await eventually(() => h.detail(task.id), d => d.task.status === 'waiting_approval', '模型工具审批');
    await h.api(`/api/approvals/${d.approvals[0].id}/decision`, { decision: 'approve' });
    d = await eventually(() => h.detail(task.id), d => d.task.status === 'needs_review', '模型交付');
    assert.equal(d.artifacts.length, 1);
    assert.ok(requests.some(r => r.messages.some((m: any) => m.role === 'tool' && m.tool_call_id === 'provider-call-1')));
    assert.ok(!JSON.stringify(d).includes('test-only-token'));
    slow = true;
    const before = requests.length;
    const next = await h.create({ mode: 'api', roleIds: [role.id], title: '取消中的模型请求' });
    await eventually(async () => requests.length, n => n > before, '模型请求已送达');
    await h.api(`/api/tasks/${next.task.id}/cancel`, {});
    await new Promise(resolve => setTimeout(resolve, 650));
    const cancelled = await h.detail(next.task.id);
    assert.equal(cancelled.task.status, 'cancelled');
    assert.equal(cancelled.artifacts.length, 0);
    assert.ok(cancelled.steps.every(s => s.status !== 'completed'));
  } finally { await h.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); }
});
