import { useRef, useState } from 'react';
import type { ConversationDetail, Delivery } from '../shared/collaboration';
import type { WorkbenchCommand } from './WorkbenchPanel';

function receiptText(detail: ConversationDetail, delivery: Delivery, member: string) {
  if (delivery.status === 'withdrawn') return '这条补充已撤回';
  const handoff = detail.inputHandoffs?.find(h => h.id === delivery.handoffId);
  if (handoff?.state === 'unknown') return '接收状态待核查';
  if (handoff?.state === 'read') return member + ' 本轮已读取';
  if (handoff?.state === 'accepted') return member + ' 本轮已接收';
  if (handoff?.state === 'sent') return '正在补充给 ' + member;
  if (delivery.status === 'held') return delivery.holdReason || '投递已暂停';
  if (delivery.status === 'consumed') {
    const next = detail.invocations.find(run => run.responseId === delivery.responseId);
    if (next?.acceptance === 'accepted') return member + ' 已在下一轮接收';
    if (next && ['failed','interrupted','cancelled'].includes(next.status)) return '下一轮已结束，未确认接收';
    return '已分配给 ' + member + ' 的下一轮';
  }
  if (delivery.continuation?.fallback) return '已排入 ' + member + ' 下一轮';
  return '等待向 ' + member + ' 本轮追加';
}

export function ProjectGuidanceReceipt({detail, delivery, command, refresh}: {
  detail: ConversationDetail; delivery: Delivery; command: WorkbenchCommand; refresh: () => Promise<void>;
}) {
  const [busy,setBusy] = useState(false), [error,setError] = useState('');
  const row = useRef<HTMLDivElement>(null);
  const run = detail.invocations.find(i => i.id === delivery.continuation?.invocationId);
  const handoff = detail.inputHandoffs?.find(h => h.id === delivery.handoffId);
  async function inspect() {
    if (!handoff || busy) return;
    setBusy(true); setError('');
    try {
      await command('/api/input-handoffs/' + handoff.id + '/inspect', {expectedRevision:handoff.revision});
      await refresh();
      row.current?.focus({preventScroll:true});
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <div className="cc-guidance-receipt" ref={row} tabIndex={-1}>
    <span role="status">{receiptText(detail,delivery,run?.member.name ?? delivery.memberId)}</span>
    {handoff?.state === 'unknown' && <button type="button" className="cc-reply-button" disabled={busy} onClick={()=>void inspect()}>{busy?'正在核查…':'核查接收状态'}</button>}
    {error && <span role="alert">{error}</span>}
  </div>;
}
