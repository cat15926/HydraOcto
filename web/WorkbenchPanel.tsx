import { carrierNames, supportsAccount } from '../shared/collaboration';
import { useState } from 'react';
import type { Carrier, CollaborationBootstrap, ConfigurationPreview } from '../shared/collaboration';
export { ProjectFolder as WorkbenchPanel } from './ProjectFolder';
export type WorkbenchCommand = <T>(path: string, body: unknown, signal?: AbortSignal) => Promise<T>;
const rid = () => crypto.randomUUID();
export function DefaultConfiguration({ data, command, refresh }: { data: CollaborationBootstrap; command: WorkbenchCommand; refresh: () => Promise<void> }) {
  const [carrier, setCarrier] = useState<Carrier>('codex-app-server'), [account, setAccount] = useState(''), [model, setModel] = useState(''), [effort, setEffort] = useState('');
  const [preview, setPreview] = useState<ConfigurationPreview>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const accounts = data.accounts.filter(a => !a.deletedAt && supportsAccount(carrier, a)), selected = accounts.find(a => a.id === account) ?? accounts[0];
  const catalog = data.accountObservations?.find(o => o.accountId === selected?.id)?.models ?? [];
  const names = (ids: string[]) => ids.map(id => data.members.find(m => m.id === id)?.name ?? id).join('、') || '无';
  async function run(work: () => Promise<unknown>) { setError(''); setBusy(true); try { await work(); await refresh(); } catch (e) { setError((e as Error).message); setPreview(undefined); } finally { setBusy(false); } }
  return <details className="cc-default-settings"><summary>运行时默认账户与模型</summary><p className="cc-note">当前：{data.defaults?.map(d => `${d.carrier} → ${data.accounts.find(a => a.id === d.accountId)?.name ?? d.accountId}`).join('；') || '尚未设置'}</p>
    <label>默认配置运行时<select value={carrier} onChange={e => { setCarrier(e.target.value as Carrier); setAccount(''); setModel(''); setEffort(''); setPreview(undefined); }}>{Object.entries(carrierNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
    <label>默认账户<select value={selected?.id ?? ''} onChange={e => { setAccount(e.target.value); setModel(''); setEffort(''); setPreview(undefined); }}><option value="" disabled>选择账户</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
    <button type="button" disabled={busy || !selected} onClick={() => void run(() => command(`/api/accounts/${selected!.id}/probe`, {}))}>刷新默认账户模型目录</button>
    <label>默认模型<select value={model} onChange={e => { setModel(e.target.value); setEffort(''); setPreview(undefined); }}><option value="">运行时默认（仅官方 CLI）</option>{catalog.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
    {carrier !== 'hermes-agent' && <label>默认推理强度<select value={effort} onChange={e => { setEffort(e.target.value); setPreview(undefined); }}><option value="">模型默认</option>{catalog.find(m => m.id === model)?.efforts.map(e => <option key={e}>{e}</option>)}</select></label>}
    <button disabled={busy || !selected} onClick={() => void run(async () => setPreview(await command('/api/collaboration/default-preview', { carrier, accountId: selected!.id, model, effort })))}>预览默认配置影响</button>
    {preview && <div className="cc-workbench-preview"><p>将跟随更新：{names(preview.affectedMemberIds)}</p><p>保留成员例外：{names(preview.unaffectedMemberIds)}</p><p className="cc-note">已开始执行保留原配置；预览 5 分钟有效，配置变化后需重新预览。</p><button disabled={busy} onClick={() => void run(async () => { await command('/api/collaboration/default-apply', { previewId: preview.id, requestId: rid() }); setPreview(undefined); })}>应用默认配置</button></div>}
    {error && <p role="alert" className="cc-form-error">{error}</p>}
  </details>;
}
