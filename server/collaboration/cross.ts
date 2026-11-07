import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import type { CollaborationEndpoint, Conversation, CrossGrant, CrossTransfer, MessageExcerpt, SourceWork, TaskActor } from '../../shared/collaboration.js';
import { AppError, now } from '../store.js';
import type { CollaborationStore } from './store.js';
import { privateScope, textDigest } from './visibility.js';
import { verifyWorkspace } from './workbench.js';

export const conflict = (message: string): never => { throw new AppError(409, message, 'cross_action_conflict'); };
export const field = (v: unknown, label: string, max = 200): string => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new AppError(400, `${label}无效。`); return v.trim(); };
export function fields(input: Record<string, unknown>, allowed: string[]) { if (Object.keys(input).some(k => !allowed.includes(k))) throw new AppError(400, '请求包含未知字段；执行身份和证据只能由服务器绑定。'); }
export const endpointEqual = (a: CollaborationEndpoint, b: CollaborationEndpoint) => a.conversationId === b.conversationId && a.memberId === b.memberId;

/** A grant authorizes an exact pair of endpoints, never general access to another conversation. */
export class CrossConversationService {
  constructor(readonly store: CollaborationStore) {}
  get data() { return this.store.artifacts; }
  get port() { return this.data.port; }
  clock() { return this.store.options.clock?.() ?? Date.now(); }
  grants() { return this.data.rows<CrossGrant>('cc_cross_grants'); }
  transfers() { return this.data.rows<CrossTransfer>('cc_cross_transfers'); }
  grant(id: string) { return this.data.get<CrossGrant>('cc_cross_grants', id); }
  workspace(c: Conversation) {
    if (c.workspaceGrant) { verifyWorkspace(c.workspaceGrant); return textDigest(JSON.stringify(c.workspaceGrant)); }
    const configuredPath = this.store.options.workspace;
    if (!configuredPath) return textDigest(JSON.stringify({ path: '' }));
    try {
      const path = realpathSync(configuredPath), stat = statSync(path);
      if (!stat.isDirectory()) throw new Error();
      return textDigest(JSON.stringify({ configuredPath, path, device: stat.dev, inode: stat.ino }));
    } catch { return conflict('工作区目录身份已改变，需要重新批准两端授权。'); }
  }
  endpoint(e: CollaborationEndpoint) {
    const c = this.store.visibility.assertConversation(e.conversationId, e.memberId);
    if (c.archivedAt || !this.store.members().some(m => m.id === e.memberId && m.enabled && !m.deletedAt)) conflict('跨会话端点已归档、停用或失效。');
    return c;
  }
  valid(g: CrossGrant, revision = g.revision) {
    if (g.state !== 'active' || g.revision !== revision || Date.parse(g.expiresAt) <= this.clock()) conflict('跨会话授权已撤销、过期或变化。');
    if (this.workspace(this.endpoint(g.home)) !== g.homeWorkspace || this.workspace(this.endpoint(g.target)) !== g.targetWorkspace) conflict('工作区身份变化，需要重新批准两端授权。');
  }
  actor(invocationId: string): TaskActor & { kind: 'agent' } {
    this.store.visibility.assertTool(invocationId, 'cross_send');
    const a = this.store.tasks.actor(invocationId);
    if (a.kind !== 'agent' || this.store.invocation(invocationId).acceptance !== 'accepted' || this.store.contract(invocationId).toolPolicyVersion !== 'cross-action-v1') conflict('当前执行没有跨会话工具权限。');
    return a as TaskActor & { kind: 'agent' };
  }
  checkOrigin(origin?: TaskActor) {
    if (origin?.kind !== 'agent') return;
    const s = this.data.get<SourceWork>('cc_sources', origin.sourceId), i = this.store.invocation(origin.invocationId), c = this.store.contract(i.id);
    this.endpoint({ conversationId: i.conversationId, memberId: origin.memberId });
    if (s.withdrawnAt || s.revision !== origin.sourceRevision || i.memberId !== origin.memberId || (i.cancelRevision ?? 0) !== origin.cancelRevision || privateScope(c.visibility) || c.sourceDigest !== this.store.sourceDigest(s)) conflict('原始请求或执行身份已失效。');
  }
  refs(cid: string, refs: unknown): MessageExcerpt[] {
    if (refs === undefined) return [];
    if (!Array.isArray(refs) || refs.length > 8) throw new AppError(400, '跨会话引用列表无效。');
    if (!refs.length) return [];
    this.store.visibility.resolveRefs(cid, refs);
    for (const ref of refs as MessageExcerpt[]) {
      const m = this.store.visibility.messages(cid).find(m => m.id === ref.messageId)!;
      if (privateScope(this.store.visibility.messageScope(m))) throw new AppError(403, '本轮跨会话只允许公开材料，私聊不能借引用转发。');
    }
    return refs as MessageExcerpt[];
  }
  createGrant(cid: string, input: Record<string, unknown>) {
    fields(input, ['requestId','homeMemberId','targetConversationId','targetMemberId','expiresAt']);
    return this.port.tx(() => this.port.command(`cross-grant:${cid}:${field(input.requestId,'请求标识')}`, input, () => {
      const home = { conversationId: cid, memberId: field(input.homeMemberId,'本会话成员') }, target = { conversationId: field(input.targetConversationId,'目标会话'), memberId: field(input.targetMemberId,'目标成员') };
      if (home.conversationId === target.conversationId) throw new AppError(400, '跨会话授权需要不同会话。');
      const hc = this.endpoint(home), tc = this.endpoint(target), expiresAt = field(input.expiresAt,'有效期');
      if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= this.clock() || Date.parse(expiresAt) > this.clock() + 30 * 86400000) throw new AppError(400, '授权有效期须在未来 30 天内。');
      if (this.grants().filter(g => g.state === 'active' && g.conversationId === cid).length >= 50) conflict('请先整理现有授权。');
      const g: CrossGrant = { id: randomUUID(), conversationId: cid, home, target, homeWorkspace: this.workspace(hc), targetWorkspace: this.workspace(tc), revision: 1, state: 'active', expiresAt, createdAt: now() };
      this.data.save('cc_cross_grants', g, 'cross.grant_created'); this.port.event(target.conversationId,'cross.grant_received',{ grantId: g.id }); return g;
    }));
  }
  revoke(id: string, input: Record<string, unknown>) {
    fields(input,['requestId','expectedRevision']);
    return this.port.tx(() => this.port.command(`cross-revoke:${id}:${field(input.requestId,'请求标识')}`, input, () => {
      const g = this.grant(id); if (g.revision !== input.expectedRevision || g.state !== 'active') conflict('授权修订已变化。');
      g.state = 'revoked'; g.revision++; this.data.save('cc_cross_grants',g,'cross.grant_revoked'); this.store.visibility.changed(g.conversationId); this.sweep(); return g;
    }));
  }
  send(cid: string, input: Record<string, unknown>, invocationId?: string) {
    fields(input,['requestId','grantId','content','refs']);
    const origin = invocationId ? this.actor(invocationId) : undefined;
    return this.port.tx(() => this.port.command(`cross-send:${cid}:${field(input.requestId,'请求标识')}`, { input, origin }, () => {
      const g = this.grant(field(input.grantId,'授权')); this.valid(g);
      const from = g.home.conversationId === cid ? g.home : g.target.conversationId === cid ? g.target : conflict('当前会话不属于此授权。');
      if (origin && (this.store.invocation(origin.invocationId).conversationId !== cid || origin.memberId !== from.memberId)) throw new AppError(403, '当前成员不是此授权的发送端。');
      this.checkOrigin(origin);
      const to = endpointEqual(from,g.home) ? g.target : g.home, refs = this.refs(cid,input.refs), content = field(input.content,'跨会话消息',12000);
      const transfer: CrossTransfer = { id: randomUUID(), conversationId: cid, grantId:g.id, grantRevision:g.revision, from, to, sourceId:'', origin, refs, content, createdAt:now() };
      const depth = origin ? this.data.get<SourceWork>('cc_sources',origin.sourceId).depth + 1 : 0; if (depth > 8) conflict('跨会话链达到深度限制。');
      const s = this.store.admitSource({ conversationId:to.conversationId, kind:'cross_message', content:`跨会话消息 ${transfer.id}，来自 ${from.memberId}。\n${content}`, requestedTargets:[to.memberId], depth, crossRef:{transferId:transfer.id} });
      transfer.sourceId=s.id; this.data.save('cc_cross_transfers',transfer,'cross.sent'); this.store.publishSource(s); this.port.event(to.conversationId,'cross.received',{ transferId:transfer.id,sourceId:s.id }); return transfer;
    }));
  }
  material(s: SourceWork) {
    if (!s.crossRef) return s.content;
    const t=this.data.get<CrossTransfer>('cc_cross_transfers',s.crossRef.transferId); this.valid(this.grant(t.grantId),t.grantRevision); this.checkOrigin(t.origin);
    if (t.invalidatedAt || s.id!==t.sourceId || s.conversationId!==t.to.conversationId || s.withdrawnAt) conflict('跨会话来源已失效。');
    this.refs(t.conversationId,t.refs);
    return s.content+(t.refs.length?'\n获准公开选段：\n'+this.store.visibility.resolveRefs(t.conversationId,t.refs):'');
  }
  routes(cid: string, memberId: string) { return this.grants().filter(g => { try { this.valid(g); return [g.home,g.target].some(e=>e.conversationId===cid&&e.memberId===memberId); } catch {return false;} }); }
  detail(cid:string) { return {crossGrants:this.grants().filter(g=>[g.home,g.target].some(e=>e.conversationId===cid)),crossTransfers:this.transfers().filter(t=>[t.from,t.to].some(e=>e.conversationId===cid))}; }
  withdraw(s: SourceWork) { if (!s.withdrawnAt) this.store.cooperation.withdraw(s.id,{requestId:`n9-withdraw:${s.id}`,expectedRevision:s.revision}); for (const i of this.store.invocations(s.conversationId)) if (this.store.response(i.responseId).inputSourceIds.includes(s.id) && ['prepared','running'].includes(i.status)) this.store.cancel(i.id); }
  sweep() { this.port.tx(()=>{
    for (const g of this.grants()) if (g.state==='active') {
      try { this.valid(g); }
      catch (error) {
        g.state=Date.parse(g.expiresAt)<=this.clock()?'expired':'revoked';g.revision++;
        g.reason=error instanceof Error?error.message:'两端授权已失效';
        this.data.save('cc_cross_grants',g,`cross.grant_${g.state}`);this.store.visibility.changed(g.conversationId);
      }
    }
    for (const t of this.transfers()) {
      const s=this.data.get<SourceWork>('cc_sources',t.sourceId);
      try {this.material(s);} catch {
        if (!t.invalidatedAt) {t.invalidatedAt=now();this.data.save('cc_cross_transfers',t,'cross.material_invalidated');this.store.visibility.changed(t.conversationId);}
        this.withdraw(s);
      }
    }
  }); }
  tool(id:string,name:string,input:Record<string,unknown>,callId:string) {
    const actor=this.actor(id),i=this.store.invocation(id);
    if(name==='cross_routes') {fields(input,[]);return {routes:this.routes(i.conversationId,actor.memberId)};}
    if(name==='cross_send') return this.send(i.conversationId,{...input,requestId:`${id}:${callId}`},id);
    throw new AppError(400,'跨会话工具不存在。');
  }
}
