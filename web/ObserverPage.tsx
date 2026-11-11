import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PublicRoomView } from '../shared/observer';
import type { ObligationState } from '../shared/obligations';

const stateLabels: Record<ObligationState, string> = {
  open: '进行中', delegated: '已交接', waiting: '等待接回', delivery_pending: '正在交付',
  awaiting_acceptance: '待用户验收', delivered: '已交付', blocked: '遇到阻碍', cancelled: '已取消',
};

export default function ObserverPage({ room }: { room: string }) {
  const [data, setData] = useState<PublicRoomView>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const retry = useRef<HTMLButtonElement>(null);

  const newest = useRef<HTMLLIElement>(null);
  const following = useRef(!window.location.hash);
  const [unseen, setUnseen] = useState(false);
  const view = data?.conversation.id === room ? data : undefined;
  const latestId = view?.messages.at(-1)?.id;
  const lastSeen = useRef<string | undefined>(undefined);
  useEffect(() => {
    function trackPosition() {
      following.current = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 48;
      if (following.current) setUnseen(false);
    }
    window.addEventListener('scroll', trackPosition, { passive: true });
    return () => window.removeEventListener('scroll', trackPosition);
  }, []);
  useLayoutEffect(() => {
    if (!latestId || latestId === lastSeen.current) return;
    const previous = lastSeen.current;
    lastSeen.current = latestId;
    if (!previous && window.location.hash) {
      document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
    } else if (following.current) {
      newest.current?.scrollIntoView({ block: 'end' });
    } else {
      setUnseen(true);
    }
  }, [latestId]);
  useEffect(() => {
    let active = true;
    let request: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout>;
    function clear() {
      clearTimeout(timer);
      request?.abort();
    }
    async function refresh() {
      clear();
      const controller = new AbortController();
      request = controller;
      try {
        const response = await fetch('/api/conversations/' + encodeURIComponent(room) + '/observer', {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]), cache: 'no-store',
        });
        if (!response.ok) throw Error([403, 404].includes(response.status) ? '此房间当前无法旁观。' : '公开动态暂时无法读取。');
        const next: PublicRoomView = await response.json();
        if (next.conversation.id !== room) throw Error('房间已变更。');
        if (!active || controller.signal.aborted) return;
        if (document.activeElement === retry.current) heading.current?.focus();
        setData(next);
        setError('');
      } catch (cause) {
        if (!active || controller.signal.aborted) return;
        setData(undefined);
        setError(cause instanceof Error && ['此房间当前无法旁观。', '房间已变更。'].includes(cause.message)
          ? cause.message : '公开动态暂时无法读取。');
      } finally {
        if (active && !controller.signal.aborted) timer = setTimeout(refresh, 3500);
      }
    }
    function pause() {
      clear();
      setData(undefined);
      setError('');
    }
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') void refresh();
      else pause();
    }
    void refresh();
    window.addEventListener('pagehide', pause);
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      active = false;
      clear();
      window.removeEventListener('pagehide', pause);
      window.removeEventListener('pageshow', refresh);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [room, attempt]);

  const progress = view?.progress ?? [];
  const deliveries = new Map(progress.map(item => [item.deliveryMessageId, item.state]));
  const messagesById = new Map(view?.messages.map(message => [message.id, message]));
  return <main className="cc-observer">
    <header><small>公开旁观</small><h1 ref={heading} tabIndex={-1}>{view?.conversation.title || '会话'}</h1></header>
    <div role="status" aria-live="polite" className="cc-observer-status">{error || (view ? '公开动态自动更新' : '正在读取公开动态…')}</div>
    {error && <button ref={retry} onClick={() => setAttempt(value => value + 1)}>重新读取</button>}
    {view && <>
      {!!progress.length && <section aria-label="任务进度"><h2>任务进度</h2><ul className="cc-observer-progress">{progress.map((item, index) =>
        <li key={item.requestMessageId + '-' + index}><span>{stateLabels[item.state]}</span>
          <a href={'#message-' + item.requestMessageId}>{messagesById.get(item.requestMessageId)?.content}</a>
          {item.deliveryMessageId && <a className="cc-observer-result" href={'#message-' + item.deliveryMessageId}>查看交付</a>}
        </li>)}</ul></section>}
      <section aria-label="公开发言"><h2>公开发言</h2>{!view.messages.length ? <p>暂无公开消息。</p> :
        <ol>{view.messages.map(message => <li key={message.id} id={'message-' + message.id} ref={message.id === latestId ? newest : undefined} tabIndex={-1}>
          <div><strong>{message.authorName || message.memberId || (message.author === 'user' ? '用户' : '协作记录')}</strong>{' '}
            <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
            {deliveries.has(message.id) && <span className="cc-observer-delivery">{stateLabels[deliveries.get(message.id)!]}</span>}</div>
          <p>{message.content}</p></li>)}</ol>}</section>
      {unseen && latestId && <button className="cc-observer-latest" onClick={() => {
        following.current = true;
        setUnseen(false);
        newest.current?.focus({ preventScroll: true });
        newest.current?.scrollIntoView({ block: 'end' });
      }}>查看最新发言 ↓</button>}
    </>}
  </main>;
}
