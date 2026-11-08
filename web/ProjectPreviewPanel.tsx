import { useEffect, useRef, useState } from 'react';
import type { Conversation } from '../shared/collaboration';
import type { ProjectPreviewState } from '../shared/project-preview';
import type { WorkbenchCommand } from './WorkbenchPanel';
import './project-preview.css';

export function ProjectPreviewPanel({conversation,visible,command,selectProject}:{
  conversation:Conversation;visible:boolean;command:WorkbenchCommand;selectProject:()=>void;
}) {
  const base='/api/conversations/'+encodeURIComponent(conversation.id)+'/project-preview';
  const [state,setState]=useState<ProjectPreviewState>();
  const [showLogs,setShowLogs]=useState(false),[expanded,setExpanded]=useState(true);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const revision=useRef(0), pending=useRef(false);
  const primary=useRef<HTMLButtonElement>(null);
  const grant=conversation.workspaceGrant;
  useEffect(()=>{ if(state?.status==='failed') setShowLogs(true); },[state?.status]);
  useEffect(()=>{
    if(!visible) return;
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    async function poll() {
      const current=revision.current;
      try {
        const res=await fetch(base,{signal:controller.signal,cache:'no-store'});
        if(!res.ok) throw new Error('无法取得预览状态。');
        const next:ProjectPreviewState=await res.json();
        if(!controller.signal.aborted && !pending.current && current===revision.current) setState(next);
      } catch(e) { if(!controller.signal.aborted) setError((e as Error).message); }
      finally { if(!controller.signal.aborted) timer=setTimeout(poll,1250); }
    }
    void poll();
    return ()=>{ controller.abort(); clearTimeout(timer); };
  },[visible,base,grant?.revision]);
  async function change(action:'start'|'stop') {
    if(pending.current || !state) return;
    revision.current++; pending.current=true; setBusy(true); setError('');
    try {
      const result=await command<ProjectPreviewState>(base+'/'+action, action==='start'
        ? {grantRevision:grant?.revision,previousId:state.id ?? null} : {id:state.id});
      setState(result); setExpanded(true);
      if(result.status==='failed') setShowLogs(true);
      requestAnimationFrame(()=>primary.current?.focus({preventScroll:true}));
    } catch(e) { setError((e as Error).message); }
    finally { pending.current=false; setBusy(false); }
  }
  if(!grant) return <section className="cc-site-preview"><p>选择一个包含网页的项目文件夹，即可在这里预览。</p><button onClick={selectProject}>选择项目文件夹</button></section>;
  const running=state?.status==='running', starting=state?.status==='starting';
  const disabled=busy || !state || starting || !!conversation.archivedAt || !!conversation.deletedAt;
  const labels={idle:'未启动',running:'运行中',starting:'正在启动',stopped:'已停止',failed:'启动失败'};
  return <section className="cc-site-preview" aria-label="项目页面与日志">
    <div className="cc-site-heading"><strong>{grant.path.split('/').filter(Boolean).at(-1)}</strong><span role="status">{state?labels[state.status]:'读取中…'}</span></div>
    {state?.entry && <code>{state.entry}</code>}
    {(!state || state.status==='idle') && <p>预览项目中的静态网页。支持项目根目录及 dist、build、public 中的 index.html。</p>}
    <div className="cc-site-actions">
      {running ? <button ref={primary} onClick={()=>setExpanded(v=>!v)} aria-expanded={expanded}>{expanded?'收起预览':'打开预览'}</button> :
        <button ref={primary} disabled={disabled} onClick={()=>void change('start')}>{!state || state.status==='idle'?'启动预览':starting?'正在启动…':'重新启动预览'}</button>}
      {!!state?.logs.length && <button onClick={()=>setShowLogs(v=>!v)} aria-expanded={showLogs}>{showLogs?'收起日志':'查看日志'}</button>}
      {(running || starting) && <button disabled={busy} onClick={()=>void change('stop')}>{starting?'取消启动':'停止预览'}</button>}
    </div>
    {error && <p role="alert">{error}</p>}
    {running && expanded && visible && <iframe key={state.id} title="项目预览" sandbox="allow-same-origin allow-scripts" referrerPolicy="no-referrer" src={state.url} />}
    {showLogs && !!state?.logs.length && <ol aria-label="预览日志">{state.logs.map((item,i)=><li key={i}><time>{new Date(item.time).toLocaleTimeString()}</time> {item.message}</li>)}</ol>}
  </section>;
}
