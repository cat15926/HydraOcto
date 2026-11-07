import type { Member } from '../shared/collaboration';
export function Choices({ members, selected, set }: { members: Member[]; selected: string[]; set: (ids: string[]) => void }) { return <div className="cc-knowledge-choices">{members.map(m => <label key={m.id}><input type="checkbox" checked={selected.includes(m.id)} onChange={() => set(selected.includes(m.id) ? selected.filter(id => id !== m.id) : [...selected, m.id])} />{m.name}</label>)}</div>; }
export function KnowledgeIcon({ name }: { name: 'search' | 'book' | 'eye' | 'users' | 'more' | 'chevron' }) {
  const paths = {
    search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
    book: 'M12 5v16M3 3h5a4 4 0 0 1 4 2 4 4 0 0 1 4-2h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3Z',
    eye: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-4M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm4-4a4 4 0 0 1 0 8',
    more: 'M5 12h.01M12 12h.01M19 12h.01', chevron: 'm9 5 7 7-7 7',
  };
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === 'more' ? 3 : 1.65} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
export function KnowledgeEmpty({ title, description, icon = 'search' }: { title: string; description: string; icon?: 'search' | 'book' | 'eye' | 'users' }) {
  return <div className="cc-knowledge-empty"><span><KnowledgeIcon name={icon} /></span><div><strong>{title}</strong><p>{description}</p></div></div>;
}
