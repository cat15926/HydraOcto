import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { Conversation, Member, MemoryEntry, MemoryLibraryDetail, MemoryVersion } from '../shared/collaboration';
import type { WorkbenchCommand } from './WorkbenchPanel';
import { Choices, KnowledgeEmpty, KnowledgeIcon } from './KnowledgeUI';

const rid = () => crypto.randomUUID();
export function pendingMemories(entries: MemoryEntry[], versions: MemoryVersion[]) {
  const pendingIds = new Set(versions.filter(v => ['candidate', 'approved'].includes(v.state)).map(v => v.entryId));
  return entries.filter(e => !e.revokedAt && pendingIds.has(e.id));
}

export function MemorySection({ scope, memories, versions, conversations, members, command, refresh, initialConversationId = '', targetVersion, pendingRequest = 0, openLibrary, choose, visible = true, compact = false }: {
  scope: MemoryEntry['scope']; memories: MemoryEntry[]; versions: MemoryVersion[]; conversations: Conversation[];
  members: Member[]; command: WorkbenchCommand; refresh: () => Promise<void>; initialConversationId?: string;
  visible?: boolean; compact?: boolean; targetVersion?: string; pendingRequest?: number; openLibrary?: () => void; choose?: (id: string) => void;
}) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [name, setName] = useState(''), [content, setContent] = useState(''), [privateTo, setPrivateTo] = useState<string[]>([]);
  const [sourceId, setSourceId] = useState(initialConversationId), [query, setQuery] = useState(''), [filter, setFilter] = useState('all');
  const [revision, setRevision] = useState<{ entry: MemoryEntry; content: string }>();
  const create = useRef<HTMLDetailsElement>(null), section = useRef<HTMLElement>(null);
  const idPrefix = useId();
  const entries = memories.filter(e => e.scope === scope && (scope === 'library' || e.conversationId === initialConversationId));
  const pending = pendingMemories(entries, versions);
  const source = conversations.find(c => c.id === sourceId && !c.deletedAt && !c.archivedAt);
  const available = members.filter(m => source?.memberIds.includes(m.id));
  useEffect(() => { if (pendingRequest) { setQuery(''); setFilter('pending'); } }, [pendingRequest]);
  useEffect(() => { if (targetVersion) { setQuery(''); setFilter('all'); } }, [targetVersion]);
  useEffect(() => { if (visible && targetVersion && !query && filter === 'all') Array.from(section.current?.querySelectorAll<HTMLElement>('[data-memory-version-id]') ?? []).find(e => e.dataset.memoryVersionId === targetVersion)?.scrollIntoView({ block: 'nearest' }); }, [targetVersion, query, filter, visible]);
  async function run(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const shown = entries.filter(e => (filter !== 'pending' || pending.some(item => item.id === e.id)) && (filter !== 'current' || !!e.headVersionId && !e.revokedAt) && (!query.trim() || [e.key, ...versions.filter(v => v.entryId === e.id).map(v => v.content)].join('\n').toLowerCase().includes(query.trim().toLowerCase())));
  return <section ref={section} className="cc-memory-section" aria-label={scope === 'library' ? '跨会话记忆' : '会话记忆'}>
    <div className="cc-knowledge-section-intro"><h3>{scope === 'library' ? '让长期共识持续可用' : '留住这次协作的共识'}</h3><p>{scope === 'library' ? '集中管理跨会话记忆；成员仍按原有可见范围读取。' : '仅管理当前会话的记忆。跨会话内容可在记忆库中查看。'}</p>{openLibrary && <button className="cc-knowledge-link" onClick={openLibrary}>打开记忆库 ↗</button>}</div>
    {error && <p className="cc-form-error" role="alert">{error}</p>}
    <div hidden={compact} className="cc-memory-filters" role="group" aria-label="记忆状态">{[['all', '全部'], ['pending', `待确认${pending.length ? ` · ${pending.length}` : ''}`], ['current', '已收录']].map(([id, label]) => <button key={id} aria-pressed={filter === id} onClick={() => setFilter(id!)}>{label}</button>)}</div>
    {scope === 'library' && <label className="cc-memory-search"><KnowledgeIcon name="search" /><input type="search" aria-label="搜索记忆库" placeholder="搜索记忆名称或内容…" value={query} onChange={e => setQuery(e.target.value)} /></label>}
    <details hidden={compact} className="cc-memory-create" ref={create}><summary><span aria-hidden="true">＋</span> 新增记忆</summary><form className="cc-knowledge-form" onSubmit={e => { e.preventDefault(); if (!source) return; void run(async () => { await command(`/api/conversations/${source.id}/memory-candidates`, { requestId: rid(), key: name, content, scope, ...(privateTo.length ? { privateTo } : {}) }); setName(''); setContent(''); setPrivateTo([]); if (create.current) create.current.open = false; }); }}>
      {scope === 'library' && <label>关联会话<select aria-label="记忆来源会话" value={source?.id ?? ''} required disabled={busy} onChange={e => { setSourceId(e.target.value); setPrivateTo([]); }}><option value="">选择记忆的来源会话</option>{conversations.filter(c => !c.archivedAt && !c.deletedAt).map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select><small>用于记录来源和可见成员；收录后可跨会话使用。</small></label>}
      {!source && <p className="cc-note">{conversations.some(c => !c.archivedAt && !c.deletedAt) ? '请先选择关联会话。' : '需要一个进行中的会话作为来源；可新建或恢复会话后再添加。'}</p>}
      <label>新记忆名称<input value={name} onChange={e => setName(e.target.value)} placeholder="例如：项目技术约定" required maxLength={120} disabled={busy} /></label>
      <label>记忆正文<textarea value={content} onChange={e => setContent(e.target.value)} placeholder="记录值得在后续协作中保留的信息" required maxLength={16000} disabled={busy} /></label>
      <fieldset disabled={busy || !source}><legend>可见成员 <small>不选则公开</small></legend><Choices members={available} selected={privateTo} set={setPrivateTo} /></fieldset>
      <p className="cc-note">保存为候选，经批准并实际收录后供成员使用。</p><button className="cc-knowledge-primary" disabled={busy || !source}>创建记忆候选</button>
    </form></details>
    {!shown.length && <KnowledgeEmpty icon="book" title={!entries.length ? '还没有保存的记忆' : '没有符合条件的记忆'} description={!entries.length ? '可以新增记忆，也可以从消息的更多操作中保存选定内容。' : '试试其他状态或关键词。'} />}
    {shown.map(entry => {
      const origin = conversations.find(c => c.id === entry.conversationId), readOnly = !!origin?.archivedAt || !!origin?.deletedAt || !origin;
      return <article key={entry.id} className="cc-memory-entry" data-memory-id={entry.id}><header><h4>{entry.key}</h4><span className="cc-knowledge-tag">{entry.visibility?.kind === 'private' ? `仅 ${entry.visibility.memberIds.map(id => members.find(m => m.id === id)?.name ?? id).join('、')}` : '公开'}</span></header>
        {scope === 'library' && <div className="cc-memory-origin">来源：{choose && origin ? <button className="cc-knowledge-link" onClick={() => choose(origin.id)}>{origin.title}</button> : origin?.title ?? '来源不可用'}{readOnly && <span> · 恢复会话后可编辑</span>}</div>}
        {versions.filter(v => v.entryId === entry.id).sort((a, b) => b.number - a.number).map(v => <div className="cc-memory-version" id={compact ? `${idPrefix}-memory-version-${v.id}` : `memory-version-${v.id}`} data-memory-version-id={v.id} key={v.id}>
          <div className="cc-memory-version-heading"><span>版本 {v.number}</span><strong>{{ candidate: '待审核', approved: '已批准，未收录', materialized: entry.headVersionId === v.id ? '已收录 · 当前版本' : '历史收录版本', revoked: '已撤销', rejected: '已拒绝', stale: '已失效' }[v.state]}</strong></div><p>{v.content}</p>
          <div className="cc-knowledge-choices">{(v.state === 'candidate' ? ['approve', 'reject'] : v.state === 'approved' ? ['materialize', 'revoke'] : v.state === 'materialized' ? ['revoke'] : []).map(action => <button key={action} disabled={busy || readOnly || !!entry.revokedAt} className={['approve', 'materialize'].includes(action) ? 'cc-knowledge-primary' : undefined} onClick={() => void run(() => command('/api/collaboration/memory-transition', { versionId: v.id, action, expectedRevision: v.revision, expectedEntryRevision: entry.revision, requestId: rid() }))}>{{ approve: '批准', reject: '拒绝', materialize: '实际收录', revoke: '撤销' }[action]}</button>)}{entry.headVersionId === v.id && !entry.revokedAt && <button disabled={busy || readOnly} onClick={() => setRevision({ entry, content: v.content })}>提议修订</button>}</div>
        </div>)}
        {revision?.entry.id === entry.id && <form className="cc-knowledge-form" onSubmit={e => { e.preventDefault(); const original = revision.entry; void run(async () => { await command(`/api/conversations/${original.conversationId}/memory-candidates`, { requestId: rid(), key: original.key, content: revision.content, scope: original.scope, entryId: original.id, expectedRevision: original.revision, ...(original.visibility ? { privateTo: original.visibility.memberIds } : {}) }); setRevision(undefined); }); }}><label>修订正文<textarea required maxLength={16000} value={revision.content} disabled={busy} onChange={e => setRevision({ ...revision, content: e.target.value })} /></label><div className="cc-knowledge-choices"><button className="cc-knowledge-primary" disabled={busy || readOnly}>提交修订候选</button><button type="button" disabled={busy} onClick={() => setRevision(undefined)}>取消修订</button></div></form>}
      </article>;
    })}
  </section>;
}

export function MemoryLibrary({ members, command, refresh, initialConversationId, eventCursor, targetVersion, choose, onBack }: {
  members: Member[]; command: WorkbenchCommand; refresh: () => Promise<void>; initialConversationId?: string; eventCursor: number;
  targetVersion?: string; choose: (id: string) => void; onBack: () => void;
}) {
  const [data, setData] = useState<MemoryLibraryDetail>(), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const abort = useRef<AbortController | undefined>(undefined);
  const load = useCallback(async () => {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller; setLoading(true); setError('');
    try { const response = await fetch('/api/collaboration/memory-library', { signal: controller.signal, cache: 'no-store' }), body = await response.json(); if (!response.ok) throw new Error(body.error ?? '记忆库读取失败'); if (abort.current === controller && !controller.signal.aborted) setData(body); }
    catch (e) { if (abort.current === controller && !controller.signal.aborted) { setError((e as Error).message); setData(undefined); } }
    finally { if (abort.current === controller) setLoading(false); }
  }, []);
  useEffect(() => { void load(); return () => abort.current?.abort(); }, [load, eventCursor]);
  return <section className="cc-knowledge cc-memory-library" aria-label="记忆库"><div className="cc-library-content"><header className="cc-library-heading"><div><span>长期资料</span><h1>记忆库</h1><p>在不同协作会话之间，保留值得复用的知识。</p></div><button onClick={onBack}>返回会话</button></header>
    {loading && <p role="status" className="cc-note">正在同步记忆库…</p>}{error && <p className="cc-form-error" role="alert">{error} <button onClick={() => void load()}>重新加载</button></p>}
    {data && <MemorySection scope="library" memories={data.memories} versions={data.memoryVersions} conversations={data.conversations} members={members} command={command} refresh={async () => { await load(); await refresh(); }} initialConversationId={initialConversationId} targetVersion={targetVersion} choose={choose} />}
  </div></section>;
}
