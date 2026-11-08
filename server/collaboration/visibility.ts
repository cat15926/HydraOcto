import { projectReviewTools } from './project-review-tools.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Conversation, ConversationMessage, MessageExcerpt, MessageVisibility, ReadCursor, SendMessage, SourceWork } from '../../shared/collaboration.js';
import { AppError, now } from '../store.js';
import type { CollaborationStore } from './store.js';

export const textDigest = (text: string) => createHash('sha256').update(text).digest('hex');
export const privateScope = (v?: MessageVisibility) => v?.kind === 'private' && !v.revealedAt;
export const scopeKey = (v?: MessageVisibility) => privateScope(v) ? `private:${[...v!.memberIds].sort().join(',')}` : 'public';
export const scopeAllows = (v: MessageVisibility | undefined, memberId?: string) => !memberId || !privateScope(v) || v!.memberIds.includes(memberId);
const conflict = (message = '材料已变化或不可访问，请重新选择。'): never => { throw new AppError(409, message, 'visibility_conflict'); };
const text = (v: unknown, max = 200): string => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new AppError(400, '参数文本无效。'); return v.trim(); };

/** All model access uses a server-bound invocation; human projections never authenticate an agent. */
export class VisibilityService {
  constructor(readonly store: CollaborationStore) {}
  private get data() { return this.store.artifacts; }
  private get port() { return this.data.port; }
  messages(cid: string): ConversationMessage[] { return this.data.rows('cc_messages', cid); }
  conversation(cid: string) { return this.data.get<Conversation>('cc_conversations', cid); }
  epoch() { return Number((this.store.db.prepare("SELECT epoch AS value FROM cc_visibility_state WHERE id=1").get() as { value: number }).value); }
  changed(cid: string) { this.store.db.prepare("UPDATE cc_visibility_state SET epoch=epoch+1 WHERE id=1").run(); this.port.event(cid, 'visibility.changed', { epoch: this.epoch() }); }
  put(table: string, value: { id: string }) { this.store.db.prepare(`UPDATE ${table} SET value=? WHERE id=?`).run(JSON.stringify(value), value.id); }
  assertConversation(cid: string, memberId?: string) {
    const c = this.conversation(cid);
    if (c.deletedAt || memberId && !c.memberIds.includes(memberId)) throw new AppError(404, '会话不可访问。');
    return c;
  }
  idle(cid?: string, queue = false) {
    if (this.store.invocations(cid).some(i => !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(i.status) || i.teardown !== 'confirmed')) conflict('需等待相关执行确认释放后再改变材料可见性。');
    if (queue && this.store.cooperation.queue(cid!).sources.length) conflict('会话仍有未投递来源，请先处理或撤回。');
  }
  audience(cid: string, ids: unknown): MessageVisibility | undefined {
    if (ids === undefined) return undefined;
    const c = this.assertConversation(cid);
    if (!Array.isArray(ids) || !ids.length || ids.length > 10 || new Set(ids).size !== ids.length || ids.some(m => typeof m !== 'string' || !c.memberIds.includes(m) || !this.store.members().some(x => x.id === m && x.enabled && !x.deletedAt))) throw new AppError(400, '私聊接收成员必须是会话中启用的成员。');
    return { kind: 'private', memberIds: [...ids].sort() };
  }
  messageScope(m: ConversationMessage): MessageVisibility | undefined {
    if (m.visibility) return m.visibility;
    if (m.sourceId) return this.data.get<SourceWork>('cc_sources', m.sourceId).visibility;
    if (m.responseId) { const r = this.store.response(m.responseId); return this.store.contract(r.invocationId).visibility; }
    return undefined;
  }
  visible(m: ConversationMessage, memberId?: string, executionScope?: string): boolean {
    if (m.deletedAt || !scopeAllows(this.messageScope(m), memberId)) return false;
    try { const s = m.sourceId ? this.data.get<SourceWork>('cc_sources',m.sourceId) : m.responseId ? this.primary(this.store.response(m.responseId).invocationId) : undefined; if(s?.crossRef) this.store.cross.material(s); if(s?.actionRef) this.store.actions.material(s); } catch { return false; }
    return executionScope === undefined || !privateScope(this.messageScope(m)) || scopeKey(this.messageScope(m)) === executionScope;
  }
  readable(cid: string, memberId?: string, executionScope?: string) {
    this.assertConversation(cid, memberId);
    return this.messages(cid).filter(m => this.visible(m, memberId, executionScope));
  }
  primary(invocationId: string) {
    const c = this.store.contract(invocationId), i = this.store.invocation(invocationId);
    return this.data.get<SourceWork>('cc_sources', c.primarySourceId ?? this.store.response(i.responseId).inputSourceIds[0]!);
  }
  sameScope(invocationId: string, s: SourceWork) { return !s.crossRef && !s.actionRef && !this.primary(invocationId).actionRef && scopeKey(this.store.contract(invocationId).visibility) === scopeKey(s.visibility) && !s.excerptRefs?.length; }
  assertTool(invocationId: string, name: string) {
    const i = this.store.invocation(invocationId), c = this.store.contract(invocationId);
    this.assertConversation(i.conversationId, i.memberId);
    if (name === 'project_environment_check' && (i.member.carrier !== 'codex-app-server' || !this.store.checkNativeFilePermission(i.id)))
      throw new AppError(403,'本次项目委托未授权平台环境查询。');
    if (c.projectReview && !projectReviewTools(c.projectReview).some(tool => tool.name === name)) throw new AppError(403,'本次评审未授权此工具。');
    const source = this.primary(invocationId); if(source.crossRef)this.store.cross.material(source); this.store.actions.validateInvocation(invocationId,true);
    if (c.visibilityEpoch !== undefined && c.visibilityEpoch !== this.epoch()) conflict('材料权限已变化，本轮不能继续读取或转发。');
    if (privateScope(c.visibility) && (name.startsWith('cross_') || name.startsWith('action_') || name.startsWith('task_') || name.startsWith('artifact_') || name.startsWith('review_') || name === 'multi_mention' || name === 'collaboration_request')) throw new AppError(403, '私聊执行不能写入公开任务、产物或向其他范围协作；请由用户选择片段分享。');
  }
  validateSend(cid: string, input: SendMessage) {
    this.assertConversation(cid);
    const visibility = this.audience(cid, input.privateTo);
    if (input.replyTo) {
      const m = this.messages(cid).find(m => m.id === input.replyTo && !m.deletedAt);
      if (!m) throw new AppError(400, '引用必须属于当前会话且仍可访问。');
      const origin = this.messageScope(m!);
      if (privateScope(origin) && (!visibility || visibility.memberIds.some(t => !origin!.memberIds.includes(t)))) throw new AppError(403, '普通引用不能公开私聊内容；请使用选段分享或先公开原消息。');
    }
    for (const id of input.attachmentIds ?? []) {
      const uses = this.messages(cid).filter(m => m.attachmentIds?.includes(id));
      if (uses.some(m => m.deletedAt || privateScope(this.messageScope(m)) && (!visibility || visibility.memberIds.some(t => !this.messageScope(m)!.memberIds.includes(t))))) throw new AppError(403, '私密附件不能作为公开消息重新发送。');
    }
    if (input.excerptRefs !== undefined) {
      if (!Array.isArray(input.excerptRefs) || !input.excerptRefs.length || input.excerptRefs.length > 8 || input.attachmentIds?.length || input.replyTo || input.resolveWhenIdle) throw new AppError(400, '选段分享需要 1–8 个引用，不能混入附件、普通引用或延迟路由。');
      const targets = this.audience(cid, input.excerptTargets);
      if (!targets) throw new AppError(400, '选段分享需要明确接收成员。');
      if (visibility && scopeKey(visibility) !== scopeKey(targets)) throw new AppError(400, '选段接收范围必须一致。');
      this.resolveRefs(cid, input.excerptRefs);
      return targets;
    }
    return visibility;
  }
  resolveRefs(cid: string, refs: MessageExcerpt[]): string {
    this.assertConversation(cid);
    if (!Array.isArray(refs) || !refs.length || refs.length > 8) throw new AppError(400, '选段列表无效。');
    let bytes = 0;
    return refs.map(ref => {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref) || typeof ref.messageId !== 'string') throw new AppError(400, '选段引用结构无效。');
      const m = this.messages(cid).find(m => m.id === ref.messageId);
      if (!m || !this.visible(m) || (m.revision ?? 1) !== ref.revision || textDigest(m.content) !== ref.digest || m.excerptRefs?.length) conflict();
      if (m!.responseId && !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(this.store.response(m!.responseId).status)) conflict();
      if (m!.sourceId && this.data.get<SourceWork>('cc_sources', m!.sourceId).withdrawnAt) conflict();
      if (!Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end) || ref.start < 0 || ref.end <= ref.start || ref.end > m!.content.length) throw new AppError(400, '选段范围无效。');
      // Never split a UTF-16 surrogate pair at either endpoint.
      for (const n of [ref.start, ref.end]) if (n > 0 && n < m!.content.length && /[\uD800-\uDBFF]/.test(m!.content[n - 1]!) && /[\uDC00-\uDFFF]/.test(m!.content[n]!)) throw new AppError(400, '选段不能截断 Unicode 字符。');
      const selected = m!.content.slice(ref.start, ref.end); bytes += Buffer.byteLength(selected);
      if (bytes > 32000) throw new AppError(413, '选段总量超过 32,000 字节。');
      return JSON.stringify({ selectedText: selected, sourceMessageId: m!.id, start: ref.start, end: ref.end });
    }).join('\n');
  }
  admissionReason(s: SourceWork): string | undefined {
    try { this.assertConversation(s.conversationId); this.sourceContent(s); }
    catch { return '引用材料已失效或会话不可访问，请重新选择材料。'; }
    return undefined;
  }
  private replyContent(cid: string, mid: string, visibility?: MessageVisibility) {
    const m = this.messages(cid).find(m => m.id === mid && this.visible(m));
    if (!m) conflict('引用来源已删除或不可访问，请重新发送。');
    const origin = this.messageScope(m!);
    if (privateScope(origin) && (!privateScope(visibility) || visibility!.memberIds.some(id => !origin!.memberIds.includes(id)))) conflict('被引用消息仍是私聊，请先公开原消息或只分享选定正文。');
    return `\n<reply-context messageId=${JSON.stringify(m!.id)} author=${JSON.stringify(m!.memberId ?? m!.author)}>\n${m!.content.slice(0, 8000)}${m!.content.length > 8000 ? '\n[引用超过 8,000 字符，余文未包含]' : ''}\n</reply-context>`;
  }
  sourceContent(s: SourceWork, visibility = s.visibility): string {
    if (s.replyTo) this.replyContent(s.conversationId, s.replyTo, visibility);
    if (s.crossRef) return this.store.cross.material(s);
    if (s.actionRef) return this.store.actions.material(s);
    return s.excerptRefs?.length ? `${s.content}\n用户明确分享的准确选段（仅这些片段获授权）：\n${this.resolveRefs(s.conversationId, s.excerptRefs)}` : s.content;
  }
  projectedMessage(m: ConversationMessage): ConversationMessage {
    let content = m.content;
    if (m.excerptRefs?.length) {
      try { content += '\n' + this.resolveRefs(m.excerptConversationId ?? m.conversationId, m.excerptRefs); }
      catch { content += '\n[选段来源已失效，不再提供缓存正文]'; }
    }
    const replyTo = m.replyTo && this.messages(m.conversationId).some(x => x.id === m.replyTo && !x.deletedAt) ? m.replyTo : undefined;
    return { ...m, replyTo, content, visibility: this.messageScope(m) };
  }
  history(cid: string, memberId: string, scope: string) {
    return this.readable(cid, memberId, scope).map(m => {
      const s = m.sourceId && this.data.get<SourceWork>('cc_sources', m.sourceId);
      if (s && (s.crossRef || s.actionRef || m.attachmentIds?.length || m.replyTo || m.excerptRefs?.length)) {
        try { return { ...m, visibility: this.messageScope(m), content: this.sourceContent(s, this.messageScope(m)) }; }
        catch { return undefined; }
      }
      if (m.excerptRefs?.length) { try { return { ...m, visibility: this.messageScope(m), content: m.content + '\n' + this.resolveRefs(m.excerptConversationId ?? cid, m.excerptRefs) }; } catch { return undefined; } }
      if (m.replyTo) { try { return { ...m, visibility: this.messageScope(m), content: m.content + '\n' + this.replyContent(cid, m.replyTo, this.messageScope(m)) }; } catch { return undefined; } }
      return { ...m, visibility: this.messageScope(m) };
    }).filter((m): m is ConversationMessage & { visibility: MessageVisibility | undefined } => !!m);
  }
  validateInvocation(invocationId: string) {
    const i = this.store.invocation(invocationId), c = this.store.contract(invocationId);
    if (c.visibilityEpoch === undefined) return; // Preserve frozen legacy behavior.
    this.assertConversation(i.conversationId, i.memberId);
    if (c.visibilityEpoch !== this.epoch()) conflict('材料可见性已经变化，不能继续发送旧输入。');
    const s = this.primary(invocationId);
    if (!scopeAllows(s.visibility, i.memberId) || s.withdrawnAt) conflict();
    if (s.excerptRefs?.length) this.resolveRefs(s.conversationId, s.excerptRefs);
    if (c.materialDigest !== undefined && c.materialDigest !== textDigest(JSON.stringify({ content: this.sourceContent(s), refs: s.excerptRefs, visibility: s.visibility }))) throw new AppError(409, '材料已变化，禁止继续发送旧输入。', 'inputs_changed');
    for (const snapshot of c.historySnapshot ?? []) {
      const current = this.messages(i.conversationId).find(m => m.id === snapshot.id);
      if (!current || !this.visible(current, i.memberId, scopeKey(c.visibility))) conflict();
      if (current!.replyTo) this.replyContent(i.conversationId, current!.replyTo, this.messageScope(current!));
      if (current!.excerptRefs?.length) this.resolveRefs(current!.excerptConversationId ?? i.conversationId, current!.excerptRefs);
    }
  }
  messageCommand(cid: string, mid: string, input: Record<string, unknown>) {
    return this.port.tx(() => this.port.command(`message-policy:${cid}:${text(input.requestId)}`, { mid, input }, () => {
      this.assertConversation(cid); this.idle(cid);
      const m = this.messages(cid).find(m => m.id === mid); if (!m || (m.revision ?? 1) !== input.expectedRevision) conflict();
      if (!['reveal', 'delete'].includes(String(input.action)) || m!.deletedAt) conflict();
      if (input.action === 'reveal') {
        if (!privateScope(this.messageScope(m!)) || m!.excerptRefs?.length) conflict('仅未公开私聊可被整体公开；选段分享不能扩大授权。');
        if (m!.replyTo) this.replyContent(cid, m!.replyTo);
        m!.visibility = { ...this.messageScope(m!)!, revealedAt: now() };
      } else m!.deletedAt = now();
      m!.revision = (m!.revision ?? 1) + 1; this.put('cc_messages', m!);
      if (m!.sourceId && input.action === 'delete') {
        const s = this.data.get<SourceWork>('cc_sources', m!.sourceId);
        if (!s.withdrawnAt) this.store.cooperation.withdraw(s.id, { requestId: `delete:${mid}`, expectedRevision: s.revision });
      }
      this.changed(cid); this.port.event(cid, `message.${input.action}`, { messageId: mid, revision: m!.revision }); return m!;
    }));
  }
  readCursor(cid: string): ReadCursor {
    return (this.store.db.prepare('SELECT value FROM cc_read_cursors WHERE conversation_id=?').get(cid) as { value: string } | undefined)?.value ? JSON.parse((this.store.db.prepare('SELECT value FROM cc_read_cursors WHERE conversation_id=?').get(cid) as { value: string }).value) : { conversationId: cid, sequence: 0, updatedAt: '' };
  }
  markRead(cid: string, sequence: unknown) {
    return this.port.tx(() => {
      this.assertConversation(cid);
      if (!Number.isSafeInteger(sequence) || Number(sequence) < 0 || Number(sequence) > Math.max(0, ...this.messages(cid).map(m => m.sequence ?? 0))) throw new AppError(400, '已读游标无效。');
      const old = this.readCursor(cid); if (Number(sequence) <= old.sequence) return old;
      const value: ReadCursor = { conversationId: cid, sequence: Number(sequence), updatedAt: now() };
      this.store.db.prepare('INSERT INTO cc_read_cursors VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET value=excluded.value').run(cid, JSON.stringify(value)); this.port.event(cid, 'conversation.read', { sequence }); return value;
    });
  }
  organize(cid: string, input: Record<string, unknown>) {
    return this.port.tx(() => this.port.command(`visibility-organize:${cid}:${text(input.requestId)}`, input, () => {
      const c = this.conversation(cid); if ((c.revision ?? 1) !== input.expectedRevision) conflict('会话修订已经变化。');
      if (input.action === 'favorite' || input.action === 'unfavorite') c.favorite = input.action === 'favorite';
      else if (input.action === 'delete') { this.idle(cid, true); c.deletedAt = now(); this.changed(cid); }
      else if (input.action === 'undelete') { delete c.deletedAt; this.changed(cid); }
      else if (input.action === 'groups') {
        if (!Array.isArray(input.groups) || input.groups.length > 12) throw new AppError(400, '最多 12 个成员组。');
        const reserved = new Set(['all', '全体', 'thread', '本帖', ...this.store.members().flatMap(m => [m.id, m.name, ...(m.aliases ?? [])])].map(v => v.toLocaleLowerCase()));
        c.memberGroups = input.groups.map(g => {
          if (!g || typeof g !== 'object' || Array.isArray(g)) throw new AppError(400, '成员组结构无效。');
          const name = text(g.name, 40); if (!/^[\p{L}\p{N}_-]+$/u.test(name) || reserved.has(name.toLocaleLowerCase())) throw new AppError(409, '组名与成员、别名或其他组冲突。');
          reserved.add(name.toLocaleLowerCase()); const audience = this.audience(cid, g.memberIds); if (!audience) throw new AppError(400, '成员组不能为空。');
          return { name, memberIds: audience.memberIds };
        });
        this.store.db.prepare("UPDATE cc_meta SET value=value+1 WHERE key='configuration_revision'").run();
      } else throw new AppError(400, '会话操作无效。');
      c.revision = (c.revision ?? 1) + 1; c.updatedAt = now(); this.put('cc_conversations', c); this.store.cross.sweep(); this.port.event(cid, 'conversation.organized', { action: input.action }); return c;
    }));
  }
  export(cid: string, memberId?: string, messageIds?: string[]) {
    const c = this.assertConversation(cid, memberId); let messages = this.readable(cid, memberId);
    if (messageIds) { if (!messageIds.length || messageIds.length > 1000 || new Set(messageIds).size !== messageIds.length || messageIds.some(id => !messages.some(m => m.id === id))) throw new AppError(404, '选定消息不可访问。'); messages = messages.filter(m => messageIds.includes(m.id)); }
    return { format: 'conversation-json-v1', title: c.title, conversationId: cid, exportedAt: now(), scope: memberId ? `member:${memberId}` : 'local-owner', messages: messages.map(m => this.projectedMessage(m)) };
  }
  branch(cid: string, input: Record<string, unknown>) {
    return this.port.tx(() => this.port.command(`branch:${cid}:${text(input.requestId)}`, input, () => {
      const parent = this.assertConversation(cid), at = this.messages(cid).find(m => m.id === input.messageId && !m.deletedAt);
      if (!at || (at.revision ?? 1) !== input.expectedRevision) conflict();
      const chosen = this.audience(cid, input.memberIds ?? parent.memberIds)!.memberIds;
      const c = this.store.create({ title: text(input.title), memberIds: chosen, defaultMemberId: chosen.includes(parent.defaultMemberId) ? parent.defaultMemberId : chosen[0]!, requestId: `branch-create:${input.requestId}` }).conversation;
      c.branch = { conversationId: cid, messageId: at!.id, cutoff: at!.sequence! }; this.put('cc_conversations', c);
      const inherited = this.readable(cid).filter(m => m.sequence! <= at!.sequence! && (!privateScope(this.messageScope(m)) || this.messageScope(m)!.memberIds.some(id => chosen.includes(id))) && (!m.responseId || ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(this.store.response(m.responseId).status)));
      const copiedIds = new Map(inherited.map(m => [m.id, randomUUID()]));
      for (const m of inherited) {
        const v = this.messageScope(m);
        let content = m.content;
        // A branched share still resolves against its original source; no cached private body.
        // Reply bodies stay separate: flattening a private quote would silently grant it on reveal.
        const images: string[] = [];
        for (const id of m.attachmentIds ?? []) {
          if (this.store.workbench.attachment(id).mediaType !== 'text/plain') {
            images.push(this.store.workbench.copyImageToBranch(id, c.id));
            continue;
          }
          const { attachment: a, content: body } = this.store.workbench.attachmentContent(id); content += `\n\n<user-attachment id=${JSON.stringify(a.id)} name=${JSON.stringify(a.name)} sha256=${JSON.stringify(a.digest)}>\n${body}\n</user-attachment>`; }
        const copy: ConversationMessage = { id: copiedIds.get(m.id)!, conversationId: c.id, author: m.author, memberId: m.memberId, content, ...(images.length ? {attachmentIds: images} : {}), replyTo: m.replyTo ? copiedIds.get(m.replyTo) : undefined, ...(m.excerptRefs ? { excerptRefs: m.excerptRefs, excerptConversationId: m.excerptConversationId ?? cid } : {}), createdAt: m.createdAt, revision: 1, visibility: privateScope(v) ? { kind: 'private', memberIds: v!.memberIds.filter(id => chosen.includes(id)) } : undefined, branchOrigin: { conversationId: cid, messageId: m.id } };
        const row = this.store.db.prepare('INSERT INTO cc_messages VALUES(?,?,NULL,?)').run(copy.id, c.id, JSON.stringify(copy)); copy.sequence = Number(row.lastInsertRowid); this.put('cc_messages', copy);
      }
      this.port.event(c.id, 'conversation.branched', { sourceConversationId: cid, cutoff: at!.sequence }); return c;
    }));
  }
  /** Member projection deliberately contains no owner-only audit objects or global event stream. */
  view(cid: string, memberId: string) {
    const c = this.assertConversation(cid, memberId), messages = this.readable(cid, memberId).map(m => this.projectedMessage(m));
    const attachmentIds = new Set(messages.flatMap(m => m.attachmentIds ?? []));
    return { conversation: { id: c.id, title: c.title, memberIds: c.memberIds }, messages, attachments: this.store.workbench.attachments(cid).filter(a => attachmentIds.has(a.id)) };
  }
}
