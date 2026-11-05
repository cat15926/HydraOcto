import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Bootstrap, CreateRole, CreateTask, Role, TaskDetail, ToolName } from '../shared/contracts';

const labels: Record<string, string> = { queued: '排队中', running: '执行中', waiting_approval: '待审批', needs_review: '待验收', completed: '已完成', succeeded: '已交付', failed: '失败', interrupted: '已中断', cancelled: '已取消', pending: '待处理', approved: '已批准', rejected: '已拒绝', expired: '已过期' };
const toolLabels: Record<ToolName, string> = { workspace_list: '列出材料', workspace_read: '读取材料', artifact_write: '保存产物', artifact_read: '读取产物' };
const date = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const short = (id: string) => id.slice(0, 8);
function Badge({ status }: { status: string }) { return <span className={`badge ${status}`}><i />{labels[status] ?? status}</span>; }
function Icon({ name, size = 18 }: { name: 'plus' | 'arrow' | 'grid' | 'check' | 'close' | 'file' | 'roles'; size?: number }) {
  const paths = { plus: 'M12 5v14M5 12h14', arrow: 'M5 12h14m-6-6 6 6-6 6', grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z', check: 'm5 12 4 4L19 6', close: 'm6 6 12 12M6 18 18 6', file: 'M14 3H5v18h14V8l-5-5Zm0 0v6h5M8 13h8M8 17h6', roles: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z' };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
async function get<T>(path: string): Promise<T> { const response = await fetch(path); const body = await response.json(); if (!response.ok) throw new Error(body.error || '读取失败'); return body as T; }

function Modal({ title, subtitle, children, onClose }: { title: string; subtitle: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} onCancel={event => { event.preventDefault(); onClose(); }} aria-labelledby="modal-title"><div className="modal-header"><div><div className="eyebrow">COLLABORATION</div><h2 id="modal-title">{title}</h2><p>{subtitle}</p></div><button className="icon-button" onClick={onClose} aria-label="关闭窗口"><Icon name="close" /></button></div>{children}</dialog>;
}

function TaskForm({ data, busy, onSubmit, onClose }: { data: Bootstrap; busy: boolean; onSubmit: (input: CreateTask) => Promise<void>; onClose: () => void }) {
  const [roleIds, setRoleIds] = useState(data.roles.slice(0, 3).map(role => role.id));
  const [mode, setMode] = useState<'demo' | 'api'>('demo');
  const [error, setError] = useState('');
  const requestId = useRef(crypto.randomUUID());
  function move(index: number, amount: number) { setRoleIds(current => { const next = [...current]; [next[index], next[index + amount]] = [next[index + amount], next[index]]; return next; }); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setError('');
    try { await onSubmit({ title: String(form.get('title')), goal: String(form.get('goal')), acceptance: String(form.get('acceptance')), mode, roleIds, requestId: requestId.current }); }
    catch (error) { setError((error as Error).message); }
  }
  return <Modal title="创建协作任务" subtitle="先定义想要的结果，再安排角色如何完成它。" onClose={onClose}><form onSubmit={submit}>
    <label>任务名称<input name="title" placeholder="例如：整理一份项目交接说明" maxLength={200} required autoFocus /></label>
    <div className="form-columns"><label>任务目标<textarea name="goal" rows={4} placeholder="描述背景、输入材料和需要交付的内容…" maxLength={20000} required /></label><label>验收条件<textarea name="acceptance" rows={4} placeholder="什么样的结果才算完成？" maxLength={20000} required /></label></div>
    <fieldset><legend>执行模式</legend><div className="mode-options"><label className={mode === 'demo' ? 'chosen' : ''}><input type="radio" name="mode" checked={mode === 'demo'} onChange={() => setMode('demo')} /><span><strong>演示流程</strong><small>固定步骤 · 无需密钥</small></span></label><label className={`${mode === 'api' ? 'chosen' : ''} ${!data.meta.apiConfigured ? 'disabled' : ''}`}><input type="radio" name="mode" checked={mode === 'api'} onChange={() => setMode('api')} disabled={!data.meta.apiConfigured} /><span><strong>真实模型</strong><small>{data.meta.apiConfigured ? data.meta.model : '需在服务端配置模型'}</small></span></label></div></fieldset>
    <fieldset><legend>角色顺序 <span className="muted">前一角色的结果传递给后一角色</span></legend><div className="role-order">{roleIds.map((id, i) => <div className="role-order-item" key={`${id}-${i}`}><span className="number">{i + 1}</span><span>{data.roles.find(role => role.id === id)?.name}</span><button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`上移角色 ${i + 1}`}>↑</button><button type="button" onClick={() => move(i, 1)} disabled={i === roleIds.length - 1} aria-label={`下移角色 ${i + 1}`}>↓</button><button type="button" onClick={() => setRoleIds(ids => ids.filter((_, index) => index !== i))} aria-label={`移除角色 ${i + 1}`}>×</button></div>)}</div><select aria-label="添加参与角色" value="" onChange={event => setRoleIds(ids => [...ids, event.target.value])} disabled={roleIds.length >= 10}><option value="">添加参与角色…</option>{data.roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></fieldset>
    <p className="hint">演示模式实际调用本地工具，用于体验审批和交付流程，不会理解任意任务。</p>{error && <p className="error" role="alert">{error}</p>}<footer className="modal-footer"><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="primary" disabled={busy || !roleIds.length}>{busy ? '正在提交…' : '创建任务'}<Icon name="arrow" /></button></footer>
  </form></Modal>;
}

function RoleForm({ roles, busy, onSubmit, onClose }: { roles: Role[]; busy: boolean; onSubmit: (input: CreateRole) => Promise<void>; onClose: () => void }) {
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); setError('');
    try { await onSubmit({ name: String(form.get('name')), description: String(form.get('description')), instructions: String(form.get('instructions')), tools: form.getAll('tools') as ToolName[] }); formElement.reset(); }
    catch (error) { setError((error as Error).message); }
  }
  return <Modal title="角色与职责" subtitle="角色说明决定工作方式，工具白名单决定它能做什么。" onClose={onClose}><div className="role-catalog">{roles.map(role => <div key={role.id}><strong>{role.name}</strong><p>{role.description}</p><small>{role.tools.map(tool => toolLabels[tool]).join(' · ') || '仅生成文字'}</small></div>)}</div><form onSubmit={submit}><h3>新增角色</h3><div className="form-columns"><label>角色名称<input name="name" maxLength={80} required placeholder="例如：资料整理员" /></label><label>一句话职责<input name="description" maxLength={1000} required placeholder="负责哪些工作" /></label></div><label>角色说明<textarea name="instructions" rows={3} maxLength={10000} required placeholder="描述这个角色的执行方法和交付要求" /></label><fieldset><legend>允许使用的工具</legend><div className="tool-options">{Object.entries(toolLabels).map(([name, label]) => <label key={name}><input type="checkbox" name="tools" value={name} />{label}{name === 'artifact_write' && <small>需审批</small>}</label>)}</div></fieldset>{error && <p className="error" role="alert">{error}</p>}<footer className="modal-footer"><button type="button" onClick={onClose}>关闭</button><button className="primary" disabled={busy}>{busy ? '正在保存…' : '保存角色'}</button></footer></form></Modal>;
}

export default function App() {
  const [data, setData] = useState<Bootstrap>();
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<TaskDetail>();
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState<'task' | 'roles'>();
  const [online, setOnline] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'delivery' | 'operations' | 'history'>('delivery');
  const selectedRef = useRef<string | undefined>(undefined);
  const csrf = useRef('');
  const detailRequest = useRef(0);
  const refreshRequest = useRef(0);
  const cursor = useRef(0);
  const mounted = useRef(true);
  const loadDetail = useCallback(async (id: string) => { const request = ++detailRequest.current; try { const next = await get<TaskDetail>(`/api/tasks/${id}`); if (mounted.current && request === detailRequest.current && selectedRef.current === id) setDetail(next); } catch (error) { if (mounted.current && selectedRef.current === id) setError((error as Error).message); } }, []);
  const choose = useCallback((id: string) => { selectedRef.current = id; setSelected(id); setDetail(undefined); setTab('delivery'); void loadDetail(id); }, [loadDetail]);
  const refresh = useCallback(async () => { const request = ++refreshRequest.current; const next = await get<Bootstrap>('/api/bootstrap'); if (!mounted.current || request !== refreshRequest.current) return next; csrf.current = next.csrfToken; cursor.current = Math.max(cursor.current, next.eventCursor); setData(next); if (selectedRef.current) await loadDetail(selectedRef.current); else if (next.tasks[0]) choose(next.tasks[0].id); return next; }, [choose, loadDetail]);
  useEffect(() => {
    mounted.current = true; let disposed = false; let source: EventSource | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
    void refresh().then(() => {
      if (disposed) return;
      source = new EventSource(`/api/events?after=${cursor.current}`);
      source.onopen = () => { setOnline(true); void refresh().catch(error => setError(error.message)); };
      source.onerror = () => setOnline(false);
      source.addEventListener('task-event', (event: MessageEvent<string>) => { try { const id = Number(event.lastEventId); if (!Number.isSafeInteger(id) || id <= cursor.current) return; cursor.current = id; if (timer) clearTimeout(timer); timer = setTimeout(() => { void refresh().catch(error => setError(error.message)); }, 80); } catch { setError('事件同步异常，请刷新页面。'); } });
    }).catch(error => { if (!disposed) setError(error.message); });
    return () => { disposed = true; mounted.current = false; source?.close(); if (timer) clearTimeout(timer); };
  }, [refresh]);
  async function command<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.current }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) { if (response.status === 403) await refresh(); throw new Error(result.error || '操作失败'); } return result as T;
  }
  async function action(path: string, body: unknown = {}) { setBusy(true); setError(''); try { await command(path, body); await refresh(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } }
  async function createTask(input: CreateTask) { setBusy(true); try { const result = await command<{ task: { id: string } }>('/api/tasks', input); choose(result.task.id); setModal(undefined); await refresh(); } finally { setBusy(false); } }
  async function createRole(input: CreateRole) { setBusy(true); try { await command('/api/roles', input); await refresh(); } finally { setBusy(false); } }
  async function example() {
    if (!data) return; setError('');
    try { await createTask({ title: '体验一次完整的协作交付', goal: '读取工作区样本，通过角色接力生成一份演示报告。', acceptance: '报告中明确目标与验收条件；写入经过批准，完成后可以查看和验收。', roleIds: data.roles.slice(0, 3).map(role => role.id), mode: 'demo', requestId: crypto.randomUUID() }); } catch (error) { setError((error as Error).message); }
  }
  const tasks = data?.tasks ?? [];
  const visible = tasks.filter(task => (filter === 'all' || (filter === 'attention' ? ['waiting_approval', 'needs_review'].includes(task.status) : filter === 'active' ? ['running', 'queued'].includes(task.status) : task.status === filter)) && `${task.title} ${task.goal}`.toLowerCase().includes(query.toLowerCase()));
  const attention = tasks.filter(task => ['waiting_approval', 'needs_review'].includes(task.status)).length;
  const task = detail?.task;
  const currentRun = detail?.runs.find(run => run.id === task?.latestRunId);
  const steps = detail?.steps.filter(step => step.runId === task?.latestRunId).sort((a, b) => a.position - b.position) ?? [];
  const approvals = detail?.approvals.filter(approval => approval.status === 'pending' && approval.runId === task?.latestRunId) ?? [];
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark"><i /><i /><i /></span><div>协作工坊<small>MULTI AGENT COLLAB</small></div></div><div className="workspace-label">本地工作空间<span>01</span></div><button className="nav-active" onClick={() => setFilter('all')}><Icon name="grid" />任务工作台<span>{tasks.length}</span></button><button className="nav-item" onClick={() => setModal('roles')} disabled={!data}><Icon name="roles" />角色与职责<span>{data?.roles.length ?? 0}</span></button><div className="sidebar-note"><div className="orbit"><i /><i /><i /></div><strong>各司其职，共同交付。</strong><p>目标、执行与验收，<br />在同一个工作台中衔接。</p></div><footer className="sidebar-footer"><span className={`connection-dot ${online ? 'live' : ''}`} />{online ? '本地服务已连接' : '正在连接服务…'}<small>v0.1 · 单用户工作空间</small></footer></aside>
    <div className="workspace"><header className="topbar"><div className="breadcrumb">工作空间 <span>/</span> <strong>任务工作台</strong></div><div className="top-actions"><span className="model-status">{data?.meta.apiConfigured ? `模型 · ${data.meta.model}` : '演示模式可用'}</span><button className="primary" onClick={() => setModal('task')} disabled={!data || busy}><Icon name="plus" />新建任务</button></div></header>
    <section className="page-heading"><div><div className="eyebrow">TASK WORKSPACE</div><h1>让协作，有迹可循。</h1><p>从清晰的目标出发，把每一步推进到可验收的交付。</p></div><div className="metrics"><div><strong>{tasks.length}</strong><span>全部任务</span></div><div><strong className="accent-text">{attention}</strong><span>需要你处理</span></div><div><strong>{tasks.filter(task => task.status === 'completed').length}</strong><span>已完成</span></div></div></section>
    {error && <div className="global-error" role="alert"><span>{error}</span><button onClick={() => { setError(''); void refresh().catch(error => setError(error.message)); }}>重新读取</button><button aria-label="关闭提示" onClick={() => setError('')}>×</button></div>}
    <div className="workbench"><section className="task-panel"><div className="panel-heading"><h2>任务列表</h2><span>{visible.length}</span></div><input className="search" aria-label="搜索任务" placeholder="搜索任务…" value={query} onChange={event => setQuery(event.target.value)} /><div className="filters">{[['all', '全部'], ['attention', '待处理'], ['active', '执行中'], ['completed', '已完成']].map(([value, label]) => <button key={value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div><div className="task-list">{visible.map(item => <button key={item.id} className={`task-item ${selected === item.id ? 'active' : ''}`} onClick={() => choose(item.id)}><div><Badge status={item.status} /><small>{item.mode === 'demo' ? '演示' : '模型'}</small></div><h3>{item.title}</h3><p>{item.goal}</p><footer><span>{item.roleIds.length} 个角色</span><time>{date(item.updatedAt)}</time></footer></button>)}{!visible.length && <div className="list-empty">{tasks.length ? '没有匹配的任务' : '你的第一个任务，将从这里开始。'}</div>}</div><div className="task-panel-footer">执行记录持久保存于本机</div></section>
    <main className="detail-panel">{!task ? <div className="empty-state"><div className="empty-diagram"><span>01</span><i /><span>02</span><i /><span><Icon name="check" size={24} /></span></div><div className="eyebrow">A CLEAR PATH TO DELIVERY</div><h2>{selected ? '正在读取任务…' : '给协作一个明确的目标'}</h2><p>安排角色、跟踪执行，在关键操作时做决定。<br />从一个演示任务开始，体验完整的协作流程。</p><button className="primary" onClick={example} disabled={!data || busy}>创建演示任务<Icon name="arrow" /></button><small>固定流程 · 真实本地工具 · 无需模型密钥</small></div> : <>
    <div className="task-detail-header"><div className="task-meta"><span>任务 {short(task.id)}</span><span>第 {currentRun?.attempt} 次执行</span><Badge status={task.status} /></div><h2>{task.title}</h2><div className="detail-actions">{['queued', 'running', 'waiting_approval', 'needs_review'].includes(task.status) && <button disabled={busy} onClick={() => action(`/api/tasks/${task.id}/cancel`)}>取消任务</button>}{['failed', 'interrupted', 'cancelled', 'needs_review'].includes(task.status) && <button disabled={busy} onClick={() => action(`/api/tasks/${task.id}/retry`)}>重新执行</button>}{task.status === 'needs_review' && <button className="primary" disabled={busy} onClick={() => action(`/api/tasks/${task.id}/accept`)}><Icon name="check" />验收通过</button>}</div></div>
    {task.mode === 'demo' && <div className="demo-notice"><strong>演示流程</strong><span>按固定步骤运行真实工具，不代表模型理解或完成了任意任务。</span></div>}
    <div className="goal-grid"><section><h3>任务目标</h3><p>{task.goal}</p></section><section><h3>验收条件</h3><p>{task.acceptance}</p></section></div>
    <section className="flow-section"><div className="section-title"><h3>角色协作</h3><span>按顺序交付上下文</span></div><div className="step-flow">{steps.map(step => <div className={`step-card ${step.status}`} key={step.id}><div className="step-icon">{step.status === 'completed' ? <Icon name="check" /> : String(step.position + 1).padStart(2, '0')}</div><div><strong>{step.role.name}</strong><small>{labels[step.status]}</small></div></div>)}</div></section>
    {currentRun?.error && <div className="run-error" role="alert">{currentRun.error}</div>}
    {approvals.map(approval => <section className="approval-card" key={approval.id}><div className="section-title"><h3>需要你批准这项操作</h3><span>有效至 {date(approval.expiresAt)}</span></div><p>将交付内容保存为任务产物。批准只适用于下列确定的内容。</p><div className="approval-operation"><Icon name="file" /><strong>{toolLabels[approval.toolName]}</strong><code>{String(approval.args.name ?? '')}</code></div><details open><summary>查看完整操作参数</summary><pre>{JSON.stringify(approval.args, null, 2)}</pre></details><footer><span>批准前不会写入这份产物</span><button disabled={busy} onClick={() => action(`/api/approvals/${approval.id}/decision`, { decision: 'reject' })}>拒绝操作</button><button className="primary" disabled={busy} onClick={() => action(`/api/approvals/${approval.id}/decision`, { decision: 'approve' })}><Icon name="check" />批准写入</button></footer></section>)}
    {task.status === 'needs_review' && <div className="review-notice"><Icon name="check" /><div><strong>角色已交付，等待你的验收</strong><p>请查看产物和复核结果，确认符合验收条件后标记完成。</p></div></div>}
    <div className="detail-tabs" role="tablist" aria-label="任务记录">{([['delivery', '交付与结果'], ['operations', `工具记录 ${detail!.toolCalls.length}`], ['history', '事件与历史']] as const).map(([key, label]) => <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'selected' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>
    <div className="tab-content" role="tabpanel">{tab === 'delivery' && <><div className="section-title"><h3>任务产物</h3><span>{detail!.artifacts.length} 份</span></div>{detail!.artifacts.length ? <div className="artifacts">{detail!.artifacts.map(artifact => <a href={artifact.url} key={artifact.id} className="artifact" download><span className="file-icon"><Icon name="file" size={24} /></span><span><strong>{artifact.name}</strong><small>{(artifact.bytes / 1024).toFixed(1)} KB · 第 {detail!.runs.find(run => run.id === artifact.runId)?.attempt} 次执行</small></span><span className="download-label">下载 ↓</span></a>)}</div> : <p className="subtle-empty">产物生成后会保存在这里。</p>}<h3 className="output-heading">角色交付</h3>{steps.map(step => <details className="role-output" key={step.id} open={step.status === 'completed'}><summary><span><strong>{step.role.name}</strong><small>{step.role.description}</small></span><Badge status={step.status} /></summary><pre>{step.output || step.error || '此角色尚未交付结果。'}</pre></details>)}</>}
    {tab === 'operations' && (detail!.toolCalls.length ? [...detail!.toolCalls].reverse().map(call => <details className="tool-record" key={call.id}><summary><div><strong>{toolLabels[call.name]}</strong><code>{call.name}</code></div><Badge status={call.status} /></summary><p className="muted">执行批次 {short(call.runId)} · {date(call.createdAt)}</p><h4>操作参数</h4><pre>{JSON.stringify(call.args, null, 2)}</pre><h4>执行结果</h4><pre>{call.result || call.error || '等待执行'}</pre></details>) : <p className="subtle-empty">当前任务还没有工具操作。</p>)}
    {tab === 'history' && <><div className="run-history">{[...detail!.runs].reverse().map(run => <div key={run.id}><strong>第 {run.attempt} 次执行</strong><time>{date(run.createdAt)}</time><Badge status={run.status} />{run.error && <p>{run.error}</p>}</div>)}</div><div className="timeline">{[...detail!.events].reverse().map(event => <div key={event.id}><i /><div><p>{event.message}</p><small>#{event.id} · {date(event.createdAt)} · {event.runId ? short(event.runId) : ''}</small></div></div>)}</div></>}
    </div></> }</main></div><footer className="workspace-footer">任务负责目标，角色负责执行，你保留最后的决定。<span>LOCAL FIRST · {online ? '实时同步' : '连接恢复中'}</span></footer></div>
    {modal === 'task' && data && <TaskForm data={data} busy={busy} onSubmit={createTask} onClose={() => { if (!busy) setModal(undefined); }} />}{modal === 'roles' && data && <RoleForm roles={data.roles} busy={busy} onSubmit={createRole} onClose={() => { if (!busy) setModal(undefined); }} />}
  </div>;
}
