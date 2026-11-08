import { useEffect, useRef, useState } from 'react';
import type { AcceptanceEvidence, CollaborationInvocation, ProjectReviewCheck } from '../shared/collaboration';
import type { WorkbenchCommand } from './WorkbenchPanel';

type Check = ProjectReviewCheck;
type FileState = Check['files'][number]['status'];
const labels: Record<FileState,string> = {
  unchanged:'与读取时一致', changed:'读取后有改动', unavailable:'当前无法核对', unread:'还没有读取回执',
};

export function ProjectReviewEvidence({ run, paths, projectScope, origin, evidence, requestedAgain, command, refresh }: {
  run: CollaborationInvocation; paths: string[]; evidence: AcceptanceEvidence[];
  projectScope?: boolean;
  origin?: {messageId:string; memberName:string};
  requestedAgain: boolean; command: WorkbenchCommand; refresh: () => Promise<void>;
}) {
  const [open,setOpen] = useState(false), [version,setVersion] = useState(0);
  const [check,setCheck] = useState<Check>(), [error,setError] = useState('');
  const [checking,setChecking] = useState(false), [resending,setResending] = useState(false);
  const ticket = useRef<string | undefined>(undefined);
  const base = '/api/conversations/'+encodeURIComponent(run.conversationId)+'/project-reviews/'+encodeURIComponent(run.id);
  const receipts = new Map<string,string>();
  for (const event of evidence) {
    const e = event.detail;
    if (event.invocationId === run.id && event.kind === 'tool' && e.origin === 'project_review' && e.state === 'read' && typeof e.path === 'string' &&
        (projectScope || paths.includes(e.path)) && typeof e.sha256 === 'string') receipts.set(e.path,e.sha256);
  }
  const commands = useRef(command);
  commands.current = command;
  const receiptVersion = [...receipts.values()].join(',');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setChecking(true); setError(''); setCheck(undefined);
    void commands.current<Check>(base+'/check',{},controller.signal).then(result => {
      if (!controller.signal.aborted) setCheck(result);
    }).catch(e => {
      if (!controller.signal.aborted) setError(e.message || '核对文件失败，请重试。');
    }).finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  },[open,base,version,run.status,receiptVersion]);
  async function reread() {
    if (requestedAgain || resending) return;
    ticket.current ??= crypto.randomUUID();
    setResending(true); setError('');
    try {
      await command(base+'/reread',{requestId:ticket.current});
      await refresh();
      ticket.current = undefined;
    } catch(e) { setError((e as Error).message); } finally { setResending(false); }
  }
  const lastCheck = [...evidence].reverse().find(event => event.invocationId === run.id && event.detail.origin === 'project_review' &&
    event.detail.state === 'checked' && Array.isArray(event.detail.files));
  const atReply = lastCheck?.detail.files as Check['files'] | undefined;
  const files = check?.files ?? atReply;
  const displayedPaths = [...new Set([...paths,...receipts.keys()])];
  const tests = new Map<string,AcceptanceEvidence['detail']>();
  if (projectScope) for (const event of evidence) {
    const d = event.detail;
    if (event.invocationId === run.id && event.kind === 'tool' && d.origin === 'project_review' &&
        ['test_started','tested','test_skipped','test_incomplete'].includes(String(d.state)) && typeof d.callId === 'string') tests.set(d.callId,d);
  }
  const staleAtReply = atReply?.some(f => f.status === 'changed');
  const stale = files?.some(f => f.status === 'changed');
  const completed = run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'interrupted';
  return <details className="cc-project-review-evidence" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>评审依据 · 已读取 {receipts.size}/{displayedPaths.length}{stale ? ' · 文件已变化' : ''}{requestedAgain ? ' · 已请求重新评审' : ''}</summary>
    {origin && <a className="cc-reply-reference" href={`#message-${origin.messageId}`}>查看 {origin.memberName} 的评审请求</a>}
    <ul>{displayedPaths.map(path => {
      const file = files?.find(f => f.path === path), sha = receipts.get(path);
      return <li key={path}><code>{path}</code><span>{file ? labels[file.status] : sha ? '已读取' : labels.unread}</span>
        {sha && <small title={sha}>读取摘要 {sha.slice(0,12)}</small>}</li>;
    })}</ul>
    {projectScope && <div aria-label="独立测试"><strong>评审成员的独立测试</strong>{tests.size === 0
      ? <p className="cc-note">暂无测试执行回执</p>
      : <ul>{[...tests].map(([id,t]) => <li key={id}><code>{Array.isArray(t.argv) && t.argv.map(String).join(' ')}</code>
        <span>{t.state === 'tested' && t.treeExited === true && typeof t.exitCode === 'number' ? t.exitCode === 0 ? '通过 · 退出码 0' : '失败 · 退出码 ' + t.exitCode
          : t.state === 'test_skipped' ? '未执行' : t.state === 'test_started' && !completed ? '正在运行' : '未取得完整结果'}</span>
        {t.state === 'test_skipped' && typeof t.reason === 'string' && <small>{t.reason}</small>}</li>)}</ul>}</div>}
    <div className="cc-project-review-actions">
      <button type="button" disabled={checking} onClick={() => setVersion(v => v+1)}>{checking ? '正在核对…' : '核对当前文件'}</button>
      {completed && files?.some(f => f.status !== 'unchanged') && <button type="button" disabled={requestedAgain || resending}
        onClick={() => void reread()}>{requestedAgain ? '已请求重新评审' : resending ? '正在发送…' : '请成员重新读取并评审'}</button>}
    </div>
    {staleAtReply && <p className="cc-note">给出原结论前，文件已经发生变化。</p>}
    {stale && !staleAtReply && <p className="cc-note">原结论依据读取时的文件。</p>}
    {error && <p className="cc-form-error" role="alert">{error}</p>}
  </details>;
}
