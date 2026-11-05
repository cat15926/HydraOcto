import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ArtifactApproval, ArtifactVersion, ConversationDetail, ManagedArtifact, Member, RuntimeInteraction } from '../shared/collaboration';
type Props = { detail: ConversationDetail; members: Member[]; command: (path: string, body: unknown) => Promise<unknown>; refresh: () => Promise<void> };
type Choice = { kind: 'propose'; artifact?: ManagedArtifact } | { kind: 'inspect'; version: ArtifactVersion; approval?: ArtifactApproval } | { kind: 'review'; version: ArtifactVersion } | { kind: 'answer'; interaction: RuntimeInteraction };
const stateNames: Record<string, string> = { proposed: '待审批', published: '已发布', rejected: '已拒绝', expired: '已过期', stale: '已失效', cancelled: '已取消', unknown: '结果未知', pending: '等待处理', approved: '已批准', running: '执行中', succeeded: '已完成', submitted: '已提交', answered: '已回答', declined: '已跳过', unsupported: '当前不支持' };

export function ArtifactPanel({ detail, members, command, refresh }: Props) {
  const [choice, setChoice] = useState<Choice>(), [content, setContent] = useState(''), [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [conflict, setConflict] = useState(false);
  const loadSequence = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null), pending = useRef<{ signature: string; body: Record<string, unknown> } | undefined>(undefined);
  useEffect(() => { if (choice) dialog.current?.showModal(); return () => dialog.current?.close(); }, [!!choice]);
  const name = (id: string) => members.find(m => m.id === id)?.name ?? id;
  async function open(c: Choice) {
    const sequence = ++loadSequence.current;
    pending.current = undefined; setChoice(c); setError(''); setConflict(false); setLoaded(false); setContent('');
    if (c.kind === 'inspect') {
      try { const r = await fetch(`/api/managed-artifacts/versions/${c.version.id}`); const data = await r.json() as { content?: string; error?: string }; if (!r.ok) throw new Error(data.error ?? '材料读取失败'); if (sequence === loadSequence.current) { setContent(data.content ?? ''); setLoaded(true); } } catch (e) { if (sequence === loadSequence.current) setError((e as Error).message); }
    }
  }
  async function act(path: string, fields: Record<string, unknown>) {
    if (busy) return;
    const signature = JSON.stringify({ path, fields });
    if (pending.current?.signature !== signature) pending.current = { signature, body: { ...fields, requestId: crypto.randomUUID() } };
    setBusy(true); setError('');
    try { await command(path, pending.current.body); pending.current = undefined; setChoice(undefined); setNotice('操作已保存；写入与评审结果分别展示。'); await refresh(); }
    catch (e) { const f = e as Error & { status?: number }; setError(f.message); if (f.status) pending.current = undefined; if (f.status === 409) { setConflict(true); await refresh().catch(() => undefined); } }
    finally { setBusy(false); }
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (!choice || conflict) return; const f = new FormData(e.currentTarget);
    if (choice.kind === 'propose') { const a = choice.artifact; void act(`/api/conversations/${detail.conversation.id}/managed-artifacts`, { name: a?.name ?? f.get('name'), content: f.get('content'), ...(a ? { artifactId: a.id, expectedRevision: a.revision, baseVersionId: a.headVersionId ?? null } : {}), ...(f.get('notifyMemberId') ? { notifyMemberId: f.get('notifyMemberId') } : {}) }); }
    if (choice.kind === 'review') void act(`/api/conversations/${detail.conversation.id}/artifact-reviews`, { versionId: choice.version.id, digest: choice.version.digest, reviewerMemberId: f.get('reviewerMemberId'), codeReview: f.get('codeReview') === 'on' });
    if (choice.kind === 'answer') { const i = choice.interaction; void act(`/api/runtime-interactions/${i.id}/answer`, { expectedRevision: i.revision, payloadDigest: i.payloadDigest, answers: Object.fromEntries(i.questions!.map(q => [q.id, f.get(`answer-${q.id}`)])) }); }
  }
  const approvals = detail.artifactApprovals ?? [], versions = detail.artifactVersions ?? [];
  return <section className="cc-monitor-section cc-artifact-panel" aria-label="产物与评审">
    <div className="cc-section-title"><h3>产物与评审 · {detail.artifacts?.length ?? 0}</h3><button onClick={() => { void open({ kind: 'propose' }); }}>提出产物</button></div>
    <p className="cc-note">审查准确版本后批准写入平台产物目录。评审结论不自动完成任务。</p>
    {notice && <p role="status">{notice}</p>}{!choice && error && <p role="alert">{error}</p>}
    {(detail.interactions ?? []).filter(i => i.state === 'pending').map(i => <div className="cc-interaction" key={i.id}><strong>{name(i.memberId)} 等待你的回答</strong><p>{i.questions?.map(q => q.question).join('；')}</p><button onClick={() => { void open({ kind: 'answer', interaction: i }); }}>回答问题</button><small>到期 {new Date(i.expiresAt).toLocaleTimeString()}</small></div>)}
    {(detail.artifacts ?? []).map(a => <details key={a.id} className="cc-task-card" data-artifact-id={a.id}><summary><strong>{a.name}</strong><span>{a.headVersionId ? '有已发布版本' : '尚未发布'}</span></summary><div className="cc-task-body">
      <button onClick={() => { void open({ kind: 'propose', artifact: a }); }}>提出新版本</button>
      {versions.filter(v => v.artifactId === a.id).reverse().map(v => {
        const approval = approvals.find(x => x.id === v.approvalId), job = detail.jobs?.find(j => j.id === v.jobId);
        return <div className="cc-artifact-version" key={v.id}><strong>v{v.number} · {stateNames[v.state]}{a.headVersionId === v.id ? ' · 当前版本' : ''}</strong><p>{v.bytes} 字节 · SHA-256 <code>{v.digest}</code></p><div className="cc-task-actions"><button onClick={() => { void open({ kind: 'inspect', version: v, approval }); }}>{approval?.state === 'pending' ? '审查并决定' : '查看材料'}</button>{v.state === 'published' && <a href={`/api/managed-artifacts/versions/${v.id}/download`}>下载</a>}{v.state === 'published' && a.headVersionId === v.id && <button onClick={() => { void open({ kind: 'review', version: v }); }}>请求评审</button>}</div>
          {approval && <p>审批：{stateNames[approval.state]}{approval.reason && ` · ${approval.reason}`}</p>}
          {job && <p>写入作业：{stateNames[job.state]}{job.reason && ` · ${job.reason}`}<small>作业 {job.id}</small>{job.state === 'unknown' && <button disabled={busy} onClick={() => { void act(`/api/managed-jobs/${job.id}/reconcile`, {}); }}>核查原文件</button>}</p>}
          {(detail.reviews ?? []).filter(r => r.versionId === v.id).map(r => <p key={r.id}>评审 · {name(r.reviewerMemberId)}：{r.verdict ? r.verdict === 'accept' ? '通过' : '需要修改' : stateNames[r.state]}{r.state === 'submitted' ? r.current ? '（当前有效）' : '（历史结论，当前无效）' : ''}<br />{r.comment}{r.headCommit && <small>代码 HEAD {r.headCommit}</small>}</p>)}
        </div>;
      })}</div></details>)}
    {!!detail.interactions?.some(i => i.state !== 'pending') && <details><summary>交互历史</summary>{detail.interactions.filter(i => i.state !== 'pending').map(i => <p key={i.id}>{name(i.memberId)} · {i.operation} · {stateNames[i.state]}<br />{i.reason}<small>{i.delivery === 'returned_to_adapter' ? '平台响应已返回适配器；原生接受另记' : '未确认交付'}</small></p>)}</details>}
    {choice && <dialog ref={dialog} className="cc-dialog cc-artifact-dialog" onCancel={e => { e.preventDefault(); if (!busy) setChoice(undefined); }} aria-labelledby="cc-artifact-title"><form onSubmit={submit}>
      <h2 id="cc-artifact-title">{choice.kind === 'propose' ? '提出产物版本' : choice.kind === 'review' ? '请求固定版本评审' : choice.kind === 'answer' ? '回答成员提问' : '审查准确材料'}</h2>
      {choice.kind === 'propose' && <><label>文件名<input name="name" required maxLength={120} defaultValue={choice.artifact?.name} readOnly={!!choice.artifact} placeholder="design.md" /></label><label>完整版本内容<textarea name="content" required rows={12} /></label><label>完成后通知<select name="notifyMemberId"><option value="">不通知，等待用户继续</option>{members.filter(m => m.enabled && detail.conversation.memberIds.includes(m.id)).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><p>仅提出版本，不直接写入。单版上限 32 KiB。</p></>}
      {choice.kind === 'inspect' && <><p>版本 {choice.version.id}<br />摘要 <code>{choice.version.digest}</code><br />此授权仅允许保存以下固定内容到平台产物目录。</p><pre className="cc-artifact-preview">{loaded ? content || '（空文件）' : '正在读取材料…'}</pre>{choice.approval?.state === 'pending' && <div className="cc-task-actions">{['approve', 'reject'].map(decision => <button key={decision} type="button" disabled={busy || conflict || !loaded} onClick={() => { const a = choice.approval!; void act(`/api/artifact-approvals/${a.id}/decide`, { expectedRevision: a.revision, operationDigest: a.operationDigest, decision }); }}>{decision === 'approve' ? '批准此版本写入' : '拒绝此版本'}</button>)}</div>}</>}
      {choice.kind === 'review' && <><p>只评审版本 {choice.version.id}。新版本会使此结论不再代表当前材料。</p><label>评审成员<select name="reviewerMemberId" required>{members.filter(m => m.enabled && detail.conversation.memberIds.includes(m.id) && !(choice.version.origin.actor.kind === 'agent' && m.id === choice.version.origin.actor.memberId)).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label><input type="checkbox" name="codeReview" />同时绑定当前干净的 Git HEAD</label></>}
      {choice.kind === 'answer' && <>{choice.interaction.questions?.map(q => <label key={q.id}>{q.question}<input name={`answer-${q.id}`} list={`options-${q.id}`} required maxLength={2000} /><datalist id={`options-${q.id}`}>{q.options?.map(o => <option key={o} value={o} />)}</datalist></label>)}<p>问题到期或执行结束后，答案不会用于其他执行。</p></>}
      {error && <p role="alert">{error}</p>}{conflict && <p>状态已变化。关闭后重新打开最新材料。</p>}
      <div className="cc-dialog-actions"><button type="button" disabled={busy} onClick={() => setChoice(undefined)}>关闭</button>{choice.kind !== 'inspect' && <button type="submit" disabled={busy || conflict}>{busy ? '提交中…' : choice.kind === 'answer' ? '提交答案' : '提交'}</button>}</div>
    </form></dialog>}
  </section>;
}
