import type { AcceptanceEvidence, CollaborationInvocation } from '../shared/collaboration';
import { useState } from 'react';

const names: Record<string,string> = { Read:'读取文件', workspace_read:'读取文件', workspace_list:'浏览目录', Write:'写入文件', Edit:'修改文件', fileChange:'修改文件', commandExecution:'运行命令', Bash:'运行命令', Glob:'查找文件', Grep:'搜索文件', collaboration_request:'邀请成员协作' };
type Step = { key:string; reasoning:boolean; label:string; state:string; description:string };
export function ReplyProcess({run, events, preference, onChange}: {
  run:CollaborationInvocation; events: AcceptanceEvidence[]; preference?:boolean; onChange:(open:boolean)=>void;
}) {
  const [choice,setChoice] = useState(preference);
  const active = ['prepared','running','cancel_requested'].includes(run.status);
  const steps = new Map<string,Step>();
  let reasonKey = '';
  for (const e of events) {
    const d = e.detail;
    if (e.kind === 'diagnostic' && (d.itemType === 'reasoning' || d.observation === 'reasoning_summary')) {
      if (d.itemType === 'reasoning' || !reasonKey) reasonKey = e.id;
      const previous = steps.get(reasonKey);
      steps.set(reasonKey,{key:reasonKey,reasoning:true,label:'思考',state:'',description:(previous?.description ?? '') + (typeof d.summary === 'string' ? d.summary : '')});
    }
    if (e.kind !== 'tool' || typeof d.callId !== 'string') continue;
    const key = JSON.stringify([d.nativeSessionId,d.nativeTurnId,d.callId]);
    const old = steps.get(key);
    const name = typeof d.name === 'string' ? (Object.hasOwn(names,d.name) ? names[d.name]! : d.name) : old?.label ?? '工具调用';
    const description = [d.commandLabel,d.path,...(Array.isArray(d.paths) ? d.paths : []),typeof d.exitCode === 'number' ? '退出码 '+d.exitCode : undefined].filter(v=>typeof v==='string').join(' · ');
    let state = old?.state ?? '结果待核查';
    if (d.state === 'started') state = active ? '进行中' : '未收到结束回执';
    if (d.state === 'completed' || d.state === 'succeeded') state = '已完成';
    if (d.state === 'failed' || typeof d.exitCode === 'number' && d.exitCode !== 0) state = '失败';
    if (old?.state === '失败') state = '失败';
    steps.set(key,{key,reasoning:false,label:name,state,description:description || old?.description || ''});
  }
  if (!steps.size) return null;
  const open = choice ?? active, rows = [...steps.values()], calls = rows.filter(s=>!s.reasoning).length;
  return <details className="cc-reply-process" open={open}><summary onClick={e=>{
    e.preventDefault(); onChange(!open); setChoice(!open);
  }}>执行过程{calls ? ' · '+calls+' 次工具调用' : ' · 思考'}</summary>
    <ol>{rows.map(row=><li key={row.key}>{row.description
      ? <details><summary>{row.label} <small>{row.state}</small></summary><p>{row.description}</p></details>
      : <span>{row.reasoning && active && row===rows.at(-1) ? '正在思考' : row.label} <small>{row.state}</small></span>}</li>)}</ol>
  </details>;
}
