import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CollaborationBootstrap, ConfigurationPreview, ConversationDetail, ProjectCapability, ProjectIntent, WorkspaceGrant } from '../shared/collaboration';
import type { WorkbenchCommand } from './WorkbenchPanel';
import { WorkspaceIcon } from './WorkspaceIcon';

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

function memberAccess(data: CollaborationBootstrap, id: string, preview?: ProjectCapability) {
  const member = data.members.find(m => m.id === id && m.enabled && !m.deletedAt);
  if (!member) return { id, available: false, reason: '成员已停用或移出会话' };
  const accountId = member.accountBinding === 'follow' ? data.defaults?.find(d => d.carrier === member.carrier)?.accountId : member.accountId;
  const account = data.accounts.find(a => a.id === accountId && !a.deletedAt && a.configured);
  const runtime = data.runtimes.find(r => r.carrier === member.carrier);
  const capability = preview ?? (account && runtime?.nativeProject?.[account.auth]);
  const reason = capability?.reason || '运行时或账户尚未通过本机验证';
  if (account?.auth !== 'cli' || !['codex-app-server', 'claude-cli'].includes(member.carrier)) {
    return { id, available: !!capability?.available, reason: capability?.available ? (preview ? '可在项目内工作' : '运行时支持，执行前核对授权') : reason };
  }
  const codex = member.carrier === 'codex-app-server';
  const identity = account.name + ' · 本机官方登录';
  if (account.codexHome === 'project') {
    const observation=data.accountObservations?.find(o=>o.accountId===account.id && o.accountRevision===(account.revision??1));
    const identity = account.name + ' · 独立项目登录';
    if (observation?.identity.state!=='authenticated') {
      const reason = !account.loginCommand ? account.loginIssue || '专用登录配置尚未就绪。'
        : observation?.identity.state==='not_authenticated' ? '请在终端完成项目专用登录，然后重新检查。' : '请重新检查项目专用账户。如果尚未登录，可在终端运行下方命令。';
      return {id,identity,available:false,reason,login:account.loginCommand,accountId:account.id};
    }
    return {id,identity,available:preview?.available??true,reason:preview && !preview.available ? reason : '专用账户已认证，执行前核对项目环境。',accountId:account.id};
  }
  if (runtime?.loginRequired) {
    return { id, identity, available: false, reason: '请先在本机终端登录。', login: codex ? 'codex login' : 'claude auth login', accountId: account.id };
  }
  if (!runtime?.available) {
    return { id, identity, available: false, reason: runtime?.installed ? '本机官方账户未就绪，可重新检查连接。' : '尚未检测到本机 CLI，请在「成员与运行时」检查安装状态。', accountId: runtime?.installed ? account.id : undefined };
  }
  return { id, identity, available: !!capability?.available, reason: capability?.available
    ? codex ? 'Codex 在项目虚拟机中运行原生命令。' : 'Claude Code 通过工作台在项目虚拟机中运行命令。'
    : reason };
}

export function ProjectFolder({ detail, data, command, refresh, visible, intent, onResolved }: {
  detail: ConversationDetail; data: CollaborationBootstrap; command: WorkbenchCommand; refresh: () => Promise<void>;
  visible: boolean; intent?: ProjectIntent; onResolved?: () => void;
}) {
  const c = detail.conversation, grant = c.workspaceGrant;
  const base = '/api/conversations/' + encodeURIComponent(c.id);
  const [preview, setPreview] = useState<ConfigurationPreview>();
  const [revokeAt, setRevokeAt] = useState<number>();
  const [busy, setBusy] = useState<'pick' | 'preview' | 'apply' | 'decision' | 'login'>();
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const pending = useRef<AbortController | undefined>(undefined);
  const chooseButton = useRef<HTMLButtonElement>(null), confirmButton = useRef<HTMLButtonElement>(null);
  const filePermission = useRef<HTMLInputElement>(null);
  const readerSelect = useRef<HTMLSelectElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const editingReview = useRef(false);
  const previewHeading = useRef<HTMLElement>(null);
  const nextFocus = useRef<'choose' | 'confirm' | 'reader' | 'filePermission' | null>(null);
  const selected = preview && 'path' in preview.value ? preview.value : undefined;
  const working = selected?.mode === 'project-work';
  const revoking = revokeAt !== undefined && revokeAt === (c.revision ?? 1) && grant?.mode === 'project-work';
  const readonly = !!c.archivedAt || !!c.deletedAt;
  const memberName = (id: string) => data.members.find(m => m.id === id)?.name ?? id;
  const names = (ids: string[]) => ids.map(memberName).join('、');
  const workMembers = grant?.mode === 'project-work' ? grant.memberIds ?? [] : [];
  const previewRows = (selected?.memberIds ?? preview?.affectedMemberIds ?? []).map(id =>
    memberAccess(data, id, preview?.projectCapabilities?.find(row => row.memberId === id) ?? { memberId: id, available: false }));
  const blocked = !!intent && !!working && intent.memberIds.some(id => !previewRows.some(row => row.id === id && row.available));
  const previous = intent?.origin && detail.invocations.find(run => run.id === intent.origin?.invocationId);
  const waitingForExit = !!intent?.origin && (!previous || !['succeeded', 'failed'].includes(previous.status) ||
    previous.teardown !== 'confirmed' || previous.acceptance !== 'accepted');
  const activeRef = useRef(false);

  useLayoutEffect(() => {
    activeRef.current = visible;
    if (!visible) setBusy(undefined);
    return () => { activeRef.current = false; pending.current?.abort(); pending.current = undefined; nextFocus.current = null; };
  }, [visible, c.id]);
  useLayoutEffect(() => {
    if (!visible || busy || !nextFocus.current) return;
    const target = nextFocus.current === 'filePermission' ? filePermission.current : nextFocus.current === 'reader' ? readerSelect.current : nextFocus.current === 'confirm'
      ? confirmButton.current?.disabled ? previewHeading.current : confirmButton.current ?? chooseButton.current
      : editingReview.current && reviewButton.current ? reviewButton.current : chooseButton.current;
    nextFocus.current = null;
    if (target?.getClientRects().length && !target.matches(':disabled') && !target.closest('[hidden], [inert], .cc-page-hidden')) {
      target.focus({ preventScroll: true });
      if (intent) target.scrollIntoView({ block: 'nearest' });
    }
    if (target === reviewButton.current || !visible) editingReview.current = false;
  }, [visible, busy, preview, error, notice, revoking, intent?.id]);
  useEffect(() => {
    if (!preview) return;
    const expire = () => { setPreview(undefined); setNotice('授权预览已失效，请重新核对文件夹。'); };
    if (preview.conversationRevision !== (c.revision ?? 1)) { expire(); return; }
    const timer = setTimeout(expire, Math.max(0, Date.parse(preview.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [preview, c.revision]);

  async function candidate(source: 'pick' | 'current' | 'candidate', mode: WorkspaceGrant['mode'], reviewMode?: 'project',
    option?: { readerId: string } | { nativeFileApprovals: boolean }) {
    const readerId = option && 'readerId' in option ? option.readerId : source === 'candidate'
      ? selected?.mcpReader?.id : source === 'current' && data.mcpReaders?.some(r => r.id === grant?.mcpReader?.id) ? grant?.mcpReader?.id : undefined;
    const nativeFileApprovals = option && 'nativeFileApprovals' in option ? option.nativeFileApprovals :
      (source === 'current' ? grant : source === 'candidate' ? selected : undefined)?.nativeFileApprovals;
    const focusOption = option && ('readerId' in option ? 'reader' : 'filePermission');
    if (busy || pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setRevokeAt(undefined); setBusy(source === 'pick' ? 'pick' : 'preview'); setError(''); setNotice('');
    const body = { expectedRevision: c.revision ?? 1, ...(mode === 'project-work' ? { mode, reviewMode, ...(readerId ? {mcpReaderId:readerId} : {}), ...(nativeFileApprovals ? {nativeFileApprovals:true} : {}) } : {}), ...(intent ? { intentId: intent.id } : {}) };
    try {
      let next: ConfigurationPreview | null;
      if (source === 'pick') {
        const result = await command<{preview: ConfigurationPreview | null}>(base + '/workspace-pick', body, controller.signal);
        next = result.preview;
      } else {
        next = await command<ConfigurationPreview>(base + '/workspace-preview', {
          ...body, mode, ...(source === 'current' ? { useCurrent: true } : { fromPreviewId: preview?.id }),
        }, controller.signal);
      }
      if (controller.signal.aborted) return;
      nextFocus.current = next ? (focusOption ?? 'confirm') : 'choose';
      if (next) setPreview(next);
      else setNotice(intent ? '已取消选择。原委托仍在这里，可稍后继续。' : '已取消选择，工作区未变更。');
    } catch (e) {
      if (!controller.signal.aborted) { setError((e as Error).message); nextFocus.current = focusOption ?? 'choose'; }
    } finally { if (pending.current === controller) { pending.current = undefined; setBusy(undefined); } }
  }
  function cancelPick() {
    pending.current?.abort(); pending.current = undefined;
    nextFocus.current = 'choose'; setBusy(undefined); setNotice(intent ? '已取消选择。原委托仍在这里，可稍后继续。' : '已取消选择，工作区未变更。');
  }
  async function commit(action: 'apply' | 'consult' | 'cancel' | 'revoke') {
    if (busy || readonly) return;
    setBusy(action === 'apply' ? 'apply' : 'decision'); setError(''); setNotice('');
    try {
      if (action === 'revoke' && revoking && grant) {
        await command(base + '/workspace-revoke', { expectedRevision: revokeAt, requestId: 'revoke-' + c.id + '-' + revokeAt });
        if (activeRef.current) { setRevokeAt(undefined); setNotice('工作授权已收回。已写入的文件保留在项目里。'); }
      } else if (action === 'apply' && preview) {
        await command(base + '/workspace-apply', { previewId: preview.id, requestId: preview.id });
        if (activeRef.current) {
          setPreview(undefined);
          if (!intent) setNotice(working ? '本会话的项目工作授权已保存。' : '项目文件夹已切换，只读授权已生效。');
        }
      } else if (intent && (action === 'consult' || action === 'cancel')) {
        await command(base + '/project-intents/' + encodeURIComponent(intent.id) + '/' + action, { expectedRevision: intent.revision, requestId: intent.id + '-' + action + '-' + intent.revision });
      } else return;
      if (activeRef.current) { nextFocus.current = 'choose'; if (intent) onResolved?.(); }
      await refresh();
    } catch (e) {
      if (activeRef.current) {
        const stale = (e as {status?: number}).status === 409;
        setError((e as Error).message); nextFocus.current = stale ? 'choose' : 'confirm';
        if (stale) { setPreview(undefined); await refresh().catch(() => {}); }
      }
    } finally { if (activeRef.current) setBusy(undefined); }
  }
  async function checkLogin(accountId: string) {
    if (busy || pending.current) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy('login'); setError(''); setNotice('');
    try {
      await command('/api/accounts/' + encodeURIComponent(accountId) + '/probe', {}, controller.signal);
      if (controller.signal.aborted) return;
      await refresh();
      if (!controller.signal.aborted) { setNotice('已重新检查本机账户。'); nextFocus.current = 'confirm'; }
    } catch (e) {
      if (!controller.signal.aborted) { setError((e as Error).message); nextFocus.current = 'confirm'; }
    } finally { if (pending.current === controller) { pending.current = undefined; setBusy(undefined); } }
  }
  function membersList(rows: ReturnType<typeof memberAccess>[]) {
    return <ul className="cc-project-capabilities">{rows.map(row =>
      <li key={row.id}><strong>{memberName(row.id)}</strong>{row.identity && <span>{row.identity}</span>}<span>{row.reason}</span>
        {row.login && <code>{row.login}</code>}{row.accountId && !readonly && <button type="button" className="cc-text-button" disabled={!!busy} aria-label={'重新检查' + memberName(row.id) + '的账户'} onClick={() => void checkLogin(row.accountId!)}>重新检查</button>}
      </li>)}</ul>;
  }
  const readyNames = names(previewRows.filter(row => row.available).map(row => row.id));
  return <section className={intent ? 'cc-project-intent cc-project-picker' : 'cc-workbench cc-project-picker'} aria-label={intent ? '等待授权的项目委托' : '项目文件夹'}>
    {intent ? <>
      <div className="cc-project-intent-heading"><WorkspaceIcon name="folder" /><h3>{intent.origin ? `${memberName(intent.origin.memberId)} 建议继续项目工作` : '为这条委托确认项目'}</h3></div>
      <blockquote>{intent.content}</blockquote>
      <p className="cc-note">{intent.origin ? waitingForExit ? '正在等待原执行确认退出。期间可以继续聊天，也可以放弃这一步。' : '原执行已退出。确认后，由原成员只执行上面建议的下一步。' : `确认后交给 ${names(intent.memberIds)}。选择文件夹期间可以继续聊天。`}</p>
    </> : <>
      <h3>项目文件夹</h3>
      <div className="cc-project-current"><span className="cc-project-symbol"><WorkspaceIcon name="folder" /></span><div><small>当前工作区</small><strong>{grant ? basename(grant.path) : '默认工作区'}</strong></div><small>{grant?.mode === 'project-work' ? '已授权项目工作' : '只读'}</small></div>
      {grant ? <code className="cc-project-path">{grant.path}</code> : <details className="cc-project-location"><summary>查看默认目录</summary><code>{data.workspace}</code></details>}
      {grant?.mode === 'project-work' && <details className="cc-project-location"><summary>已授权成员 · {workMembers.length}</summary>{membersList(workMembers.map(id => c.memberIds.includes(id) ? memberAccess(data, id) : { id, available: false, reason: '已移出会话' }))}</details>}
      {grant?.nativeFileApprovals && <p className="cc-note">文件和命令确认已开启</p>}
      {grant?.mcpReader && <p className="cc-note">已授权资料源 · {grant.mcpReader.label}（{grant.mcpReader.origin}）</p>}
      {grant?.mode === 'project-work' && !readonly && !preview && !revoking &&
        <button type="button" ref={reviewButton} className="cc-text-button" disabled={!!busy} onClick={() => {
          editingReview.current = true;
          void candidate('current','project-work',grant.reviewMode);
        }}>
          项目权限
        </button>}
    </>}
    {readonly ? <p className="cc-note">恢复会话后可设置项目文件夹。</p> : <>
      <div className="cc-project-actions">
        <button ref={chooseButton} className={selected ? '' : 'cc-project-primary'} disabled={!!busy || waitingForExit} onClick={() => void candidate(intent && grant && !selected ? 'current' : 'pick', intent ? 'project-work' : 'read-only', intent && !selected ? grant?.reviewMode : undefined)}><WorkspaceIcon name="folder" />{busy === 'pick' ? '正在选择…' : selected ? '重新选择…' : intent && grant ? '核对当前项目' : grant ? '更换文件夹…' : '选择文件夹…'}</button>
        {!intent && !c.importedFor && grant && !preview && !revoking && <button disabled={!!busy} onClick={() => {
          if (grant.mode === 'project-work') { nextFocus.current = 'confirm'; setRevokeAt(c.revision ?? 1); setError(''); setNotice(''); }
          else void candidate('current', 'project-work');
        }}>{grant.mode === 'project-work' ? '收回工作授权…' : '允许在此项目工作…'}</button>}
        {busy === 'pick' && <button onClick={cancelPick}>取消选择</button>}
      </div>
      {revoking && <section className="cc-workbench-preview cc-project-preview">
        <strong>将项目改为只读？</strong><code>{grant.path}</code><p>会话「{c.title}」将停止在这里执行的项目工作，已写入的改动会保留。</p>
        <div className="cc-project-actions"><button ref={confirmButton} disabled={!!busy} onClick={() => void commit('revoke')}>确认收回工作授权</button><button disabled={!!busy} onClick={() => { nextFocus.current = 'choose'; setRevokeAt(undefined); }}>取消</button></div>
      </section>}
      {selected && preview && <section ref={previewHeading} tabIndex={-1} aria-label="项目授权范围" className="cc-workbench-preview cc-project-preview">
        <small>等待确认 · {c.title}</small><strong>{basename(selected.path)}</strong><code>{selected.path}</code>
        <p>{working ? readyNames
          ? `确认后，${readyNames} 可在这个文件夹中修改原文件、运行项目命令。`
          : '当前成员仅可读取文件。工作授权可以单独保存，成员的运行时与账户通过执行检查后才可修改项目。'
          : '仅此会话可读取该目录。确认前仍使用当前工作区。'}</p>
        {working && membersList(previewRows)}
        {working && <label className="cc-review-permission"><input data-project-native-approval ref={filePermission} type="checkbox" checked={selected.nativeFileApprovals === true} disabled={!!busy}
          onChange={e => void candidate('candidate','project-work',selected.reviewMode,{nativeFileApprovals:e.target.checked})} />
          <span>在聊天里确认文件和命令<small>成员在此项目提交单文件变更或受支持的只读命令时，你可以先查看操作并决定是否允许这一次。</small></span></label>}
        {working && <label className="cc-review-permission"><input type="checkbox" checked={selected.reviewMode === 'project'} disabled={!!busy}
          onChange={e => void candidate('candidate','project-work',e.target.checked ? 'project' : undefined)} />
          <span>允许评审成员查阅项目并运行测试<small>适用于此会话后续的项目评审。测试在独立副本中运行，改动不会写回原文件。</small></span>
        </label>}
        {working && !!data.mcpReaders?.length && <label className="cc-project-reader">外部只读资料源
          <select ref={readerSelect} disabled={!!busy} value={selected.mcpReader?.id ?? ''} onChange={e => void candidate('candidate','project-work',selected.reviewMode,{readerId:e.target.value})}>
            <option value="">不连接</option>
            {data.mcpReaders.map(r => <option key={r.id} value={r.id}>{r.label} · {r.origin}</option>)}
          </select>
          {selected.mcpReader && <small>确认后，上列项目成员可将检索词发送到 {selected.mcpReader.origin}，通过 {selected.mcpReader.tool} 读取资料。仅在本会话中作为项目作者工作时生效。</small>}
        </label>}
        {blocked && <p className="cc-note">这条委托的成员尚不具备项目执行能力。可按只读咨询发送，或保留委托稍后继续。</p>}
        <div className="cc-project-actions">
          <button ref={confirmButton} className="cc-project-primary" disabled={!!busy || waitingForExit || blocked || preview.conversationRevision !== (c.revision ?? 1)} onClick={() => void commit('apply')}>{busy === 'apply' ? '正在授权…' : working ? intent ? '确认并继续委托' : '确认项目工作授权' : '确认只读授权'}</button>
          {!working && !intent && !c.importedFor && <button disabled={!!busy} onClick={() => void candidate('candidate', 'project-work')}>查看项目工作权限</button>}
          <button disabled={!!busy} onClick={() => { nextFocus.current = 'choose'; setPreview(undefined); setError(''); }}>取消</button>
        </div>
      </section>}
      {intent && <div className="cc-project-decisions"><button disabled={!!busy || waitingForExit} onClick={() => void commit('consult')}>按只读咨询发送</button><button disabled={!!busy} onClick={() => void commit('cancel')}>放弃委托</button></div>}
    </>}
    {notice && <p role="status" className="cc-note">{notice}</p>}{error && <p className="cc-form-error" role="alert">{error}</p>}
  </section>;
}
