import { useEffect, useRef, useState } from 'react';
import type { AcceptanceEvidence, RuntimeInteraction } from '../shared/collaboration';
import type { WorkbenchCommand } from './WorkbenchPanel';

export function NativeFilePermission({ item, member, command, refresh, evidence, stopped, latestPull }: {
  latestPull?: RuntimeInteraction; item: RuntimeInteraction; member: string; stopped: boolean; command: WorkbenchCommand; refresh: () => Promise<void>; evidence?: AcceptanceEvidence[];
}) {
  const [saved,setSaved] = useState<RuntimeInteraction>(), [error,setError] = useState(''), [busy,setBusy] = useState(false);
  const [clock,setClock] = useState(Date.now);
  const active = useRef<AbortController | null>(null);
  const key = useRef<{decision:string;id:string} | null>(null);
  const card = useRef<HTMLElement>(null);
  const current = saved && saved.revision > item.revision ? saved : item;
  const expires = Date.parse(current.expiresAt);
  const pending = current.state === 'pending';
  const state = pending && clock >= expires ? 'expired' : pending && stopped ? 'cancelled' : current.state;
  const change = current.fileChange, commandRequest = current.nativeCommand;
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (state !== 'pending') return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0,expires-Date.now()+1));
    return () => clearTimeout(timer);
  }, [expires,state]);
  async function decide(decision:'allow_once'|'decline'|'cancel') {
    if (active.current || stopped || state !== 'pending' || Date.now() >= expires) return;
    const controller = new AbortController(); active.current = controller;
    const signature = [current.revision,current.payloadDigest,decision].join('.');
    if (key.current?.decision !== signature) key.current = {decision:signature,id:crypto.randomUUID()};
    const focusedButton = document.activeElement instanceof HTMLButtonElement && card.current?.contains(document.activeElement) ? document.activeElement : undefined;
    let committed = false;
    setBusy(true); setError('');
    try {
      const result = await command<{interaction:RuntimeInteraction}>('/api/runtime-interactions/'+encodeURIComponent(current.id)+'/answer',
        {requestId:key.current.id,expectedRevision:current.revision,payloadDigest:current.payloadDigest,decision},controller.signal);
      if (!controller.signal.aborted) {
        committed = true;
        setSaved(result.interaction);
        await refresh();
      }
    } catch (e) {
      if (!controller.signal.aborted) { setError((e as Error).message || '提交失败，可重试。'); await refresh().catch(() => undefined); }
    } finally {
      if (!controller.signal.aborted) {
        active.current=null; setBusy(false);
        requestAnimationFrame(() => {
          if (focusedButton && (document.activeElement === document.body || card.current?.contains(document.activeElement))) {
            if (committed || !focusedButton.isConnected) card.current?.focus(); else focusedButton.focus();
          }
        });
      }
    }
  }
  const stateLabels = {
    pending: '等待确认', answered: '已允许一次', cancelled: '已取消', declined: '已拒绝',
    expired: '已过期', unsupported: '未获授权',
  };
  const target = current.payload.target;
  const git = item.gitDelivery;
  const gitResult = git && evidence?.slice().reverse().find(e => e.invocationId === item.invocationId && e.detail.origin === 'project_git' && e.detail.callId === item.nativeItemId);
  const ci=item.pullStatus;
  const newerCommit=latestPull && latestPull.createdAt>=item.createdAt && latestPull.gitDelivery?.commit!==git?.commit
    ? latestPull.gitDelivery?.commit : undefined;
  async function refreshPull() {
    if (busy) return;
    setBusy(true); setError('');
    try { await command('/api/runtime-interactions/'+encodeURIComponent(item.id)+'/refresh-pull',{}); await refresh(); }
    catch(e) {setError((e as Error).message);}
    finally {setBusy(false);}
  }
  const managed = item.transport === 'project-check';
  const origin = managed ? 'project_environment' : 'native';
  const receipt = evidence?.find(e => e.invocationId === item.invocationId && e.kind === 'tool' && e.detail.origin === origin &&
    (!managed || e.detail.name === 'project_environment_check') &&
    e.detail.nativeSessionId === item.nativeSessionId && e.detail.nativeTurnId === item.nativeTurnId &&
    e.detail.callId === item.nativeItemId && ['completed','failed'].includes(String(e.detail.state)));
  const exitCode = receipt?.detail.exitCode;
  let result = stopped ? '本轮已结束，未收到该操作的完成回执。' : managed ? '等待项目副本返回命令结果。' : '等待成员返回操作结果。';
  if (receipt) {
    if (receipt.detail.state === 'failed' || typeof exitCode === 'number' && exitCode !== 0) result = '操作失败。';
    else if (managed) result = exitCode === 0 ? '已在项目副本完成。' : '未收到项目副本的退出码。';
    else result = '成员已完成操作。';
  }
  if (git) {
    const status = gitResult?.detail.state;
    result = status === 'completed' ? (git.pull ? '已推送到工作分支。' : '已核对远端分支，推送成功。') : status === 'failed' ? String(gitResult?.detail.reason || '推送失败。') : status === 'unknown' || stopped ? '远端结果待核对，可在此会话重新查询。' : '正在向远端交付。';
  }
  const action = git?.pull ? (git.pull.number ? '更新 PR' : '创建 PR') : git ? '提交并推送' : managed ? '在项目副本运行命令' : change ? {create:'创建文件',patch:'修改文件',write:'写入文件'}[change.action] : commandRequest ? '运行命令' : '请求项目权限';
  return <section className="cc-project-export cc-native-file-permission" ref={card} tabIndex={-1}
    aria-label={member + (managed ? '的项目副本命令请求' : '的原生权限请求')} data-permission-id={current.id}>
    <header><strong>{member} · {action}</strong><span className="cc-export-state" role="status">{stateLabels[state]}</span></header>
    {git && <>
      <p>{git.message}</p><dl className="cc-project-file-pair">
        <dt>远端</dt><dd>{git.remote}</dd><dt>{git.pull ? '工作分支 → 目标分支' : '分支'}</dt><dd>{git.branch}{git.pull && ' → '+git.pull.base}</dd>
        <dt>本次提交</dt><dd><code>{git.commit}</code></dd></dl>
      {git.pull && <p>{git.pull.repair ? 'CI 失败后，将失败的检查交回'+member+'修复。' : '提交后在这里跟踪 CI 检查。'}</p>}
      <details><summary>查看 {git.files.length} 个文件的差异</summary>
        <ul>{git.files.map(path=><li key={path}><code>{path}</code></li>)}</ul>
        <pre className="cc-artifact-preview">{git.diff}</pre></details>
    </>}
    {change && <>
      <code>{change.path}</code>
      <details><summary>{change.action === 'patch' ? '查看补丁' : '查看写入内容'}</summary>
        <pre className="cc-artifact-preview">{change.preview || '（空文件）'}</pre>
      </details>
    </>}
    {commandRequest && <dl className="cc-project-file-pair">
      <dt>命令</dt><dd><code>{commandRequest.command}</code></dd>
      <dt>工作目录</dt><dd><code>{commandRequest.cwd}</code></dd>
    </dl>}
    {!change && !commandRequest && typeof target === 'string' && <code>{target}</code>}
    {state === 'pending' && <small>请在 <time dateTime={current.expiresAt}>{new Date(expires).toLocaleTimeString()}</time> 前处理。允许后仅此操作可执行一次。</small>}
    {state === 'answered' && <p role="status">{result}
      {commandRequest && typeof exitCode === 'number' && Number.isSafeInteger(exitCode) && <span> 退出码 {exitCode}</span>}
    </p>}
    {git?.pull && state==='answered' && <div className="cc-pull-status">
      {newerCommit && <p>此卡记录先前提交。更新的提交为 <code>{newerCommit.slice(0,10)}</code>。</p>}
      {ci?.url && <a href={ci.url} target="_blank" rel="noreferrer">查看 PR #{ci.number}</a>}
      {ci && <><p role="status"><strong>{{waiting:'等待 CI 检查',pending:'CI 运行中',passed:'CI 已通过',failed:'CI 失败',unavailable:'暂时无法获取检查',superseded:'PR 已有其他提交',closed:'PR 已关闭',stopped:'已停止跟踪'}[ci.state]}</strong> · <code>{ci.commit.slice(0,10)}</code></p>
        {ci.reason && <p>{ci.reason}</p>}
        {ci.checks?.length ? <ul>{ci.checks.map((check,index)=><li key={index}>
          <span>{({pending:'等待或运行中',passed:'通过',failed:'失败',skipped:'跳过'})[check.state]} · </span>
          {check.url ? <a href={check.url} target="_blank" rel="noreferrer">{check.name}</a> : check.name}
          {check.state==='failed' && check.summary && <small>{check.summary}</small>}</li>)}</ul> : null}
        {item.repairSourceId && <p>失败信息已交回 {member}。</p>}
        {!newerCommit && ci.number && ci.state!=='stopped' && <button type="button" disabled={busy} onClick={()=>void refreshPull()}>刷新检查</button>}
      </>}
    </div>}
    {current.reason && <p>{current.reason}</p>}
    {state === 'pending' && (change || commandRequest || git) && <div className="cc-export-controls" aria-busy={busy}>
      <button type="button" disabled={busy} onClick={() => void decide('allow_once')}>{git?.pull ? (git.pull.number ? '确认更新 PR' : '确认创建 PR') : git ? '确认推送' : '允许一次'}</button>
      <button type="button" disabled={busy} onClick={() => void decide('decline')}>拒绝</button>
      <button type="button" disabled={busy} onClick={() => void decide('cancel')}>取消并停止本轮</button>
    </div>}
    {error && (state === 'pending' || git?.pull) && <p role="alert">{error}</p>}
  </section>;
}
