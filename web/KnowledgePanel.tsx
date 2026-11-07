import type { OpenWorkspaceTarget } from './WorkspacePanel';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Conversation, ConversationDetail, ConversationMessage, Member, MessageExcerpt, SearchResult } from '../shared/collaboration';
import type { WorkbenchCommand } from './WorkbenchPanel';
import { Choices, KnowledgeIcon, KnowledgeEmpty } from './KnowledgeUI';
import { MemorySection } from './MemoryPanel';
import './knowledge.css';
const rid = () => crypto.randomUUID();
const privateMessage = (m: ConversationMessage) => m.visibility?.kind === 'private' && !m.visibility.revealedAt;
async function get<T>(path: string, signal?: AbortSignal): Promise<T> { const r = await fetch(path, { signal, cache: 'no-store' }), b = await r.json(); if (!r.ok) throw new Error(b.error ?? '读取失败'); return b; }
async function refFor(m: ConversationMessage, start: number, end: number): Promise<MessageExcerpt> { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m.content)); return { messageId: m.id, revision: m.revision ?? 1, start, end, digest: Array.from(new Uint8Array(bytes)).map(x => x.toString(16).padStart(2, '0')).join('') }; }
export function PrivateComposer({ members, selected, set, disabled }: { members: Member[]; selected: string[]; set: (ids: string[]) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return <div className="cc-private-composer"><button type="button" disabled={disabled} onClick={() => setOpen(v => !v)}>{selected.length ? `私聊 · ${members.filter(m => selected.includes(m.id)).map(m => m.name).join('、')}` : '私聊'}</button>{selected.length > 0 && <button type="button" disabled={disabled} onClick={() => { set([]); setOpen(false); }}>返回公开会话</button>}{open && <div><p className="cc-note">仅你和选定成员可见；公开消息仍可直接发送。</p><Choices members={members} selected={selected} set={set} /></div>}</div>;
}
export function MessageActions({ message: m, detail, members, command, refresh, choose }: { message: ConversationMessage; detail: ConversationDetail; members: Member[]; command: WorkbenchCommand; refresh: () => Promise<void>; choose: (id: string) => void }) {
  const [mode, setMode] = useState<'share' | 'branch' | 'memory'>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [start, setStart] = useState(0), [end, setEnd] = useState(m.content.length), [targets, setTargets] = useState<string[]>([]), [title, setTitle] = useState('');
  const selection = useRef<HTMLTextAreaElement>(null);
  async function run(work: () => Promise<void>) { setError(''); setBusy(true); try { await work(); await refresh(); setMode(undefined); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  const policy = (action: string) => run(async () => { await command(`/api/conversations/${m.conversationId}/messages/${m.id}/visibility`, { requestId: rid(), expectedRevision: m.revision ?? 1, action }); });
  const open = (next: typeof mode) => { setMode(mode === next ? undefined : next); setTitle(next === 'branch' ? `${detail.conversation.title} · 分支` : ''); setStart(0); setEnd(m.content.length); setTargets(next === 'branch' ? detail.conversation.memberIds : []); setError(''); };
  return <div className="cc-message-actions">
    {privateMessage(m) && <span className="cc-private-badge">私聊 · {m.visibility!.memberIds.map(id => members.find(x => x.id === id)?.name ?? id).join('、')}</span>}
    <details><summary>更多操作</summary><div className="cc-knowledge-choices"><a href={`/api/conversations/${m.conversationId}/export?messageIds=${m.id}`} download>导出此消息</a><button disabled={busy || !!m.excerptRefs?.length || !m.content} onClick={() => open('share')}>选段分享</button><button disabled={busy} onClick={() => open('branch')}>从此处分支</button><button disabled={busy || !!m.excerptRefs?.length || !m.content} onClick={() => open('memory')}>存为记忆候选</button>{privateMessage(m) && !m.excerptRefs?.length && <button disabled={busy} onClick={() => void policy('reveal')}>公开此消息</button>}<button disabled={busy} onClick={() => void policy('delete')}>删除此消息</button></div></details>
    {mode && <form className="cc-knowledge-form" onSubmit={e => { e.preventDefault(); void run(async () => {
      if (mode === 'branch') { const r = await command<{ result: Conversation }>(`/api/conversations/${m.conversationId}/branch`, { requestId: rid(), messageId: m.id, expectedRevision: m.revision ?? 1, title, memberIds: targets }); choose(r.result.id); }
      else { const ref = await refFor(m, start, end); if (mode === 'share') await command(`/api/conversations/${m.conversationId}/messages`, { requestId: rid(), content: '请查看我分享的选段。', excerptRefs: [ref], excerptTargets: targets });
        else await command(`/api/conversations/${m.conversationId}/memory-candidates`, { requestId: rid(), key: title, content: m.content.slice(start, end), sourceRefs: [ref], ...(privateMessage(m) ? { privateTo: m.visibility!.memberIds } : {}) }); }
    }); }}>
      {mode !== 'branch' && <><label>选择要分享或记忆的正文<textarea ref={selection} readOnly value={m.content} onSelect={e => { if (e.currentTarget.selectionEnd > e.currentTarget.selectionStart) { setStart(e.currentTarget.selectionStart); setEnd(e.currentTarget.selectionEnd); } }} onKeyUp={e => { if (e.currentTarget.selectionEnd > e.currentTarget.selectionStart) { setStart(e.currentTarget.selectionStart); setEnd(e.currentTarget.selectionEnd); } }} onMouseUp={e => { if (e.currentTarget.selectionEnd > e.currentTarget.selectionStart) { setStart(e.currentTarget.selectionStart); setEnd(e.currentTarget.selectionEnd); } }} /></label><p className="cc-note">当前选段：{start}–{end} · {end - start} 字符（在上方拖选可缩小范围）</p><blockquote>{m.content.slice(start, end)}</blockquote></>}
      {mode !== 'share' && <label>{mode === 'branch' ? '分支名称' : '记忆名称'}<input aria-label={mode === 'branch' ? '分支名称' : '记忆名称'} value={title} onChange={e => setTitle(e.target.value)} required maxLength={120} /></label>}
      {mode !== 'memory' && <><p>{mode === 'share' ? '仅将选段分享给' : '分支参与成员'}</p><Choices members={members.filter(x => detail.conversation.memberIds.includes(x.id))} selected={targets} set={setTargets} /></>}
      <button disabled={busy || mode !== 'memory' && !targets.length}>{mode === 'branch' ? '创建分支' : mode === 'memory' ? '提议候选' : '分享选段'}</button><button type="button" onClick={() => setMode(undefined)}>取消</button>
    </form>}{error && <p className="cc-form-error" role="alert">{error}</p>}
  </div>;
}
const knowledgeTabs = [
  { id: 'memory', title: '会话记忆', icon: 'book' }, { id: 'search', title: '查找材料', icon: 'search' },
  { id: 'visibility', title: '可见范围', icon: 'eye' }, { id: 'groups', title: '成员组', icon: 'users' },
] as const;
type KnowledgeTab = typeof knowledgeTabs[number]['id'];
export function KnowledgePanel({ detail, members, command, refresh, choose, onClose, openLibrary, memoryFocus, visible = true, onOpenTarget }: { detail: ConversationDetail; members: Member[]; command: WorkbenchCommand; refresh: () => Promise<void>; choose: (id: string) => void; onClose: () => void; openLibrary: (versionId?: string) => void; memoryFocus: number; visible?: boolean; onOpenTarget?: OpenWorkspaceTarget }) {
  const c = detail.conversation, panelId = useId();
  const [tab, setTab] = useState<KnowledgeTab>('search'), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(''), [all, setAll] = useState(false), [results, setResults] = useState<SearchResult>(), [searching, setSearching] = useState(false);
  const [viewer, setViewer] = useState(''), [view, setView] = useState<{ messages: ConversationMessage[] }>(), [viewLoading, setViewLoading] = useState(false);
  const [groupName, setGroupName] = useState(''), [groupIds, setGroupIds] = useState<string[]>([]);
  const abort = useRef<AbortController | undefined>(undefined), viewAbort = useRef<AbortController | undefined>(undefined);
  const menu = useRef<HTMLDetailsElement>(null);
  const [locateMemory, setLocateMemory] = useState<string>();
  useEffect(() => { if (memoryFocus) { selectTab('memory'); setLocateMemory(undefined); } }, [memoryFocus]);
  useEffect(() => {
    const dismiss = (e: PointerEvent) => { if (menu.current && !menu.current.contains(e.target as Node)) menu.current.open = false; };
    document.addEventListener('pointerdown', dismiss);
    return () => { abort.current?.abort(); viewAbort.current?.abort(); document.removeEventListener('pointerdown', dismiss); };
  }, []);
  useEffect(() => { if (!visible) { abort.current?.abort(); viewAbort.current?.abort(); setSearching(false); setViewLoading(false); } else if (tab === 'visibility' && viewer) void preview(viewer); }, [visible]);
  const accessKey = JSON.stringify([c.revision, members.map(m => [m.id, m.revision, m.enabled])]);
  const materials = useMemo(() => new Map<string, string>([
    ...detail.messages.map(m => [`message:${m.id}`, JSON.stringify([m.revision, m.deletedAt, m.visibility])] as const),
    ...(detail.memoryVersions ?? []).map(v => [`memory:${v.id}`, JSON.stringify([v.revision, v.state])] as const),
    ...(detail.memories ?? []).map(e => [`entry:${e.id}`, JSON.stringify([e.revision, e.revokedAt])] as const),
    ...(detail.artifacts ?? []).map(a => [`artifact:${a.id}`, JSON.stringify([a.revision, a.headVersionId])] as const),
  ]), [detail.messages, detail.memoryVersions, detail.memories, detail.artifacts]);
  const previousAccess = useRef<{ authority: string; materials: Map<string, string> } | undefined>(undefined);
  useEffect(() => {
    const previous = previousAccess.current;
    previousAccess.current = { authority: accessKey, materials };
    // Appended materials do not invalidate an existing search. Removal, revision or authority changes do.
    if (!previous) return;
    if (previous.authority === accessKey && [...previous.materials].every(([id, revision]) => materials.get(id) === revision)) {
      if (materials.size > previous.materials.size && visible && tab === 'visibility' && viewer) void preview(viewer, true);
      return;
    }
    cancelSearch(); setResults(undefined); viewAbort.current?.abort(); setView(undefined);
    if (visible && tab === 'visibility' && viewer) void preview(viewer);
  }, [accessKey, materials]);
  function closeMenu() { if (menu.current?.open) { menu.current.open = false; menu.current.querySelector('summary')?.focus(); } }
  async function run(work: () => Promise<unknown>) { if (busy) return; closeMenu(); setBusy(true); setError(''); try { await work(); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  function cancelSearch() { abort.current?.abort(); abort.current = undefined; setSearching(false); }
  function editQuery(value: string) { cancelSearch(); setQuery(value); setResults(undefined); setError(''); }
  async function search(searchAll = all) {
    if (!query.trim()) return;
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    setError(''); setSearching(true); setResults(undefined);
    try { const found = await get<SearchResult>(`/api/collaboration/search?q=${encodeURIComponent(query.trim())}${!searchAll ? `&conversationId=${c.id}` : ''}`, controller.signal); if (abort.current === controller && !controller.signal.aborted) setResults(found); }
    catch (e) { if (abort.current === controller && !controller.signal.aborted) setError((e as Error).message); }
    finally { if (abort.current === controller) setSearching(false); }
  }
  async function preview(value: string, preserve = false) {
    viewAbort.current?.abort(); const controller = new AbortController(); viewAbort.current = controller;
    setViewer(value); if (!preserve) setView(undefined); setError(''); setViewLoading(!!value && !preserve); if (!value) return;
    try { const found = await get<{ messages: ConversationMessage[] }>(`/api/conversations/${c.id}?viewer=${encodeURIComponent(value)}`, controller.signal); if (viewAbort.current === controller && !controller.signal.aborted) setView(found); }
    catch (e) { if (viewAbort.current === controller && !controller.signal.aborted) setError((e as Error).message); }
    finally { if (viewAbort.current === controller) setViewLoading(false); }
  }
  function selectTab(next: KnowledgeTab) { cancelSearch(); viewAbort.current?.abort(); setViewLoading(false); setTab(next); setError(''); closeMenu(); if (next === 'visibility' && viewer && !view) void preview(viewer); }
  function locateResult(hit: SearchResult['hits'][number]) {
    if (hit.conversationId !== c.id) { choose(hit.conversationId); return; }
    if (onOpenTarget) {
      if (hit.kind === 'docs') { const artifact = detail.artifacts?.find(a => a.id === hit.id); if (artifact?.headVersionId) { onOpenTarget({ kind: 'artifact', conversationId: c.id, artifactId: artifact.id, versionId: artifact.headVersionId }); return; } }
      if (hit.kind === 'memory') { const version = detail.memoryVersions?.find(v => v.id === hit.id), entry = detail.memories?.find(e => e.id === version?.entryId); if (version && entry?.scope === 'conversation') { onOpenTarget({ kind: 'memory', conversationId: c.id, entryId: entry.id, versionId: version.id }); return; } }
      const message = detail.messages.find(m => hit.kind === 'threads' ? m.id === hit.id : hit.kind === 'sessions' ? m.responseId === hit.id : m.attachmentIds?.includes(hit.id));
      if (message) { onOpenTarget({ kind: 'message', conversationId: c.id, messageId: message.id }); return; }
    }
    if (hit.kind === 'memory') { const version = detail.memoryVersions?.find(v => v.id === hit.id); if (detail.memories?.find(e => e.id === version?.entryId)?.scope === 'library') openLibrary(hit.id); else { selectTab('memory'); setLocateMemory(hit.id); } return; }
    const message = detail.messages.find(m => hit.kind === 'threads' ? m.id === hit.id : hit.kind === 'sessions' ? m.responseId === hit.id : m.attachmentIds?.includes(hit.id));
    if (message) { onClose(); requestAnimationFrame(() => document.getElementById(`message-${message.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })); }
    else setError('材料位置已变化，请重新查找。');
  }
  function tabKey(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault(); const next = e.key === 'Home' ? 0 : e.key === 'End' ? knowledgeTabs.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + knowledgeTabs.length) % knowledgeTabs.length;
    selectTab(knowledgeTabs[next]!.id); e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus();
  }
  const organize = (action: string) => run(() => command(`/api/conversations/${c.id}/visibility-organize`, { requestId: rid(), expectedRevision: c.revision ?? 1, action }));
  const unread = detail.messages.filter(m => (m.sequence ?? 0) > (detail.readCursor?.sequence ?? 0)).length;
  const available = members.filter(m => c.memberIds.includes(m.id));
  return <section id="cc-conversation-info" className="cc-knowledge cc-workspace-knowledge" aria-label="会话资料">
    <div className="cc-knowledge-body">
      <div className="cc-knowledge-toolbar">
        <div className="cc-knowledge-tabs" role="tablist" aria-label="资料功能">{knowledgeTabs.map((item, index) => <button key={item.id} id={`${panelId}-${item.id}`} role="tab" aria-selected={tab === item.id} aria-controls={`${panelId}-panel`} tabIndex={tab === item.id ? 0 : -1} onKeyDown={e => tabKey(e, index)} onClick={() => selectTab(item.id)}><KnowledgeIcon name={item.icon} />{item.title}</button>)}</div>
        <details className="cc-knowledge-menu" ref={menu} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); } }}>
          <summary aria-label="更多会话操作" title="会话操作"><KnowledgeIcon name="more" /></summary>
          <div className="cc-knowledge-menu-items"><small>会话操作</small>
            <button aria-label="标为已读" disabled={busy || !unread} onClick={() => void run(() => command(`/api/conversations/${c.id}/read-cursor`, { sequence: Math.max(0, ...detail.messages.map(m => m.sequence ?? 0)) }))}>标为已读{unread > 0 && <span>{unread}</span>}</button>
            <button disabled={busy} onClick={() => void organize(c.favorite ? 'unfavorite' : 'favorite')}>{c.favorite ? '取消收藏' : '收藏会话'}</button>
            <a href={`/api/conversations/${c.id}/export`} download onClick={closeMenu}>导出会话 JSON</a>
            <button className={c.deletedAt ? '' : 'cc-knowledge-danger'} disabled={busy} onClick={() => void organize(c.deletedAt ? 'undelete' : 'delete')}>{c.deletedAt ? '从回收站恢复' : '移入回收站'}</button>
          </div>
        </details>
      </div>
      {c.deletedAt && <p className="cc-knowledge-banner">此会话已移入回收站。<button disabled={busy} onClick={() => void organize('undelete')}>从回收站恢复</button></p>}
      {c.branch && <p className="cc-knowledge-banner">这是独立的历史分支。<button onClick={() => choose(c.branch!.conversationId)}>查看原会话</button></p>}
      {error && <p className="cc-form-error" role="alert">{error}</p>}
      <div id={`${panelId}-panel`} role="tabpanel" aria-labelledby={`${panelId}-${tab}`} className="cc-knowledge-content">
        {tab === 'search' && <section aria-label="材料搜索">
          <form className="cc-material-search" onSubmit={e => { e.preventDefault(); void search(); }}>
            <div className="cc-material-input"><KnowledgeIcon name="search" /><input type="search" aria-label="搜索材料" placeholder="搜索消息、资料或记忆中的关键词…" value={query} onChange={e => editQuery(e.target.value)} required maxLength={200} /></div>
            <button className="cc-knowledge-primary" disabled={searching || !query.trim()}>{searching ? '查找中…' : '查找'}</button>
          </form>
          <div className="cc-search-filters"><span>搜索范围</span><div role="group" aria-label="搜索范围">{[false, true].map(value => <button key={String(value)} aria-pressed={all === value} onClick={() => { if (value !== all) { setAll(value); setResults(undefined); if (query.trim()) void search(value); } }}>{value ? '全部会话' : '本会话'}</button>)}</div>{searching && <button className="cc-knowledge-link" onClick={cancelSearch}>取消检索</button>}</div>
          {searching ? <p className="cc-knowledge-loading" role="status">正在查找相关材料…</p> : results ? <div aria-label="检索结果" aria-live="polite">
            <div className="cc-knowledge-results-heading"><strong>{results.hits.length ? `找到 ${results.hits.length} 条材料` : '没有找到匹配材料'}</strong><span>{all ? '全部会话' : '本会话'}{results.truncated ? ' · 请缩小范围' : ''}</span></div>
            {!results.hits.length && <KnowledgeEmpty title="试试更短的关键词" description="也可以切换到全部会话，扩大搜索范围。" />}
            {results.hits.map((h, i) => { const artifact = h.conversationId === c.id && h.kind === 'docs' ? detail.artifacts?.find(a => a.id === h.id) : undefined; return <article className="cc-material-result" key={`${h.kind}:${h.id}:${i}`}><div><span className="cc-knowledge-tag">{{ threads: '消息', docs: '资料', memory: '记忆', sessions: '执行回复' }[h.kind]}</span><strong>{h.title}</strong></div><p>{h.excerpt}</p>{artifact?.headVersionId ? <><button className="cc-knowledge-link" onClick={() => locateResult(h)}>打开产物版本 ↗</button><a href={`/api/managed-artifacts/versions/${artifact.headVersionId}/download`}>下载资料 ↗</a></> : <button className="cc-knowledge-link" onClick={() => locateResult(h)}>{h.conversationId !== c.id ? '打开所属会话' : h.kind === 'memory' ? '查看记忆' : '定位消息'} <span aria-hidden="true">↗</span></button>}</article>; })}
          </div> : <KnowledgeEmpty title="让讨论中的信息随时可查" description="输入关键词，查找消息、文本资料、已收录记忆和成员回复。" />}
        </section>}
        {tab === 'memory' && <MemorySection scope="conversation" memories={detail.memories ?? []} versions={detail.memoryVersions ?? []} conversations={[c]} members={members} command={command} refresh={refresh} initialConversationId={c.id} targetVersion={locateMemory} pendingRequest={memoryFocus} visible={visible} openLibrary={() => openLibrary()} />}
        {tab === 'visibility' && <section aria-label="可见范围">
          <div className="cc-knowledge-section-intro"><h3>查看成员能读取的内容</h3><p>选择一位成员，预览其获权消息。</p></div>
          <label className="cc-viewer-field">成员视角预览<select aria-label="成员视角预览" value={viewer} onChange={e => void preview(e.target.value)}><option value="">选择成员</option>{available.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          {viewLoading ? <p className="cc-knowledge-loading" role="status">正在读取可见消息…</p> : !viewer ? <KnowledgeEmpty icon="eye" title="每位成员都有自己的可见范围" description="公开消息与获权私聊会在这里展示。" /> : view && <><div className="cc-knowledge-results-heading"><strong>{view.messages.length} 条可见消息</strong><a href={`/api/conversations/${c.id}/export?viewer=${encodeURIComponent(viewer)}`} download>按此范围导出 ↗</a></div>{!view.messages.length && <KnowledgeEmpty icon="eye" title="暂无可见消息" description="该成员目前没有可读取的会话消息。" />}{view.messages.map(m => <article className="cc-view-message" key={m.id}><small>{m.memberId ? members.find(x => x.id === m.memberId)?.name ?? m.memberId : m.author === 'user' ? '你' : '协作记录'}</small><p>{m.content}</p></article>)}</>}
        </section>}
        {tab === 'groups' && <section aria-label="成员组">
          <div className="cc-knowledge-section-intro"><h3>一次邀请多位成员</h3><p>在消息中使用 @组名，即可邀请组内成员。</p></div>
          <div className="cc-member-groups">{c.memberGroups?.map(g => <article key={g.name}><div><strong>@{g.name}</strong><p>{g.memberIds.map(id => members.find(m => m.id === id)?.name ?? id).join('、')}</p></div><button disabled={busy} onClick={() => void run(() => command(`/api/conversations/${c.id}/visibility-organize`, { requestId: rid(), expectedRevision: c.revision ?? 1, action: 'groups', groups: c.memberGroups!.filter(x => x.name !== g.name) }))}>删除组</button></article>)}</div>
          <form className="cc-knowledge-form cc-group-create" onSubmit={e => { e.preventDefault(); void run(async () => { await command(`/api/conversations/${c.id}/visibility-organize`, { requestId: rid(), expectedRevision: c.revision ?? 1, action: 'groups', groups: [...(c.memberGroups ?? []).filter(g => g.name !== groupName), { name: groupName, memberIds: groupIds }] }); setGroupName(''); setGroupIds([]); }); }}><label>成员组名称<input value={groupName} onChange={e => setGroupName(e.target.value)} placeholder="例如：评审组" required maxLength={40} /></label><fieldset><legend>选择成员</legend><Choices members={available} selected={groupIds} set={setGroupIds} /></fieldset><button className="cc-knowledge-primary" disabled={busy || !groupIds.length}>保存成员组</button></form>
        </section>}
      </div>
    </div>
  </section>;
}
