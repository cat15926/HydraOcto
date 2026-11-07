import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Carrier, CollaborationBootstrap, ConfigurationPreview, ConversationDetail } from '../shared/collaboration';
import { WorkspaceIcon } from './WorkspaceIcon';
export type WorkbenchCommand = <T>(path: string, body: unknown, signal?: AbortSignal) => Promise<T>;
const rid = () => crypto.randomUUID();
export function WorkbenchPanel({ detail, workspace, command, refresh, visible }: {
  detail: ConversationDetail; workspace: string; command: WorkbenchCommand; refresh: () => Promise<void>; visible: boolean;
}) {
  const c = detail.conversation, grant = c.workspaceGrant;
  const [preview, setPreview] = useState<ConfigurationPreview>(), [picking, setPicking] = useState(false), [applying, setApplying] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const pending = useRef<AbortController | undefined>(undefined), chooseButton = useRef<HTMLButtonElement>(null), confirmButton = useRef<HTMLButtonElement>(null);
  const nextFocus = useRef<'choose' | 'confirm' | null>(null);
  useLayoutEffect(() => { if (!visible) setPicking(false); return () => { pending.current?.abort(); pending.current = undefined; nextFocus.current = null; }; }, [visible, c.id]);
  // Wait for React to re-enable the control before handing the keyboard back to it.
  useLayoutEffect(() => {
    if (!visible || applying || picking || !nextFocus.current) return;
    const target = nextFocus.current === 'confirm' ? confirmButton.current ?? chooseButton.current : chooseButton.current;
    nextFocus.current = null;
    if (target?.getClientRects().length && !target.disabled) target.focus({ preventScroll: true });
  }, [visible, applying, picking, preview, notice, error]);
  useEffect(() => {
    if (!preview) return;
    const expire = () => { setPreview(undefined); setNotice('授权预览已失效，请重新选择文件夹。'); };
    if (preview.conversationRevision !== (c.revision ?? 1)) { expire(); return; }
    const timer = setTimeout(expire, Math.max(0, Date.parse(preview.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [preview, c.revision]);
  async function pick() {
    if (pending.current || applying) return;
    const controller = new AbortController(); pending.current = controller;
    setPicking(true); setError(''); setNotice('');
    try {
      const result = await command<{ preview: ConfigurationPreview | null }>('/api/conversations/' + c.id + '/workspace-pick', {expectedRevision: c.revision ?? 1}, controller.signal);
      if (!controller.signal.aborted) {
        nextFocus.current = result.preview ? 'confirm' : 'choose';
        if (result.preview) setPreview(result.preview);
        else setNotice('已取消选择，工作区未变更。');
      }
    } catch (e) { if (!controller.signal.aborted) { nextFocus.current = 'choose'; setError((e as Error).message); } }
    finally { if (pending.current === controller) { pending.current = undefined; setPicking(false); } }
  }
  function cancelPick() {
    pending.current?.abort(); pending.current = undefined; nextFocus.current = 'choose'; setPicking(false); setNotice('已取消选择，工作区未变更。');
  }
  async function apply() {
    if (!preview || applying || picking) return;
    setApplying(true); setError(''); setNotice('');
    try {
      await command('/api/conversations/' + c.id + '/workspace-apply', { previewId: preview.id, requestId: rid() });
      nextFocus.current = 'choose'; setPreview(undefined); await refresh(); setNotice('项目文件夹已切换，只读授权已生效。');
    } catch (e) { setError((e as Error).message); const stale = (e as {status?: number}).status === 409; nextFocus.current = stale ? 'choose' : 'confirm'; if (stale) setPreview(undefined); }
    finally { setApplying(false); }
  }
  const selected = preview && 'path' in preview.value ? preview.value.path : undefined;
  const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  return <section className="cc-workbench cc-project-picker" aria-label="项目文件夹">
    <h3>项目文件夹</h3><div className="cc-project-current"><span className="cc-project-symbol"><WorkspaceIcon name="folder" /></span><div><small>当前工作区</small><strong>{grant ? basename(grant.path) : '默认工作区'}</strong></div><small>只读</small></div>
    {grant ? <code className="cc-project-path">{grant.path}</code> : <details className="cc-project-location"><summary>查看默认目录</summary><code>{workspace}</code></details>}
    <p className="cc-note">{c.archivedAt || c.deletedAt ? '恢复会话后可更换项目文件夹。' : picking ? '请在系统窗口中选择项目文件夹。' : '为这次会话选择一个本地项目。'}</p>
    <div className="cc-project-actions"><button ref={chooseButton} className={selected ? '' : 'cc-project-primary'} disabled={picking || applying || !!c.archivedAt || !!c.deletedAt} onClick={() => void pick()}><WorkspaceIcon name="folder" />{picking ? '正在选择…' : selected ? '重新选择…' : grant ? '更换文件夹…' : '选择文件夹…'}</button>{picking && <button onClick={cancelPick}>取消选择</button>}</div>
    {selected && <section className="cc-workbench-preview cc-project-preview"><small>● 等待确认</small><strong>{basename(selected)}</strong><code>{selected}</code><p>仅此会话可读取该目录。确认前仍使用当前工作区。</p><div className="cc-project-actions"><button ref={confirmButton} className="cc-project-primary" disabled={applying || picking || preview?.conversationRevision !== (c.revision ?? 1)} onClick={() => void apply()}>{applying ? '正在授权…' : '确认只读授权'}</button><button disabled={applying || picking} onClick={() => { setPreview(undefined); setError(''); chooseButton.current?.focus(); }}>取消</button></div></section>}
    {notice && <p role="status" className="cc-note">{notice}</p>}{error && <p className="cc-form-error" role="alert">{error}</p>}
  </section>;
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
