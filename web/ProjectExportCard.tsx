import { useEffect, useRef, useState } from 'react';
import type { ProjectFileExport } from '../shared/collaboration';
import type { WorkbenchCommand } from './WorkbenchPanel';
import { WorkspaceIcon } from './WorkspaceIcon';

type Action = 'pick' | 'allow' | 'decline';
const states: Record<ProjectFileExport['state'], string> = {
  pending:'待选择位置', ready:'等待确认', writing:'正在写入', written:'已导出',
  declined:'已拒绝', expired:'已过期', cancelled:'已取消', failed:'写入失败', unknown:'写入结果待核查',
};

export function ProjectExportCard({ item, memberName, command, refresh }: {
  item: ProjectFileExport; memberName: string; command: WorkbenchCommand; refresh: () => Promise<void>;
}) {
  const [received,setReceived] = useState<ProjectFileExport>();
  const request = received && received.revision > item.revision ? received : item;
  const [busy,setBusy] = useState<Action>(), [error,setError] = useState(''), [note,setNote] = useState('');
  const [clock,setClock] = useState(Date.now);
  const pending = useRef<AbortController | undefined>(undefined);
  const ticket = useRef<{key:string;id:string} | undefined>(undefined);
  const root = useRef<HTMLElement>(null);
  const timestamp = Date.parse(request.expiresAt);
  const interactive = request.state === 'pending' || request.state === 'ready';
  const expired = interactive && clock >= timestamp;
  const actionable = interactive && !expired;
  useEffect(() => {
    if (!interactive) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0,timestamp-Date.now()+1));
    return () => clearTimeout(timer);
  },[timestamp,interactive]);
  useEffect(() => () => pending.current?.abort(),[]);
  async function act(action:Action) {
    if (pending.current || !actionable) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(action); setError(''); setNote('');
    const base = '/api/conversations/'+encodeURIComponent(request.conversationId)+'/project-exports/'+encodeURIComponent(request.id);
    let focusTarget = action === 'pick' ? 'pick' : 'result';
    try {
      if (action === 'pick') {
        const result = await command<{cancelled:boolean;export?:ProjectFileExport}>(base+'/pick',{expectedRevision:request.revision},controller.signal);
        if (controller.signal.aborted) return;
        if (result.cancelled) setNote('已取消选择。');
        else if (result.export) { setReceived(result.export); focusTarget='allow'; }
      } else {
        const key = [request.revision,request.payloadDigest,action].join('.');
        if (ticket.current?.key !== key) ticket.current={key,id:crypto.randomUUID()};
        const result = await command<{export:ProjectFileExport}>(base+'/decide',{expectedRevision:request.revision,
          requestId:ticket.current.id,decision:action,payloadDigest:request.payloadDigest},controller.signal);
        if (controller.signal.aborted) return;
        setReceived(result.export);
      }
      await refresh();
    } catch(e) {
      if (!controller.signal.aborted) {
        setError((e as Error).message);
        focusTarget=action;
        await refresh().catch(()=>{});
      }
    } finally {
      if (!controller.signal.aborted) {
        pending.current=undefined; setBusy(undefined);
        requestAnimationFrame(() => {
          const card = root.current;
          if (card && (card.contains(document.activeElement) || document.activeElement === document.body))
            (card.querySelector<HTMLElement>('[data-export-action="'+focusTarget+'"]') ?? card).focus({preventScroll:true});
        });
      }
    }
  }
  return <section ref={root} tabIndex={-1} className="cc-project-export" aria-label={'导出 '+request.fileName} data-export-id={request.id}>
    <header><WorkspaceIcon name="file"/><strong>导出文件</strong><span className="cc-export-state" role="status">{expired ? states.expired : states[request.state]}</span></header>
    <dl className="cc-project-file-pair">
      <dt>项目文件</dt><dd><code>{request.path}</code></dd>
      {request.targetPath && <><dt>{request.state === 'written' ? '已保存到' : '目标文件'}</dt><dd><code>{request.targetPath}</code></dd></>}
    </dl>
    {actionable && <p>{memberName} 请求由平台{request.state === 'ready' ? '在上述位置新建这一份文件。' : '将文件复制到项目外。选择保存位置后可核对并确认。'}</p>}
    <details className="cc-export-info"><summary>文件与授权详情</summary><dl className="cc-project-file-pair">
      <dt>申请成员</dt><dd>{memberName}</dd><dt>执行方</dt><dd>平台文件导出</dd>
      <dt>文件大小</dt><dd>{request.bytes.toLocaleString()} 字节</dd><dt>内容 SHA-256</dt><dd><code>{request.sha256}</code></dd>
      {!actionable && <><dt>有效期至</dt><dd><time dateTime={request.expiresAt}>{new Date(request.expiresAt).toLocaleString()}</time></dd></>}
    </dl></details>
    {actionable && <div className="cc-export-controls">
      {request.state === 'ready' && request.targetPath && <button type="button" data-export-action="allow" className="cc-project-primary" disabled={!!busy} onClick={()=>void act('allow')}>{busy==='allow'?'正在确认…':'允许导出一次'}</button>}
      <button type="button" data-export-action="pick" className={request.state==='pending'?'cc-project-primary':undefined} disabled={!!busy} onClick={()=>void act('pick')}>{busy==='pick'?'正在选择…':request.targetPath?'更换位置':'选择保存位置'}</button>
      <button type="button" data-export-action="decline" disabled={!!busy} onClick={()=>void act('decline')}>{busy==='decline'?'正在拒绝…':'拒绝'}</button>
    </div>}
    {actionable && <small>本次申请有效至 <time dateTime={request.expiresAt}>{new Date(request.expiresAt).toLocaleTimeString()}</time></small>}
    {request.reason && <p>{request.reason}</p>}
    {note && actionable && <p role="status">{note}</p>}
    {error && <p className="cc-form-error" role="alert">{error}</p>}
  </section>;
}
