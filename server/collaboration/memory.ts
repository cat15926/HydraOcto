import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import type { MemoryEntry, MemoryVersion, MemoryLibraryDetail, MemorySnapshot, MessageExcerpt, MessageVisibility, SearchHit, SearchResult } from '../../shared/collaboration.js';
import { AppError, now } from '../store.js';
import type { CollaborationStore } from './store.js';
import { privateScope, scopeAllows, scopeKey, textDigest } from './visibility.js';

const text = (v: unknown, max = 200): string => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new AppError(400, '记忆参数无效。'); return v.trim(); };
const conflict = (): never => { throw new AppError(409, '记忆版本、授权或来源已变化，请刷新。', 'memory_conflict'); };

/** Explicit review and SQLite materialization are separate, durable domain transitions. */
export class MemoryService {
  constructor(readonly store: CollaborationStore) {}
  private get data() { return this.store.artifacts; }
  private get port() { return this.data.port; }
  entries(): MemoryEntry[] { return this.data.rows('cc_memories'); }
  versions(): MemoryVersion[] { return this.data.rows('cc_memory_versions'); }
  private actor(invocationId: string) {
    this.store.visibility.assertTool(invocationId, 'memory_propose'); this.store.tasks.actor(invocationId, true);
    if (!['visibility-memory-v1', 'cross-action-v1'].includes(this.store.contract(invocationId).toolPolicyVersion)) throw new AppError(403, '此冻结契约没有记忆权限。');
    const i = this.store.invocation(invocationId);
    if (i.status !== 'running' || i.acceptance !== 'accepted' || (i.cancelRevision ?? 0) !== 0) conflict();
    return i;
  }
  private eligible(e: MemoryEntry, cid: string, memberId?: string, executionScope?: string) {
    if (e.revokedAt || this.store.visibility.conversation(e.conversationId).deletedAt || (e.scope !== 'library' && e.conversationId !== cid) || !scopeAllows(e.visibility, memberId)) return false;
    if (memberId && !this.store.visibility.conversation(e.conversationId).memberIds.includes(memberId)) return false;
    return executionScope === undefined || !privateScope(e.visibility) || scopeKey(e.visibility) === executionScope;
  }
  private validateRefs(cid: string, refs: MessageExcerpt[], visibility?: MessageVisibility) {
    if (!refs.length) return;
    this.store.visibility.resolveRefs(cid, refs);
    for (const ref of refs) {
      const m = this.store.visibility.messages(cid).find(m => m.id === ref.messageId)!;
      const origin = this.store.visibility.messageScope(m);
      if (privateScope(origin) && (!privateScope(visibility) || visibility!.memberIds.some(t => !origin!.memberIds.includes(t)))) throw new AppError(403, '记忆不能扩大来源可见范围；先显式公开源消息。');
    }
  }
  propose(cid: string, input: Record<string, unknown>, invocationId?: string) {
    return this.port.tx(() => this.port.command(`memory-propose:${cid}:${text(input.requestId)}`, { input, invocationId }, () => {
      this.store.visibility.assertConversation(cid);
      const actor = invocationId ? this.actor(invocationId) : undefined;
      if (actor && actor.conversationId !== cid) conflict();
      const visibility = actor ? this.store.contract(actor.id).visibility : this.store.visibility.audience(cid, input.privateTo);
      const scope = input.scope ?? 'conversation'; if (!['conversation', 'library'].includes(String(scope)) || actor && scope !== 'conversation') throw new AppError(403, 'Agent 仅可提议当前会话记忆。');
      if (actor && (input.privateTo !== undefined || input.owner !== undefined)) throw new AppError(403, '记忆身份与可见性由当前执行绑定。');
      const content = text(input.content, 16000), key = text(input.key, 120);
      if (Buffer.byteLength(content) > 32768) throw new AppError(413, '记忆最多 32 KiB。');
      const refs = (input.sourceRefs ?? []) as MessageExcerpt[];
      if (!Array.isArray(refs) || refs.length > 8) throw new AppError(400, '记忆来源最多 8 个选段。');
      this.validateRefs(cid, refs, visibility);
      const old = input.entryId ? this.entries().find(e => e.id === input.entryId && e.conversationId === cid) : undefined;
      if (input.entryId && (!old || old.revision !== input.expectedRevision || old.revokedAt || old.key !== key || old.scope !== scope || scopeKey(old.visibility) !== scopeKey(visibility) || actor && old.owner !== actor.memberId)) conflict();
      if (!old && this.entries().some(e => e.conversationId === cid && e.key === key && !e.revokedAt && e.scope === scope && scopeKey(e.visibility) === scopeKey(visibility))) conflict();
      const e: MemoryEntry = old ?? { id: randomUUID(), conversationId: cid, key, scope: scope as MemoryEntry['scope'], visibility, owner: actor?.memberId ?? 'user', revision: 1, createdAt: now(), updatedAt: now() };
      if (!old) this.store.db.prepare('INSERT INTO cc_memories VALUES(?,?,?)').run(e.id, cid, JSON.stringify(e));
      const v: MemoryVersion = { id: randomUUID(), entryId: e.id, conversationId: cid, number: this.versions().filter(v => v.entryId === e.id).length + 1, baseRevision: e.revision, content, digest: textDigest(content), state: 'candidate', revision: 1, createdAt: now(), origin: actor ? { kind: 'agent', invocationId: actor.id, memberId: actor.memberId } : { kind: 'user' }, sourceRefs: refs };
      this.store.db.prepare('INSERT INTO cc_memory_versions VALUES(?,?,?)').run(v.id, cid, JSON.stringify(v)); this.port.event(cid, 'memory.candidate', { entryId: e.id, versionId: v.id }); return { entry: e, version: v };
    }));
  }
  transition(vid: string, input: Record<string, unknown>) {
    return this.port.tx(() => this.port.command(`memory-transition:${vid}:${text(input.requestId)}`, input, () => {
      const v = this.versions().find(v => v.id === vid); if (!v || v.revision !== input.expectedRevision) conflict();
      const version = v!, entry = this.entries().find(e => e.id === version.entryId)!;
      this.store.visibility.assertConversation(entry.conversationId);
      if (entry.revision !== input.expectedEntryRevision) conflict();
      if (input.action === 'approve' || input.action === 'reject') {
        if (version.state !== 'candidate' || entry.revokedAt) conflict();
        this.validateRefs(entry.conversationId, version.sourceRefs, entry.visibility);
        version.state = input.action === 'approve' ? 'approved' : 'rejected'; if (input.action === 'approve') version.approvedAt = now();
      } else if (input.action === 'materialize') {
        if (version.state !== 'approved' || version.baseRevision !== entry.revision || entry.revokedAt || textDigest(version.content) !== version.digest) conflict();
        this.validateRefs(entry.conversationId, version.sourceRefs, entry.visibility);
        // New material may otherwise be smuggled into an already established native context.
        this.store.visibility.idle(entry.scope === 'library' ? undefined : entry.conversationId);
        this.store.db.prepare('INSERT INTO cc_memory_materializations VALUES(?,?,?,?)').run(version.id, entry.id, version.digest, now());
        version.state = 'materialized'; version.materializedAt = now(); entry.headVersionId = version.id; entry.revision++; entry.updatedAt = now();
        this.store.visibility.put('cc_memories', entry); this.store.visibility.changed(entry.conversationId);
      } else if (input.action === 'revoke') {
        if (version.state === 'revoked') conflict();
        this.store.visibility.idle(entry.scope === 'library' ? undefined : entry.conversationId);
        version.state = 'revoked'; version.revokedAt = now();
        if (entry.headVersionId === version.id) { delete entry.headVersionId; entry.revokedAt = now(); }
        entry.revision++; entry.updatedAt = now(); this.store.visibility.put('cc_memories', entry); this.store.visibility.changed(entry.conversationId);
      } else throw new AppError(400, '记忆操作无效。');
      version.revision++; this.store.visibility.put('cc_memory_versions', version); this.port.event(entry.conversationId, `memory.${input.action}`, { entryId: entry.id, versionId: vid, revision: version.revision }); return { entry, version };
    }));
  }
  current(cid: string, memberId?: string, executionScope?: string): MemorySnapshot[] {
    this.store.visibility.assertConversation(cid, memberId);
    return this.entries().filter(e => this.eligible(e, cid, memberId, executionScope) && e.headVersionId).flatMap(e => {
      const v = this.versions().find(v => v.id === e.headVersionId && v.state === 'materialized');
      if (!v || textDigest(v.content) !== v.digest) return [];
      const receipt = this.store.db.prepare('SELECT digest FROM cc_memory_materializations WHERE version_id=? AND entry_id=?').get(v.id, e.id) as { digest: string } | undefined;
      if (!receipt || receipt.digest !== v.digest) return [];
      try { this.validateRefs(e.conversationId, v.sourceRefs, e.visibility); } catch { return []; }
      return [{ entryId: e.id, versionId: v.id, revision: e.revision, key: e.key, content: v.content, digest: v.digest }];
    });
  }
  snapshot(cid: string, memberId: string, visibility?: MessageVisibility) {
    const selected: MemorySnapshot[] = []; let bytes = 0;
    for (const m of this.current(cid, memberId, scopeKey(visibility)).sort((a, b) => a.key.localeCompare(b.key))) {
      bytes += Buffer.byteLength(JSON.stringify(m)); if (bytes > 16000 || selected.length >= 20) break; selected.push(m);
    }
    return selected;
  }
  validateInvocation(id: string) {
    const i = this.store.invocation(id), c = this.store.contract(id), actual = this.current(i.conversationId, i.memberId, scopeKey(c.visibility));
    for (const m of c.memorySnapshot ?? []) if (!actual.some(a => a.versionId === m.versionId && a.revision === m.revision && a.digest === m.digest)) conflict();
  }
  detail(cid: string) { const memories = this.entries().filter(e => e.conversationId === cid || e.scope === 'library' && !this.store.visibility.conversation(e.conversationId).deletedAt); return { memories, memoryVersions: this.versions().filter(v => memories.some(e => e.id === v.entryId)) }; }
  /** Local owner's library administration; not an Agent read or a new recall permission. */
  library(): MemoryLibraryDetail {
    const conversations = this.store.list().filter(c => !c.deletedAt);
    const sources = new Set(conversations.map(c => c.id));
    const memories = this.entries().filter(e => e.scope === 'library' && sources.has(e.conversationId));
    const ids = new Set(memories.map(e => e.id));
    return { memories, memoryVersions: this.versions().filter(v => ids.has(v.entryId)), conversations };
  }
  tool(id: string, name: string, input: Record<string, unknown>, callId: string) {
    const i = this.actor(id); if (name === 'memory_propose') return this.propose(i.conversationId, { ...input, requestId: `${id}:${callId}` }, id);
    if (name === 'memory_read') {
      if (Object.keys(input).some(k => !['offset', 'limit'].includes(k))) throw new AppError(400, '记忆读取不接受身份参数。');
      const offset = input.offset ?? 0, limit = input.limit ?? 20;
      if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 50) throw new AppError(400, '记忆分页无效。');
      const all = this.current(i.conversationId, i.memberId, scopeKey(this.store.contract(id).visibility)).sort((a, b) => a.key.localeCompare(b.key));
      const memories: MemorySnapshot[] = []; let bytes = 0;
      for (const m of all.slice(Number(offset), Number(offset) + Number(limit))) { const size = Buffer.byteLength(JSON.stringify(m)); if (bytes + size > 64000) break; bytes += size; memories.push(m); }
      const next = Number(offset) + memories.length; return { memories, hasMore: next < all.length, nextOffset: next < all.length ? next : null };
    }
    throw new AppError(400, '记忆工具无效。');
  }
  async search(input: { query: string; mode?: string; kinds?: string[]; conversationId?: string; memberId?: string; invocationId?: string; signal?: AbortSignal }): Promise<SearchResult> {
    if (input.mode && input.mode !== 'lexical') throw new AppError(503, 'semantic/hybrid 服务未接入；可显式选择词法检索。', 'search_degraded');
    const query = text(input.query, 200).toLocaleLowerCase();
    const kinds = input.kinds ?? ['threads', 'docs', 'memory', 'sessions']; if (!Array.isArray(kinds) || !kinds.length || kinds.some(k => !['threads', 'docs', 'memory', 'sessions'].includes(k))) throw new AppError(400, '检索类型无效。');
    const epoch = this.store.visibility.epoch(), deadline = Date.now() + 15000;
    let cid = input.conversationId, memberId = input.memberId, executionScope: string | undefined;
    if (input.invocationId) { const i = this.actor(input.invocationId); cid = i.conversationId; memberId = i.memberId; executionScope = scopeKey(this.store.contract(i.id).visibility); }
    if (memberId && !cid) throw new AppError(400, '成员视角需要准确会话。');
    const conversations = cid ? [this.store.visibility.assertConversation(cid, memberId)] : this.store.list().filter(c => !c.deletedAt);
    const hits: SearchHit[] = []; let scanned = 0, truncated = false;
    const add = (kind: SearchHit['kind'], conversationId: string, id: string, title: string, content: string) => {
      if (!kinds.includes(kind)) return; scanned++;
      if (scanned > 10000) { truncated = true; return; }
      const index = (title + '\n' + content).toLocaleLowerCase().indexOf(query); if (index < 0) return;
      if (hits.length >= 50) { truncated = true; return; }
      const all = title + '\n' + content; hits.push({ kind, conversationId, id, title, excerpt: all.slice(Math.max(0, index - 80), index + query.length + 180) });
    };
    try {
      for (const c of conversations) {
        input.signal?.throwIfAborted(); if (Date.now() > deadline) throw new AppError(503, '检索超时，请缩小范围。', 'search_degraded');
        const messages = this.store.visibility.readable(c.id, memberId, executionScope);
        const usedAttachments = new Set<string>();
        for (let n = 0; n < messages.length && scanned <= 10000; n++) {
          const m = messages[n]!; if (n % 50 === 0) { await setImmediate(); input.signal?.throwIfAborted(); if (Date.now() > deadline) throw new AppError(503, '检索超时。', 'search_degraded'); }
          const projected = this.store.visibility.projectedMessage(m); add('threads', c.id, m.id, c.title, projected.content);
          for (const a of m.attachmentIds ?? []) if (!usedAttachments.has(a)) { usedAttachments.add(a); if (this.store.workbench.attachment(a).mediaType !== 'text/plain') continue; const material = this.store.workbench.attachmentContent(a); add('docs', c.id, a, material.attachment.name, material.content); }
          // Sessions means authorized platform response material, never native transcript or frozen private audit.
          if (m.responseId) add('sessions', c.id, m.responseId, `执行回复 · ${m.memberId}`, projected.content);
        }
        for (const a of this.store.artifacts.detail(c.id).artifacts ?? []) if (a.headVersionId) { const result = this.store.artifacts.content(a.headVersionId); add('docs', c.id, a.id, a.name, result.content); }
        for (const m of this.current(c.id, memberId, executionScope)) if (!hits.some(h => h.kind === 'memory' && h.id === m.versionId)) add('memory', c.id, m.versionId, m.key, m.content);
        if (scanned > 10000) break;
      }
      input.signal?.throwIfAborted();
      if (epoch !== this.store.visibility.epoch()) throw new AppError(409, '检索期间可见性发生变化，请重试。');
      if (input.invocationId) this.actor(input.invocationId);
      return { mode: 'lexical', hits, scanned, truncated, degraded: false, scope: input.invocationId ? 'current-invocation' : memberId ? `member:${memberId}` : cid ? 'conversation-owner' : 'local-owner-all-conversations' };
    } catch (e) { if (e instanceof AppError || input.signal?.aborted) throw e; throw new AppError(503, '资料检索暂不可用，未返回伪造命中。', 'search_degraded'); }
  }
}
