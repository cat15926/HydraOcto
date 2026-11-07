import { useRef, useState } from 'react';
import type { ConversationDetail, Member } from '../shared/collaboration';

const groupNames = { collecting: '等待结果', done: '已收齐', timeout: '已超时', cancelled: '已取消', lost: '重启后停止收集' };
const appendNames = { sent: '等待追加回执', accepted: '承载已接受', read: '已取得原生读取证据', unknown: '结果未知，保留原绑定', not_accepted: '未接受，保留下一轮' };
type Props = { detail: ConversationDetail; members: Member[]; command: (path: string, body: unknown) => Promise<unknown>; refresh: () => Promise<void> };

/** Scheduling controls and consultation progress; requests originate in the conversation. */
export function CooperationPanel({ detail, members, command, refresh }: Props) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const pending = useRef<{ signature: string; body: Record<string, unknown> } | undefined>(undefined);
  const name = (id: string) => members.find(m => m.id === id)?.name ?? id;
  const queue = detail.queue;
  async function act(path: string, fields: Record<string, unknown>, success: string) {
    if (busy) return false;
    const signature = JSON.stringify({ path, fields });
    if (pending.current?.signature !== signature) pending.current = { signature, body: { ...fields, requestId: crypto.randomUUID() } };
    setBusy(true); setError(''); setNotice('');
    try { await command(path, pending.current.body); pending.current = undefined; setNotice(success); await refresh(); return true; }
    catch (cause) {
      const e = cause as Error & { status?: number }; setError(e.message);
      if (e.status) pending.current = undefined;
      if (e.status === 409) await refresh().catch(() => undefined);
      return false;
    } finally { setBusy(false); }
  }
  function move(index: number, offset: number) {
    if (!queue) return;
    const sourceIds = queue.sources.map(s => s.id), next = index + offset;
    [sourceIds[index], sourceIds[next]] = [sourceIds[next]!, sourceIds[index]!];
    void act('/api/conversations/' + detail.conversation.id + '/queue-order', { expectedRevision: queue.revision, sourceIds }, '来源顺序已更新。');
  }
  return <section className="cc-monitor-section cc-cooperation-panel" aria-label="协作调度">
    <div className="cc-section-title"><h3>协作调度</h3><button disabled={busy || !detail.invocations.some(i => ['prepared', 'running', 'cancel_requested'].includes(i.status))} onClick={() => void act('/api/conversations/' + detail.conversation.id + '/cancel-all', {}, '已请求停止当前执行。成员暂缓 60 秒，新输入可解除对应目标的暂缓。')}>停止当前全部</button></div>
    {error && <p className="cc-operation-note cc-operation-error" role="alert">{error}</p>}
    {notice && <p className="cc-operation-note" role="status">{notice}</p>}
    <details><summary>来源队列 · {queue?.sources.length ?? 0}</summary>
      <p className="cc-note">排序作用于整条来源。撤回只影响尚未交付的目标。</p>
      {queue?.sources.map((s, index) => <div className="cc-cooperation-card" key={s.id} data-queue-source={s.id}>
        <strong>{s.bindingState === 'unresolved' ? '等待空闲解析目标' : s.requestedTargets.map(name).join('、')}</strong>
        <p>{s.content}</p><small>{s.priority === 'urgent' ? '优先' : '普通'} · {s.kind}</small>
        <div className="cc-cooperation-actions">
          <button disabled={busy || index === 0} onClick={() => move(index, -1)} aria-label="来源上移">上移</button>
          <button disabled={busy || index === queue.sources.length - 1} onClick={() => move(index, 1)} aria-label="来源下移">下移</button>
          <button disabled={busy} onClick={() => void act('/api/sources/' + s.id + '/priority', { expectedRevision: queue.revision, priority: s.priority === 'urgent' ? 'normal' : 'urgent' }, '来源优先级已更新。')}>{s.priority === 'urgent' ? '设为普通' : '设为优先'}</button>
          <button disabled={busy} onClick={() => void act('/api/sources/' + s.id + '/withdraw', { expectedRevision: s.revision }, '未交付目标已撤回；既有运行事实保留。')}>撤回待投递</button>
        </div>
      </div>)}
      {queue?.backoffs.map(b => <p className="cc-note" key={b.sourceId}>发送前退避至 {new Date(b.until).toLocaleTimeString()} · 第 {b.attempts} 次</p>)}
      {queue?.suppressions.map(f => <p className="cc-note" key={f.memberId}>{name(f.memberId)} 暂缓至 {new Date(f.until).toLocaleTimeString()}</p>)}
    </details>
    <details><summary>本轮追加与输入归并 · {(detail.inputHandoffs?.length ?? 0) + (detail.inputExposures?.filter(e => e.kind !== 'append').length ?? 0)}</summary>
      <p className="cc-note">追加接受、原生读取和任务完成分别记录。没有准确证据时不会重复发送。</p>
      {detail.inputHandoffs?.map(h => <div className="cc-cooperation-card" key={h.id} data-input-handoff={h.id}>
        <strong>{name(h.memberId)} · {appendNames[h.state]}</strong><p>{h.content}</p><small>{h.reason}</small>
        <code>执行 {h.invocationId} · 轮次 {h.nativeTurnId}</code>
        {['sent', 'accepted', 'unknown'].includes(h.state) && <button disabled={busy} onClick={() => void act('/api/input-handoffs/' + h.id + '/inspect', { expectedRevision: h.revision }, '已核查原追加；以最新准确证据为准。')}>核查原追加</button>}
      </div>)}
      {detail.inputExposures?.filter(e => e.kind !== 'append').map(e => <details className="cc-cooperation-card" key={e.id} data-input-exposure={e.id}><summary>{e.kind === 'prompt' ? '首次输入全文归并' : '工具完整读取'} · 输入第 {e.inputRevision} 版</summary><code>来源 {e.sourceId} · 回复 {e.responseId}</code><p>{e.content}</p></details>)}
    </details>
    {!!detail.groups?.length && <section aria-label="多人征询进度">
      <div className="cc-section-title"><h3>多人征询 · {detail.groups.length}</h3></div>
      {detail.groups.map(g => <details className="cc-cooperation-card" key={g.id} data-mention-group={g.id}><summary>{g.question} · {groupNames[g.state]}{g.results && ` · 已收集 ${g.results.length}/${g.targets.length}`}</summary>
        {g.context && <p>{g.context}</p>}<small>参与成员：{g.targets.map(name).join('、')} · 截止 {new Date(g.deadline).toLocaleTimeString()}</small>
        {g.missing?.length ? <p>{g.state === 'collecting' ? '等待' : '未收集'}：{g.missing.map(name).join('、')}</p> : null}
        {g.state === 'collecting' && <p className="cc-note">收齐后将在对话中汇集各成员的结果。</p>}
        {g.state === 'timeout' && <p className="cc-note">已到等待时限，未生成完整结果汇集。</p>}
        {g.state === 'done' && <p className="cc-note">以下为各成员的原始结果。</p>}
        {g.results?.map(r => <p key={r.memberId}><strong>{name(r.memberId)} · {r.status === 'failed' ? '失败' : '已返回'}</strong><br />{r.content}</p>)}
        {g.state === 'collecting' && <button disabled={busy} onClick={() => void act('/api/mention-groups/' + g.id + '/cancel', { expectedRevision: g.revision }, '征询已取消；已请求停止此组准确执行。')}>取消此征询</button>}
      </details>)}
    </section>}
  </section>;
}
