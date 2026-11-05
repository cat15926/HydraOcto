import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ConversationDetail, Member, OrdinaryTask } from '../shared/collaboration';

const states = { todo: '待办', doing: '进行中', blocked: '等待条件', done: '已完成' };
const endings = { frozen: '冻结本次跟踪', degraded: '降级结束跟踪', abandoned: '放弃本次任务' };
const handoffStates = { waiting: '等待旧执行释放', applied: '已变更负责人', cancelled: '已撤销', refused: '未应用' };
type Choice = { kind: 'create' | 'update' | 'handoff' | 'cancel-handoff'; task?: OrdinaryTask };
type Props = { detail: ConversationDetail; members: Member[]; command: (path: string, body: unknown) => Promise<unknown>; refresh: () => Promise<void> };

/** Task controls are optional and live outside the natural message composer. */
export function TaskPanel({ detail, members, command, refresh }: Props) {
  const [choice, setChoice] = useState<Choice>();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [conflict, setConflict] = useState(false);
  const [status, setStatus] = useState('doing');
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef<{ signature: string; body: Record<string, unknown> } | undefined>(undefined);
  useEffect(() => { if (choice) dialog.current?.showModal(); return () => dialog.current?.close(); }, [!!choice]);
  const name = (id?: string | null) => id ? members.find(m => m.id === id)?.name ?? id : '未分配';
  function open(next: Choice) { pending.current = undefined; setChoice(next); setStatus(next.task?.status ?? 'doing'); setError(''); setConflict(false); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!choice || busy) return;
    const form = new FormData(event.currentTarget), task = choice.task;
    const path = choice.kind === 'create' ? `/api/conversations/${detail.conversation.id}/ordinary-tasks` : `/api/ordinary-tasks/${task!.id}/${choice.kind}`;
    const fields: Record<string, unknown> = choice.kind === 'create' ? { title: form.get('title'), description: form.get('description'), ownerMemberId: form.get('ownerMemberId') || null }
      : { expectedRevision: task!.revision, expectedOwnerRevision: task!.ownerRevision,
        ...(choice.kind === 'handoff' ? { targetMemberId: form.get('targetMemberId'), reason: form.get('reason'), stopCurrent: form.get('stopCurrent') === 'on' }
          : choice.kind === 'update' ? { ...((status in endings) ? { disposition: status } : { status }), reason: form.get('reason') } : {}) };
    const signature = JSON.stringify({ path, fields });
    if (pending.current?.signature !== signature) pending.current = { signature, body: { ...fields, requestId: crypto.randomUUID() } };
    setBusy(true); setError('');
    try {
      await command(path, pending.current.body); pending.current = undefined; setChoice(undefined);
      setNotice(choice.kind === 'handoff' ? '交接意图已保存；负责人以真实释放后的结果为准。' : choice.kind === 'cancel-handoff' ? '交接已撤销，已有停止意图与执行事实仍保留。' : '任务操作已保存。');
      await refresh();
    } catch (cause) {
      const failure = cause as Error & { status?: number };
      if (failure.status) pending.current = undefined;
      setError(failure.message);
      if (failure.status === 409) { setConflict(true); await refresh().catch(() => undefined); }
    } finally { setBusy(false); }
  }
  const tasks = detail.tasks ?? [];
  const messageItems = detail.responsibility?.filter(r => r.kind === 'message') ?? [];
  return <section className="cc-monitor-section cc-task-panel" aria-label="普通任务">
    <div className="cc-section-title"><h3>普通任务 · {tasks.length}</h3><button onClick={() => open({ kind: 'create' })}>新建任务</button></div>
    <p className="cc-note">需要明确责任时再建任务，聊天可直接继续。完成回复不会自动完成任务。</p>
    {notice && <p className="cc-task-notice" role="status">{notice}</p>}
    {!tasks.length && <p className="cc-panel-empty">本会话尚无普通任务。</p>}
    {tasks.map(t => {
      const projection = detail.responsibility?.find(r => r.taskId === t.id), handoffs = detail.taskHandoffs?.filter(h => h.taskId === t.id) ?? [];
      const waiting = handoffs.find(h => h.id === t.pendingHandoffId);
      return <details className="cc-task-card" key={t.id} data-task-id={t.id}>
        <summary><strong>{t.title}</strong><span className={`cc-task-state cc-task-${t.status}`}>{t.disposition ? endings[t.disposition.kind] : states[t.status]}</span></summary>
        <div className="cc-task-body"><p>{t.description || '无补充描述'}</p><dl><dt>负责人</dt><dd>{name(t.ownerMemberId)} · 第 {t.ownerRevision} 版</dd><dt>当前执行者</dt><dd>{t.executionRef ? `${name(t.executionRef.memberId)} · ${t.executionRef.invocationId.slice(0, 8)}` : '当前无执行绑定'}</dd>
          {waiting && <><dt>拟接任成员</dt><dd>{name(waiting.toMemberId)} · 等待旧执行释放</dd></>}
          <dt>责任状态</dt><dd>{projection?.reason ?? '等待读取状态'}{projection?.diagnostic && <strong className="cc-task-diagnostic">{projection.diagnostic}</strong>}</dd>
          {t.statusReason && <><dt>状态说明</dt><dd>{t.statusReason}</dd></>}
        </dl><div className="cc-task-actions"><button onClick={() => open({ kind: 'update', task: t })}>更新状态</button>{t.pendingHandoffId ? <button onClick={() => open({ kind: 'cancel-handoff', task: t })}>撤销交接</button> : t.status !== 'done' && !t.disposition && <button onClick={() => open({ kind: 'handoff', task: t })}>{t.ownerMemberId ? '正式转交' : '指派成员'}</button>}</div>
          {handoffs.length > 0 && <details className="cc-task-history"><summary>交接记录 · {handoffs.length}</summary>{handoffs.map(h => <p key={h.id}>{name(h.fromMemberId)} → {name(h.toMemberId)}<br /><strong>{handoffStates[h.state]}</strong> · {h.reason}<br /><small>来源 {h.sourceId.slice(0, 8)} · {h.stopRequested ? '已请求停止旧执行' : '等待自然结束'}</small></p>)}</details>}
          <small className="cc-task-id">任务 {t.id} · 修订 {t.revision}</small>
        </div>
      </details>;
    })}
    {messageItems.length > 0 && <p className="cc-note cc-message-responsibility">消息责任：{messageItems.filter(r => r.state === 'active').length} 项执行中，{messageItems.filter(r => ['pending', 'waiting'].includes(r.state)).length} 项待投递。按各目标分别记录，不决定任务负责人。</p>}
    {choice && <dialog ref={dialog} className="cc-dialog cc-task-dialog" onCancel={e => { e.preventDefault(); if (!busy) setChoice(undefined); }} aria-labelledby="cc-task-dialog-title">
      <header><h2 id="cc-task-dialog-title">{({ create: '新建普通任务', update: '更新任务状态', handoff: choice.task?.ownerMemberId ? '正式转交任务' : '指派任务成员', 'cancel-handoff': '撤销等待中的交接' })[choice.kind]}</h2><button disabled={busy} onClick={() => setChoice(undefined)} aria-label="关闭任务操作">×</button></header>
      <form className="cc-settings-form" onSubmit={event => void submit(event)}>
        {choice.task && <p className="cc-note">{choice.task.title} · 基于修订 {choice.task.revision} / 负责人 {choice.task.ownerRevision}</p>}
        {choice.kind === 'create' && <><label>任务标题<input name="title" required maxLength={200} autoFocus /></label><label>任务说明<textarea name="description" rows={4} maxLength={20000} /></label><label>负责人<select name="ownerMemberId" defaultValue=""><option value="">暂不分配</option>{members.filter(m => m.enabled && detail.conversation.memberIds.includes(m.id)).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><p className="cc-note">指定成员后会排队执行；未分配任务等待后续领取或指派。</p></>}
        {choice.kind === 'update' && <><label>任务状态<select name="status" value={status} onChange={e => setStatus(e.target.value)}>{Object.entries(states).map(([id, label]) => <option key={id} value={id}>{label}</option>)}{Object.entries(endings).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label>说明<textarea name="reason" rows={3} maxLength={2000} required={status === 'blocked' || status in endings} /></label><p className="cc-note">完成或结束跟踪不会替代执行退出。明确设置为进行中时，已有负责人且无执行或待投递项的任务会重新排队。</p></>}
        {choice.kind === 'handoff' && <><label>新负责人<select name="targetMemberId" required defaultValue=""><option value="" disabled>选择会话成员</option>{members.filter(m => m.enabled && m.id !== choice.task?.ownerMemberId && detail.conversation.memberIds.includes(m.id)).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label>交接说明<textarea name="reason" required rows={3} maxLength={2000} /></label>{choice.task?.executionRef && <label className="cc-task-stop"><input type="checkbox" name="stopCurrent" />请求停止旧执行后转交</label>}<p className="cc-note">旧执行真实释放后变更负责人，并由新成员排队执行。普通协助请在聊天中 @成员。</p></>}
        {choice.kind === 'cancel-handoff' && <p className="cc-note">撤回本次未应用交接，保留原负责人。已发出的停止请求不会撤销，执行仍需真实退出证据。</p>}
        {error && <p className="cc-task-error" role="alert">{error}</p>}
        {conflict && choice.task && <button type="button" onClick={() => { const latest = detail.tasks?.find(t => t.id === choice.task?.id); if (latest) { setChoice({ ...choice, task: latest }); setConflict(false); setError('已读取最新版本，请核对后再次提交。'); } }}>读取最新版本</button>}
        <button type="submit" disabled={busy || conflict}>{busy ? '保存中…' : choice.kind === 'cancel-handoff' ? '确认撤销交接' : '保存'}</button>
      </form>
    </dialog>}
  </section>;
}
