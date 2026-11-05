import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Approval, Artifact, CreateRole, CreateTask, Role, Run, Step, Task, TaskDetail, TaskEvent, ToolCall } from '../shared/contracts.js';

export class AppError extends Error {
  constructor(public status: number, message: string, public code = 'invalid_request') { super(message); }
}
export class StaleOperation extends Error { constructor() { super('Execution ownership changed.'); } }
export class ServiceLeaseLost extends StaleOperation {
  constructor() { super(); this.message = '本地服务已失去数据库运行租约，请重启服务后重试。'; }
}
export interface Aggregate { task: Task; runs: Run[]; steps: Step[]; toolCalls: ToolCall[]; approvals: Approval[]; artifacts: Artifact[] }
export type Emit = (type: string, message: string, data?: Record<string, unknown>) => void;
interface StoredRow { aggregate: string; revision: number }
interface LeaseRow { owner: string; expires_at: number }
export const now = () => new Date().toISOString();
export const clone = <T>(value: T): T => structuredClone(value);
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

const builtins = (): Role[] => [
  { id: 'coordinator', name: '协调者', description: '梳理目标、材料和执行安排。', instructions: '理解任务目标与验收条件，检查工作区材料，给出供后续角色使用的明确计划。', tools: ['workspace_list', 'workspace_read'], createdAt: now() },
  { id: 'executor', name: '执行者', description: '依据目标与计划完成交付物。', instructions: '依据任务目标、材料和前序结果完成工作，使用 artifact_write 提议保存完整交付物。', tools: ['workspace_list', 'workspace_read', 'artifact_write', 'artifact_read'], createdAt: now() },
  { id: 'reviewer', name: '复核者', description: '读取交付物并逐项核对验收条件。', instructions: '读取本任务产物，结合前序结果逐项检查验收条件，说明满足情况和限制；最终验收由用户决定。', tools: ['artifact_read', 'workspace_list', 'workspace_read'], createdAt: now() },
];

export class Store {
  readonly db: DatabaseSync;
  readonly owner = randomUUID();
  readonly leaseMs: number;
  private closed = false;
  private listeners = new Set<(events: TaskEvent[]) => void>();
  constructor(path: string, options: { leaseMs?: number } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.leaseMs = options.leaseMs ?? 15_000;
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
    if (path !== ':memory:') for (const file of [`${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, aggregate TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id TEXT, type TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT);
      CREATE TABLE IF NOT EXISTS commands (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, task_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS service_lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id,id);
    `);
    try {
      this.transaction(() => {
        const lease = this.db.prepare('SELECT owner, expires_at FROM service_lease WHERE id=1').get() as LeaseRow | undefined;
        if (lease && lease.expires_at > Date.now()) throw new AppError(409, 'Another application instance owns this data directory.', 'service_lease_held');
        this.db.prepare('INSERT INTO service_lease(id,owner,expires_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at').run(this.owner, Date.now() + this.leaseMs);
        for (const role of builtins()) this.db.prepare('INSERT OR IGNORE INTO roles(id,value) VALUES(?,?)').run(role.id, JSON.stringify(role));
      });
    } catch (error) { this.db.close(); this.closed = true; throw error; }
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  assertLease(): void {
    if (this.closed) throw new ServiceLeaseLost();
    const lease = this.db.prepare('SELECT owner, expires_at FROM service_lease WHERE id=1').get() as LeaseRow | undefined;
    if (!lease || lease.owner !== this.owner) throw new ServiceLeaseLost();
    // A suspended process may resume through an HTTP request or runtime callback
    // before its heartbeat timer. Expiry allows takeover, but is not itself takeover.
    if (lease.expires_at <= Date.now()) this.heartbeat();
  }
  heartbeat(): void {
    if (this.closed) throw new ServiceLeaseLost();
    // One conditional write serializes renewal against another Store's takeover.
    // It also works inside an existing transaction without nesting BEGINs.
    const renewed = this.db.prepare('UPDATE service_lease SET expires_at=? WHERE id=1 AND owner=?').run(Date.now() + this.leaseMs, this.owner);
    if (renewed.changes !== 1) throw new ServiceLeaseLost();
  }
  close(): void {
    if (this.closed) return;
    this.db.prepare('DELETE FROM service_lease WHERE id=1 AND owner=?').run(this.owner);
    this.db.close(); this.closed = true;
  }
  subscribe(listener: (events: TaskEvent[]) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private publish(events: TaskEvent[]): void { if (events.length) for (const listener of this.listeners) { try { listener(events); } catch { /* Client disconnection does not undo a commit. */ } } }
  listRoles(): Role[] { return (this.db.prepare('SELECT value FROM roles ORDER BY rowid').all() as { value: string }[]).map(row => JSON.parse(row.value) as Role); }
  addRole(input: CreateRole): Role {
    const role: Role = { ...clone(input), id: randomUUID(), createdAt: now() };
    this.transaction(() => { this.assertLease(); this.db.prepare('INSERT INTO roles(id,value) VALUES(?,?)').run(role.id, JSON.stringify(role)); });
    return role;
  }
  list(): Task[] { return this.aggregates().map(item => item.task).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  aggregates(): Aggregate[] { return (this.db.prepare('SELECT aggregate FROM tasks ORDER BY rowid').all() as { aggregate: string }[]).map(row => JSON.parse(row.aggregate) as Aggregate); }
  get(id: string): Aggregate {
    const row = this.db.prepare('SELECT aggregate FROM tasks WHERE id=?').get(id) as { aggregate: string } | undefined;
    if (!row) throw new AppError(404, 'Task not found.', 'not_found');
    return JSON.parse(row.aggregate) as Aggregate;
  }
  detail(id: string): TaskDetail { return { ...this.get(id), events: this.events(0, id, -1) }; }
  cursor(): number { return Number((this.db.prepare('SELECT COALESCE(MAX(id),0) AS cursor FROM events').get() as { cursor: number }).cursor); }
  events(after = 0, taskId?: string, limit = 10_000): TaskEvent[] {
    const rows = (taskId ? this.db.prepare('SELECT * FROM events WHERE id>? AND task_id=? ORDER BY id LIMIT ?').all(after, taskId, limit) : this.db.prepare('SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?').all(after, limit)) as { id: number; task_id: string; run_id: string | null; type: string; message: string; created_at: string; data: string | null }[];
    return rows.map(row => ({ id: Number(row.id), taskId: row.task_id, ...(row.run_id ? { runId: row.run_id } : {}), type: row.type, message: row.message, createdAt: row.created_at, ...(row.data ? { data: JSON.parse(row.data) as Record<string, unknown> } : {}) }));
  }
  private insertEvent(taskId: string, runId: string, type: string, message: string, data?: Record<string, unknown>): TaskEvent {
    const createdAt = now();
    const result = this.db.prepare('INSERT INTO events(task_id,run_id,type,message,created_at,data) VALUES(?,?,?,?,?,?)').run(taskId, runId, type, message, createdAt, data ? JSON.stringify(data) : null);
    return { id: Number(result.lastInsertRowid), taskId, runId, type, message, createdAt, ...(data ? { data } : {}) };
  }
  create(input: CreateTask): { task: Task; replayed: boolean } {
    const digest = createHash('sha256').update(canonical(input)).digest('hex');
    const events: TaskEvent[] = [];
    const result = this.transaction(() => {
      this.assertLease();
      const existing = this.db.prepare('SELECT digest,task_id FROM commands WHERE request_id=?').get(input.requestId) as { digest: string; task_id: string } | undefined;
      if (existing) {
        if (existing.digest !== digest) throw new AppError(409, 'This request ID was already used with different content.', 'idempotency_conflict');
        return { task: this.get(existing.task_id).task, replayed: true };
      }
      const roles = this.listRoles();
      const selected = input.roleIds.map(id => { const role = roles.find(r => r.id === id); if (!role) throw new AppError(400, 'A selected role no longer exists.'); return role; });
      const createdAt = now(); const taskId = randomUUID(); const runId = randomUUID();
      const task: Task = { id: taskId, title: input.title, goal: input.goal, acceptance: input.acceptance, roleIds: [...input.roleIds], mode: input.mode, status: 'queued', latestRunId: runId, createdAt, updatedAt: createdAt };
      const aggregate: Aggregate = { task, runs: [{ id: runId, taskId, attempt: 1, status: 'queued', createdAt }], steps: selected.map((role, position) => ({ id: randomUUID(), runId, position, role: clone(role), status: 'queued', round: 0, createdAt, messages: [] })), toolCalls: [], approvals: [], artifacts: [] };
      this.db.prepare('INSERT INTO tasks(id,aggregate) VALUES(?,?)').run(taskId, JSON.stringify(aggregate));
      this.db.prepare('INSERT INTO commands(request_id,digest,task_id) VALUES(?,?,?)').run(input.requestId, digest, taskId);
      events.push(this.insertEvent(taskId, runId, 'task.created', '任务已受理，等待执行。'));
      return { task: clone(task), replayed: false };
    });
    this.publish(events); return result;
  }
  update(id: string, mutate: (aggregate: Aggregate, emit: Emit) => void): Aggregate {
    const events: TaskEvent[] = [];
    const result = this.transaction(() => {
      this.assertLease();
      const row = this.db.prepare('SELECT aggregate,revision FROM tasks WHERE id=?').get(id) as StoredRow | undefined;
      if (!row) throw new AppError(404, 'Task not found.', 'not_found');
      const aggregate = JSON.parse(row.aggregate) as Aggregate;
      mutate(aggregate, (type, message, data) => events.push(this.insertEvent(id, aggregate.task.latestRunId, type, message, data)));
      aggregate.task.updatedAt = now();
      this.db.prepare('UPDATE tasks SET aggregate=?,revision=? WHERE id=? AND revision=?').run(JSON.stringify(aggregate), row.revision + 1, id, row.revision);
      return aggregate;
    });
    this.publish(events); return result;
  }
  recover(): void {
    for (const aggregate of this.aggregates()) {
      if (aggregate.task.status !== 'running') continue;
      this.update(aggregate.task.id, (current, emit) => {
        const runId = current.task.latestRunId;
        current.task.status = 'interrupted';
        const run = current.runs.find(item => item.id === runId)!;
        run.status = 'interrupted'; run.error = '服务在执行期间停止；请重新执行。'; run.finishedAt = now();
        for (const step of current.steps.filter(item => item.runId === runId && (item.status === 'running' || item.status === 'queued'))) { step.status = 'interrupted'; step.error = run.error; step.finishedAt = now(); }
        for (const call of current.toolCalls.filter(item => item.runId === runId && ['pending', 'approved', 'waiting_approval'].includes(item.status))) { call.status = 'cancelled'; call.updatedAt = now(); }
        for (const approval of current.approvals.filter(item => item.runId === runId && item.status === 'pending')) { approval.status = 'cancelled'; approval.decidedAt = now(); }
        emit('run.interrupted', run.error);
      });
    }
  }
}
