import { useEffect, useState } from 'react';

interface PublicConversation {
  conversation:{id:string;title:string};
  messages:{id:string;author:string;memberId?:string;content:string;createdAt:string}[];
}
export default function ObserverPage({room}:{room:string}) {
  const [data,setData]=useState<PublicConversation>(), [error,setError]=useState(''), [epoch,setEpoch]=useState(0);
  useEffect(()=>{
    const ab=new AbortController();
    let timer:ReturnType<typeof setTimeout>|undefined;
    async function poll(){
      try{
        const response=await fetch('/api/conversations/'+encodeURIComponent(room)+'/observer',{signal:ab.signal,cache:'no-store'});
        if(!response.ok)throw Error(response.status===404?'找不到这个会话。':'无法读取公开消息。');
        const next=await response.json() as PublicConversation;
        if(!ab.signal.aborted){setData(next);setError('');}
      }catch(e){if(!ab.signal.aborted)setError((e as Error).message);}
      finally{if(!ab.signal.aborted)timer=setTimeout(poll,3500);}
    }
    void poll();return ()=>{ab.abort();clearTimeout(timer);};
  },[room,epoch]);
  return <main className="cc-observer"><header><small>公开旁观</small><h1>{data?.conversation.title||'会话'}</h1></header>
    {error&&<p role="alert">{error} <button onClick={()=>setEpoch(v=>v+1)}>重新读取</button></p>}
    {!data&&!error&&<p role="status">正在读取公开消息…</p>}
    {data&&(!data.messages.length?<p>暂无公开消息。</p>:<ol>{data.messages.map(m=><li key={m.id}>
      <div><strong>{m.memberId??(m.author==='user'?'用户':'协作记录')}</strong> <time dateTime={m.createdAt}>{new Date(m.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time></div><p>{m.content}</p>
    </li>)}</ol>)}
  </main>;
}
