import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Conversation, ConversationDetail, Member } from '../shared/collaboration';
import { pendingMemories } from './MemoryPanel';
import { WorkspaceIcon } from './WorkspaceIcon';
import { describeTarget, emptyWorkspace, restoreWorkspace, targetKey, targetPage, workspaceReducer, workspaceStorageKey, workspaceTools, type WorkspaceAction, type WorkspaceOrigin, type WorkspaceTarget, type WorkspaceView } from './workspace-state';
import './workspace.css';
export { WorkspaceButtonIcon } from './WorkspaceIcon';
export type { WorkspacePage } from './workspace-state';

export type WorkspaceRequest = { sequence: number; target: WorkspaceTarget; origin?: WorkspaceOrigin; pendingMemory?: boolean };
export type OpenWorkspaceTarget = (target: WorkspaceTarget, options?: { origin?: WorkspaceOrigin; preview?: boolean }) => void;
export type WorkspaceRenderContext = { detail: ConversationDetail; target: WorkspaceTarget; active: boolean; memoryFocus: number; openTarget: OpenWorkspaceTarget; revealMessage: (id: string) => void };
type WorkItem = { target: WorkspaceTarget; title: string; description: string; icon: string };
const isRunning = (status: string) => ['prepared', 'running', 'cancel_requested'].includes(status);
const statusNames: Record<string, string> = { prepared: '准备中', running: '运行中', cancel_requested: '等待停止', succeeded: '执行成功', failed: '失败', interrupted: '已中断', cancelled: '已取消' };

export function workspaceAttentionItems(detail: ConversationDetail): WorkItem[] {
  const conversationId = detail.conversation.id, base = { conversationId };
  const memory = pendingMemories((detail.memories ?? []).filter(e => e.scope === 'conversation' && e.conversationId === conversationId), detail.memoryVersions ?? []);
  return [
    ...memory.map(entry => { const version = [...(detail.memoryVersions ?? [])].reverse().find(v => v.entryId === entry.id && ['candidate', 'approved'].includes(v.state))!; return { target: { ...base, kind: 'memory' as const, entryId: entry.id, versionId: version.id }, title: entry.key, description: version.state === 'approved' ? '会话记忆 · 已批准，等待收录' : '会话记忆 · 待确认', icon: 'book' }; }),
    ...(detail.artifactApprovals ?? []).filter(a => a.state === 'pending').flatMap(a => { const version = detail.artifactVersions?.find(v => v.id === a.versionId), artifact = detail.artifacts?.find(x => x.id === version?.artifactId); return version && artifact ? [{ target: { ...base, kind: 'artifact' as const, artifactId: artifact.id, versionId: version.id }, title: `${artifact.name} · v${version.number}`, description: '等待确认此版本写入', icon: 'file' }] : []; }),
    ...(detail.interactions ?? []).filter(i => i.state === 'pending').map(i => ({ target: { ...base, kind: 'interaction' as const, interactionId: i.id }, title: i.questions?.[0]?.question ?? '成员等待你的回答', description: '成员提问 · 等待回答', icon: 'question' })),
    ...(detail.actions ?? []).filter(a => a.state === 'candidate').map(a => ({ target: { ...base, kind: 'action' as const, actionId: a.id }, title: a.title, description: '责任候选 · 待验收', icon: 'link' })),
    ...detail.invocations.filter(i => i.recoveryState === 'pending' || i.dispatchStarted && i.teardown === 'unknown' && !['prepared', 'running'].includes(i.status)).map(i => ({ target: { ...base, kind: 'invocation' as const, invocationId: i.id }, title: `执行 ${i.id.slice(0, 8)}`, description: '原执行证据待核查', icon: 'pulse' })),
  ];
}
export function workspaceAttention(detail: ConversationDetail) { return workspaceAttentionItems(detail); }

/** Keep visited conversation hosts mounted, but only a freshly loaded selected snapshot can become visible. */
export function WorkspaceCollection({ detail, selected, open, library, conversations, members, request, onClose, onMessage, renderView }: {
  detail?: ConversationDetail; selected?: string; open: boolean; library: boolean; conversations: Conversation[]; members: Member[];
  request?: WorkspaceRequest; onClose: () => void; onMessage: (id: string) => void; renderView: (context: WorkspaceRenderContext) => ReactNode;
}) {
  const cache = useRef(new Map<string, ConversationDetail>());
  for (const key of cache.current.keys()) if (!conversations.some(c => c.id === key)) cache.current.delete(key);
  if (detail && detail.conversation.id === selected) cache.current.set(selected, detail);
  return <>{Array.from(cache.current, ([cid, snapshot]) => {
    const current = cid === selected && detail?.conversation.id === cid;
    const conversation = conversations.find(c => c.id === cid);
    const authoritative = !current && conversation?.deletedAt ? { ...snapshot, conversation } : snapshot;
    return <WorkspacePanel key={cid} detail={authoritative} members={members} visible={!!current && open && !library} request={request?.target.conversationId === cid ? request : undefined} onClose={onClose} onMessage={onMessage} renderView={renderView} />;
  })}</>;
}

function resultItems(detail: ConversationDetail): WorkItem[] {
  const base = { conversationId: detail.conversation.id };
  return [
    ...(detail.artifactVersions ?? []).filter(v => v.state === 'published').map(v => ({ target: { ...base, kind: 'artifact' as const, artifactId: v.artifactId, versionId: v.id }, title: `${detail.artifacts?.find(a => a.id === v.artifactId)?.name ?? '产物'} · v${v.number}`, description: '新产物已发布', icon: 'file' })),
    ...detail.invocations.filter(i => !isRunning(i.status)).map(i => ({ target: { ...base, kind: 'invocation' as const, invocationId: i.id }, title: `执行 ${i.id.slice(0, 8)}`, description: statusNames[i.status] ?? i.status, icon: 'pulse' })),
  ];
}

function WorkspacePanel({ detail, members, visible, request, onClose, onMessage, renderView }: {
  detail: ConversationDetail; members: Member[]; visible: boolean; request?: WorkspaceRequest;
  onClose: () => void; onMessage: (id: string) => void; renderView: (context: WorkspaceRenderContext) => ReactNode;
}) {
  const cid = detail.conversation.id, storageKey = workspaceStorageKey(cid);
  const [layout, setLayout] = useState(() => { try { return restoreWorkspace(JSON.parse(localStorage.getItem(storageKey) ?? 'null'), cid); } catch { return emptyWorkspace(cid); } });
  const [storageError, setStorageError] = useState(''), [notice, setNotice] = useState('');
  const [menu, setMenu] = useState(false), [closedMenu, setClosedMenu] = useState(false), [query, setQuery] = useState('');
  const [memoryFocus, setMemoryFocus] = useState(0), [focusRevision, setFocusRevision] = useState(0);
  const [updates, setUpdates] = useState<WorkItem[]>([]);
  const seenResults = useRef(new Set(resultItems(detail).map(i => targetKey(i.target))));
  const root = useRef<HTMLElement>(null), home = useRef<HTMLDivElement>(null), toolbar = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const viewNodes = useRef(new Map<string, HTMLDivElement>()), origins = useRef(new Map<string, HTMLElement>());
  const nextFocus = useRef<'heading' | 'tab' | 'return'>('heading'), returnFocus = useRef<HTMLElement | undefined>(undefined);
  const appliedRequest = useRef(0), wasVisible = useRef(false);
  const activeView = layout.views.find(v => v.key === layout.active);
  const attention = detail.conversation.deletedAt ? [] : workspaceAttentionItems(detail);
  const name = (id: string | null) => members.find(m => m.id === id)?.name ?? id ?? '未分配';
  const allViews = [...layout.views, ...layout.closed];
  function dispatch(action: WorkspaceAction, focus = true) {
    const addsView = action.type === 'restore' ? layout.closed.some(v => v.key === action.key)
      : action.type === 'open' && !layout.views.some(v => v.key === targetKey(action.target)) && !(action.preview && layout.preview);
    if (addsView && layout.views.length >= 40) { setNotice('已打开 40 个视图，请先关闭部分视图。'); return false; }
    setNotice('');
    setLayout(state => workspaceReducer(state, action));
    if (focus) setFocusRevision(v => v + 1);
    return true;
  }
  const openTarget: OpenWorkspaceTarget = (target, options) => {
    const origin = options?.origin ?? (activeView ? { kind: 'view' as const, target: activeView.target } : { kind: 'home' as const });
    if (!dispatch({ type: 'open', target, origin, preview: options?.preview ?? target.kind === 'artifact' })) return;
    if (document.activeElement instanceof HTMLElement && root.current?.contains(document.activeElement)) origins.current.set(targetKey(target), document.activeElement);
    nextFocus.current = 'heading'; setMenu(false); setClosedMenu(false);
    setUpdates(items => items.filter(i => targetKey(i.target) !== targetKey(target)));
  };
  const openTool = (tool: typeof workspaceTools[number]['id']) => openTarget({ kind: 'tool', conversationId: cid, tool });
  useEffect(() => {
    if (!request || request.sequence === appliedRequest.current) return;
    appliedRequest.current = request.sequence;
    openTarget(request.target, { origin: request.origin });
    if (request.pendingMemory) setMemoryFocus(v => v + 1);
  }, [request]);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(restoreWorkspace(layout, cid))); setStorageError(''); }
    catch { setStorageError('浏览器无法保存布局；当前操作仍可继续，刷新后可能无法恢复。'); }
  }, [layout, cid, storageKey]);
  useEffect(() => {
    const next = resultItems(detail), fresh = next.filter(i => !seenResults.current.has(targetKey(i.target)));
    seenResults.current = new Set(next.map(i => targetKey(i.target)));
    if (fresh.length) setUpdates(previous => [...fresh, ...previous].filter((v, index, list) => list.findIndex(i => targetKey(i.target) === targetKey(v.target)) === index).slice(0, 5));
  }, [detail]);
  useLayoutEffect(() => {
    if (!visible) { wasVisible.current = false; return; }
    if (!focusRevision && wasVisible.current) return;
    wasVisible.current = true;
      if (nextFocus.current === 'return' && returnFocus.current?.isConnected && returnFocus.current.getClientRects().length) returnFocus.current.focus({ preventScroll: true });
      else if (nextFocus.current === 'tab') (Array.from(toolbar.current?.querySelectorAll<HTMLButtonElement>('[data-view-tab]') ?? []).find(b => b.dataset.viewTab === layout.active) ?? root.current?.querySelector<HTMLButtonElement>('.cc-workspace-home-tab'))?.focus();
      else (layout.active ? viewNodes.current.get(layout.active) : home.current)?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  }, [focusRevision, visible]);
  function back(view: WorkspaceView) {
    const origin = view.origin;
    if (origin.kind === 'message') { onMessage(origin.messageId); return; }
    returnFocus.current = origins.current.get(view.key); nextFocus.current = 'return';
    if (origin.kind === 'home') dispatch({ type: 'home' });
    else dispatch({ type: 'open', target: origin.target });
  }
  function homeAction() { nextFocus.current = 'heading'; setMenu(false); setClosedMenu(false); dispatch({ type: 'home' }); }
  function toggleMenu() { setMenu(v => !v); setClosedMenu(false); if (!menu) requestAnimationFrame(() => search.current?.focus()); }
  const needle = query.trim().toLowerCase(), filteredTools = workspaceTools.filter(t => `${t.title} ${t.keywords}`.toLowerCase().includes(needle));
  const recent = layout.recent.flatMap(key => { const view = allViews.find(v => v.key === key); return view && !describeTarget(view.target, detail).unavailable && describeTarget(view.target, detail).title.toLowerCase().includes(needle) ? [view] : []; });
  const rows = (items: WorkItem[]) => items.map(item => <button key={targetKey(item.target)} className="cc-workspace-row" data-workspace-object={targetKey(item.target)} onClick={() => openTarget(item.target, { origin: { kind: 'home' } })}><span className="cc-workspace-glyph"><WorkspaceIcon name={item.icon} /></span><span><strong>{item.title}</strong><small>{item.description}</small></span><WorkspaceIcon name="chevron" /></button>);
  const base = { conversationId: cid };
  const running: WorkItem[] = detail.invocations.filter(i => isRunning(i.status)).map(i => ({ target: { ...base, kind: 'invocation', invocationId: i.id }, title: name(i.memberId), description: `${statusNames[i.status]} · ${new Date(i.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`, icon: 'pulse' }));
  const tasks: WorkItem[] = (detail.tasks ?? []).filter(t => t.status !== 'done' && !t.disposition).map(t => ({ target: { ...base, kind: 'task', taskId: t.id }, title: t.title, description: `${name(t.ownerMemberId)} · ${{ todo: '待办', doing: '进行中', blocked: '等待条件', done: '已完成' }[t.status]}`, icon: 'check' }));
  const artifacts: WorkItem[] = (detail.artifacts ?? []).flatMap(a => { const v = detail.artifactVersions?.find(v => v.id === a.headVersionId && v.state === 'published'); return v ? [{ target: { ...base, kind: 'artifact' as const, artifactId: a.id, versionId: v.id }, title: a.name, description: `v${v.number} · 已发布`, icon: 'file', date: v.publishedAt ?? v.createdAt }] : []; }).sort((a, b) => b.date.localeCompare(a.date));
  return <aside id={visible ? 'cc-workspace' : undefined} data-workspace-conversation={cid} data-expanded={layout.expanded} className="cc-workspace" hidden={!visible} inert={!visible} style={{ '--workspace-width': `${layout.width}%` } as CSSProperties} ref={root} aria-label="工作台" onKeyDown={e => {
    if (e.defaultPrevented || (e.target as Element).closest('dialog')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (menu || closedMenu) { setMenu(false); setClosedMenu(false); root.current?.querySelector<HTMLButtonElement>('.cc-workspace-add')?.focus(); } else onClose(); }
  }}>
    <button className="cc-workspace-resize" aria-label="调整工作台宽度" onDoubleClick={() => dispatch({ type: 'resize', width: 48 }, false)} onKeyDown={e => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); dispatch({ type: 'resize', width: layout.width + (e.key === 'ArrowLeft' ? 2 : -2) }, false); } }} onPointerDown={e => {
      const handle = e.currentTarget, parent = root.current?.parentElement; if (!parent) return;
      e.preventDefault(); handle.setPointerCapture(e.pointerId);
      const move = (event: PointerEvent) => { const box = parent.getBoundingClientRect(); dispatch({ type: 'resize', width: (box.right - event.clientX) / box.width * 100 }, false); };
      const done = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', done); handle.removeEventListener('pointercancel', done); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', done); handle.addEventListener('pointercancel', done);
    }}><span /></button>
    <header className="cc-workspace-header"><span className="cc-workspace-eyebrow"><i />工作台</span><div><button className="cc-workspace-icon" onClick={() => dispatch({ type: 'expand' }, false)} aria-label={layout.expanded ? '还原工作台宽度' : '展开工作台'} aria-pressed={layout.expanded}><WorkspaceIcon name="expand" /></button><button className="cc-workspace-close" onClick={onClose} aria-label="关闭工作台"><WorkspaceIcon name="close" /></button></div></header>
    <div className="cc-workspace-tabs" ref={toolbar} role="navigation" aria-label="已打开的工作" onKeyDown={e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const buttons = Array.from(toolbar.current?.querySelectorAll<HTMLButtonElement>('[data-view-tab],.cc-workspace-home-tab,.cc-workspace-add') ?? []), index = buttons.indexOf(e.target as HTMLButtonElement); if (index < 0) return;
      e.preventDefault(); buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }}><button className={`cc-workspace-home-tab ${!layout.active && !menu ? 'selected' : ''}`} onClick={homeAction} aria-current={!layout.active && !menu ? 'page' : undefined}><WorkspaceIcon name="home" />概览</button>
      {layout.views.map(view => { const label = describeTarget(view.target, detail); return <span key={view.key} className={`cc-workspace-tab ${layout.active === view.key && !menu ? 'selected' : ''} ${layout.preview === view.key ? 'preview' : ''}`}><button data-view-tab={view.key} aria-current={layout.active === view.key && !menu ? 'page' : undefined} title={label.title} onClick={() => { setMenu(false); setClosedMenu(false); nextFocus.current = 'heading'; dispatch({ type: 'activate', key: view.key }); }}><WorkspaceIcon name={view.pinned ? 'pin' : label.icon} /><span>{label.title}</span>{layout.preview === view.key && <span className="cc-visually-hidden">（临时预览）</span>}</button><button className="cc-workspace-tab-close" aria-label={`关闭视图：${label.title}`} onClick={() => { nextFocus.current = 'tab'; dispatch({ type: 'close', key: view.key }); }}><WorkspaceIcon name="close" /></button></span>; })}
      <button className="cc-workspace-add" onClick={toggleMenu} aria-label="打开工具与最近访问" aria-expanded={menu}><WorkspaceIcon name="plus" /></button></div>
    {(storageError || notice) && <p className="cc-workspace-notice" role="status">{storageError || notice}</p>}
    {!!updates.length && !menu && <div className="cc-workspace-updates" role="status"><span>{updates[0]!.description} · {updates[0]!.title}{updates.length > 1 ? `，另有 ${updates.length - 1} 项` : ''}</span><button onClick={() => openTarget(updates[0]!.target)}>查看</button><button aria-label="忽略新结果提示" onClick={() => setUpdates([])}><WorkspaceIcon name="close" /></button></div>}
    <div className="cc-workspace-catalogue cc-workspace-scroll" hidden={!menu}>
      <label className="cc-workspace-search"><WorkspaceIcon name="search" /><input ref={search} type="search" aria-label="查找工作台工具" placeholder="查找工具与最近访问…" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && filteredTools.length === 1) openTool(filteredTools[0]!.id); }} /></label>
      {!!recent.length && <section className="cc-workspace-group"><h3>最近访问</h3>{recent.map(view => <button className="cc-workspace-tool" key={view.key} onClick={() => openTarget(view.target)}><WorkspaceIcon name={describeTarget(view.target, detail).icon} /><span>{describeTarget(view.target, detail).title}</span><WorkspaceIcon name="chevron" /></button>)}</section>}
      <section className="cc-workspace-group"><h3>全部工具</h3>{filteredTools.map(tool => <button className="cc-workspace-tool" data-workspace-tool={tool.id} key={tool.id} onClick={() => openTool(tool.id)}><WorkspaceIcon name={tool.icon} /><span>{tool.title}</span><WorkspaceIcon name="chevron" /></button>)}</section>
      {!filteredTools.length && !recent.length && <p className="cc-workspace-empty" role="status">没有匹配的工具或访问记录，试试“记忆”“项目”或“执行”。</p>}
      <p className="cc-note">这里只查找工具与访问记录；材料正文在“会话资料”内搜索。</p>
    </div>
    <div className="cc-workspace-home cc-workspace-scroll" ref={home} hidden={menu || !!layout.active} inert={menu || !!layout.active}>
      <span className="cc-workspace-scope">当前会话</span><h2 tabIndex={-1}>继续手头的工作</h2><p className="cc-workspace-context">{detail.conversation.title}</p>
      {detail.conversation.deletedAt ? <p className="cc-workspace-empty">会话已移入回收站。<button onClick={() => openTool('knowledge')}>管理会话</button></p> : <>
        {!!attention.length && <section className="cc-workspace-section cc-workspace-attention"><h3>需要你处理 <span>{attention.length} 项</span></h3><div>{rows(attention)}</div></section>}
        {!!running.length && <section className="cc-workspace-section"><h3>正在进行 <button onClick={() => openTool('activity')}>全部记录 <WorkspaceIcon name="chevron" /></button></h3>{rows(running.slice(0, 3))}</section>}
        {!!tasks.length && <section className="cc-workspace-section"><h3>跟进任务 <button onClick={() => openTool('tasks')}>全部任务 <WorkspaceIcon name="chevron" /></button></h3>{rows(tasks.slice(0, 3))}</section>}
        {!!artifacts.length && <section className="cc-workspace-section"><h3>最近产物 <button onClick={() => openTool('artifacts')}>全部产物 <WorkspaceIcon name="chevron" /></button></h3>{rows(artifacts.slice(0, 3))}</section>}
        {!attention.length && !running.length && !tasks.length && !artifacts.length && <div className="cc-workspace-empty"><WorkspaceIcon name="check" /><h3>暂时没有需要跟进的工作</h3><p>继续在聊天中协作，任务、待确认事项和产物会显示在这里。</p><button onClick={toggleMenu}>打开工具 <WorkspaceIcon name="plus" /></button></div>}
        {(detail.tasks === undefined || detail.artifactVersions === undefined || detail.memoryVersions === undefined) && <p className="cc-workspace-notice">部分工作数据尚未取得，请等待同步或重新加载。</p>}
        {detail.deliveries.some(d => ['pending', 'held'].includes(d.status)) && <button className="cc-workspace-queue" onClick={() => openTool('cooperation')}>{detail.deliveries.filter(d => ['pending', 'held'].includes(d.status)).length} 项待投递 · 查看协作调度 <WorkspaceIcon name="chevron" /></button>}
      </>}
    </div>
    {allViews.map(view => {
      const viewActive = visible && layout.active === view.key && !menu, descriptor = describeTarget(view.target, detail);
      return <div key={view.key} ref={node => { if (node) viewNodes.current.set(view.key, node); else viewNodes.current.delete(view.key); }} hidden={layout.active !== view.key || menu} inert={!viewActive} className="cc-workspace-detail cc-workspace-scroll" data-workspace-page={viewActive ? targetPage(view.target) : undefined} data-workspace-view={view.key} onInputCapture={() => dispatch({ type: 'promote', key: view.key }, false)}>
        <div className="cc-workspace-detail-toolbar"><button className="cc-workspace-back" onClick={() => back(view)}><WorkspaceIcon name="back" />{view.origin.kind === 'home' ? '返回概览' : view.origin.kind === 'message' ? '返回来源消息' : '返回来源'}</button><button className="cc-workspace-pin" aria-pressed={view.pinned} onClick={() => dispatch({ type: 'pin', key: view.key }, false)}><WorkspaceIcon name="pin" />{view.pinned ? '取消固定' : '固定视图'}</button></div>
        <h2 tabIndex={-1} className="cc-workspace-view-title">{descriptor.title}</h2>
        {descriptor.unavailable ? <p role="status" className="cc-workspace-empty">{descriptor.unavailable}</p> : <>{renderView({ detail, target: view.target, active: viewActive, memoryFocus, openTarget, revealMessage: onMessage })}{['task', 'artifact'].includes(view.target.kind) && <label className="cc-workspace-notes">{view.target.kind === 'task' ? '跟进备注' : '评审备注'} · 草稿<textarea rows={3} aria-label={view.target.kind === 'task' ? '跟进备注草稿' : '评审备注草稿'} placeholder="切换视图后可以继续填写…" /><small>仅在当前页面保留；刷新后不保留，也不会自动发送给成员。</small></label>}</>}
      </div>;
    })}
    <footer className="cc-workspace-footer"><span>仅当前会话</span><button onClick={() => { setClosedMenu(v => !v); setMenu(false); }} aria-expanded={closedMenu}><WorkspaceIcon name="history" />最近关闭 {layout.closed.length}</button></footer>
    {closedMenu && <div className="cc-workspace-closed">{layout.closed.length ? layout.closed.map(view => <button key={view.key} onClick={() => { setClosedMenu(false); nextFocus.current = 'heading'; dispatch({ type: 'restore', key: view.key }); }}><WorkspaceIcon name="history" />{describeTarget(view.target, detail).title}</button>) : <p>暂无最近关闭的视图。</p>}</div>}
  </aside>;
}
