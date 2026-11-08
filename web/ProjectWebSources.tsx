import type { ReactNode } from 'react';
import type { AcceptanceEvidence } from '../shared/collaboration';

export function CitedReply({body,events,invocationId}:{body:string;events:AcceptanceEvidence[];invocationId:string}) {
  const verified=new Set<string>();
  for (const event of events) {
    const result=event.detail.result as {url?:string} | undefined;
    if (event.invocationId===invocationId && event.detail.origin==='project_web' && event.detail.name==='project_web_read' &&
        event.detail.state==='completed' && result?.url && /^https?:\/\//.test(result.url)) verified.add(result.url);
  }
  if (!verified.size) return body;
  const parts:ReactNode[]=[];
  let at=0;
  for (const match of body.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>\x22）)。，、]+)/g)) {
    const candidate=(match[2] ?? match[3]).replace(/[.,;]+$/,'');
    if (!verified.has(candidate.split('#')[0])) continue;
    parts.push(body.slice(at,match.index),<a key={match.index} href={candidate} target="_blank" rel="noreferrer">{match[1] ?? candidate}</a>);
    at=match.index+(match[2] ? match[0].length : candidate.length);
  }
  return <>{parts}{body.slice(at)}</>;
}

export function ProjectWebSources({events,invocationId,running}:{events:AcceptanceEvidence[];invocationId:string;running:boolean}) {
  const calls = new Map<string,AcceptanceEvidence>();
  for (const event of events) {
    if (event.invocationId === invocationId && event.kind === 'tool' && event.detail.origin === 'project_web') {
      calls.set(String(event.detail.callId),event);
    }
  }
  if (!calls.size) return null;
  return <details className="cc-project-export"><summary>网页查证记录 · {calls.size}</summary><ul>
    {[...calls.values()].map(({id,detail}) => {
      const result = detail.result as {url?:string;title?:string;results?:unknown[]} | undefined;
      const search = detail.name === 'project_web_search';
      const url = result?.url;
      return <li key={id}>
        {search ? '搜索「'+String(detail.query)+'」' : url && /^https?:\/\//.test(url) ?
          <a href={url} target="_blank" rel="noreferrer">{result?.title || url}</a> : String(detail.url ?? '')}
        {' · '}{detail.state === 'started' ? (running ? '查询中' : '未取得结果') : detail.state === 'failed' ? String(detail.reason ?? '查询失败') :
          search ? (result?.results?.length ?? 0)+' 条结果' : '已读取原文'}
        {typeof detail.checkedAt === 'string' && <small> · <time dateTime={detail.checkedAt}>{new Date(detail.checkedAt).toLocaleTimeString()}</time></small>}
      </li>;
    })}
  </ul></details>;
}
