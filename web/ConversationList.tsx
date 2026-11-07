import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Conversation } from '../shared/collaboration';
import type { WorkbenchCommand } from './WorkbenchPanel';
import { WorkspaceIcon } from './WorkspaceIcon';

type Open = { id: string; revision: number; mode: 'menu' | 'rename'; above: boolean };
export function ConversationList({ rows, selected, disabled, query, choose, command, refresh, date }: {
  rows: Conversation[]; selected?: string; disabled: boolean; query: string; choose: (id: string) => void;
  command: WorkbenchCommand; refresh: () => Promise<void>; date: (value: string) => string;
}) {
  const [open, setOpen] = useState<Open>(), [name, setName] = useState(''), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(''), [error, setError] = useState('');
  const nav = useRef<HTMLElement>(null), editor = useRef<HTMLInputElement>(null), menu = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>()), inFlight = useRef(false);
  const restoreFocus = (id: string) => requestAnimationFrame(() => {
    (buttons.current.get(id) ?? nav.current?.querySelector<HTMLButtonElement>('button') ?? document.querySelector<HTMLButtonElement>('.cc-archive-filter'))?.focus({ preventScroll: true });
  });
  const close = () => { if (!inFlight.current && open) { setOpen(undefined); setError(''); restoreFocus(open.id); } };
  useLayoutEffect(() => {
    if (open?.mode === 'rename') { editor.current?.focus(); editor.current?.select(); }
    if (open?.mode === 'menu') menu.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [open?.id, open?.mode]);
  useEffect(() => {
    if (!open) return;
    if (!rows.some(c => c.id === open.id)) { setOpen(undefined); return; }
    if (open.mode !== 'menu') return;
    const outside = (e: Event) => { if (!(e.target instanceof Element) || e.target.closest('[data-thread-id]')?.getAttribute('data-thread-id') !== open.id) setOpen(undefined); };
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); };
  }, [open, rows]);
  async function apply(c: Conversation, action: string) {
    if (inFlight.current || !open || c.id !== open.id) return;
    const title = name.trim();
    if (action === 'rename' && !title) { setError('请输入会话名称。'); editor.current?.focus(); return; }
    inFlight.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await command('/api/conversations/' + c.id + '/organize', { requestId: crypto.randomUUID(), expectedRevision: open.revision, action, ...(action === 'rename' ? { title } : {}) });
      setOpen(undefined);
      setNotice(action === 'archive' ? '已归档，可在归档列表中恢复。' : action === 'restore' ? '已恢复到进行中的会话。' : action === 'rename' ? '会话已重命名。' : action === 'pin' ? '会话已置顶。' : '已取消置顶。');
      await refresh(); restoreFocus(c.id);
    } catch (e) {
      setError((e as Error).message); await refresh().catch(() => undefined);
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <><nav className="cc-conversation-list" aria-label="会话列表" ref={nav}>
    {rows.length ? rows.map(c => {
      const editing = open?.id === c.id && open.mode === 'rename', expanded = open?.id === c.id && open.mode === 'menu';
      return <div key={c.id} data-thread-id={c.id} className={'cc-thread-row' + (selected === c.id ? ' selected' : '') + (expanded ? ' expanded' : '')}
        onKeyDown={e => { if ((expanded || editing) && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }}>
        {editing ? <form className="cc-thread-rename" onSubmit={e => { e.preventDefault(); void apply(c, 'rename'); }}>
          <label><span className="cc-visually-hidden">新会话名称</span><input ref={editor} value={name} onChange={e => setName(e.target.value)} maxLength={200} disabled={busy} /></label>
          <div><button disabled={busy || !name.trim()}>保存</button><button type="button" onClick={close} disabled={busy}>取消</button></div>
        </form> : <>
          <button className="cc-thread-main" aria-current={selected === c.id ? 'page' : undefined} title={c.title} disabled={disabled} onClick={() => { setOpen(undefined); setError(''); setNotice(''); choose(c.id); }}>
            <WorkspaceIcon name={c.pinned ? 'pin' : 'message'} /><span><strong>{c.favorite ? '☆ ' : ''}{c.title}</strong><small>{c.pinned && '已置顶 · '}{date(c.updatedAt)}</small></span>
          </button>
          {!c.deletedAt && <button className="cc-thread-more" ref={b => { if (b) buttons.current.set(c.id,b); else buttons.current.delete(c.id); }} aria-label={c.title + '的更多操作'} aria-haspopup="menu" aria-expanded={expanded} disabled={disabled || busy}
            onClick={e => { setNotice(''); setError(''); const bottom = nav.current!.getBoundingClientRect().bottom; const r = e.currentTarget.getBoundingClientRect(); setOpen(expanded ? undefined : { id: c.id, revision: c.revision ?? 1, mode: 'menu', above: bottom-r.bottom < 132 && r.top-nav.current!.getBoundingClientRect().top > 132 }); }}>⋯</button>}
          {expanded && <div ref={menu} className={'cc-thread-menu' + (open.above ? ' above' : '')} role="menu" aria-label="会话操作" onKeyDown={e => {
            const items = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('button'));
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(items.indexOf(e.target as HTMLButtonElement)+(e.key === 'ArrowDown' ? 1 : items.length-1)) % items.length]?.focus(); }
          }}>
            <button role="menuitem" disabled={busy} onClick={() => { setName(c.title); setOpen({ ...open, mode: 'rename' }); }}><WorkspaceIcon name="edit" />重命名</button>
            <button role="menuitem" disabled={busy} onClick={() => void apply(c, c.pinned ? 'unpin' : 'pin')}><WorkspaceIcon name="pin" />{c.pinned ? '取消置顶' : '置顶会话'}</button>
            <button role="menuitem" disabled={busy} onClick={() => void apply(c, c.archivedAt ? 'restore' : 'archive')}><WorkspaceIcon name="archive" />{c.archivedAt ? '恢复会话' : '归档会话'}</button>
          </div>}
        </>}
        {open?.id === c.id && error && <p className="cc-thread-error" role="alert">{error}{(c.revision ?? 1) !== open.revision && <button onClick={() => { setOpen({ ...open, revision: c.revision ?? 1 }); setError(''); }}>采用更新后的版本</button>}</p>}
      </div>;
    }) : <p>{query ? '没有匹配的会话。' : '此列表暂无会话。'}</p>}
  </nav>{notice && <p className="cc-thread-notice" role="status">{notice}</p>}{error && !open && <p className="cc-thread-error" role="alert">{error}</p>}</>;
}
