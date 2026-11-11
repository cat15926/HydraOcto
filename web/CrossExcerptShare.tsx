import { useRef, useState, type FormEvent } from 'react';
import type { Conversation, ConversationMessage, Member, MessageExcerpt } from '../shared/collaboration';
import type { WorkbenchCommand } from './WorkbenchPanel';
export async function refFor(m: ConversationMessage, start: number, end: number): Promise<MessageExcerpt> { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(m.content)); return { messageId: m.id, revision: m.revision ?? 1, start, end, digest: Array.from(new Uint8Array(bytes)).map(x => x.toString(16).padStart(2, '0')).join('') }; }
type Props = {message:ConversationMessage; room:Conversation; rooms:Conversation[]; members:Member[]; command:WorkbenchCommand};
export function CrossExcerptShare({message,room,rooms,members,command}:Props) {
  const modal=useRef<HTMLDialogElement>(null), trigger=useRef<HTMLButtonElement>(null);
  const [target,setTarget]=useState(''), [recipient,setRecipient]=useState(''), [range,setRange]=useState([0,0] as [number,number]);
  const [busy,setBusy]=useState(false), [error,setError]=useState(''), [notice,setNotice]=useState('');
  const last=useRef<{body:string;key:string} | undefined>(undefined);
  const targets=rooms.filter(r=>r.id!==room.id && !r.archivedAt && !r.deletedAt && members.some(m=>m.enabled && !m.deletedAt && r.memberIds.includes(m.id)));
  const selected=targets.find(r=>r.id===target);
  const people=(r?:Conversation)=>members.filter(m=>m.enabled && !m.deletedAt && r?.memberIds.includes(m.id));
  const sender=people(room).find(m=>m.id===message.memberId) ?? people(room).find(m=>m.id===room.defaultMemberId) ?? people(room)[0];
  const chosen=people(selected).find(m=>m.id===recipient);
  function destination(id:string) {
    setTarget(id); const r=targets.find(r=>r.id===id), eligible=people(r);
    setRecipient(eligible.find(m=>m.id===r?.defaultMemberId)?.id ?? eligible[0]?.id ?? ''); setError('');
  }
  function open(){
    destination(targets.length===1 ? targets[0]!.id : ''); setRange([0,0]);setError('');setNotice('');last.current=undefined;modal.current?.showModal();
  }
  async function submit(e:FormEvent) {
    e.preventDefault(); if(busy || !sender || !chosen || !selected || range[1]<=range[0])return;
    setBusy(true);setError('');
    try {
      const body={homeMemberId:sender.id,targetConversationId:selected.id,targetMemberId:chosen.id,refs:[await refFor(message,...range)]};
      const serialized=JSON.stringify(body); if(last.current?.body!==serialized)last.current={body:serialized,key:crypto.randomUUID()};
      await command(`/api/conversations/${room.id}/share-excerpts`,{...body,requestId:last.current.key});
      setNotice(`选段已投递给「${selected.title}」的 ${chosen.name}。`);modal.current?.close();
    } catch(e) {setError((e as Error).message);} finally {setBusy(false);}
  }
  return <><button ref={trigger} type="button" onClick={open}>分享选段到其他会话</button>
    <dialog className="cc-excerpt-dialog" aria-label="跨会话分享选段" ref={modal} onClose={()=>trigger.current?.focus()} onCancel={e=>{if(busy)e.preventDefault();}}>
      <form className="cc-settings-form" onSubmit={submit}>
        <h3>分享选段到其他会话</h3>
        <label>在原文中选择要发送的文字<textarea readOnly rows={5} value={message.content} onSelect={e=>setRange([e.currentTarget.selectionStart,e.currentTarget.selectionEnd])}/></label>
        <label>目标会话<select required value={target} onChange={e=>destination(e.target.value)}><option value="">选择会话</option>{targets.map(r=><option key={r.id} value={r.id}>{r.title}</option>)}</select></label>
        {!targets.length && <p>还没有其他含可用成员的会话。</p>}
        <label>接收成员<select required value={recipient} onChange={e=>setRecipient(e.target.value)} disabled={!selected}>{people(selected).map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        <strong>对方将收到</strong><blockquote>{range[1]>range[0]?message.content.slice(...range):'尚未选中文字。'}</blockquote>
        <p className="cc-note">以本会话的 {sender?.name ?? '不可用成员'} 为发送端，仅向选定成员投递一次。授权有效期为 24 小时；可在工作台撤销尚未读取的材料。</p>
        {error && <p role="alert">{error}</p>}
        <div><button type="button" disabled={busy} onClick={()=>modal.current?.close()}>取消</button> <button disabled={busy || !sender || !chosen || range[1]<=range[0]}>{busy?'正在发送…':'确认并发送选段'}</button></div>
      </form>
    </dialog>{notice && <span role="status">{notice}</span>}</>;
}
