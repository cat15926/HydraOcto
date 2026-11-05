import { createHash, randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import type { AcceptanceEvidence, CollaborationAccount, CollaborationEvent, CollaborationInvocation, CollaborationResponse, Consumption, Conversation, ConversationDetail, ConversationMessage, CreateConversation, Delivery, DispatchBatch, Member, RuntimeEvent, SendMessage, SourceWork, ExecutionContractSnapshot, InputManifest, RoutingDecision, RecoveryCheck, RecoveryRequest, RuntimeInspection, HoldRecheck, NativeSessionBinding, NativeSessionIdentity, NativeSessionPlan } from '../../shared/collaboration.js';
import { AppError, canonical, now, Store } from '../store.js';
import { parseMentions, resolveRouting } from './routing.js';
import { assembleContext, CONTEXT_POLICY_VERSION } from './context.js';
import { nativeUsage, sessionFingerprint } from './continuity.js';
import { resolve } from 'node:path';
import { ArtifactService } from './artifacts.js';
import { InteractionService } from './interactions.js';
import { OrdinaryTaskService } from './tasks.js';

const id = () => randomUUID();
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const terminal = new Set(['succeeded', 'failed', 'interrupted', 'cancelled']);
const supported = ['codex-app-server', 'claude-cli', 'openai-api', 'anthropic-api'];
function checkText(value: unknown, name: string, max = 20000): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(400, `${name} must contain 1–${max} characters.`); }
export interface Admission { batch: DispatchBatch; invocations: CollaborationInvocation[] }
interface FailureProof { sourceId: string; responseId: string; invocationId: string; callerMemberId: string; callerInvocationId: string; identity: 'strict' }

/** One SQLite transaction covers each domain transition; no provider calls inside. */
export class CollaborationStore {
  readonly db;
  readonly tasks: OrdinaryTaskService;
  readonly artifacts: ArtifactService;
  readonly interactions: InteractionService;
  private listeners = new Set<(events: CollaborationEvent[]) => void>();
  private emitted: CollaborationEvent[] | undefined;
  constructor(readonly owner: Store, readonly options: { workspace?: string; artifactDir?: string } = {}) {
    this.db = owner.db;
    this.tasks = new OrdinaryTaskService({ db: this.db, tx: fn => this.tx(fn), command: (key, input, fn) => this.command(key, input, fn),
      invocation: key => this.invocation(key), saveInvocation: i => this.saveInvocation(i), contract: key => this.contract(key), addSource: input => this.addSource(input),
      message: (conversationId, content, sourceId) => this.addMessage({ conversationId, content, sourceId, author: 'system' }), event: (conversationId, type, data) => this.event(conversationId, type, data) });
    this.artifacts = new ArtifactService({ db: this.db, tasks: this.tasks, tx: fn => this.tx(fn), command: (key, input, fn) => this.command(key, input, fn), invocation: key => this.invocation(key), contract: key => this.contract(key), addSource: input => this.addSource(input), event: (cid, type, data) => this.event(cid, type, data) }, options.artifactDir ?? resolve('.local-data/collaboration-artifacts'), options.workspace ?? '');
    this.interactions = new InteractionService(this.artifacts);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cc_accounts (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_members (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES cc_accounts(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_conversations (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_sources (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES cc_conversations(id), sequence INTEGER NOT NULL UNIQUE, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_commands (request_id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_deliveries (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES cc_sources(id), member_id TEXT NOT NULL REFERENCES cc_members(id), response_id TEXT, status TEXT NOT NULL CHECK(status IN ('pending','consumed','held','withdrawn')), value TEXT NOT NULL, UNIQUE(source_id,member_id));
      CREATE TABLE IF NOT EXISTS cc_claims (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES cc_sources(id), source_revision INTEGER NOT NULL, targets TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_batches (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES cc_sources(id), claim_id TEXT NOT NULL REFERENCES cc_claims(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_invocations (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES cc_conversations(id), batch_id TEXT NOT NULL REFERENCES cc_batches(id), member_id TEXT NOT NULL REFERENCES cc_members(id), response_id TEXT NOT NULL UNIQUE, account_snapshot TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_responses (id TEXT PRIMARY KEY, invocation_id TEXT NOT NULL UNIQUE REFERENCES cc_invocations(id), conversation_id TEXT NOT NULL REFERENCES cc_conversations(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_consumptions (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES cc_sources(id), delivery_id TEXT NOT NULL UNIQUE REFERENCES cc_deliveries(id), response_id TEXT NOT NULL REFERENCES cc_responses(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_failure_proofs (source_id TEXT NOT NULL REFERENCES cc_sources(id), response_id TEXT NOT NULL REFERENCES cc_responses(id), value TEXT NOT NULL, PRIMARY KEY(source_id,response_id));
      CREATE TABLE IF NOT EXISTS cc_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES cc_conversations(id), response_id TEXT UNIQUE, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_evidence (id TEXT PRIMARY KEY, invocation_id TEXT NOT NULL REFERENCES cc_invocations(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cc_events (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES cc_conversations(id), type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS cc_sources_conversation ON cc_sources(conversation_id,sequence);
      CREATE INDEX IF NOT EXISTS cc_delivery_status ON cc_deliveries(status,source_id);
      CREATE INDEX IF NOT EXISTS cc_invocation_member ON cc_invocations(conversation_id,member_id);
      CREATE INDEX IF NOT EXISTS cc_event_conversation ON cc_events(conversation_id,id);
      CREATE INDEX IF NOT EXISTS cc_messages_conversation ON cc_messages(conversation_id);
    `);
    this.migrate();
    this.tx(() => {
      for (const a of [ { id: 'codex-cli', name: 'Codex 官方 CLI 登录', provider: 'codex', auth: 'cli', revision: 1 }, { id: 'claude-cli', name: 'Claude Code 官方 CLI 登录', provider: 'claude', auth: 'cli', revision: 1 } ] satisfies CollaborationAccount[]) this.db.prepare('INSERT OR IGNORE INTO cc_accounts VALUES(?,?)').run(a.id, JSON.stringify(a));
      for (const m of [{ id: 'codex', name: 'Codex', carrier: 'codex-app-server', accountId: 'codex-cli', enabled: true, revision: 1, instructions: '依据用户目标开展工作，必要时通过 collaboration_request 请求其他成员协作。不要把普通提及当作已交接。' }, { id: 'claude', name: 'Claude Code', carrier: 'claude-cli', accountId: 'claude-cli', enabled: true, revision: 1, instructions: '依据用户目标开展工作，必要时通过 collaboration_request 请求其他成员协作。普通完成后等待用户，除非有明确新的协作请求。' }] satisfies Member[]) this.db.prepare('INSERT OR IGNORE INTO cc_members VALUES(?,?,?)').run(m.id, m.accountId, JSON.stringify(m));
    });
  }
  private migrate(): void {
    this.tx(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS cc_schema (version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS cc_meta (key TEXT PRIMARY KEY,value INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS cc_contracts (id TEXT PRIMARY KEY,invocation_id TEXT NOT NULL UNIQUE REFERENCES cc_invocations(id),value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cc_routing (id TEXT PRIMARY KEY,source_id TEXT NOT NULL UNIQUE REFERENCES cc_sources(id),value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cc_manifests (id TEXT PRIMARY KEY,invocation_id TEXT NOT NULL UNIQUE REFERENCES cc_invocations(id),value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cc_payloads (id TEXT PRIMARY KEY,prompt TEXT NOT NULL,digest TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cc_recovery_checks (id TEXT PRIMARY KEY,invocation_id TEXT NOT NULL REFERENCES cc_invocations(id),value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cc_hold_rechecks (id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL REFERENCES cc_deliveries(id),value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cc_native_sessions (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES cc_conversations(id), member_id TEXT NOT NULL REFERENCES cc_members(id), sequence INTEGER NOT NULL, value TEXT NOT NULL, UNIQUE(conversation_id,member_id,sequence));
        CREATE TABLE IF NOT EXISTS cc_ordinary_tasks (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES cc_conversations(id), value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS cc_task_handoffs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES cc_ordinary_tasks(id), conversation_id TEXT NOT NULL REFERENCES cc_conversations(id), value TEXT NOT NULL);`);
      for (const table of ['cc_artifacts', 'cc_artifact_versions', 'cc_artifact_approvals', 'cc_managed_jobs', 'cc_artifact_reviews', 'cc_runtime_interactions']) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES cc_conversations(id), value TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ${table}_conversation ON ${table}(conversation_id)`);
      this.db.exec('CREATE TABLE IF NOT EXISTS cc_artifact_contents(version_id TEXT PRIMARY KEY REFERENCES cc_artifact_versions(id), content TEXT NOT NULL)');
      const version = (this.db.prepare('SELECT version FROM cc_schema').get() as { version: number } | undefined)?.version ?? 1;
      if (version > 5) throw new AppError(503, '数据库版本较新，当前服务不能安全启动。', 'schema_not_supported');
      this.db.prepare('INSERT OR IGNORE INTO cc_meta VALUES(?,?)').run('configuration_revision', 1);
      if (version === 5) return;
      if (version === 2 || version === 3 || version === 4) { this.db.exec('UPDATE cc_schema SET version=5'); return; }
      for (const table of ['cc_members', 'cc_accounts', 'cc_conversations']) for (const row of this.rows<{ id: string; revision?: number }>(table)) { row.revision ??= 1; this.put(table, row); }
      for (const row of this.db.prepare('SELECT rowid,value FROM cc_messages').all() as { rowid: number; value: string }[]) {
        const m = JSON.parse(row.value) as ConversationMessage; m.sequence = Number(row.rowid); this.put('cc_messages', m);
      }
      for (const i of this.invocations()) {
        i.invocationRevision ??= 1; i.cancelRevision ??= ['cancelled', 'cancel_requested'].includes(i.status) ? 1 : 0;
        if (i.status === 'interrupted') { i.interruptionCause = 'legacy_unknown'; i.recoveryState = 'pending'; }
        else i.recoveryState ??= 'none';
        const batch = this.get<DispatchBatch>('cc_batches', i.batchId);
        batch.historyCutoff ??= this.messageCursor(i.conversationId); this.put('cc_batches', batch);
        const c = this.makeContract(i, batch, 'legacy_reconstructed');
        c.toolPolicyVersion = 'readonly-v1'; c.adapterCapabilityVersion = 'native-fresh-v1'; c.behaviorVersion = '0.2.1'; c.contextPolicyVersion = 'legacy-history-40-v1'; c.routingPolicyVersion = 'legacy-default-v1';
        if (i.dispatchStarted) { c.workspaceScope = ''; c.roster = []; c.historyMessageIds = []; c.historySnapshot = []; c.historySourceSnapshots = []; }
        this.db.prepare('INSERT INTO cc_contracts VALUES(?,?,?)').run(c.id, i.id, JSON.stringify(c));
        i.contractId = c.id; this.put('cc_invocations', i);
      }
      this.db.exec('DELETE FROM cc_schema; INSERT INTO cc_schema VALUES(5)');
    });
  }
  configurationRevision(): number { return (this.db.prepare('SELECT value FROM cc_meta WHERE key=?').get('configuration_revision') as { value: number }).value; }
  private configurationChanged(): void { this.db.prepare('UPDATE cc_meta SET value=value+1 WHERE key=?').run('configuration_revision'); }
  private messageCursor(conversationId: string): number { return Number((this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM cc_messages WHERE conversation_id=?').get(conversationId) as { n: number }).n); }
  private saveInvocation(i: CollaborationInvocation): void { i.invocationRevision = (i.invocationRevision ?? 0) + 1; this.put('cc_invocations', i); }
  contract(invocationId: string): ExecutionContractSnapshot {
    const c = this.rows<ExecutionContractSnapshot>('cc_contracts', 'WHERE invocation_id=?', [invocationId])[0];
    if (!c) throw new AppError(503, '执行缺少冻结契约，不能安全启动。', 'contract_not_supported'); return c;
  }
  private makeContract(i: CollaborationInvocation, batch: DispatchBatch, snapshotOrigin: ExecutionContractSnapshot['snapshotOrigin'] = 'admission'): ExecutionContractSnapshot {
    const detail = this.detail(i.conversationId); const source = detail.sources.find(s => s.id === batch.sourceId)!;
    const consumed = new Set(detail.consumptions.filter(c => c.memberId === i.memberId).map(c => c.sourceId));
    const cutoff = batch.historyCutoff ?? this.messageCursor(i.conversationId);
    const historySnapshot = detail.messages.filter(m => (m.sequence ?? 0) <= cutoff && m.sourceId !== source.id && (m.responseId ? detail.responses.some(r => r.id === m.responseId && terminal.has(r.status)) : (snapshotOrigin === 'admission' && m.author === 'user') || !!m.sourceId && consumed.has(m.sourceId) && detail.sources.some(s => s.id === m.sourceId && s.sequence < source.sequence)));
    const historyMessageIds = historySnapshot.map(m => m.id);
    const historySourceIds = new Set(historySnapshot.flatMap(m => m.sourceId ? [m.sourceId] : []));
    const historySourceSnapshots: NonNullable<ExecutionContractSnapshot['historySourceSnapshots']> = detail.sources.filter(s => historySourceIds.has(s.id)).map(s => ({
      sourceId: s.id, sourceRevision: s.revision, requestedTargets: [...s.requestedTargets], visibilityOnly: true,
      deliveries: detail.deliveries.filter(d => d.sourceId === s.id).map(d => ({
        deliveryId: d.id, memberId: d.memberId, status: d.status, revision: d.revision,
        ...(d.responseId ? { responseId: d.responseId } : {}), ...(d.holdReason ? { holdReason: d.holdReason } : {}),
        consumptions: detail.consumptions.filter(c => c.sourceId === s.id && c.deliveryId === d.id && c.memberId === d.memberId).map(c => ({ id: c.id, responseId: c.responseId, kind: c.kind })),
      })),
    }));
    const routing = detail.routingDecisions?.find(r => r.sourceId === source.id);
    return { id: id(), invocationId: i.id, behaviorVersion: '0.6.0', routingDecisionId: routing?.id, routingPolicyVersion: routing?.policyVersion ?? 'a2a-exact-v1', contextPolicyVersion: 'bounded-public-context-artifacts-v3', toolPolicyVersion: 'managed-artifacts-v1', adapterCapabilityVersion: 'native-continuity-v1', memberSnapshot: structuredClone(i.member), accountMetadataSnapshot: this.accountFor(i.id), workspaceScope: this.options.workspace ?? '', roster: this.members().filter(m => detail.conversation.memberIds.includes(m.id)), historyCutoff: cutoff, historyMessageIds, historySnapshot, historySourceSnapshots, sourceRevision: source.revision, sourceDigest: hash(source.content), ...(source.taskRef ? { taskSnapshot: this.tasks.getTask(source.taskRef.taskId) } : {}), ...(source.reviewRef ? { reviewSnapshot: this.artifacts.review(source.reviewRef.reviewId) } : {}), createdAt: now(), snapshotOrigin };
  }
  private validateContract(c: ExecutionContractSnapshot): void {
    if (!['0.2.1', '0.3.0', '0.4.0', '0.5.0', '0.6.0'].includes(c.behaviorVersion) || !['legacy-history-40-v1', CONTEXT_POLICY_VERSION, 'bounded-public-context-tasks-v2', 'bounded-public-context-artifacts-v3'].includes(c.contextPolicyVersion) || !['readonly-v1', 'readonly-tasks-v1', 'managed-artifacts-v1'].includes(c.toolPolicyVersion) || !['native-fresh-v1', 'native-continuity-v1'].includes(c.adapterCapabilityVersion)) throw new AppError(503, '此执行的冻结规则版本不受当前服务支持，已保留待处理。', 'contract_not_supported');
  }
  blockInvocation(invocationId: string, reason: string): void { this.tx(() => { const i = this.invocation(invocationId); if (i.status !== 'prepared' || i.dispatchStarted) return; i.blockedReason = reason; this.saveInvocation(i); this.event(i.conversationId, 'invocation.blocked', { invocationId, reason }); }); }
  private tx<T>(fn: () => T): T {
    if (this.emitted) return fn();
    this.owner.assertLease(); this.db.exec('BEGIN IMMEDIATE'); this.emitted = [];
    let events: CollaborationEvent[]; let result: T;
    try { this.owner.assertLease(); result = fn(); this.db.exec('COMMIT'); events = this.emitted; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    finally { this.emitted = undefined; }
    for (const listener of this.listeners) { try { listener(events!); } catch { /* Replay committed events. */ } }
    return result!;
  }
  private rows<T>(table: string, where = '', args: SQLInputValue[] = []): T[] { return (this.db.prepare(`SELECT value FROM ${table} ${where}`).all(...args) as { value: string }[]).map(r => JSON.parse(r.value) as T); }
  private get<T>(table: string, key: string): T { const item = this.rows<T>(table, 'WHERE id=?', [key])[0]; if (!item) throw new AppError(404, 'Record not found.', 'not_found'); return item; }
  private put(table: string, value: { id: string }): void { this.db.prepare(`UPDATE ${table} SET value=? WHERE id=?`).run(JSON.stringify(value), value.id); }
  private event(conversationId: string, type: string, data: Record<string, unknown>): void {
    const createdAt = now(); const inserted = this.db.prepare('INSERT INTO cc_events(conversation_id,type,data,created_at) VALUES(?,?,?,?)').run(conversationId, type, JSON.stringify(data), createdAt);
    this.emitted!.push({ id: Number(inserted.lastInsertRowid), conversationId, type, data, createdAt });
  }
  subscribe(listener: (events: CollaborationEvent[]) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  events(after = 0, conversationId?: string, limit = -1): CollaborationEvent[] {
    const rows = this.db.prepare(`SELECT * FROM cc_events WHERE id>? ${conversationId ? 'AND conversation_id=?' : ''} ORDER BY id LIMIT ?`).all(...(conversationId ? [after, conversationId, limit] : [after, limit])) as { id: number; conversation_id: string; type: string; data: string; created_at: string }[];
    return rows.map(r => ({ id: Number(r.id), conversationId: r.conversation_id, type: r.type, data: JSON.parse(r.data), createdAt: r.created_at }));
  }
  cursor(): number { return Number((this.db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM cc_events').get() as { n: number }).n); }
  accounts(): CollaborationAccount[] { return this.rows('cc_accounts', 'ORDER BY rowid'); }
  members(): Member[] { return this.rows('cc_members', 'ORDER BY rowid'); }
  list(): Conversation[] { return this.rows<Conversation>('cc_conversations', 'ORDER BY rowid DESC'); }
  saveAccount(input: CollaborationAccount): CollaborationAccount {
    checkText(input.id, 'id', 100); checkText(input.name, 'name', 100);
    if (!['codex', 'claude', 'openai', 'anthropic'].includes(input.provider) || !['cli', 'api'].includes(input.auth)) throw new AppError(400, 'Unsupported account.');
    if (input.auth === 'cli' && !['codex', 'claude'].includes(input.provider)) throw new AppError(400, 'Only native CLI runtimes support official CLI login.');
    if (input.auth === 'api' && (!input.apiKeyEnv || !/^[A-Z_][A-Z0-9_]{0,100}$/.test(input.apiKeyEnv))) throw new AppError(400, 'API account requires an environment variable reference.');
    if (input.auth === 'api' && ['codex', 'claude'].includes(input.provider) && !input.baseUrl?.trim()) throw new AppError(400, 'CLI API accounts require an explicit API base URL.');
    if (input.baseUrl) { try { const url = new URL(input.baseUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('invalid URL'); } catch { throw new AppError(400, 'Invalid API base URL.'); } }
    const account: CollaborationAccount = { id: input.id, name: input.name, provider: input.provider, auth: input.auth, ...(input.auth === 'api' ? { apiKeyEnv: input.apiKeyEnv, ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}) } : {}) };
    return this.tx(() => { const old = this.accounts().find(a => a.id === input.id); if (old && (old.auth !== input.auth || old.provider !== input.provider) && this.members().some(m => m.accountId === input.id)) throw new AppError(409, 'Referenced account cannot change authentication kind.'); account.revision = (old?.revision ?? 0) + 1; this.db.prepare('INSERT INTO cc_accounts VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(account.id, JSON.stringify(account)); this.configurationChanged(); return account; });
  }
  saveMember(input: Member): Member {
    checkText(input.id, 'id', 100); checkText(input.name, 'name', 100); if (typeof input.instructions !== 'string' || input.instructions.length > 10000) throw new AppError(400, 'instructions must contain at most 10000 characters.');
    if (!/^[A-Za-z0-9_-]+$/.test(input.id) || !supported.includes(input.carrier) || typeof input.enabled !== 'boolean') throw new AppError(400, 'Invalid member.');
    if (input.model !== undefined) checkText(input.model, 'model', 200);
    const account = this.get<CollaborationAccount>('cc_accounts', input.accountId);
    const expected = { 'codex-app-server': 'codex', 'claude-cli': 'claude', 'openai-api': 'openai', 'anthropic-api': 'anthropic' }[input.carrier];
    if (account.provider !== expected) throw new AppError(400, 'Member runtime and account do not match.');
    if (account.auth === 'api' && !input.model?.trim()) throw new AppError(400, 'API 认证的成员需要明确填写模型名称。');
    const member: Member = { id: input.id, name: input.name, instructions: input.instructions, carrier: input.carrier, accountId: input.accountId, enabled: input.enabled, ...(input.model ? { model: input.model } : {}) };
    return this.tx(() => { member.revision = (this.members().find(m => m.id === member.id)?.revision ?? 0) + 1; this.db.prepare('INSERT INTO cc_members VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,value=excluded.value').run(member.id, member.accountId, JSON.stringify(member)); this.configurationChanged(); return member; });
  }
  private command<T>(requestId: string, input: unknown, work: () => T): { result: T; replayed: boolean } {
    checkText(requestId, 'requestId', 250); const digest = hash(input);
    const old = this.db.prepare('SELECT digest,result FROM cc_commands WHERE request_id=?').get(requestId) as { digest: string; result: string } | undefined;
    if (old) { if (old.digest !== digest) throw new AppError(409, 'Request ID has different content.', 'idempotency_conflict'); return { result: JSON.parse(old.result) as T, replayed: true }; }
    const result = work(); this.db.prepare('INSERT INTO cc_commands VALUES(?,?,?)').run(requestId, digest, JSON.stringify(result)); return { result, replayed: false };
  }
  create(input: CreateConversation): { conversation: Conversation; replayed: boolean } {
    checkText(input.title, 'title', 200);
    if (!Array.isArray(input.memberIds) || input.memberIds.length < 1 || input.memberIds.length > 12 || new Set(input.memberIds).size !== input.memberIds.length || !input.memberIds.includes(input.defaultMemberId)) throw new AppError(400, 'Invalid conversation members.');
    return this.tx(() => {
      const result = this.command(`conversation:${input.requestId}`, input, () => {
        for (const memberId of input.memberIds) if (!this.get<Member>('cc_members', memberId).enabled) throw new AppError(400, 'Member disabled.');
        const createdAt = now(); const conversation: Conversation = { id: id(), title: input.title, memberIds: [...input.memberIds], defaultMemberId: input.defaultMemberId, createdAt, updatedAt: createdAt, revision: 1 };
        this.db.prepare('INSERT INTO cc_conversations VALUES(?,?)').run(conversation.id, JSON.stringify(conversation)); this.event(conversation.id, 'conversation.created', { conversationId: conversation.id }); return conversation;
      }); return { conversation: result.result, replayed: result.replayed };
    });
  }
  updateConversation(conversationId: string, input: { memberIds: string[]; defaultMemberId: string; preferredMemberIds?: string[]; routingMode?: 'normal' | 'concierge' }): Conversation {
    if (!Array.isArray(input.memberIds) || input.memberIds.length < 1 || input.memberIds.length > 12 || new Set(input.memberIds).size !== input.memberIds.length || !input.memberIds.includes(input.defaultMemberId)) throw new AppError(400, 'Invalid conversation members.');
    return this.tx(() => {
      const detail = this.detail(conversationId);
      if (input.preferredMemberIds && (new Set(input.preferredMemberIds).size !== input.preferredMemberIds.length || input.preferredMemberIds.some(m => !input.memberIds.includes(m)))) throw new AppError(400, '偏好成员必须属于会话且不重复。');
      if (input.routingMode !== undefined && !['normal', 'concierge'].includes(input.routingMode)) throw new AppError(400, '路由模式无效。');
      for (const memberId of input.memberIds) if (!this.get<Member>('cc_members', memberId).enabled) throw new AppError(400, 'Member disabled.');
      const removed = detail.conversation.memberIds.filter(m => !input.memberIds.includes(m));
      if (detail.deliveries.some(d => removed.includes(d.memberId) && ['pending', 'held'].includes(d.status)) || detail.invocations.some(i => removed.includes(i.memberId) && this.busy(i))) throw new AppError(409, 'A removed member still owns pending or active work.');
      const conversation = { ...detail.conversation, memberIds: [...input.memberIds], defaultMemberId: input.defaultMemberId, ...(input.preferredMemberIds ? { preferredMemberIds: [...input.preferredMemberIds] } : { preferredMemberIds: detail.conversation.preferredMemberIds?.filter(m => input.memberIds.includes(m)) }), ...(input.routingMode ? { routingMode: input.routingMode } : {}), updatedAt: now(), revision: (detail.conversation.revision ?? 1) + 1 };
      this.put('cc_conversations', conversation); this.configurationChanged(); this.event(conversationId, 'conversation.updated', { memberIds: input.memberIds, defaultMemberId: input.defaultMemberId }); return conversation;
    });
  }
  /** User mentions are routing, without any extra composer selectors. */
  mentions(content: string, conversationId: string, lineStart = false): string[] {
    const conversation = this.get<Conversation>('cc_conversations', conversationId);
    return parseMentions(content, conversation, this.members(), lineStart);
  }
  previewRoute(conversationId: string, content: string): RoutingDecision {
    checkText(content, 'content'); const detail = this.detail(conversationId);
    const messages = detail.messages.map(m => { const decision = detail.routingDecisions?.find(r => r.sourceId === m.sourceId); return { ...m, ...(decision?.reason === 'explicit_mention' ? { explicitTargets: decision.targets } : {}) }; });
    const routing = resolveRouting({ content, conversation: detail.conversation, members: this.members(), messages, responses: detail.responses, historyCursor: this.messageCursor(conversationId), configurationRevision: this.configurationRevision() });
    return { id: hash({ conversationId, content, ...routing }), ...routing };
  }
  send(conversationId: string, input: SendMessage): { source: SourceWork; routing?: RoutingDecision; replayed: boolean } {
    checkText(input.content, 'content'); checkText(input.requestId, 'requestId', 200);
    return this.tx(() => {
      const result = this.command(`message:${input.requestId}`, { conversationId, ...input }, () => {
        const routing = this.previewRoute(conversationId, input.content);
        const source = this.addSource({ conversationId, kind: 'user', content: input.content, requestedTargets: routing.targets, depth: 0 });
        routing.id = id(); routing.sourceId = source.id; source.routingDecisionId = routing.id;
        this.db.prepare('INSERT INTO cc_routing VALUES(?,?,?)').run(routing.id, source.id, JSON.stringify(routing)); this.put('cc_sources', source);
        this.addMessage({ conversationId, author: 'user', sourceId: source.id, content: input.content }); return source;
      }); return { source: result.result, routing: this.rows<RoutingDecision>('cc_routing', 'WHERE source_id=?', [result.result.id])[0], replayed: result.replayed };
    });
  }
  private addMessage(message: Omit<ConversationMessage, 'id' | 'createdAt'>): void {
    const value: ConversationMessage = { ...message, id: id(), createdAt: now() };
    const inserted = this.db.prepare('INSERT INTO cc_messages VALUES(?,?,?,?)').run(value.id, value.conversationId, value.responseId ?? null, JSON.stringify(value));
    value.sequence = Number(inserted.lastInsertRowid); this.put('cc_messages', value);
    const c = this.get<Conversation>('cc_conversations', value.conversationId); c.updatedAt = value.createdAt; this.put('cc_conversations', c);
  }
  private addSource(input: Pick<SourceWork, 'conversationId' | 'kind' | 'content' | 'requestedTargets' | 'depth'> & Partial<Pick<SourceWork, 'id' | 'parentInvocationId' | 'authorMemberId' | 'taskRef' | 'reviewRef'>>): SourceWork {
    const conversation = this.get<Conversation>('cc_conversations', input.conversationId);
    if (!input.requestedTargets.length || input.requestedTargets.some(t => !conversation.memberIds.includes(t))) throw new AppError(400, 'Targets must belong to this conversation.');
    const sequence = Number((this.db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM cc_sources').get() as { n: number }).n);
    const source: SourceWork = { ...input, id: input.id ?? id(), requestedTargets: [...new Set(input.requestedTargets)], bindingState: 'bound', revision: 1, sequence, createdAt: now() };
    this.db.prepare('INSERT INTO cc_sources VALUES(?,?,?,?)').run(source.id, source.conversationId, sequence, JSON.stringify(source));
    for (const memberId of source.requestedTargets) {
      const enabled = this.get<Member>('cc_members', memberId).enabled;
      const delivery: Delivery = { id: id(), sourceId: source.id, memberId, status: enabled ? 'pending' : 'held', ...(enabled ? {} : { holdReason: '成员已禁用；需要显式恢复。' }), revision: 1 };
      this.db.prepare('INSERT INTO cc_deliveries VALUES(?,?,?,?,?,?)').run(delivery.id, source.id, memberId, null, delivery.status, JSON.stringify(delivery));
    }
    this.event(source.conversationId, 'source.admitted', { sourceId: source.id, kind: source.kind, targets: source.requestedTargets }); return source;
  }
  detail(conversationId: string): ConversationDetail {
    const conversation = this.get<Conversation>('cc_conversations', conversationId);
    const sources = this.rows<SourceWork>('cc_sources', 'WHERE conversation_id=? ORDER BY sequence', [conversationId]);
    const sourcesIds = new Set(sources.map(s => s.id)); const invocations = this.invocations(conversationId); const invocationIds = new Set(invocations.map(i => i.id));
    return { conversation, ...this.artifacts.detail(conversationId), interactions: this.interactions.list(conversationId), messages: this.rows<ConversationMessage>('cc_messages', 'WHERE conversation_id=? ORDER BY rowid', [conversationId]), sources,
      deliveries: this.rows<Delivery>('cc_deliveries', 'ORDER BY rowid').filter(d => sourcesIds.has(d.sourceId)), batches: this.rows<DispatchBatch>('cc_batches', 'ORDER BY rowid').filter(b => sourcesIds.has(b.sourceId)), invocations,
      responses: this.rows<CollaborationResponse>('cc_responses', 'WHERE conversation_id=? ORDER BY rowid', [conversationId]), consumptions: this.rows<Consumption>('cc_consumptions', 'ORDER BY rowid').filter(c => sourcesIds.has(c.sourceId)),
      evidence: this.rows<AcceptanceEvidence>('cc_evidence', 'ORDER BY rowid').filter(e => invocationIds.has(e.invocationId)), events: this.events(0, conversationId),
      contracts: this.rows<ExecutionContractSnapshot>('cc_contracts').filter(c => invocationIds.has(c.invocationId)),
      inputManifests: this.rows<InputManifest>('cc_manifests').filter(m => invocationIds.has(m.invocationId)),
      routingDecisions: this.rows<RoutingDecision>('cc_routing').filter(r => r.sourceId && sourcesIds.has(r.sourceId)),
      recoveryChecks: this.rows<RecoveryCheck>('cc_recovery_checks').filter(r => invocationIds.has(r.invocationId)),
      nativeSessions: this.nativeSessions(conversationId), tasks: this.tasks.list(conversationId), taskHandoffs: this.tasks.handoffs(conversationId), responsibility: this.tasks.projection(conversationId),
      holdRechecks: this.rows<HoldRecheck>('cc_hold_rechecks').filter(r => sourcesIds.has(r.sourceId)) };
  }
  invocations(conversationId?: string): CollaborationInvocation[] { return this.rows('cc_invocations', conversationId ? 'WHERE conversation_id=? ORDER BY rowid' : 'ORDER BY rowid', conversationId ? [conversationId] : []); }
  invocation(invocationId: string): CollaborationInvocation { return this.get('cc_invocations', invocationId); }
  bindToolCall(invocationId: string, name: string, args: Record<string, unknown>, callId: string): void {
    checkText(callId, 'tool call identity', 200);
    this.tx(() => this.command(`runtime-tool-binding:${invocationId}:${callId}`, { name, args }, () => ({ registered: true })));
  }
  response(responseId: string): CollaborationResponse { return this.get('cc_responses', responseId); }
  accountFor(invocationId: string): CollaborationAccount { return JSON.parse((this.db.prepare('SELECT account_snapshot FROM cc_invocations WHERE id=?').get(invocationId) as { account_snapshot: string }).account_snapshot); }
  private saveDelivery(delivery: Delivery): void { this.db.prepare('UPDATE cc_deliveries SET status=?,response_id=?,value=? WHERE id=?').run(delivery.status, delivery.responseId ?? null, JSON.stringify(delivery), delivery.id); }
  private busy(i: CollaborationInvocation): boolean { return !terminal.has(i.status) || i.teardown !== 'confirmed'; }
  /** Reads and claims synchronously under the same write lock: there is no async resolver snapshot. */
  admitNext(): Admission | undefined {
    return this.tx(() => {
      this.tasks.reconcile(); this.artifacts.sweep(); this.interactions.sweep();
      for (const conversation of this.list().reverse()) {
        const detail = this.detail(conversation.id); const busy = new Set(detail.invocations.filter(i => this.busy(i)).map(i => i.memberId)); const held = new Set<string>();
        for (const source of detail.sources) {
          const outstanding = detail.deliveries.filter(d => d.sourceId === source.id && ['pending', 'held'].includes(d.status)); if (!outstanding.length) continue;
          const taskHold = this.tasks.admissionReason(source) ?? this.artifacts.admissionReason(source);
          if (taskHold) { for (const d of outstanding) if (d.status === 'pending') { d.status = 'held'; d.holdReason = taskHold; d.revision++; this.saveDelivery(d); } continue; }
          // Bound recipients never silently fall back to a new default member.
          for (const d of outstanding) if (d.status === 'pending' && !this.get<Member>('cc_members', d.memberId).enabled) { d.status = 'held'; d.holdReason = '成员已禁用；需要显式恢复。'; d.revision++; this.saveDelivery(d); this.event(conversation.id, 'delivery.held', { deliveryId: d.id }); }
          const eligible = outstanding.filter(d => d.status === 'pending'); if (!eligible.length) continue;
          const targets = outstanding.some(d => d.status === 'held') ? eligible.slice(0, 1) : eligible;
          if (targets.some(d => busy.has(d.memberId) || held.has(d.memberId))) { for (const d of targets) held.add(d.memberId); continue; }
          const claimId = id(); const createdAt = now();
          this.db.prepare('INSERT INTO cc_claims VALUES(?,?,?,?,?)').run(claimId, source.id, source.revision, JSON.stringify(targets.map(d => d.memberId)), createdAt);
          const batch: DispatchBatch = { id: id(), sourceId: source.id, targets: targets.map(d => d.memberId), mode: targets.length > 1 ? 'parallel' : 'serial', createdAt, historyCutoff: this.messageCursor(conversation.id) };
          this.db.prepare('INSERT INTO cc_batches VALUES(?,?,?,?)').run(batch.id, source.id, claimId, JSON.stringify(batch));
          const invocations: CollaborationInvocation[] = [];
          for (const delivery of targets) {
            const member = this.get<Member>('cc_members', delivery.memberId); const account = this.get<CollaborationAccount>('cc_accounts', member.accountId);
            const invocation: CollaborationInvocation = { id: id(), conversationId: conversation.id, batchId: batch.id, responseId: id(), memberId: member.id, member, status: 'prepared', acceptance: 'unknown', continuity: 'unknown', teardown: 'unknown', dispatchStarted: false, createdAt, invocationRevision: 1, cancelRevision: 0, recoveryState: 'none' };
            const response: CollaborationResponse = { id: invocation.responseId, invocationId: invocation.id, conversationId: conversation.id, memberId: member.id, status: 'prepared', content: '', inputSourceIds: [source.id], inputRevision: 1, createdAt };
            this.db.prepare('INSERT INTO cc_invocations VALUES(?,?,?,?,?,?,?)').run(invocation.id, invocation.conversationId, batch.id, member.id, response.id, JSON.stringify(account), JSON.stringify(invocation));
            this.db.prepare('INSERT INTO cc_responses VALUES(?,?,?,?)').run(response.id, invocation.id, conversation.id, JSON.stringify(response));
            const consumption: Consumption = { id: id(), sourceId: source.id, deliveryId: delivery.id, memberId: member.id, responseId: response.id, kind: 'prompt', createdAt };
            this.db.prepare('INSERT INTO cc_consumptions VALUES(?,?,?,?,?)').run(consumption.id, source.id, delivery.id, response.id, JSON.stringify(consumption));
            if ((source.kind === 'a2a' || source.kind === 'mention') && source.authorMemberId && source.parentInvocationId) {
              const proof: FailureProof = { sourceId: source.id, responseId: response.id, invocationId: invocation.id, callerMemberId: source.authorMemberId, callerInvocationId: source.parentInvocationId, identity: 'strict' };
              this.db.prepare('INSERT INTO cc_failure_proofs VALUES(?,?,?)').run(source.id, response.id, JSON.stringify(proof));
            }
            delivery.status = 'consumed'; delivery.responseId = response.id; delivery.revision++; this.saveDelivery(delivery);
            this.tasks.bindAdmission(source, invocation);
            const contract = this.makeContract(invocation, batch); invocation.contractId = contract.id;
            this.db.prepare('INSERT INTO cc_contracts VALUES(?,?,?)').run(contract.id, invocation.id, JSON.stringify(contract)); this.put('cc_invocations', invocation);
            invocations.push(invocation);
          }
          this.event(conversation.id, 'batch.admitted', { batchId: batch.id, sourceId: source.id, mode: batch.mode, targets: batch.targets, invocationIds: invocations.map(i => i.id) });
          return { batch, invocations };
        }
      }
      return undefined;
    });
  }
  nativeSessions(conversationId: string): NativeSessionBinding[] { return this.rows('cc_native_sessions', 'WHERE conversation_id=? ORDER BY rowid', [conversationId]); }
  /** Called after read-only runtime discovery, before dispatch. Replays retain the original plan. */
  prepareSession(invocationId: string, identity: NativeSessionIdentity): NativeSessionPlan {
    return this.tx(() => {
      const i = this.invocation(invocationId), c = this.contract(i.id);
      if (i.status !== 'prepared' || i.dispatchStarted) throw new AppError(409, '原生会话计划只能在派发前创建。');
      if (i.sessionPlan) return i.sessionPlan;
      const previous = this.nativeSessions(i.conversationId).filter(s => s.memberId === i.memberId).at(-1);
      const compatible = identity.supported && !!identity.fingerprint && !!i.member.model && c.adapterCapabilityVersion === 'native-continuity-v1';
      const fingerprint = sessionFingerprint(c, identity);
      if (compatible && previous?.status === 'ready' && previous.fingerprint === fingerprint && previous.nativeSessionId && previous.anchor) {
        const prior = this.invocation(previous.lastInvocationId);
        if (prior.status !== 'succeeded' || prior.acceptance !== 'accepted' || prior.teardown !== 'confirmed' || (prior.cancelRevision ?? 0) > 0) throw new AppError(409, '前序执行未安全释放，不能续接。');
        previous.status = 'reserved'; previous.lastInvocationId = i.id; previous.updatedAt = now(); this.put('cc_native_sessions', previous);
        i.sessionPlan = { bindingId: previous.id, mode: 'resume', nativeSessionId: previous.nativeSessionId, previousAnchor: previous.anchor, identity, reason: '前序执行成功并已退出，配置与原生身份兼容。' };
      } else if (c.adapterCapabilityVersion !== 'native-continuity-v1' || i.member.carrier.endsWith('-api')) {
        i.sessionPlan = { mode: 'unsupported', reason: c.adapterCapabilityVersion !== 'native-continuity-v1' ? '保留旧执行的 fresh 契约。' : '此 API 承载使用平台历史，不支持原生会话续接。' };
        if (previous && c.adapterCapabilityVersion === 'native-continuity-v1') { previous.status = 'sealed'; previous.reason = i.sessionPlan.reason; previous.updatedAt = now(); this.put('cc_native_sessions', previous); }
      } else {
        const reason = !compatible ? (!i.member.model ? '模型未固定，保守新建以避免默认模型变化。' : identity.reason) : !previous ? '本会话成员首次建立原生会话。' : previous.fingerprint !== fingerprint ? this.sessionChangeReason(previous, c, identity) : '前代缺少可安全续接的成功与历史证据。';
        if (previous) { previous.status = 'sealed'; previous.reason = reason; previous.updatedAt = now(); this.put('cc_native_sessions', previous); }
        const binding = this.newSession(i, fingerprint, identity, reason, previous);
        i.sessionPlan = { bindingId: binding.id, mode: previous ? 'replace' : 'fresh', reason, identity };
      }
      this.saveInvocation(i); this.event(i.conversationId, 'session.planned', { invocationId, ...i.sessionPlan }); return i.sessionPlan;
    });
  }
  private sessionChangeReason(previous: NativeSessionBinding, current: ExecutionContractSnapshot, identity: NativeSessionIdentity): string {
    const prior = this.contract(previous.lastInvocationId), reasons: string[] = [];
    if (hash(prior.accountMetadataSnapshot) !== hash(current.accountMetadataSnapshot)) reasons.push('账户配置变化');
    if (prior.memberSnapshot.carrier !== current.memberSnapshot.carrier) reasons.push('承载变化');
    if (prior.memberSnapshot.model !== current.memberSnapshot.model) reasons.push('模型变化');
    if (prior.memberSnapshot.instructions !== current.memberSnapshot.instructions) reasons.push('成员职责变化');
    if (prior.toolPolicyVersion !== current.toolPolicyVersion) reasons.push('工具权限变化');
    if (prior.workspaceScope !== current.workspaceScope) reasons.push('工作目录变化');
    if (prior.adapterCapabilityVersion !== current.adapterCapabilityVersion) reasons.push('适配策略变化');
    const oldIdentity = this.invocation(previous.lastInvocationId).sessionPlan?.identity;
    if (oldIdentity?.fingerprint !== identity.fingerprint) reasons.push(oldIdentity?.version !== identity.version ? 'CLI 版本变化' : '认证凭据、CLI 配置或目录身份变化');
    return `${reasons.join('；') || '兼容配置变化'}，封存旧代并新建。`;
  }
  private newSession(i: CollaborationInvocation, fingerprint: string, identity: NativeSessionIdentity, reason: string, previous?: NativeSessionBinding): NativeSessionBinding {
    const c = this.contract(i.id), createdAt = now();
    const b: NativeSessionBinding = { id: id(), conversationId: i.conversationId, memberId: i.memberId, sequence: (previous?.sequence ?? 0) + 1,
      ...(previous ? { previousBindingId: previous.id } : {}), status: 'reserved', reason, fingerprint, accountId: c.accountMetadataSnapshot.id,
      accountRevision: c.accountMetadataSnapshot.revision ?? 1, model: i.member.model, carrier: i.member.carrier, workspaceScope: c.workspaceScope,
      runtimeVersion: identity.version, lastInvocationId: i.id, createdAt, updatedAt: createdAt };
    this.db.prepare('INSERT INTO cc_native_sessions VALUES(?,?,?,?,?)').run(b.id, b.conversationId, b.memberId, b.sequence, JSON.stringify(b));
    return b;
  }
  private validateSessionEvent(i: CollaborationInvocation, e: RuntimeEvent): void {
    if (!i.sessionPlan?.bindingId) return;
    if (e.kind === 'session_replaced') {
      const exposed = this.rows<AcceptanceEvidence>('cc_evidence', 'WHERE invocation_id=?', [i.id]).some(x => x.kind === 'exposed' && x.detail.source !== 'platform_prompt');
      if (i.status !== 'running' || i.sessionPlan.mode !== 'resume' || i.acceptance === 'accepted' || exposed || e.detail.beforeInput !== true || e.detail.previousSessionId !== i.sessionPlan.nativeSessionId) throw new AppError(409, '输入发送后不能以重建会话重发。', 'session_replace_conflict');
    }
    if (e.kind === 'session' && typeof e.detail.nativeSessionId === 'string' && (i.nativeSessionId && i.nativeSessionId !== e.detail.nativeSessionId || i.sessionPlan.nativeSessionId && i.sessionPlan.nativeSessionId !== e.detail.nativeSessionId)) throw new AppError(409, '原生会话证据身份冲突。', 'session_identity_conflict');
    if (e.kind === 'session' && typeof e.detail.nativeSessionId === 'string' && this.rows<NativeSessionBinding>('cc_native_sessions').some(b => b.id !== i.sessionPlan?.bindingId && b.carrier === i.member.carrier && b.nativeSessionId === e.detail.nativeSessionId)) throw new AppError(409, '该原生会话已绑定其他成员或代次。', 'session_identity_conflict');
  }
  private applySessionEvent(i: CollaborationInvocation, e: AcceptanceEvidence): void {
    if (!i.sessionPlan?.bindingId || i.status !== 'running' || (i.cancelRevision ?? 0) > 0) return;
    let b = this.get<NativeSessionBinding>('cc_native_sessions', i.sessionPlan.bindingId);
    if (b.lastInvocationId !== i.id || b.status === 'sealed') return;
    if (e.kind === 'session_replaced') {
      b.status = 'sealed'; b.reason = String(e.detail.reason || '原生历史不可续接，输入发送前重建。'); b.updatedAt = now(); this.put('cc_native_sessions', b);
      b = this.newSession(i, b.fingerprint, i.sessionPlan.identity!, b.reason, b);
      i.sessionPlan = { bindingId: b.id, mode: 'replace', reason: b.reason, identity: i.sessionPlan.identity };
      this.event(i.conversationId, 'session.replaced', { invocationId: i.id, bindingId: b.id, previousBindingId: b.previousBindingId, reason: b.reason });
    }
    if (e.kind === 'session' && typeof e.detail.nativeSessionId === 'string') {
      b.nativeSessionId = e.detail.nativeSessionId;
      if (e.detail.historyVerified === true && typeof e.detail.anchor === 'string' && e.detail.anchor) { b.anchor = e.detail.anchor; b.evidenceId = e.id; }
      b.updatedAt = now(); this.put('cc_native_sessions', b);
    }
  }
  private settleSession(i: CollaborationInvocation): void {
    if (!i.sessionPlan?.bindingId) return;
    const b = this.get<NativeSessionBinding>('cc_native_sessions', i.sessionPlan.bindingId);
    if (b.lastInvocationId !== i.id || b.status === 'sealed') return;
    const evidence = b.evidenceId && this.get<AcceptanceEvidence>('cc_evidence', b.evidenceId);
    const ready = i.status === 'succeeded' && i.teardown === 'confirmed' && i.acceptance === 'accepted' && (i.cancelRevision ?? 0) === 0 &&
      i.sessionPlan.identity?.supported && !!i.member.model && evidence && evidence.invocationId === i.id && b.anchor && i.continuity !== 'unknown';
    b.status = ready ? 'ready' : 'sealed'; b.updatedAt = now();
    if (!ready) b.reason = '本轮未同时取得成功、真实退出及可续接历史证据，后续不复用此代。';
    this.put('cc_native_sessions', b); this.event(i.conversationId, 'session.settled', { invocationId: i.id, bindingId: b.id, status: b.status, reason: b.reason });
  }
  startInvocation(invocationId: string): CollaborationInvocation {
    return this.tx(() => { const i = this.invocation(invocationId); if (i.status !== 'prepared' || i.dispatchStarted) throw new AppError(409, 'Invocation cannot start again.'); this.validateContract(this.contract(i.id)); this.prepareInput(i.id); i.status = 'running'; i.dispatchStarted = true; i.startedAt = now(); this.saveInvocation(i); const r = this.response(i.responseId); r.status = 'running'; this.put('cc_responses', r); this.event(i.conversationId, 'invocation.dispatch_started', { invocationId }); return i; });
  }
  recordEvidence(invocationId: string, event: RuntimeEvent): void {
    this.tx(() => {
      const i = this.invocation(invocationId);
      this.validateSessionEvent(i, event);
      const evidence: AcceptanceEvidence = { id: id(), invocationId, kind: event.kind, detail: event.detail, createdAt: now() };
      this.db.prepare('INSERT INTO cc_evidence VALUES(?,?,?)').run(evidence.id, invocationId, JSON.stringify(evidence));
      if (event.kind === 'accepted') i.acceptance = 'accepted';
      if (event.kind === 'not_accepted' && i.acceptance !== 'accepted') i.acceptance = 'not_accepted';
      if ((event.kind === 'process_exit' || event.kind === 'transport_settled') && event.detail.confirmed === true) i.teardown = 'confirmed';
      if (event.kind === 'session') { if (typeof event.detail.nativeSessionId === 'string') i.nativeSessionId = event.detail.nativeSessionId; if (typeof event.detail.nativeTurnId === 'string') i.nativeTurnId = event.detail.nativeTurnId; if (event.detail.continuity === 'fresh' || event.detail.continuity === 'resumed') i.continuity = event.detail.continuity; }
      if (event.kind === 'usage') i.usage = nativeUsage(event.detail) ?? i.usage;
      this.applySessionEvent(i, evidence);
      this.saveInvocation(i); this.event(i.conversationId, 'invocation.evidence', { invocationId, evidenceId: evidence.id, kind: event.kind });
      this.tasks.onInvocationChanged(i);
    });
  }
  requestCollaboration(invocationId: string, callId: string, input: { targets: string[]; content: string }, maxDepth = 8): { sourceId: string; targets: string[]; replayed: boolean } {
    checkText(callId, 'callId', 200); checkText(input.content, 'content');
    return this.tx(() => {
      const i = this.invocation(invocationId);
      const result = this.command(`tool:${invocationId}:${callId}`, input, () => {
        if (i.status !== 'running') throw new AppError(409, 'Callback belongs to an inactive invocation.', 'stale_callback');
        if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 2 || new Set(input.targets).size !== input.targets.length || input.targets.includes(i.memberId)) throw new AppError(400, 'Select 1–2 other conversation members.');
        const batch = this.get<DispatchBatch>('cc_batches', i.batchId); const source = this.get<SourceWork>('cc_sources', batch.sourceId);
        if (this.rows<SourceWork>('cc_sources', 'WHERE conversation_id=?', [i.conversationId]).filter(s => s.parentInvocationId === i.id && s.kind === 'a2a').length >= 16) throw new AppError(409, 'Invocation collaboration request limit reached.', 'collaboration_limit');
        if (source.depth >= maxDepth) throw new AppError(409, 'Collaboration depth limit reached; wait for user input.', 'collaboration_limit');
        const target = this.addSource({ conversationId: i.conversationId, kind: 'a2a', content: input.content, requestedTargets: input.targets, parentInvocationId: i.id, authorMemberId: i.memberId, depth: source.depth + 1 });
        this.addMessage({ conversationId: i.conversationId, author: 'member', memberId: i.memberId, sourceId: target.id, content: input.content });
        return { sourceId: target.id, targets: target.requestedTargets };
      }); return { ...result.result, replayed: result.replayed };
    });
  }
  finish(invocationId: string, status: 'succeeded' | 'failed' | 'interrupted' | 'cancelled', content: string, expectedRevision?: number, maxDepth = 8): void {
    this.finishTransition(invocationId, status, content, expectedRevision, maxDepth);
  }
  private finishTransition(invocationId: string, status: 'succeeded' | 'failed' | 'interrupted' | 'cancelled', content: string, expectedRevision?: number, maxDepth = 8, recoveryId?: string): void {
    this.tx(() => {
      const i = this.invocation(invocationId); const response = this.response(i.responseId);
      if (recoveryId) {
        if (i.status !== 'interrupted' || !['service_restart', 'service_stop'].includes(i.interruptionCause ?? '') || i.recoveryState !== 'pending' || (i.cancelRevision ?? 0) !== 0) throw new AppError(409, '执行不允许修正终态，取消或既有结果不会被覆盖。', 'recovery_not_allowed');
        this.event(i.conversationId, 'recovery.previous_result', { invocationId, status: i.status, content: response.content, finishedAt: i.finishedAt, recoveryId });
      } else if (terminal.has(i.status)) { if (i.status === status && response.content === content) return; throw new AppError(409, 'Terminal replay conflicts with saved result.', 'terminal_conflict'); }
      if (expectedRevision !== undefined && response.inputRevision !== expectedRevision) throw new AppError(409, 'Response inputs changed.', 'inputs_changed');
      if (i.status === 'cancel_requested') { status = i.teardown === 'confirmed' ? 'cancelled' : 'interrupted'; content = '用户已请求停止；实际退出证据单独记录。'; }
      const callers = new Set<string>();
      if (status === 'failed') for (const proof of this.rows<FailureProof>('cc_failure_proofs', 'WHERE response_id=?', [response.id])) {
        const source = this.get<SourceWork>('cc_sources', proof.sourceId); const caller = this.invocation(proof.callerInvocationId);
        const receipt = this.rows<Consumption>('cc_consumptions', 'WHERE source_id=? AND response_id=?', [source.id, response.id])[0];
        const delivery = receipt && this.get<Delivery>('cc_deliveries', receipt.deliveryId);
        if (proof.invocationId !== i.id || proof.responseId !== response.id || proof.identity !== 'strict' || source.conversationId !== i.conversationId || caller.conversationId !== i.conversationId || caller.memberId !== proof.callerMemberId || source.authorMemberId !== caller.memberId || source.parentInvocationId !== caller.id || !response.inputSourceIds.includes(source.id) || receipt?.memberId !== i.memberId || delivery?.responseId !== response.id || delivery?.status !== 'consumed') throw new AppError(409, 'Failure return proof is inconsistent.', 'failure_proof_conflict');
        if (source.kind !== 'a2a_failure' && caller.memberId !== i.memberId) callers.add(caller.memberId);
      }
      i.status = status; i.finishedAt = now(); if (status !== 'succeeded') i.error = content; else delete i.error;
      if (status === 'interrupted') { i.interruptionCause ??= (i.cancelRevision ?? 0) > 0 ? 'user_cancel' : 'service_stop'; i.recoveryState = 'pending'; }
      if (recoveryId) { i.recoveryState = 'resolved'; i.resolutionId = recoveryId; }
      this.saveInvocation(i); this.settleSession(i);
      response.status = status; response.content = content; response.finishedAt = i.finishedAt; this.put('cc_responses', response);
      if (recoveryId) {
        const message = this.rows<ConversationMessage>('cc_messages', 'WHERE response_id=?', [response.id])[0];
        if (!message) throw new AppError(409, '恢复结果缺少原回复记录。', 'recovery_message_missing');
        message.content = content; this.put('cc_messages', message);
      } else this.addMessage({ conversationId: i.conversationId, author: 'member', memberId: i.memberId, responseId: response.id, content });
      const batch = this.get<DispatchBatch>('cc_batches', i.batchId); const source = this.get<SourceWork>('cc_sources', batch.sourceId);
      if (callers.size) this.addSource({ id: response.id, conversationId: i.conversationId, kind: 'a2a_failure', content: `成员 ${i.memberId} 的执行失败：${content}`, requestedTargets: [...callers], authorMemberId: i.memberId, depth: source.depth + 1 });
      if (status === 'succeeded') {
        const handingOff = new Set(this.tasks.handoffs(i.conversationId).filter(h => h.executionRef?.invocationId === i.id && ['waiting', 'applied'].includes(h.state)).map(h => h.toMemberId));
        const mentions = this.mentions(content, i.conversationId, true).filter(m => m !== i.memberId && !handingOff.has(m)).slice(0, 2);
        if (mentions.length && batch.mode === 'parallel') this.event(i.conversationId, 'routing.text_suppressed', { invocationId, reason: 'parallel_batch' });
        else if (mentions.length && source.depth < maxDepth) this.addSource({ conversationId: i.conversationId, kind: 'mention', content, requestedTargets: mentions, parentInvocationId: i.id, authorMemberId: i.memberId, depth: source.depth + 1 });
      }
      this.tasks.onInvocationChanged(i);
      this.event(i.conversationId, `invocation.${status}`, { invocationId, responseId: response.id, failureTargets: [...callers] });
    });
  }
  cancel(invocationId: string): void {
    this.tx(() => {
      const i = this.invocation(invocationId);
      // A service interruption is a stored terminal presentation, but a recovery decision
      // may still be in flight. Explicit cancellation must fence that pending decision.
      if (i.status === 'interrupted' && i.recoveryState === 'pending') {
        if (i.interruptionCause === 'user_cancel') return;
        i.cancelRevision = (i.cancelRevision ?? 0) + 1; i.interruptionCause = 'user_cancel'; this.saveInvocation(i);
        this.event(i.conversationId, 'invocation.cancel_requested', { invocationId, interruptedRecovery: true }); return;
      }
      if (terminal.has(i.status) || i.status === 'cancel_requested') return;
      i.status = 'cancel_requested'; i.cancelRevision = (i.cancelRevision ?? 0) + 1; i.interruptionCause = 'user_cancel';
      if (!i.dispatchStarted) i.teardown = 'confirmed'; this.saveInvocation(i);
      const r = this.response(i.responseId); r.status = i.status; this.put('cc_responses', r);
      this.event(i.conversationId, 'invocation.cancel_requested', { invocationId });
      if (!i.dispatchStarted) this.finish(i.id, 'cancelled', '用户取消了尚未开始的执行。');
    });
  }
  recover(): void {
    this.tx(() => {
      for (const i of this.invocations()) {
        if (terminal.has(i.status)) continue;
        if (i.status === 'prepared' && !i.dispatchStarted) continue; // Safe to start this exact persisted invocation.
        i.interruptionCause = (i.cancelRevision ?? 0) > 0 ? 'user_cancel' : 'service_restart'; this.saveInvocation(i);
        this.finish(i.id, i.status === 'cancel_requested' && i.teardown === 'confirmed' ? 'cancelled' : 'interrupted', '服务重启，原执行结果待核查；不会自动重发。');
      }
    });
  }
  private checkRecoveryVersion(invocationId: string, input: RecoveryRequest): CollaborationInvocation {
    const i = this.invocation(invocationId); const r = this.response(i.responseId);
    if ((i.invocationRevision ?? 1) !== input.expectedInvocationRevision || (i.cancelRevision ?? 0) !== input.expectedCancelRevision || r.inputRevision !== input.expectedInputRevision) throw new AppError(409, '执行状态已变化，请刷新后重新核查。', 'recovery_version_conflict');
    return i;
  }
  recoveryReplay(invocationId: string, input: RecoveryRequest): { check: RecoveryCheck; invocation: CollaborationInvocation; replayed: boolean } | undefined {
    checkText(input.requestId, 'requestId', 200);
    const row = this.db.prepare('SELECT digest,result FROM cc_commands WHERE request_id=?').get(`reconcile:${invocationId}:${input.requestId}`) as { digest: string; result: string } | undefined;
    if (row) { if (row.digest !== hash(input)) throw new AppError(409, '核查请求标识对应不同参数。', 'idempotency_conflict'); return { ...JSON.parse(row.result), replayed: true }; }
    this.checkRecoveryVersion(invocationId, input); return undefined;
  }
  resolveRecovery(invocationId: string, input: RecoveryRequest, observation: RuntimeInspection): { check: RecoveryCheck; invocation: CollaborationInvocation; replayed: boolean } {
    return this.tx(() => {
      const result = this.command(`reconcile:${invocationId}:${input.requestId}`, input, () => {
        let i = this.checkRecoveryVersion(invocationId, input);
        if (observation.invocationId !== i.id || observation.carrier !== i.member.carrier || (i.nativeSessionId && observation.nativeSessionId && i.nativeSessionId !== observation.nativeSessionId) || (i.nativeTurnId && observation.nativeTurnId && i.nativeTurnId !== observation.nativeTurnId)) throw new AppError(409, '核查证据不属于此准确执行。', 'recovery_identity_conflict');
        if ((observation.result || observation.teardown === 'confirmed') && ((i.nativeSessionId && observation.nativeSessionId !== i.nativeSessionId) || (i.nativeTurnId && observation.nativeTurnId !== i.nativeTurnId))) throw new AppError(409, '终态核查缺少原执行的准确原生身份。', 'recovery_identity_conflict');
        const check: RecoveryCheck = { id: id(), invocationId, requestId: input.requestId, expectedInvocationRevision: input.expectedInvocationRevision, expectedCancelRevision: input.expectedCancelRevision, expectedInputRevision: input.expectedInputRevision, resolution: 'unresolved', reason: observation.reason, observation, createdAt: now() };
        const persistedClosed = i.teardown === 'confirmed';
        const confirmedClosed = persistedClosed || (observation.teardown === 'confirmed' && observation.state === 'settled');
        if (terminal.has(i.status) && i.status !== 'interrupted' && persistedClosed) {
          check.resolution = 'already_settled'; check.reason = '执行已有终态；核查不覆盖既有结果。';
        } else if (observation.state === 'running') {
          check.resolution = 'running'; check.reason = '同一服务进程仍在观察此调用；接受状态独立记录，不启动第二次调用。';
        } else if (confirmedClosed) {
          if (observation.teardown === 'confirmed' && observation.state === 'settled') {
            for (const event of observation.evidence.filter(e => ['session', 'accepted', 'not_accepted', 'process_exit', 'transport_settled'].includes(e.kind))) this.recordEvidence(i.id, event);
            i = this.invocation(i.id);
            // A normalized inspection from the server adapter is evidence; the HTTP body never supplies it.
            i.teardown = 'confirmed'; if (observation.acceptance !== 'unknown' && i.acceptance !== 'accepted') i.acceptance = observation.acceptance;
            this.saveInvocation(i);
          }
          if (!terminal.has(i.status) && observation.state === 'settled' && observation.teardown === 'confirmed') {
            if (observation.result) {
              this.finish(i.id, observation.result.status, observation.result.content, input.expectedInputRevision);
              check.resolution = 'resolved'; check.reason = '已按原调用的准确结果与退出证据收敛；取消规则继续生效。';
            } else {
              i.interruptionCause = (i.cancelRevision ?? 0) > 0 ? 'user_cancel' : 'runtime_unknown'; this.saveInvocation(i);
              this.finish(i.id, (i.cancelRevision ?? 0) > 0 ? 'cancelled' : 'interrupted', '承载退出已确认，但未取得准确结果；不会自动重发。', input.expectedInputRevision);
              check.resolution = 'closed_result_unknown'; check.reason = '准确执行已退出，结果仍待核查，不自动重发。';
            }
          } else if (terminal.has(i.status) && i.status !== 'interrupted') {
            check.resolution = 'already_settled'; check.reason = '已补齐准确退出证据，保留原有终态。';
          } else if (i.status === 'interrupted' && i.recoveryState === 'pending' && ['service_restart', 'service_stop'].includes(i.interruptionCause ?? '') && (i.cancelRevision ?? 0) === 0 && observation.result && observation.state === 'settled' && observation.teardown === 'confirmed') {
            this.finishTransition(i.id, observation.result.status, observation.result.content, input.expectedInputRevision, 8, check.id);
            check.resolution = 'resolved'; check.reason = '已按准确终态和退出证据收敛；原中断记录保留在审计中。';
          } else {
            check.resolution = 'closed_result_unknown';
            check.reason = (i.cancelRevision ?? 0) > 0 ? '退出已确认；用户取消不被迟到结果覆盖，也不自动重发。' : '退出已确认；结果或历史中断原因仍不充分，不伪造成功或重新派发。';
          }
        }
        // A normalized adapter observation may confirm teardown without separate raw events.
        this.tasks.onInvocationChanged(this.invocation(i.id));
        this.db.prepare('INSERT INTO cc_recovery_checks VALUES(?,?,?)').run(check.id, i.id, JSON.stringify(check));
        this.event(i.conversationId, 'invocation.reconciled', { invocationId: i.id, checkId: check.id, resolution: check.resolution, reason: check.reason });
        return { check, invocation: this.invocation(i.id) };
      }); return { ...result.result, replayed: result.replayed };
    });
  }
  recheckDelivery(deliveryId: string, input: { requestId: string; expectedDeliveryRevision: number; expectedSourceRevision: number }): { check: HoldRecheck; delivery: Delivery; replayed: boolean } {
    return this.tx(() => {
      const result = this.command(`hold-recheck:${deliveryId}:${input.requestId}`, input, () => {
        const d = this.get<Delivery>('cc_deliveries', deliveryId); const source = this.get<SourceWork>('cc_sources', d.sourceId);
        if (d.revision !== input.expectedDeliveryRevision || source.revision !== input.expectedSourceRevision) throw new AppError(409, '来源或投递已变化，请刷新后重新核查。', 'delivery_version_conflict');
        if (d.status !== 'held') throw new AppError(409, '仅阻塞中的投递需要重验。', 'delivery_not_held');
        const conversation = this.get<Conversation>('cc_conversations', source.conversationId); const member = this.get<Member>('cc_members', d.memberId);
        const taskHold = this.tasks.admissionReason(source) ?? this.artifacts.admissionReason(source);
        const available = member.enabled && conversation.memberIds.includes(d.memberId) && !taskHold;
        if (available) { d.status = 'pending'; delete d.holdReason; } else d.holdReason = taskHold || '成员未启用或不再属于该会话，仍保留原目标。';
        d.revision++; this.saveDelivery(d);
        const check: HoldRecheck = { id: id(), requestId: input.requestId, sourceId: source.id, deliveryId: d.id, memberId: d.memberId, expectedDeliveryRevision: input.expectedDeliveryRevision, expectedSourceRevision: input.expectedSourceRevision, outcome: available ? 'pending' : 'held', reason: available ? '已恢复原投递待调度；是否启动仍由原来源组及占用规则决定。' : d.holdReason!, createdAt: now() };
        this.db.prepare('INSERT INTO cc_hold_rechecks VALUES(?,?,?)').run(check.id, d.id, JSON.stringify(check)); this.event(source.conversationId, 'delivery.rechecked', { deliveryId: d.id, checkId: check.id, outcome: check.outcome, reason: check.reason });
        return { check, delivery: d };
      }); return { ...result.result, replayed: result.replayed };
    });
  }
  private legacyPrompt(invocationId: string): string {
    const i = this.invocation(invocationId); const detail = this.detail(i.conversationId); const batch = detail.batches.find(b => b.id === i.batchId)!; const source = detail.sources.find(s => s.id === batch.sourceId)!;
    const consumed = new Set(detail.consumptions.filter(c => c.memberId === i.memberId).map(c => c.sourceId));
    const contract = this.contract(invocationId);
    const history = (contract.historySnapshot ?? []).slice(-40).map(m => `${m.author === 'user' ? '用户' : m.memberId ?? '系统'}: ${m.content}`).join('\n\n');
    const members = contract.roster.map(m => `${m.id} (${m.name})`).join(', ');
    return `${i.member.instructions}\n\n你在一个持续协作会话中。本次成员ID: ${i.memberId}；本次批次模式: ${batch.mode}。可协作成员: ${members}。\n需要交接时调用 collaboration_request，参数 targets 为1–2个其他成员ID，content 为完整任务。工具成功仅表示请求已排队，不表示任务已完成。不要重复发起同一工作。普通完成不自动回唤请求者，若需继续协作必须明确调用工具。不要把仅提及成员当作工具成功。\n以下历史只作背景，本次待执行输入在最后。平台采用新原生会话并注入最近40条相关历史。\n<history>\n${history}\n</history>\n<current-input source="${source.id}" kind="${source.kind}">\n${source.content}\n</current-input>`;
  }
  prepareInput(invocationId: string): { manifest: InputManifest; prompt: string } {
    return this.tx(() => {
      const i = this.invocation(invocationId); const c = this.contract(invocationId); this.validateContract(c);
      const existing = this.input(invocationId);
      if (existing) {
        const response = this.response(i.responseId); const batch = this.get<DispatchBatch>('cc_batches', i.batchId); const source = this.get<SourceWork>('cc_sources', batch.sourceId);
        if (existing.manifest.inputRevision !== response.inputRevision || existing.manifest.sourceRevision !== source.revision || hash(source.content) !== c.sourceDigest || existing.manifest.contractId !== c.id) throw new AppError(409, '冻结输入的来源或版本已变化，禁止继续发送。', 'inputs_changed');
        return existing;
      }
      if (i.dispatchStarted || terminal.has(i.status)) throw new AppError(409, '历史执行没有捕获输入，不能事后重建为当时事实。', 'input_not_captured');
      const batch = this.get<DispatchBatch>('cc_batches', i.batchId); const source = this.get<SourceWork>('cc_sources', batch.sourceId);
      if (source.revision !== c.sourceRevision || hash(source.content) !== c.sourceDigest) throw new AppError(409, '来源已变化，不能使用旧执行的输入。', 'inputs_changed');
      const response = this.response(i.responseId); const legacy = c.contextPolicyVersion === 'legacy-history-40-v1';
      const assembly = legacy ? undefined : assembleContext({ invocation: i, taskSnapshot: c.taskSnapshot, taskPolicy: ['bounded-public-context-tasks-v2', 'bounded-public-context-artifacts-v3'].includes(c.contextPolicyVersion), artifactPolicy: c.toolPolicyVersion === 'managed-artifacts-v1', reviewSnapshot: c.reviewSnapshot, source, batch: { ...batch, historyCutoff: c.historyCutoff }, roster: c.roster,
        history: (c.historySnapshot ?? []).map(m => ({ ...m, sequence: m.sequence! })), historySourceSnapshots: c.historySourceSnapshots,
        ...(source.parentInvocationId ? { caller: this.invocation(source.parentInvocationId) } : {}) });
      const prompt = assembly?.prompt ?? this.legacyPrompt(invocationId);
      const renderDigest = createHash('sha256').update(prompt).digest('hex');
      const payloadRef = id();
      const manifest: InputManifest = { id: id(), invocationId, responseId: response.id, inputRevision: response.inputRevision, sourceRevision: source.revision, contractId: c.id, historyCutoff: c.historyCutoff, items: assembly?.items ?? [{ kind: 'request', reference: `source:${source.id}@${source.revision}`, representation: 'full', characters: source.content.length, complete: true }], budget: assembly?.budget ?? { maxEstimatedTokens: Buffer.byteLength(prompt), usedEstimatedTokens: Buffer.byteLength(prompt), method: 'legacy-unbounded-utf8-bytes' }, payloadRef, renderVersion: assembly?.renderVersion ?? 'legacy-history-40-v1', renderDigest, digestStage: 'platform_prompt', assemblyState: 'prepared', createdAt: now(), ...(assembly?.caller ? { caller: assembly.caller } : {}) };
      this.db.prepare('INSERT INTO cc_payloads VALUES(?,?,?)').run(payloadRef, prompt, renderDigest);
      this.db.prepare('INSERT INTO cc_manifests VALUES(?,?,?)').run(manifest.id, invocationId, JSON.stringify(manifest));
      this.event(i.conversationId, 'input.prepared', { invocationId, manifestId: manifest.id, renderDigest, providerAcceptance: false });
      return { manifest, prompt };
    });
  }
  input(invocationId: string): { manifest: InputManifest; prompt: string } | undefined {
    this.invocation(invocationId);
    const manifest = this.rows<InputManifest>('cc_manifests', 'WHERE invocation_id=?', [invocationId])[0]; if (!manifest) return undefined;
    const payload = this.db.prepare('SELECT prompt,digest FROM cc_payloads WHERE id=?').get(manifest.payloadRef) as { prompt: string; digest: string } | undefined;
    if (!payload || payload.digest !== manifest.renderDigest || createHash('sha256').update(payload.prompt).digest('hex') !== manifest.renderDigest) throw new AppError(409, '保存的输入快照不完整或校验失败，禁止发送。', 'input_digest_conflict');
    return { manifest, prompt: payload.prompt };
  }
  prompt(invocationId: string): string { return (this.input(invocationId) ?? this.prepareInput(invocationId)).prompt; }
}
