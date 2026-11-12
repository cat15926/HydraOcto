import { VersionPackageReceipt } from './VersionPackageReceipt';
import { useEffect, useRef, useState } from 'react';
import type { ConversationDetail, Member, MentionGroup } from '../shared/collaboration';
import type { Obligation, OperatorObligation } from '../shared/obligations';
import { OpinionRoundReceipt, opinionProgress } from './OpinionRoundReceipt';
import type { WorkbenchCommand } from './WorkbenchPanel';

const labels:Record<Obligation['state'],string> = {open:'处理中',delegated:'等待同伴回报',waiting:'等待外部结果',
  delivery_pending:'正在交付',awaiting_acceptance:'等你验收',delivered:'已交付',blocked:'需要处理',cancelled:'已取消'};
type Operation = 'signal'|'cancel'|'retry'|'reassign'|'accept'|'approve-external';
type Form = Exclude<Operation,'accept'|'approve-external'>;
type Request = {op:Operation; fields:Record<string,unknown>};
type Props = {onMessage?:(id:string)=>void; item:OperatorObligation; rows:Obligation[]; detail:ConversationDetail; members:Member[]; command:WorkbenchCommand; refresh:()=>Promise<void>};

function GroupResults({group, name}: {group:MentionGroup; name:(id:string)=>string}) {
  const results = group.results ?? [];
  const received = new Set(results.map(result => result.memberId));
  const missing = group.targets.filter(memberId => !received.has(memberId));
  const status = { collecting:'征询中', done:'已收齐', timeout:'已到截止时间', cancelled:'已取消', lost:'征询受阻' }[group.state];
  return <details className="cc-obligation-group" open={group.state === 'collecting' || undefined}>
    <summary>{group.question} · {status} · {results.length}/{group.targets.length}</summary>
    {missing.length > 0 && <p>{group.state === 'collecting' ? '等待' : '缺少'}{missing.map(name).join('、')}的答复</p>}
    {group.reason && <p>{group.reason}</p>}
    {results.map(result => <p key={result.memberId}><strong>{name(result.memberId)} · {result.status === 'failed' ? '执行失败' : '已答复'}</strong><br/>{result.content}</p>)}
    {group.state === 'collecting' && group.contract && <small>收齐后由{name(group.contract.returnTo.memberId)}继续 · 截至 {new Date(group.deadline).toLocaleString()}</small>}
  </details>;
}

export function ObligationReceipt({item,rows,detail,members,command,refresh,onMessage}:Props) {
  const [action,setAction] = useState<Form>(), [note,setNote] = useState(''), [target,setTarget] = useState('');
  const [externalChoice,setExternalChoice]=useState('');
  const externalTargets=item.externalOperation?.stage==='approval'?detail.sources.find(s=>s.id===item.originSourceId)?.externalScope?.targets:[];
  const chosenTarget=externalTargets?.find(t=>t.id===externalChoice)?.id || item.externalOperation?.target.id;
  const [error,setError] = useState(''), [busy,setBusy] = useState(false), [pending,setPending] = useState<Request>();
  const trigger = useRef<HTMLElement>(null), formRevision = useRef(item.revision), sending = useRef(false);
  const retryButton = useRef<HTMLButtonElement>(null);
  useEffect(()=>{ if (pending && !busy) retryButton.current?.focus({preventScroll:true}); },[pending,busy]);
  const name=(id:string)=>members.find(m=>m.id===id)?.name??id;
  const children=rows.filter(o=>o.parentId===item.id);
  const current=[...children].reverse().find(c=>!['delivered','cancelled'].includes(c.state));
  const groups = (detail.groups ?? []).filter(group => group.contract?.obligationId === item.id);
  const active = groups.find(group => group.id === item.activeGroupId && group.state === 'collecting');
  const rounds = (detail.opinionRounds ?? []).filter(round => round.obligationId === item.id);
  const openRound = rounds.find(round => ['collecting','ready'].includes(round.state));
  const timer = item.wait?.kind === 'timer';
  function progressLabel() {
    if (openRound && !['blocked','cancelled','delivered'].includes(item.state)) return opinionProgress(openRound);
    if (active) return `等待成员答复 · ${active.results?.length ?? 0}/${active.targets.length}`;
    if (item.externalOperation?.stage==='approval' && item.state==='waiting') return '等你授权 · '+item.externalOperation.target.title;
    if (item.externalOperation?.stage==='unknown' && item.state!=='cancelled') return '外部结果待核查';
    if (item.state === 'waiting' && timer) return '等待约定时间';
    if (item.state === 'delegated' && current) return '等待 ' + name(current.owner.memberId) + ' 回报';
    return labels[item.state];
  }
  const restore=()=>requestAnimationFrame(()=>trigger.current?.focus({preventScroll:true}));
  function reset() {
    setAction(undefined); setNote(''); setTarget(''); setError(''); setPending(undefined); restore();
  }
  function begin(form:Form) {
    formRevision.current = item.revision;
    setError(''); setNote(''); setTarget(''); setAction(form);
  }
  const recovery = item.recovery;
  const selectedTarget = recovery?.handoffTargets.find(e => e.instanceId === target);
  const changed = !!action && item.revision !== formRevision.current;
  const editable = !detail.conversation.archivedAt && !detail.conversation.deletedAt && !detail.conversation.importedFor;
  const activeItem = !['delivered','cancelled'].includes(item.state);
  const prompt = action === 'signal' ? '你观察到了什么结果？' : action === 'retry' ? '要请负责人核对哪些材料？'
    : action === 'reassign' ? '告诉接手成员需要继续处理什么' : '取消后将停止跟进，可填写原因';
  async function submit(op:Operation) {
    if (sending.current || (changed && !pending)) return;
    const fields:Record<string,unknown> = {requestId:crypto.randomUUID(),expectedRevision:action ? formRevision.current : item.revision};
    if (op === 'approve-external') Object.assign(fields,{operationId:item.externalOperation?.id,targetId:chosenTarget});
    if (op === 'signal') Object.assign(fields,{condition:item.wait?.condition,waitId:item.wait?.id,summary:note.trim()});
    else if (note.trim()) fields.reason = note.trim();
    if (op === 'reassign' && selectedTarget) Object.assign(fields,selectedTarget,{taskRevision:recovery?.taskRevision});
    const request = pending ?? {op,fields};
    sending.current = true; setBusy(true); setError('');
    try {
      await command('/api/conversations/'+item.conversationId+'/obligations/'+item.id+'/'+request.op,request.fields);
      await refresh(); reset();
    } catch(e) {
      const status = (e as {status?:number}).status;
      // A missing receipt may follow an actual commit. Replay the exact original command.
      setPending(status && status >= 400 && status < 500 && status !== 408 ? undefined : request);
      setError((e as Error).message); await refresh().catch(()=>{});
    } finally { sending.current = false; setBusy(false); }
  }
  return <details className="cc-obligation"><summary ref={trigger}><strong>{name(item.owner.memberId)} 负责</strong><span> · {progressLabel()}</span></summary>
    <div className="cc-obligation-body"><p>{item.goal}</p><small>交付条件：{item.acceptance}</small>
      {item.externalOperation && <div className="cc-obligation-child"><strong>{item.externalOperation.target.title}</strong>
        <p>{{approval:'等待你确认，授权范围为本对象的一次写入。',approved:'已授权一次写入。',unknown:'尚未取得外部回执。核查将读取原记录。',recorded:'已取得外部回执。'}[item.externalOperation.stage]}</p>
        <small>原操作编号：{item.externalOperation.id}</small>{item.externalOperation.receipt&&<small>回执：{item.externalOperation.receipt}</small>}</div>}
      {item.userAcceptance&&<small>你在原消息中要求：「{item.userAcceptance.quote}」</small>}
      {groups.map(group => <GroupResults key={group.id} group={group} name={name} />)}
      {detail.versionPackages?.filter(bundle => bundle.obligationId === item.id).map(bundle => <VersionPackageReceipt key={bundle.id} bundle={bundle} conversationId={detail.conversation.id} command={command} refresh={refresh} />)}
      {rounds.map(round => <OpinionRoundReceipt key={round.id} round={round} name={name} onMessage={onMessage} />)}
      {children.map(child=><div className="cc-obligation-child" key={child.id}><strong>{name(child.owner.memberId)} · {child.report?{passed:'验证通过',failed:'验证未通过',blocked:'验证受阻'}[child.report.outcome]:labels[child.state]}</strong>
        <p>{child.report?.summary??child.acceptance}</p>{child.version&&<small title={child.version}>验证版本：{child.version}</small>}
        {child.report && <small>{child.report.authority==='project_test'?'项目测试回执':'成员回报'}{child.report.evidenceIds.length?' · '+child.report.evidenceIds.length+' 条证据':''}</small>}
        {child.report?.invocationId && <a href={'#message-'+(detail.messages.find(m=>m.responseId===detail.invocations.find(i=>i.id===child.report?.invocationId)?.responseId)?.id??'')}
          hidden={!detail.messages.some(m=>m.responseId&&m.responseId===detail.invocations.find(i=>i.id===child.report?.invocationId)?.responseId)}>查看验证回复</a>}</div>)}
      {item.wait && <small>{item.wait.condition} · {timer
        ? `${new Date(item.wait.deadline).toLocaleString()} ${item.wait.firedAt ? '已安排' : '提醒'} ${name(item.owner.memberId)} 接回`
        : `截至 ${new Date(item.wait.deadline).toLocaleString()}`}</small>}
      {item.reason&&<p>{item.reason}</p>}{item.delivery?.messageId&&<a href={'#message-'+item.delivery.messageId}>查看最终答复</a>}
      {editable && (activeItem || pending || action) && <div className="cc-obligation-actions">
        {pending ? <><p>尚未收到操作回执。重试将核对同一次操作。</p>
          <button ref={retryButton} disabled={busy} onClick={()=>void submit(pending.op)}>重试上次操作</button></> :
          !action ? <>
            {item.state==='waiting' && item.externalOperation?.stage==='approval' && externalTargets && externalTargets.length>1 &&
              <label>本次授权对象<select value={chosenTarget} disabled={busy} onChange={e=>setExternalChoice(e.target.value)}>
                {externalTargets.map(t=><option key={t.id} value={t.id}>{t.title}</option>)}</select></label>}
            {item.state==='waiting' && item.externalOperation?.stage==='approval' && <button disabled={busy} onClick={()=>void submit('approve-external')}>授权此次操作</button>}
            {item.state==='blocked' && recovery?.retryUnavailable && <small>{recovery.retryUnavailable}</small>}
            {item.state==='blocked' && recovery && !recovery.retryUnavailable && <>
              <button disabled={busy} onClick={()=>void submit('retry')}>{item.externalOperation?.stage==='unknown'?'查询原操作':'请负责人复核'}</button>
              <button disabled={busy} onClick={()=>begin('retry')}>补充材料并复核…</button></>}
            {!!recovery?.handoffTargets.length && <button disabled={busy} onClick={()=>begin('reassign')}>改派负责人…</button>}
            {item.state==='awaiting_acceptance' && <button disabled={busy} onClick={()=>void submit('accept')}>确认验收</button>}
            {item.state==='waiting'&&item.wait&&!timer&&!item.wait.condition.startsWith('ci:')&&<button disabled={busy} onClick={()=>begin('signal')}>补充实际结果</button>}
            {activeItem && <button disabled={busy} onClick={()=>begin('cancel')}>取消跟进…</button>}</> : null}
        {action && <form onSubmit={e=>{e.preventDefault();if (!pending) void submit(action);}} onKeyDown={e=>{
          if (e.key==='Escape' && !busy && !pending) {e.preventDefault();reset();}
        }}>
          {action==='reassign' && <label>接手成员<select autoFocus disabled={busy||!!pending} value={target} onChange={e=>setTarget(e.target.value)} required>
            <option value="">选择一位房间成员</option>
            {recovery?.handoffTargets.map(m=><option key={m.instanceId} value={m.instanceId}>{name(m.memberId)}</option>)}</select></label>}
          <label>{prompt}<textarea autoFocus={action!=='reassign'} readOnly={busy||!!pending} value={note} maxLength={action==='signal'?2000:1000}
            onChange={e=>setNote(e.target.value)} required={action!=='cancel'}/></label>
          {(action==='retry'||action==='reassign') && <small>说明将提供给接手的成员，并保存在本次公开委托中。</small>}
          {changed && !pending && <p role="status">委托已更新，请返回核对最新进度。</p>}
          {!pending && <><button disabled={busy||changed||(action!=='cancel'&&!note.trim())||(action==='reassign'&&!selectedTarget)}>
            {{signal:'提交观察结果',cancel:'确认取消',retry:'提交材料并复核',reassign:'确认改派'}[action]}</button>
            <button type="button" disabled={busy} onClick={reset}>返回</button></>}
        </form>}
      </div>}
      {error&&<p role="alert">{error}</p>}
    </div></details>;
}
