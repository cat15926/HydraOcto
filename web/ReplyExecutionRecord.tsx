import { useEffect, useRef } from 'react';
import type { CollaborationInvocation, ConversationDetail } from '../shared/collaboration';
import { RuntimeIdentity } from './RuntimeIdentity';
import { WorkspaceIcon } from './WorkspaceIcon';

type RecordProps = { run: CollaborationInvocation; detail: ConversationDetail };
const labels = {
  prepared: '等待启动', running: '执行中', cancel_requested: '正在停止', cancelled: '已停止',
  failed: '执行失败', interrupted: '执行中断', succeeded: '执行记录',
};

export function ReplyRecordButton({ run, detail, onOpen }: RecordProps & { onOpen: () => void }) {
  const active = ['prepared', 'running', 'cancel_requested'].includes(run.status);
  const unconfirmed = !active && run.teardown !== 'confirmed';
  const declined = run.status === 'succeeded' && detail.interactions?.some(i => i.invocationId === run.id && i.state === 'declined');
  const status = declined ? '本轮已结束' : labels[run.status];
  const label = unconfirmed ? (status === '执行记录' ? '退出待核查' : status + ' · 退出待核查') : status;
  return <button type="button" className="cc-record-trigger" aria-haspopup="dialog" data-record-run={run.id}
    data-attention={unconfirmed || ['failed', 'interrupted'].includes(run.status)} onClick={onOpen}>
    <WorkspaceIcon name="pulse" />{label}
  </button>;
}

export function ReplyExecutionRecord({ run, detail, onClose, onAudit }: RecordProps & {
  onClose: () => void; onAudit: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => {
      dialog.close();
      document.querySelector<HTMLButtonElement>('[data-record-run="' + CSS.escape(run.id) + '"]')?.focus({preventScroll:true});
    };
  }, [run.id]);
  const milestones: Record<string, string> = {
    prepared: '已准备输入', exposed: '已向运行时提供输入', accepted: '运行时已接受输入',
    not_accepted: '运行时未接受输入', session: '收到会话回执', process_exit: '收到进程退出记录',
    session_replaced: '已更换原生会话', transport_settled: '请求传输已结束',
  };
  const events = detail.evidence.filter(e => e.invocationId === run.id && milestones[e.kind]);
  return <dialog ref={ref} aria-labelledby="reply-record-title" className="cc-record-dialog"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== ref.current) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientY < bounds.top || event.clientX > bounds.right || event.clientY > bounds.bottom) onClose();
    }}>
    <header><h2 id="reply-record-title">执行记录</h2><button type="button" onClick={onClose} aria-label="关闭执行记录"><WorkspaceIcon name="close" /></button></header>
    <p className="cc-note">{run.member.name} · {new Date(run.createdAt).toLocaleString('zh-CN')}</p>
    <RuntimeIdentity detail={detail} run={run} />
    {(run.error || run.blockedReason) && <p className="cc-execution-error">{run.blockedReason || run.error}</p>}
    <h3>执行过程</h3>
    {events.length ? <ol>{events.map(e => <li key={e.id}><time>{new Date(e.createdAt).toLocaleTimeString('zh-CN')}</time>{milestones[e.kind]}</li>)}</ol> : <p className="cc-note">尚无执行过程回执。</p>}
    <button type="button" onClick={onAudit}>在工作台查看完整记录</button>
  </dialog>;
}
