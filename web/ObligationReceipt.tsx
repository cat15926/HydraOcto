import { useRef, useState } from 'react';
import type { ConversationDetail, Member } from '../shared/collaboration';
import type { Obligation } from '../shared/obligations';
import type { WorkbenchCommand } from './WorkbenchPanel';

const labels:Record<Obligation['state'],string> = {open:'处理中',delegated:'等待同伴回报',waiting:'等待外部结果',
  delivery_pending:'正在交付',awaiting_acceptance:'等你验收',delivered:'已交付',blocked:'需要处理',cancelled:'已取消'};
type Props = {item:Obligation; rows:Obligation[]; detail:ConversationDetail; members:Member[]; command:WorkbenchCommand; refresh:()=>Promise<void>};

export function ObligationReceipt({item,rows,detail,members,command,refresh}:Props) {
  const [action,setAction]=useState<''|'signal'|'cancel'>(''),[note,setNote]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const trigger=useRef<HTMLElement>(null), pending=useRef<{signature:string;requestId:string}|null>(null);
  const name=(id:string)=>members.find(m=>m.id===id)?.name??id;
  const children=rows.filter(o=>o.parentId===item.id);
  const current=[...children].reverse().find(c=>!['delivered','cancelled'].includes(c.state));
  const restore=()=>requestAnimationFrame(()=>trigger.current?.focus({preventScroll:true}));
  const reset=()=>{setAction('');setError('');setNote('');pending.current=null;restore();};
  async function submit(op:'signal'|'accept'|'cancel'|'retry'){
    if(busy)return;
    const fields=op==='signal'?{condition:item.wait?.condition,waitId:item.wait?.id,summary:note.trim()}:op==='cancel'&&note.trim()?{reason:note.trim()}:{};
    const signature=JSON.stringify([op,item.id,item.revision,fields]); if(pending.current?.signature!==signature)pending.current={signature,requestId:crypto.randomUUID()};
    setBusy(true);setError('');
    try { await command('/api/conversations/'+item.conversationId+'/obligations/'+item.id+'/'+op,{...fields,expectedRevision:item.revision,requestId:pending.current.requestId}); await refresh();reset();}
    catch(e){setError((e as Error).message);await refresh().catch(()=>{});} finally{setBusy(false);}
  }
  const editable=!detail.conversation.archivedAt&&!detail.conversation.deletedAt;
  return <details className="cc-obligation"><summary ref={trigger}><strong>{name(item.owner.memberId)} 负责</strong><span> · {item.state==='delegated'&&current?'等待 '+name(current.owner.memberId)+' 回报':labels[item.state]}</span></summary>
    <div className="cc-obligation-body"><p>{item.goal}</p><small>交付条件：{item.acceptance}</small>
      {item.userAcceptance&&<small>你在原消息中要求：「{item.userAcceptance.quote}」</small>}
      {children.map(child=><div className="cc-obligation-child" key={child.id}><strong>{name(child.owner.memberId)} · {child.report?{passed:'验证通过',failed:'验证未通过',blocked:'验证受阻'}[child.report.outcome]:labels[child.state]}</strong>
        <p>{child.report?.summary??child.acceptance}</p>{child.version&&<small title={child.version}>验证版本：{child.version}</small>}
        {child.report && <small>{child.report.authority==='project_test'?'项目测试回执':'成员回报'}{child.report.evidenceIds.length?' · '+child.report.evidenceIds.length+' 条证据':''}</small>}
        {child.report?.invocationId && <a href={'#message-'+(detail.messages.find(m=>m.responseId===detail.invocations.find(i=>i.id===child.report?.invocationId)?.responseId)?.id??'')}
          hidden={!detail.messages.some(m=>m.responseId&&m.responseId===detail.invocations.find(i=>i.id===child.report?.invocationId)?.responseId)}>查看验证回复</a>}</div>)}
      {item.wait&&<small>等待：{item.wait.condition} · 截至 {new Date(item.wait.deadline).toLocaleString()}</small>}
      {item.reason&&<p>{item.reason}</p>}{item.delivery?.messageId&&<a href={'#message-'+item.delivery.messageId}>查看最终答复</a>}
      {editable&&!['delivered','cancelled'].includes(item.state)&&<div className="cc-obligation-actions">
        {!action&&<>{item.state==='blocked'&&<button disabled={busy} onClick={()=>void submit('retry')}>请负责人复核</button>}{item.state==='awaiting_acceptance'&&<button disabled={busy} onClick={()=>void submit('accept')}>确认验收</button>}
          {item.state==='waiting'&&!item.wait?.condition.startsWith('ci:')&&<button onClick={()=>setAction('signal')}>补充实际结果</button>}
          <button onClick={()=>setAction('cancel')}>取消跟进…</button></>}
        {action&&<form onSubmit={e=>{e.preventDefault();void submit(action);}}><label>{action==='signal'?'你观察到了什么结果？':'取消后将停止跟进，可填写原因'}
          <textarea autoFocus value={note} maxLength={action==='signal'?2000:1000} onChange={e=>setNote(e.target.value)} required={action==='signal'}/></label>
          <button disabled={busy||(action==='signal'&&!note.trim())}>{action==='signal'?'提交观察结果':'确认取消'}</button>
          <button type="button" disabled={busy} onClick={reset}>返回</button></form>}</div>}
      {error&&<p role="alert">{error}</p>}
    </div></details>;
}
