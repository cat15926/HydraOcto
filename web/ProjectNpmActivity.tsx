import { useEffect, useRef, useState } from 'react';
import type { AcceptanceEvidence, CollaborationInvocation, RuntimeInteraction } from '../shared/collaboration';
import type { WorkbenchCommand } from './WorkbenchPanel';
import { WorkspaceIcon } from './WorkspaceIcon';

export function isNpmDownload(i: RuntimeInteraction) {
  return i.transport === 'project-npm' && i.operation === 'npm_download' && i.kind === 'question';
}

const downloadStates: Record<RuntimeInteraction['state'], string> = {
  pending: '等待确认', answered: '已允许此次下载', declined: '已拒绝下载',
  expired: '下载请求已过期', cancelled: '下载请求已取消', unsupported: '当前无法下载',
};

export function ProjectNpmDownload({ item, memberName, command, refresh, stopped }: {
  item: RuntimeInteraction; memberName: string; command: WorkbenchCommand; refresh: () => Promise<void>; stopped: boolean;
}) {
  const [response, setResponse] = useState<RuntimeInteraction>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [clock, setClock] = useState(Date.now);
  const root = useRef<HTMLElement>(null);
  const pending = useRef<AbortController | null>(null);
  const ticket = useRef<{ key: string; id: string } | null>(null);
  const interaction = response && response.revision > item.revision ? response : item;
  const expires = Date.parse(interaction.expiresAt);
  const state = interaction.state === 'pending' ? stopped ? 'cancelled' : clock >= expires ? 'expired' : 'pending' : interaction.state;
  const decision = state === 'answered' && interaction.answers?.download !== '允许此次下载' ? '此次下载未获授权' : downloadStates[state];
  const { packages, registry, lockSha256, project } = interaction.payload;
  const names = Array.isArray(packages) ? packages.filter((p): p is string => typeof p === 'string') : [];
  const source = typeof registry === 'string' ? registry : '';
  const valid = source === 'https://registry.npmjs.org' && typeof lockSha256 === 'string' && /^[a-f\d]{64}$/i.test(lockSha256) && names.length > 0;
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (state !== 'pending') return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, expires - Date.now() + 1));
    return () => clearTimeout(timer);
  }, [state, expires]);

  async function decide(allow: boolean) {
    if (pending.current || state !== 'pending' || Date.now() >= expires || (allow && !valid)) return;
    const controller = new AbortController();
    pending.current = controller;
    const key = [interaction.id, interaction.revision, interaction.payloadDigest, allow].join('.');
    if (ticket.current?.key !== key) ticket.current = { key, id: crypto.randomUUID() };
    setBusy(true); setError('');
    let committed = false;
    try {
      const result = await command<{ interaction: RuntimeInteraction }>(
        '/api/runtime-interactions/' + encodeURIComponent(interaction.id) + '/answer', {
          requestId: ticket.current.id, expectedRevision: interaction.revision, payloadDigest: interaction.payloadDigest,
          ...(allow ? { answers: { download: '允许此次下载' } } : { decline: true }),
        }, controller.signal);
      if (controller.signal.aborted) return;
      setResponse(result.interaction); committed = true;
      await refresh();
    } catch (e) {
      if (controller.signal.aborted) return;
      setError((e as Error).message || '提交失败，请重试。');
      await refresh().catch(() => undefined);
    } finally {
      if (!controller.signal.aborted) {
        pending.current = null; setBusy(false);
        requestAnimationFrame(() => {
          const card = root.current;
          if (!card || !card.getClientRects().length || (!card.contains(document.activeElement) && document.activeElement !== document.body)) return;
          const retry = !committed && card.querySelector<HTMLElement>(allow ? '[data-allow]' : '[data-decline]');
          (retry || card).focus({ preventScroll: true });
        });
      }
    }
  }
  return <section ref={root} tabIndex={-1} className="cc-project-export cc-npm-download" data-download-id={item.id} aria-label="依赖下载授权">
    <header><WorkspaceIcon name="link"/><strong>下载测试依赖</strong><span className="cc-export-state" role="status">{decision}</span></header>
    <p>{memberName} 为{typeof project === 'string' ? '「' + project + '」' : '当前项目'}运行测试，需要从 <code>{source}</code> 下载锁文件中缺少的依赖。</p>
    <details className="cc-export-info"><summary>查看 {names.length} 项依赖</summary>
      <ul>{names.map((pkg, index) => <li key={index}><code>{pkg}</code></li>)}</ul>
      {typeof lockSha256 === 'string' && <small>锁文件 SHA-256 <code>{lockSha256}</code></small>}
    </details>
    {state === 'pending' && <><div className="cc-export-controls">
      <button data-allow type="button" className="cc-project-primary" disabled={busy || !valid} onClick={() => void decide(true)}>允许此次下载</button>
      <button data-decline type="button" disabled={busy} onClick={() => void decide(false)}>拒绝下载</button>
    </div><small>{!valid ? '无法核对本次下载范围。' : '仅对本次执行和以上依赖生效。'} 有效至 <time dateTime={interaction.expiresAt}>{new Date(expires).toLocaleTimeString()}</time></small></>}
    {error && <p role="alert" className="cc-form-error">{error}</p>}
  </section>;
}

const phases: Record<string, string> = {
  waiting_for_project: '等待当前项目执行退出', preparing: '正在准备测试依赖', awaiting_download: '等待下载授权', testing: '正在运行测试',
  failed: '未能完成项目检查', skipped: '未执行', denied: '已拒绝下载',
};

export function ProjectNpmTests({ events, run }: { events: AcceptanceEvidence[]; run: CollaborationInvocation }) {
  const latest = new Map<string, AcceptanceEvidence['detail']>();
  for (const e of events) {
    if (e.invocationId === run.id && e.kind === 'tool' && e.detail.origin === 'project_npm' && typeof e.detail.callId === 'string') {
      latest.set(e.detail.callId, e.detail);
    }
  }
  if (!latest.size) return null;
  const active = ['prepared', 'running'].includes(run.status);
  return <ul aria-label="项目测试" className="cc-project-test-list">{[...latest].map(([id, d]) => {
    const state = String(d.state);
    let label = phases[state] ?? '测试结果待核查';
    if (state === 'tested') label = typeof d.exitCode === 'number' && d.treeExited === true
      ? (d.exitCode === 0 ? '测试通过' : '测试失败') + ' · 退出码 ' + d.exitCode : '测试结果待核查';
    if (!active && ['waiting_for_project', 'preparing', 'awaiting_download', 'testing'].includes(state)) label = run.status === 'cancel_requested' ? '正在停止' : '未取得完整测试结果';
    return <li key={id}><div><code>{Array.isArray(d.argv) ? d.argv.map(String).join(' ') : 'npm test'}</code>
      <span role="status">{label}</span></div>
      {typeof d.reason === 'string' && <small>{d.reason}</small>}
      {typeof d.snapshotSha256 === 'string' && <small title={d.snapshotSha256}>测试副本 {d.snapshotSha256.slice(0, 12)}</small>}
    </li>;
  })}</ul>;
}
