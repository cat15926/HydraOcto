import { randomUUID, createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { AccountObservation, Carrier, CollaborationAccount, ConfigurationPreview, Conversation, ConversationAttachment, ConversationMessage, Member, RuntimeDefault, SendMessage, WorkspaceGrant } from '../../shared/collaboration.js';
import { AppError, now } from '../store.js';
import type { CollaborationStore } from './store.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const conflict = (text: string): never => { throw new AppError(409, text, 'workbench_conflict'); };
const text = (v: unknown, label: string, max = 200): string => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new AppError(400, `${label}无效。`); return v.trim(); };
export const carrierProvider = { 'codex-app-server': 'codex', 'claude-cli': 'claude', 'openai-api': 'openai', 'anthropic-api': 'anthropic' } as const;
export function verifyWorkspace(grant: WorkspaceGrant): void {
  try { const path = realpathSync(grant.path), s = statSync(path); if (path !== grant.path || !s.isDirectory() || s.dev !== grant.device || s.ino !== grant.inode) throw new Error(); }
  catch { throw new AppError(409, '工作区目录身份已改变，请重新预览并授权。', 'workspace_changed'); }
}
function overlap(a: string, b: string) { const rel = relative(a, b); return !rel || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
function canonicalPath(path: string): string { try { return realpathSync(path); } catch { const parent = dirname(path); return parent === path ? path : resolve(canonicalPath(parent), path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1))); } }

/** Human workbench commands share the collaboration transaction and never change historical snapshots. */
export class WorkbenchService {
  private probes = new Map<string, string>();
  constructor(readonly store: CollaborationStore) {}
  private get data() { return this.store.artifacts; }
  private get port() { return this.data.port; }
  private put(table: string, value: { id: string }) { this.store.db.prepare(`UPDATE ${table} SET value=? WHERE id=?`).run(JSON.stringify(value), value.id); }
  private configChanged() { this.store.db.prepare("UPDATE cc_meta SET value=value+1 WHERE key='configuration_revision'").run(); }
  private emitConfig(type: string, data: Record<string, unknown>) { for (const c of this.store.list()) this.port.event(c.id, type, data); }
  defaults(): RuntimeDefault[] { return (this.store.db.prepare('SELECT value FROM cc_runtime_defaults').all() as { value: string }[]).map(r => JSON.parse(r.value)); }
  account(id: string) { const a = this.store.accounts().find(a => a.id === id && !a.deletedAt); if (!a) throw new AppError(400, '账户不存在或已删除。'); return a; }
  resolveMember(member: Member): Member {
    const d = this.defaults().find(d => d.carrier === member.carrier);
    const accountId = member.accountBinding === 'follow' ? d?.accountId : member.accountId;
    if (!accountId) conflict('运行时尚未配置默认账户。');
    if (member.modelBinding === 'follow' && !d) conflict('运行时尚未设置默认模型配置。');
    const account = this.account(accountId!);
    const model = member.modelBinding === 'follow' ? d?.model : member.model;
    const effort = member.modelBinding === 'follow' ? d?.effort : member.effort;
    if (account.provider !== carrierProvider[member.carrier]) throw new AppError(400, '成员运行时与账户不匹配。');
    if (account.auth === 'api' && !model) throw new AppError(400, 'API 账户需要明确模型。');
    return { ...member, accountId: account.id, model, effort };
  }
  conversation(id: string) { return this.data.get<Conversation>('cc_conversations', id); }
  organize(cid: string, input: Record<string, unknown>) {
    return this.port.tx(() => this.port.command(`organize:${cid}:${text(input.requestId, '请求标识')}`, input, () => {
      const c = this.conversation(cid); if ((c.revision ?? 1) !== input.expectedRevision) conflict('会话已变化，请刷新。');
      if (!['rename', 'pin', 'unpin', 'archive', 'restore'].includes(String(input.action))) throw new AppError(400, '会话操作无效。');
      if (input.action === 'rename') c.title = text(input.title, '会话名称');
      if (input.action === 'pin' || input.action === 'unpin') c.pinned = input.action === 'pin';
      if (input.action === 'archive') c.archivedAt = now();
      if (input.action === 'restore') delete c.archivedAt;
      c.revision = (c.revision ?? 1) + 1; c.updatedAt = now(); this.put('cc_conversations', c);
      this.store.cross.sweep(); this.port.event(cid, 'conversation.organized', { action: input.action, revision: c.revision }); return c;
    }));
  }
  attachments(cid: string): ConversationAttachment[] { return this.data.rows('cc_attachments', cid); }
  upload(cid: string, input: Record<string, unknown>) {
    return this.port.tx(() => this.port.command(`upload:${cid}:${text(input.requestId, '请求标识')}`, input, () => {
      if (this.conversation(cid).archivedAt) conflict('请先恢复归档会话。');
      const name = text(input.name, '文件名', 160);
      if (/[\\/\x00-\x1f]/.test(name) || name === '.' || name === '..' || name.startsWith('.')) throw new AppError(400, '文件名不允许路径或隐藏文件。');
      if (typeof input.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64)) throw new AppError(400, '附件编码无效。');
      if (!['text/plain', 'text/markdown', 'text/csv', 'text/javascript', 'text/typescript', 'text/html', 'text/css', 'application/json', 'application/xml', 'text/xml', ''].includes(String(input.mediaType ?? ''))) throw new AppError(415, '当前仅支持 UTF-8 文本和代码附件，暂不支持图片/PDF。');
      const bytes = Buffer.from(input.base64, 'base64'); if (!bytes.length || bytes.length > 32768) throw new AppError(413, '每个附件需要 1–32 KiB。');
      let content: string; try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new AppError(415, '附件需要有效 UTF-8 编码。'); }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content) || /^%PDF-|^\x89PNG/.test(content)) throw new AppError(415, '附件包含二进制内容。');
      // A UTF-8 BOM is accepted but kept in the digest and actual payload.
      content = bytes.toString('utf8');
      const a: ConversationAttachment = { id: randomUUID(), conversationId: cid, name, mediaType: 'text/plain', bytes: bytes.length, digest: digest(content), createdAt: now() };
      this.store.db.prepare('INSERT INTO cc_attachments VALUES(?,?,?)').run(a.id, cid, JSON.stringify(a));
      this.store.db.prepare('INSERT INTO cc_attachment_contents VALUES(?,?)').run(a.id, content);
      this.port.event(cid, 'attachment.uploaded', { attachmentId: a.id, name, bytes: a.bytes, digest: a.digest, source: 'user_upload' }); return a;
    }));
  }
  attachmentContent(id: string) {
    const attachment = this.data.get<ConversationAttachment>('cc_attachments', id);
    const row = this.store.db.prepare('SELECT content FROM cc_attachment_contents WHERE attachment_id=?').get(id) as { content: string } | undefined;
    if (!row || digest(row.content) !== attachment.digest) conflict('附件正文缺失或摘要不一致。');
    return { attachment, content: row!.content };
  }
  compose(cid: string, input: SendMessage): string {
    if (this.conversation(cid).archivedAt) conflict('请先恢复归档会话再发送。');
    if (typeof input.content !== 'string' || input.content.length > 20000) throw new AppError(400, '消息最多 20,000 字符。');
    const ids = input.attachmentIds ?? [];
    if (!Array.isArray(ids) || ids.length > 4 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) throw new AppError(400, '每条消息最多 4 个不重复附件。');
    const parts = [input.content]; let bytes = 0;
    if (input.replyTo) {
      const m = this.data.get<ConversationMessage>('cc_messages', text(input.replyTo, '引用标识'));
      if (m.conversationId !== cid) throw new AppError(400, '引用必须属于当前会话。');
      parts.push(`\n<reply-context messageId=${JSON.stringify(m.id)} author=${JSON.stringify(m.memberId ?? m.author)}>\n${m.content.slice(0, 8000)}${m.content.length > 8000 ? '\n[引用超过 8,000 字符，余文未包含]' : ''}\n</reply-context>`);
    }
    for (const id of ids) {
      const { attachment: a, content } = this.attachmentContent(id); if (a.conversationId !== cid) throw new AppError(400, '附件必须属于当前会话。');
      bytes += a.bytes;
      parts.push(`\n<user-attachment id=${JSON.stringify(a.id)} name=${JSON.stringify(a.name)} sha256=${JSON.stringify(a.digest)}>\n${content}\n</user-attachment>`);
    }
    if (bytes > 49152) throw new AppError(413, '单条消息附件总量最多 48 KiB。');
    if (!input.content.trim() && !ids.length) throw new AppError(400, '请输入消息或添加附件。');
    return parts.join('\n');
  }
  private idle(cid: string) {
    if (this.store.invocations(cid).some(i => !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(i.status) || i.teardown !== 'confirmed') || this.store.cooperation.queue(cid).sources.length) conflict('工作区切换需要会话没有待投递来源或未释放执行。');
  }
  private workspace(path: string, revision: number): WorkspaceGrant {
    if (!isAbsolute(path)) throw new AppError(400, '工作区需要绝对路径。');
    let actual: string; try { actual = realpathSync(path); if (!statSync(actual).isDirectory()) throw new Error(); } catch { throw new AppError(400, '工作区目录不存在。'); }
    const privateRoots = [this.store.options.artifactDir ?? resolve('.local-data/collaboration-artifacts'), ...((this.store.db.prepare('PRAGMA database_list').all() as { file: string }[]).filter(r => r.file).map(r => dirname(r.file))), resolve(homedir(), '.codex'), resolve(homedir(), '.claude'), resolve(homedir(), '.ssh'), resolve(homedir(), '.aws')].map(canonicalPath);
    // An inherited project may contain .local-data; hidden paths remain unreadable. Its private child cannot be selected.
    if (actual === sep || actual === homedir() || actual.split(sep).some(p => p.startsWith('.')) || privateRoots.some(p => overlap(p, actual) || (overlap(actual, p) && !relative(actual, p).split(sep).some(x => x.startsWith('.'))))) throw new AppError(403, '此目录覆盖私有数据，不能作为授权工作区。');
    const s = statSync(actual); return { path: actual, device: s.dev, inode: s.ino, authorizedAt: now(), revision, mode: 'read-only' };
  }
  checkFolderSelection(cid: string, expectedRevision: number) {
    const c = this.conversation(cid);
    if (c.archivedAt || c.deletedAt) conflict('请先恢复此会话，再选择项目文件夹。');
    if ((c.revision ?? 1) !== expectedRevision) conflict('会话已变化，请重新选择项目文件夹。');
    this.idle(cid);
  }
  previewWorkspace(cid: string, input: Record<string, unknown>) {
    return this.port.tx(() => {
      const c = this.conversation(cid); this.idle(cid);
      const grant = this.workspace(text(input.path, '工作区', 2000), (c.workspaceGrant?.revision ?? 0) + 1);
      return this.savePreview({ kind: 'workspace', value: grant, conversationId: cid, conversationRevision: c.revision ?? 1, affectedMemberIds: c.memberIds, unaffectedMemberIds: [] });
    });
  }
  private savePreview(input: Omit<ConfigurationPreview, 'id' | 'configurationRevision' | 'expiresAt'>): ConfigurationPreview {
    const p: ConfigurationPreview = { ...input, id: randomUUID(), configurationRevision: this.store.configurationRevision(), expiresAt: new Date(Date.now() + 300000).toISOString() };
    this.store.db.prepare('INSERT INTO cc_configuration_previews VALUES(?,?)').run(p.id, JSON.stringify(p)); return p;
  }
  private catalog(accountId: string, model?: string, effort?: string) {
    if (!model) { if (effort) throw new AppError(400, '推理强度需要指定模型。'); if (this.account(accountId).auth === 'api') throw new AppError(400, 'API 账户需要明确模型。'); return; }
    const observation = this.observations().find(o => o.accountId === accountId);
    const entry = observation?.models.find(m => m.id === model);
    if (!entry || Date.now() - Date.parse(observation!.checkedAt) > 600000) conflict('请先刷新所选账户的真实模型目录，再选择目录中的模型。');
    if (effort && !entry!.efforts.includes(effort)) throw new AppError(400, '模型目录未声明支持此推理强度。');
  }
  previewDefault(input: Record<string, unknown>) {
    return this.port.tx(() => {
      const carrier = String(input.carrier) as Carrier; if (!(carrier in carrierProvider)) throw new AppError(400, '运行时无效。');
      const account = this.account(text(input.accountId, '账户'));
      if (account.provider !== carrierProvider[carrier]) throw new AppError(400, '默认账户与运行时不匹配。');
      const model = input.model ? text(input.model, '模型') : undefined, effort = input.effort ? text(input.effort, '推理强度', 30) : undefined;
      this.catalog(account.id, model, effort);
      const members = this.store.members().filter(m => m.carrier === carrier && !m.deletedAt);
      for (const m of members.filter(m => m.accountBinding === 'follow' || m.modelBinding === 'follow')) this.catalog(m.accountBinding === 'follow' ? account.id : m.accountId, m.modelBinding === 'follow' ? model : m.model, m.modelBinding === 'follow' ? effort : m.effort);
      return this.savePreview({ kind: 'default', value: { carrier, accountId: account.id, model, effort, revision: (this.defaults().find(d => d.carrier === carrier)?.revision ?? 0) + 1 }, affectedMemberIds: members.filter(m => m.accountBinding === 'follow' || m.modelBinding === 'follow').map(m => m.id), unaffectedMemberIds: members.filter(m => m.accountBinding !== 'follow' && m.modelBinding !== 'follow').map(m => m.id) });
    });
  }
  applyPreview(input: Record<string, unknown>, cid?: string) {
    return this.port.tx(() => this.port.command(`preview-apply:${text(input.requestId, '请求标识')}`, { ...input, cid }, () => {
      const p = this.data.get<ConfigurationPreview>('cc_configuration_previews', text(input.previewId, '预览标识'));
      if (p.appliedAt || p.configurationRevision !== this.store.configurationRevision() || Date.parse(p.expiresAt) <= Date.now()) conflict('配置预览已失效，请重新预览。');
      if ((p.kind === 'workspace') !== !!cid || p.conversationId !== cid) throw new AppError(400, '预览不属于此操作。');
      if (p.kind === 'workspace') {
        const c = this.conversation(cid!); this.idle(c.id); if ((c.revision ?? 1) !== p.conversationRevision) conflict('会话已变化，请重新预览授权。');
        const grant = p.value as WorkspaceGrant; verifyWorkspace(grant); this.workspace(grant.path, grant.revision);
        c.workspaceGrant = { ...grant, authorizedAt: now() }; c.revision = (c.revision ?? 1) + 1; c.updatedAt = now(); this.put('cc_conversations', c);
        this.store.cross.sweep(); this.port.event(c.id, 'workspace.authorized', { grant: c.workspaceGrant, source: 'user_authorization' });
      } else {
        const value = p.value as RuntimeDefault; this.account(value.accountId); this.catalog(value.accountId, value.model, value.effort);
        this.store.db.prepare('INSERT INTO cc_runtime_defaults VALUES(?,?) ON CONFLICT(carrier) DO UPDATE SET value=excluded.value').run(value.carrier, JSON.stringify(value));
        this.emitConfig('configuration.default_applied', { carrier: value.carrier, accountId: value.accountId, affectedMemberIds: p.affectedMemberIds });
      }
      p.appliedAt = now(); this.put('cc_configuration_previews', p); this.configChanged(); return p;
    }));
  }
  saveMember(input: Member, version?: unknown, requestId?: unknown) {
    return this.port.tx(() => this.port.command(`member:${text(requestId, '请求标识')}`, { input, version }, () => {
      const old = this.store.members().find(m => m.id === input.id); if ((old?.revision ?? 0) !== version) conflict('成员配置已变化，请刷新。');
      if (old?.deletedAt) conflict('成员已删除；历史 ID 不能复用。');
      const effective = this.resolveMember(input);
      const prior = old && (() => { try { return this.resolveMember(old); } catch { return undefined; } })();
      if (!prior || effective.accountId !== prior.accountId || effective.model !== prior.model || effective.effort !== prior.effort || effective.carrier !== prior.carrier) this.catalog(effective.accountId, effective.model, effective.effort);
      const saved = this.store.saveMember(input); this.emitConfig('configuration.member_saved', { memberId: saved.id, revision: saved.revision }); return saved;
    }));
  }
  saveAccount(input: CollaborationAccount, version?: unknown, requestId?: unknown) {
    return this.port.tx(() => this.port.command(`account:${text(requestId, '请求标识')}`, { input, version }, () => {
      const old = this.store.accounts().find(a => a.id === input.id); if ((old?.revision ?? 0) !== version) conflict('账户配置已变化，请刷新。');
      if (old?.deletedAt) conflict('账户已删除；历史 ID 不能复用。');
      const a = this.store.saveAccount(input); this.emitConfig('configuration.account_saved', { accountId: a.id, revision: a.revision }); return a;
    }));
  }
  remove(kind: 'members' | 'accounts', id: string, input: Record<string, unknown>) {
    return this.port.tx(() => this.port.command(`delete-${kind}:${id}:${text(input.requestId, '请求标识')}`, input, () => {
      const table = kind === 'members' ? 'cc_members' : 'cc_accounts';
      const value = this.data.get<Member | CollaborationAccount>(table, id);
      if ((value.revision ?? 1) !== input.expectedRevision || value.deletedAt) conflict('配置已变化，请刷新。');
      if (kind === 'accounts' && (this.store.members().some(m => !m.deletedAt && (m.accountBinding !== 'follow' && m.accountId === id || this.defaults().some(d => d.accountId === id && d.carrier === m.carrier && m.accountBinding === 'follow'))) || this.defaults().some(d => d.accountId === id))) conflict('账户仍被成员或运行时默认配置引用，请先调整绑定。');
      value.deletedAt = now(); value.revision = (value.revision ?? 1) + 1; if ('enabled' in value) value.enabled = false;
      this.put(table, value); this.configChanged(); this.store.cross.sweep(); this.emitConfig('configuration.deleted', { kind, id, revision: value.revision }); return value;
    }));
  }
  beginProbe(accountId: string) { const account = this.account(accountId), ticket = randomUUID(); this.probes.set(accountId, ticket); return { account, ticket }; }
  finishProbe(account: CollaborationAccount, ticket: string, observation: AccountObservation) {
    return this.port.tx(() => {
      if (this.probes.get(account.id) !== ticket || this.account(account.id).revision !== account.revision) conflict('账户或探测请求已变化，旧结果已丢弃。');
      this.store.db.prepare('INSERT INTO cc_account_observations VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(account.id, JSON.stringify(observation));
      return observation;
    });
  }
  observations(): AccountObservation[] {
    const saved = (this.store.db.prepare('SELECT value FROM cc_account_observations').all() as { value: string }[]).map(r => JSON.parse(r.value) as AccountObservation);
    return this.store.accounts().filter(a => !a.deletedAt).map(a => {
      const o: AccountObservation = saved.find(o => o.accountId === a.id && o.accountRevision === (a.revision ?? 1)) ?? { accountId: a.id, accountRevision: a.revision ?? 1, checkedAt: '', installed: a.provider === 'openai' || a.provider === 'anthropic', configured: a.auth === 'cli' || !!(a.apiKeyEnv && process.env[a.apiKeyEnv]?.trim()), connection: 'unknown', identity: { state: 'unknown' }, models: [], catalogSource: 'unavailable', quota: { state: 'unknown' }, reason: '尚未探测此账户版本。' };
      const run = this.store.invocations().filter(i => { const account = this.store.accountFor(i.id); return account.id === o.accountId && (account.revision ?? 1) === o.accountRevision; }).at(-1);
      return { ...o, ...(run ? { latestInvocation: { id: run.id, status: run.status, at: run.finishedAt ?? run.startedAt ?? run.createdAt, accountRevision: o.accountRevision } } : {}) };
    });
  }
}
