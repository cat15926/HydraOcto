import type { AcceptanceEvidence } from '../shared/collaboration';

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
