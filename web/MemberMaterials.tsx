import { useEffect, useRef, useState } from 'react';
import type { FactorView } from '../shared/factors';
import type { WorkbenchCommand } from './WorkbenchPanel';

interface Props {
  cid: string;
  memberId: string;
  name: string;
  active: boolean;
  editable: boolean;
  latestMessage?: string;
  command: WorkbenchCommand;
}

function StatementInvitation({cid, memberId, name, command}:Pick<Props,'cid'|'memberId'|'name'|'command'>) {
  const [confirming,setConfirming]=useState(false), [sending,setSending]=useState(false);
  const [sent,setSent]=useState(false), [error,setError]=useState('');
  const button=useRef<HTMLButtonElement>(null), submit=useRef<HTMLButtonElement>(null);
  const requestId=useRef(''), pending=useRef(false);
  useEffect(()=>{if(confirming)submit.current?.focus();},[confirming]);
  function close(){
    setConfirming(false);setError('');
    requestAnimationFrame(()=>button.current?.focus());
  }
  async function invite(){
    if(pending.current)return;
    pending.current=true;setSending(true);setError('');
    requestId.current ||= crypto.randomUUID();
    try {
      await command('/api/conversations/'+encodeURIComponent(cid)+'/messages',{
        requestId:requestId.current,publicStatementFor:memberId,content:'请根据获准资料发表你的观点。',
      });
      requestId.current='';setSent(true);close();
    }catch(e){setError((e as Error).message);}
    finally{pending.current=false;setSending(false);}
  }
  return <div className="cc-material-invitation">
    {confirming ? <>
      <p>邀请{name}使用本房间获准公开的观点发言？所有旁观者都能看到邀请和回复。</p>
      <button ref={submit} type="button" disabled={sending} onClick={()=>void invite()}>{sending?'正在发送…':'发送邀请'}</button>
      <button type="button" disabled={sending} onClick={close}>取消邀请</button>
      {error&&<p role="alert">{error}</p>}
    </> : <>
      <button ref={button} type="button" className="cc-knowledge-link" onClick={()=>setConfirming(true)}>{sent?'再次邀请公开发言':'请此成员公开发言'}</button>
      {sent&&<p role="status">已邀请{name}，可在会话中查看回复。</p>}
    </>}
  </div>;
}

export function MemberMaterials({cid, memberId, name, active, editable, latestMessage, command}:Props) {
  const [rows,setRows]=useState<FactorView[]>([]), [open,setOpen]=useState(false);
  const [content,setContent]=useState(''), [expression,setExpression]=useState('');
  const [decide,setDecide]=useState(false), [optionText,setOptionText]=useState('');
  const options=optionText.split('\n').map(text=>text.trim()).filter(Boolean);
  const optionsValid=options.length>=2 && options.length<=8 && options.every(text=>text.length<=1000) && new Set(options).size===options.length;
  const [revoking,setRevoking]=useState(''), [busy,setBusy]=useState(false), [error,setError]=useState(''), [status,setStatus]=useState('');
  const [epoch,setEpoch]=useState(0);
  const add=useRef<HTMLButtonElement>(null), first=useRef<HTMLTextAreaElement>(null);
  const request=useRef({payload:'',id:''});
  const base='/api/conversations/'+encodeURIComponent(cid)+'/factors';
  useEffect(()=>{
    if (!active) return;
    const ab=new AbortController();
    setError('');
    void fetch(base+'?issuedTo='+encodeURIComponent(memberId),{cache:'no-store',signal:ab.signal})
      .then(async r=>{const value=await r.json();if(!r.ok)throw Error(value.error||'读取资料失败');return value;})
      .then(value=>{if(!ab.signal.aborted)setRows(Array.isArray(value)?value:value.factors);})
      .catch(e=>{if(!ab.signal.aborted)setError(e.message);});
    return ()=>ab.abort();
  },[base,memberId,active,epoch,latestMessage]);
  useEffect(()=>{if(open && active)first.current?.focus();},[open,active]);
  function close(){
    setOpen(false);setContent('');setExpression('');setDecide(false);setOptionText('');setError('');request.current={payload:'',id:''};
    requestAnimationFrame(()=>add.current?.focus());
  }
  async function apply(revoke?:string){
    if(busy||!active||!editable||(!revoke && (!content.trim() || (decide && !optionsValid))))return;
    const body=revoke?{factorId:revoke}:{memberId,content:content.trim(),...(decide?{expressionOptions:options}:expression.trim()?{publicExpression:expression.trim()}:{})};
    const payload=JSON.stringify(body);
    if(request.current.payload!==payload)request.current={payload,id:crypto.randomUUID()};
    setBusy(true);setError('');setStatus('');
    try {
      await command(base+(revoke?'/revoke':'/issue'),{...body,requestId:request.current.id});
      if(!revoke)close();else {setRevoking('');requestAnimationFrame(()=>add.current?.focus());}
      setStatus(revoke?'这份资料已撤回。':'已提供给'+name+'。');setEpoch(v=>v+1);
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  return <section className="cc-member-materials" hidden={!active} aria-label={name+'的个人资料'}>
    <div className="cc-knowledge-results-heading"><strong>给{name}的个人资料</strong>{editable&&<button type="button" ref={add} className="cc-knowledge-link" disabled={open||busy} onClick={()=>{setStatus('');setRevoking('');setOpen(true);}}>提供资料</button>}</div>
    {open&&editable&&<form className="cc-knowledge-form" onSubmit={e=>{e.preventDefault();void apply();}}>
      <label>私密原文<textarea ref={first} value={content} maxLength={4000} required onChange={e=>setContent(e.target.value)} /></label>
      <label>公开表达方式<select value={decide?'choice':'direct'} onChange={e=>setDecide(e.target.value==='choice')}><option value="direct">指定允许公开的内容</option><option value="choice">由成员判断</option></select></label>
      {decide ? <label>可选观点（每行一项）<textarea rows={3} value={optionText} maxLength={8100} required onChange={e=>setOptionText(e.target.value)} /><small>提供 2–8 个不同的观点，每项最多 1000 字。成员结合私密原文选择其中一项。</small></label> :
        <label>允许公开表达的内容（可选）<textarea value={expression} maxLength={1000} onChange={e=>setExpression(e.target.value)}/></label>}
      <p className="cc-note">保存后，{name}可以在本房间的私聊中读取原文。邀请其公开发言时，成员只会收到获准公开的观点。</p>
      <div><button className="cc-knowledge-primary" disabled={!content.trim()||busy||(decide&&!optionsValid)}>保存资料</button> <button type="button" disabled={busy} onClick={close}>取消</button></div>
    </form>}
    {rows.filter(f=>f.kind==='observation').map(f=><article key={f.id} className="cc-view-message">
      <p>{f.content}</p>
      {f.expressionOptions && <details><summary>可选观点 · {f.expressionOptions.length}</summary><ul>{f.expressionOptions.map(option=><li key={option}>{option}</li>)}</ul></details>}
      {rows.filter(e=>e.kind==='expression'&&e.parentIds.includes(f.id)).map(e=><p key={e.id}><small>允许公开表达</small><br/>{e.content}</p>)}
      {editable&&(revoking===f.id?<div>撤回后，这份资料不能用于后续工作。<div><button disabled={busy} onClick={()=>void apply(f.id)}>确认撤回</button> <button disabled={busy} onClick={()=>{setRevoking('');requestAnimationFrame(()=>document.getElementById('revoke-'+f.id)?.focus());}}>保留资料</button></div></div>:
        <button id={'revoke-'+f.id} className="cc-knowledge-link" disabled={busy} onClick={()=>{setStatus('');setError('');setRevoking(f.id);}}>撤回资料</button>)}
    </article>)}
    {editable&&rows.some(f=>f.kind==='expression')&&<StatementInvitation cid={cid} memberId={memberId} name={name} command={command}/>}
    {status&&<p role="status">{status}</p>}
    {error&&<p role="alert">{error} {!open&&!revoking&&<button onClick={()=>setEpoch(v=>v+1)}>重新读取</button>}</p>}
  </section>;
}
