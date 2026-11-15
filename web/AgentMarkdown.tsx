import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AcceptanceEvidence } from '../shared/collaboration';

const plugins = [remarkGfm];

function citationUrls(events: AcceptanceEvidence[], invocationId?: string) {
  if (!invocationId) return '';
  const urls = new Set<string>();
  for (const event of events) {
    if (event.invocationId !== invocationId || event.detail.origin !== 'project_web' ||
        event.detail.name !== 'project_web_read' || event.detail.state !== 'completed') continue;
    const result = event.detail.result as { url?: string } | undefined;
    if (typeof result?.url === 'string' && /^https?:\/\//.test(result.url)) urls.add(result.url.split('#')[0]);
  }
  return [...urls].join('\n');
}

// Keep completed replies stable as unrelated execution events arrive.
const FormattedReply = memo(function FormattedReply({ body, citations }: { body: string; citations: string }) {
  const verified = new Set(citations.split('\n').filter(Boolean));
  return <div className="cc-agent-markdown"><Markdown remarkPlugins={plugins} components={{
    a: ({ href, children }) => href && verified.has(href.split('#')[0])
      ? <a href={href} target="_blank" rel="noreferrer">{children}</a>
      : <>{children}{href && String(children) !== href ? ' (' + href + ')' : ''}</>,
    img: ({ alt }) => <span>{alt || '图片'}</span>,
    table: ({ children }) => <div className="cc-markdown-table"><table>{children}</table></div>,
  }}>{body}</Markdown></div>;
});

export function AgentMarkdown({ body, events = [], invocationId, raw }: {
  body: string; events?: AcceptanceEvidence[]; invocationId?: string; raw?: boolean;
}) {
  if (raw) return <pre className="cc-markdown-source">{body}</pre>;
  return <FormattedReply body={body} citations={citationUrls(events, invocationId)} />;
}
