export function WorkspaceIcon({ name }: { name: string }) {
  const path: Record<string, string> = {
    edit: 'm4 16 12-12 4 4L8 20H4Zm10-10 4 4', archive: 'M3 4h18v5H3zM5 9v11h14V9M10 12h4',
    home: 'm3 10 9-7 9 7v11h-6v-7H9v7H3Z', plus: 'M12 4v16M4 12h16', pin: 'm8 3 8 0-1 7 4 5H5l4-5ZM12 15v7', expand: 'M3 9V3h6m6 0h6v6M3 15v6h6m6 0h6v-6', history: 'M3 5v5h5M4 10a8 8 0 1 1 1 9M12 7v5l3 2', question: 'M9 9a3 3 0 1 1 5 2l-2 2v2M12 18v1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', message: 'M3 3h18v14H9l-6 4Z', grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z', folder: 'M3 6h6l2 3h10v11H3ZM3 6V4h6l2 2h10v3',
    book: 'M12 5v16M3 3h5a4 4 0 0 1 4 2 4 4 0 0 1 4-2h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3Z',
    file: 'M5 3h9l5 5v13H5ZM14 3v6h5M8 13h8M8 17h5', check: 'M9 4h11v16H4V9m-1-4 3 3 6-6M8 13h8M8 17h5',
    people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-4M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm4-4a4 4 0 0 1 0 8',
    link: 'm10 13 4-4m-7 7-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m4 0 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
    pulse: 'M2 12h5l3-8 4 16 3-8h5', search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
    back: 'M20 12H4m6-6-6 6 6 6', close: 'm6 6 12 12M6 18 18 6', chevron: 'm9 5 7 7-7 7',
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={path[name] ?? path.grid} /></svg>;
}
export function WorkspaceButtonIcon() { return <WorkspaceIcon name="grid" />; }
