import { useState, type FormEvent } from 'react';
import type { Carrier, CollaborationBootstrap, ConfigurationPreview, ConversationDetail } from '../shared/collaboration';
export type WorkbenchCommand = <T>(path: string, body: unknown) => Promise<T>;
const rid = () => crypto.randomUUID();
export function WorkbenchPanel({ detail, workspace, command, refresh }: { detail: ConversationDetail; workspace: string; command: WorkbenchCommand; refresh: () => Promise<void> }) {
  const c = detail.conversation;
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [preview, setPreview] = useState<ConfigurationPreview>();
  async function run(work: () => Promise<unknown>) { setBusy(true); setError(''); try { await work(); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  const organize = (action: string, title?: string) => run(() => command(`/api/conversations/${c.id}/organize`, { requestId: rid(), expectedRevision: c.revision ?? 1, action, title }));
  return <details className="cc-workbench"><summary>会话与项目 <span>{c.archivedAt ? '已归档' : c.pinned ? '已置顶' : ''} · {c.workspaceGrant ? '项目已授权' : '使用服务默认工作区'}</span></summary><div className="cc-workbench-body">
    <form onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); void organize('rename', String(new FormData(e.currentTarget).get('title'))); }}><label>会话名称<input name="title" key={c.title} defaultValue={c.title} maxLength={200} required /></label><button disabled={busy}>保存名称</button></form>
    <div className="cc-workbench-actions"><button disabled={busy} onClick={() => void organize(c.pinned ? 'unpin' : 'pin')}>{c.pinned ? '取消置顶' : '置顶会话'}</button><button disabled={busy} onClick={() => void organize(c.archivedAt ? 'restore' : 'archive')}>{c.archivedAt ? '恢复会话' : '归档会话'}</button></div>
    <p className="cc-note">当前只读工作区：<code>{c.workspaceGrant?.path ?? workspace}</code>。归档保留历史及原执行；恢复后可继续发送。</p>
    <form onSubmit={e => { e.preventDefault(); const path = String(new FormData(e.currentTarget).get('path')); void run(async () => setPreview(await command(`/api/conversations/${c.id}/workspace-preview`, { path }))); }}><label>项目目录<input name="path" required placeholder="本机项目绝对路径" maxLength={2000} onChange={() => setPreview(undefined)} /></label><button disabled={busy}>预览工作区授权</button></form>
    {preview && <div className="cc-workbench-preview"><strong>授权预览 · 只读</strong><code>{'path' in preview.value ? preview.value.path : ''}</code><p>仅授权此会话读取该项目。切换前会检查目录身份与未完成工作，旧会话链不会移作新项目使用。</p><button disabled={busy} onClick={() => void run(async () => { await command(`/api/conversations/${c.id}/workspace-apply`, { previewId: preview.id, requestId: rid() }); setPreview(undefined); })}>授权此项目</button></div>}
    {detail.events.filter(e => ['attachment.uploaded', 'workspace.authorized', 'artifact.published', 'job.succeeded'].includes(e.type)).slice(-4).map(e => <p className="cc-note" key={e.id}>来源事件 #{e.id} · {e.type} · {String(e.data.name ?? e.data.source ?? e.data.versionId ?? '')}</p>)}
    {error && <p className="cc-form-error" role="alert">{error}</p>}
  </div></details>;
}
export function DefaultConfiguration({ data, command, refresh }: { data: CollaborationBootstrap; command: WorkbenchCommand; refresh: () => Promise<void> }) {
  const [carrier, setCarrier] = useState<Carrier>('codex-app-server'), [account, setAccount] = useState(''), [model, setModel] = useState(''), [effort, setEffort] = useState('');
  const [preview, setPreview] = useState<ConfigurationPreview>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const provider = { 'codex-app-server': 'codex', 'claude-cli': 'claude', 'openai-api': 'openai', 'anthropic-api': 'anthropic' }[carrier];
  const accounts = data.accounts.filter(a => a.provider === provider), selected = accounts.find(a => a.id === account) ?? accounts[0];
  const catalog = data.accountObservations?.find(o => o.accountId === selected?.id)?.models ?? [];
  const names = (ids: string[]) => ids.map(id => data.members.find(m => m.id === id)?.name ?? id).join('、') || '无';
  async function run(work: () => Promise<unknown>) { setError(''); setBusy(true); try { await work(); await refresh(); } catch (e) { setError((e as Error).message); setPreview(undefined); } finally { setBusy(false); } }
  return <details className="cc-default-settings"><summary>运行时默认账户与模型</summary><p className="cc-note">当前：{data.defaults?.map(d => `${d.carrier} → ${data.accounts.find(a => a.id === d.accountId)?.name ?? d.accountId}`).join('；') || '尚未设置'}</p>
    <label>默认配置运行时<select value={carrier} onChange={e => { setCarrier(e.target.value as Carrier); setAccount(''); setModel(''); setEffort(''); setPreview(undefined); }}><option value="codex-app-server">Codex CLI</option><option value="claude-cli">Claude Code CLI</option><option value="openai-api">OpenAI 兼容 API</option><option value="anthropic-api">Anthropic API</option></select></label>
    <label>默认账户<select value={selected?.id ?? ''} onChange={e => { setAccount(e.target.value); setModel(''); setEffort(''); setPreview(undefined); }}><option value="" disabled>选择账户</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
    <button type="button" disabled={busy || !selected} onClick={() => void run(() => command(`/api/accounts/${selected!.id}/probe`, {}))}>刷新默认账户模型目录</button>
    <label>默认模型<select value={model} onChange={e => { setModel(e.target.value); setEffort(''); setPreview(undefined); }}><option value="">运行时默认（仅官方 CLI）</option>{catalog.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
    <label>默认推理强度<select value={effort} onChange={e => { setEffort(e.target.value); setPreview(undefined); }}><option value="">模型默认</option>{catalog.find(m => m.id === model)?.efforts.map(e => <option key={e}>{e}</option>)}</select></label>
    <button disabled={busy || !selected} onClick={() => void run(async () => setPreview(await command('/api/collaboration/default-preview', { carrier, accountId: selected!.id, model, effort })))}>预览默认配置影响</button>
    {preview && <div className="cc-workbench-preview"><p>将跟随更新：{names(preview.affectedMemberIds)}</p><p>保留成员例外：{names(preview.unaffectedMemberIds)}</p><p className="cc-note">已开始执行保留原配置；预览 5 分钟有效，配置变化后需重新预览。</p><button disabled={busy} onClick={() => void run(async () => { await command('/api/collaboration/default-apply', { previewId: preview.id, requestId: rid() }); setPreview(undefined); })}>应用默认配置</button></div>}
    {error && <p role="alert" className="cc-form-error">{error}</p>}
  </details>;
}
