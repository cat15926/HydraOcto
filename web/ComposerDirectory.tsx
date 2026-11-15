import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { CollaborationBootstrap, ConversationDetail } from '../shared/collaboration';
import type { DirectoryChoice } from './ProjectFolder';
import { WorkspaceIcon } from './WorkspaceIcon';

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) || path;

/** Recent paths are suggestions only. Every selection needs a new server-side grant preview. */
export function ComposerDirectory({ data, detail, selected, disabled, buttonRef, onChoose, onMembers, memberCount, children }: {
  data?: CollaborationBootstrap; detail?: ConversationDetail; selected?: string; disabled: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>; onChoose: (choice: DirectoryChoice) => void;
  onMembers: (button: HTMLButtonElement) => void; memberCount: number; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const path = detail?.conversation.workspaceGrant?.path;
  const isDefault = !path || path === data?.workspace;
  const paths = new Set<string>();
  if (path && !isDefault) paths.add(path);
  for (const conversation of [...(data?.conversations ?? [])].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))) {
    if (!conversation.deletedAt && conversation.workspaceGrant?.path && conversation.workspaceGrant.path !== data?.workspace)
      paths.add(conversation.workspaceGrant.path);
  }
  const recent = [...paths].slice(0, 6);
  function close(focus = false) {
    setOpen(false);
    if (focus) buttonRef.current?.focus({preventScroll:true});
  }
  useEffect(() => { setOpen(false); }, [selected, disabled]);
  useEffect(() => {
    if (!open) return;
    const click = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', click);
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"], button')?.focus({preventScroll:true});
    return () => document.removeEventListener('pointerdown', click);
  }, [open]);
  function pick(choice: Omit<DirectoryChoice, 'id'>) {
    close(true); onChoose({id:crypto.randomUUID(), ...choice});
  }
  return <div className="cc-composer-context">
    <div ref={root} className="cc-directory" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => {
      if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true); }
      if (open && ['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
        event.preventDefault();
        const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length-1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }}>
      <button ref={buttonRef} type="button" className="cc-directory-trigger" disabled={disabled} aria-label="设置会话工作目录" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} title={path ?? data?.workspace} onClick={() => setOpen(value => !value)} onKeyDown={event => { if (!open && ['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); } }}>
        <WorkspaceIcon name="folder" /><span>{isDefault ? selected ? '默认工作区' : '选择工作目录' : basename(path)}</span><WorkspaceIcon name="chevron" />
      </button>
      {open && <div ref={menu} id={menuId} role="menu" aria-label="选择工作目录" className="cc-directory-menu">
        <small role="presentation">当前目录 · {detail?.conversation.workspaceGrant?.mode === 'project-work' ? '已授权项目工作' : isDefault ? '使用默认工作区' : '仅浏览文件'}</small>
        <small role="presentation">最近使用的目录</small>
        {recent.map(value => <button key={value} type="button" role="menuitemradio" aria-checked={path === value} onClick={() => path === value ? close(true) : pick({path:value})}>
          <WorkspaceIcon name="folder" /><span><strong>{basename(value)}</strong><small>{value}</small></span>{path === value && <span aria-hidden="true">✓</span>}
        </button>)}
        {!recent.length && <p role="presentation">选择文件夹后，可在这里快速切换。</p>}
        <div className="cc-directory-menu-actions" role="presentation">
          <button type="button" role="menuitem" onClick={() => pick({})}><WorkspaceIcon name="plus" /><span>选择其他文件夹…</span></button>
          <button type="button" role="menuitemradio" aria-checked={isDefault} onClick={() => isDefault ? close(true) : pick({path:data?.workspace,defaultWorkspace:true})}><WorkspaceIcon name="home" /><span>使用默认工作区</span>{isDefault && <span aria-hidden="true">✓</span>}</button>
        </div>
      </div>}
    </div>
    {children}
    <button type="button" className="cc-composer-members" disabled={disabled} onClick={event => onMembers(event.currentTarget)} aria-label={selected ? '设置会话成员与默认成员' : '选择新会话成员与默认成员'}><WorkspaceIcon name="people" /><span className="cc-members-label">成员 · </span>{memberCount}</button>
  </div>;
}
