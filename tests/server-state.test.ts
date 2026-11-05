import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/index.js';
import { AppError, StaleOperation, Store } from '../server/store.js';
import type { Provider, ProviderResponse } from '../server/provider.js';
import type { CreateTask } from '../shared/contracts.js';

const taskInput = (requestId: string, roleIds = ['executor']): CreateTask => ({ title: '测试任务', goal: '生成交付物', acceptance: '包含目标和结果', roleIds, mode: 'demo', requestId });
async function until(predicate: () => boolean, timeout = 4000) { const end = Date.now() + timeout; while (!predicate()) { if (Date.now() >= end) throw new Error('Timed out waiting for state.'); await new Promise(resolve => setTimeout(resolve, 15)); } }
async function sandbox() { return mkdtemp(join(tmpdir(), 'agent-platform-state-')); }

test('aggregate edits and events roll back together; idempotency and lease fencing hold', async () => {
  const path = await sandbox(); const store = new Store(join(path, 'db.sqlite'));
  try {
    const input = taskInput('same'); const first = store.create(input);
    assert.equal(store.create(input).task.id, first.task.id);
    assert.throws(() => store.create({ ...input, goal: 'different' }), (error: unknown) => error instanceof AppError && error.status === 409);
    const cursor = store.cursor();
    assert.throws(() => store.update(first.task.id, (aggregate, emit) => { aggregate.task.status = 'completed'; emit('invalid', 'must roll back'); throw new Error('rollback'); }));
    assert.equal(store.get(first.task.id).task.status, 'queued'); assert.equal(store.cursor(), cursor);
    assert.throws(() => new Store(join(path, 'db.sqlite')), /Another application instance/);
    store.db.prepare('UPDATE service_lease SET owner=? WHERE id=1').run('new-owner');
    assert.throws(() => store.update(first.task.id, aggregate => { aggregate.task.status = 'completed'; }), StaleOperation);
    assert.equal(store.get(first.task.id).task.status, 'queued');
  } finally { store.close(); await rm(path, { recursive: true, force: true }); }
});

test('cancel fences a late provider result and releases the worker for another task', async () => {
  const dataDir = await sandbox(); let release: ((result: ProviderResponse) => void) | undefined; let calls = 0;
  const provider: Provider = async () => { calls += 1; if (calls === 1) return new Promise(resolve => { release = resolve; }); return { content: '第二任务交付完成。' }; };
  const app = await createApplication({ dataDir, port: 0, provider });
  try {
    app.worker.start(); const first = app.store.create(taskInput('first')).task;
    await until(() => Boolean(release));
    const cancelled = app.commands.cancel(first.id); assert.equal(cancelled.status, 'cancelled');
    const second = app.store.create(taskInput('second')).task;
    release!({ content: null, toolCalls: [{ id: 'late-call', name: 'artifact_write', arguments: JSON.stringify({ name: 'late.md', content: 'must never write' }) }] });
    await until(() => app.store.get(second.id).task.status === 'needs_review');
    const result = app.store.get(first.id); assert.equal(result.task.status, 'cancelled'); assert.equal(result.toolCalls.length, 0); assert.equal(result.artifacts.length, 0);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('approval remains stable on repeat; opposed decision conflicts and retry preserves the old batch', async () => {
  const dataDir = await sandbox();
  const provider: Provider = async context => context.step.messages.some(message => message.role === 'tool') ? { content: '已完成文档。' } : { content: null, toolCalls: [{ id: 'provider-write', name: 'artifact_write', arguments: JSON.stringify({ name: 'report.md', content: '# Result\nApproved output.' }) }] };
  const app = await createApplication({ dataDir, port: 0, provider });
  try {
    app.worker.start(); const task = app.store.create(taskInput('approval')).task;
    await until(() => app.store.get(task.id).task.status === 'waiting_approval');
    const before = app.store.get(task.id); const approval = before.approvals[0]!;
    assert.equal(before.artifacts.length, 0);
    const decision = app.commands.decide(approval.id, 'approved'); assert.equal(decision.status, 'approved');
    assert.deepEqual(app.commands.decide(approval.id, 'approved'), decision);
    assert.throws(() => app.commands.decide(approval.id, 'rejected'), (error: unknown) => error instanceof AppError && error.status === 409);
    await until(() => app.store.get(task.id).task.status === 'needs_review');
    const completed = app.store.get(task.id); assert.equal(completed.artifacts.length, 1); assert.equal(completed.toolCalls[0]?.providerCallId, 'provider-write');
    assert.equal(completed.steps[0]?.messages.find(message => message.role === 'tool')?.tool_call_id, 'provider-write');
    const oldRun = task.latestRunId; const retried = app.commands.retry(task.id); assert.notEqual(retried.latestRunId, oldRun);
    const history = app.store.get(task.id); assert.equal(history.runs.length, 2); assert.equal(history.runs[0]?.status, 'succeeded'); assert.equal(history.artifacts.length, 1);
    app.commands.cancel(task.id);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('approval payload tampering and expiration cannot produce an artifact', async () => {
  const dataDir = await sandbox();
  const provider: Provider = async () => ({ content: null, toolCalls: [{ id: 'write', name: 'artifact_write', arguments: JSON.stringify({ name: 'report.md', content: 'original' }) }] });
  const app = await createApplication({ dataDir, port: 0, provider, approvalTtlMs: 60_000 });
  try {
    app.worker.start(); const task = app.store.create(taskInput('tamper')).task;
    await until(() => app.store.get(task.id).task.status === 'waiting_approval');
    const approval = app.store.get(task.id).approvals[0]!;
    app.store.update(task.id, aggregate => { aggregate.toolCalls[0]!.args.content = 'changed after request'; });
    assert.throws(() => app.commands.decide(approval.id, 'approved'), /不适用于当前操作/);
    assert.equal(app.store.get(task.id).artifacts.length, 0); app.commands.cancel(task.id);
    const expiryTask = app.store.create(taskInput('expiry')).task;
    await until(() => app.store.get(expiryTask.id).task.status === 'waiting_approval');
    const expiry = app.store.get(expiryTask.id).approvals[0]!;
    app.store.update(expiryTask.id, aggregate => { aggregate.approvals[0]!.expiresAt = new Date(0).toISOString(); });
    assert.throws(() => app.commands.decide(expiry.id, 'approved'), /过期/);
    assert.equal(app.store.get(expiryTask.id).task.status, 'failed'); assert.equal(app.store.get(expiryTask.id).artifacts.length, 0);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('restart interrupts an active execution and preserves a waiting approval', async () => {
  const dataDir = await sandbox();
  const provider: Provider = async () => ({ content: null, toolCalls: [{ id: 'write', name: 'artifact_write', arguments: JSON.stringify({ name: 'report.md', content: 'saved after approval' }) }] });
  const app = await createApplication({ dataDir, port: 0, provider });
  let next: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    app.worker.start(); const waiting = app.store.create(taskInput('waiting')).task;
    await until(() => app.store.get(waiting.id).task.status === 'waiting_approval');
    await app.worker.stop();
    const running = app.store.create(taskInput('running')).task;
    app.store.update(running.id, aggregate => { aggregate.task.status = 'running'; aggregate.runs[0]!.status = 'running'; aggregate.steps[0]!.status = 'running'; });
    const approvalId = app.store.get(waiting.id).approvals[0]!.id;
    await app.close();
    next = await createApplication({ dataDir, port: 0, provider, startWorker: false });
    assert.equal(next.store.get(running.id).task.status, 'interrupted'); assert.equal(next.store.get(running.id).steps[0]?.status, 'interrupted');
    assert.equal(next.store.get(waiting.id).task.status, 'waiting_approval'); assert.equal(next.store.get(waiting.id).approvals[0]?.id, approvalId);
    assert.equal(next.store.get(waiting.id).approvals[0]?.status, 'pending');
  } finally { await app.close(); await next?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('role order and previous outputs are frozen; unauthorized tools fail without effects', async () => {
  const dataDir = await sandbox(); const received: string[][] = [];
  const provider: Provider = async context => { received.push(context.previousOutputs); return context.step.position === 0 ? { content: '第一角色的交付证据' } : { content: null, toolCalls: [{ id: 'forbidden', name: 'artifact_write', arguments: '{"name":"no.md","content":"no"}' }] }; };
  const app = await createApplication({ dataDir, port: 0, provider });
  try {
    app.worker.start(); const task = app.store.create(taskInput('roles', ['executor', 'coordinator'])).task;
    await until(() => app.store.get(task.id).task.status === 'failed');
    const result = app.store.get(task.id); assert.deepEqual(result.steps.map(step => step.role.id), ['executor', 'coordinator']);
    assert.deepEqual(received, [[], ['第一角色的交付证据']]); assert.equal(result.artifacts.length, 0); assert.match(result.runs[0]!.error!, /未获准/);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('approval expiry is checked again at execution and the recorded decision stays stable', async () => {
  const dataDir = await sandbox();
  const provider: Provider = async () => ({ content: null, toolCalls: [{ id: 'write', name: 'artifact_write', arguments: '{"name":"report.md","content":"must not be saved"}' }] });
  const app = await createApplication({ dataDir, port: 0, provider });
  try {
    app.worker.start(); const task = app.store.create(taskInput('expired-after-approval')).task;
    await until(() => app.store.get(task.id).task.status === 'waiting_approval');
    await app.worker.stop(); const approval = app.store.get(task.id).approvals[0]!;
    const decided = app.commands.decide(approval.id, 'approved');
    app.store.update(task.id, aggregate => { aggregate.approvals[0]!.expiresAt = new Date(0).toISOString(); });
    app.worker.start(); await until(() => app.store.get(task.id).task.status === 'failed');
    assert.equal(app.store.get(task.id).artifacts.length, 0);
    const repeated = app.commands.decide(approval.id, 'approved');
    assert.equal(repeated.status, 'approved'); assert.equal(repeated.decidedAt, decided.decidedAt);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('waiting approval releases the single worker and model timeouts fail boundedly', async () => {
  const dataDir = await sandbox();
  const provider: Provider = async context => {
    if (context.task.title === 'timeout') return new Promise(() => {});
    if (context.task.title === 'quick') return { content: 'Finished while another task waits.' };
    return { content: null, toolCalls: [{ id: 'write', name: 'artifact_write', arguments: '{"name":"waiting.md","content":"waiting"}' }] };
  };
  const app = await createApplication({ dataDir, port: 0, provider, providerTimeoutMs: 50 });
  try {
    app.worker.start(); const first = app.store.create(taskInput('wait-slot')).task;
    await until(() => app.store.get(first.id).task.status === 'waiting_approval');
    const quick = app.store.create({ ...taskInput('quick'), title: 'quick' }).task;
    await until(() => app.store.get(quick.id).task.status === 'needs_review');
    assert.equal(app.store.get(first.id).task.status, 'waiting_approval');
    const timeout = app.store.create({ ...taskInput('timeout'), title: 'timeout' }).task;
    await until(() => app.store.get(timeout.id).task.status === 'failed');
    assert.match(app.store.get(timeout.id).runs[0]!.error!, /超时/);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
