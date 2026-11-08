import { useEffect, useRef, useState } from 'react';
import type { CollaborationInvocation, ProjectInspectionSnapshot } from '../shared/collaboration';
import type { WorkbenchCommand } from './WorkbenchPanel';
import { WorkspaceIcon } from './WorkspaceIcon';

const domain = {running:'仍在运行',exited:'已确认退出',unknown:'退出情况待核查'};
const terminal = {succeeded:'原生执行成功',failed:'原生执行失败',unknown:'尚无确定结果'};
const acceptance = {accepted:'已接受',not_accepted:'明确未接受',unknown:'尚未确认'};
const operations = {started:'已开始，尚缺结束回执',completed:'已完成',failed:'失败',unknown:'结果待核查'};

export function ProjectInspectionCard({run,command}: {run:CollaborationInvocation;command:WorkbenchCommand}) {
  const [snapshot,setSnapshot] = useState<ProjectInspectionSnapshot>();
  const [busy,setBusy] = useState<'check'|'pick'>(), [error,setError] = useState(''), [note,setNote] = useState('');
  const pending = useRef<AbortController | undefined>(undefined);
  const root = useRef<HTMLElement>(null);
  useEffect(()=>()=>pending.current?.abort(),[]);
  async function inspect(action:'check'|'pick') {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current=controller; setBusy(action); setError(''); setNote('');
    try {
      const base = '/api/conversations/'+encodeURIComponent(run.conversationId)+'/project-inspections/'+encodeURIComponent(run.id);
      const selectedPaths = snapshot?.files.filter(f=>f.origin==='selected').map(f=>f.path) ?? [];
      const body = selectedPaths.length ? {selectedPaths} : {};
      const result = await command<ProjectInspectionSnapshot|{cancelled:true}>(base+'/'+action,body,controller.signal);
      if (controller.signal.aborted) return;
      if ('cancelled' in result) {setNote('已取消选择。');return;}
      if (result.invocationId!==run.id) throw Error('核查记录与本次执行不符，请重新核查。');
      setSnapshot(result);
    } catch(e) { if(!controller.signal.aborted) setError((e as Error).message); }
    finally {
      if(!controller.signal.aborted) {
        pending.current=undefined; setBusy(undefined);
        requestAnimationFrame(()=>{
          const card=root.current;
          if (card && (card.contains(document.activeElement) || document.activeElement===document.body))
            card.querySelector<HTMLButtonElement>('button[data-inspect="'+action+'"]')?.focus({preventScroll:true});
        });
      }
    }
  }
  return <section ref={root} className="cc-project-scene" aria-label="原执行现场" data-project-inspection={run.id}>
    <header><WorkspaceIcon name="history"/><strong>原执行现场</strong></header>
    {!snapshot && <p className="cc-note">{run.status === 'cancelled'
      ? (run.teardown==='confirmed' ? '执行已停止。已写入项目的改动会保留。' : '已写入项目的改动会保留。执行域退出仍待核查。')
      : run.status==='interrupted' || run.recoveryState==='pending' ? '执行结果待核查，可核对本轮回执和已落盘的文件。' : '可以核对本次失败的工具回执和文件。'}</p>}
    {snapshot && <>
      <dl className="cc-project-file-pair">
        <dt>输入</dt><dd>{acceptance[snapshot.acceptance]}</dd><dt>执行结果</dt><dd>{terminal[snapshot.terminal]}</dd>
        <dt>退出回执</dt><dd>{snapshot.teardown==='confirmed'?'已确认':'尚未确认'}</dd>
        <dt>执行域现况</dt><dd>{domain[snapshot.domain.state]}</dd>
      </dl>
      {snapshot.domain.reason && <p className="cc-note">{snapshot.domain.reason}</p>}
      {snapshot.operations.length > 0 && <details><summary>本轮工具回执 · {snapshot.operations.length}</summary><ul>{snapshot.operations.map(op=>
        <li key={op.callId}><strong>{op.name}</strong> · {operations[op.state]}{op.exitCode!==undefined && ' · 退出码 '+op.exitCode}
          {op.paths.map(path=><code key={path}>{path}</code>)}</li>)}</ul></details>}
      <div className="cc-inspected-files"><strong>文件当前状态</strong>
        {snapshot.files.length ? <ul>{snapshot.files.map(f=><li key={f.path}><code>{f.path}</code>
          <span>{f.status==='present'?'当前可读取':'当前无法核对'} · {f.origin==='selected'?'手动选取':'工具回执涉及'}</span>
          {f.sha256 && <details className="cc-export-info"><summary>内容摘要{f.bytes!==undefined?' · '+f.bytes+' 字节':''}</summary><code>{f.sha256}</code></details>}</li>)}</ul>
        : <p>本轮回执中没有可核对的文件路径。</p>}</div>
      {snapshot.truncated && <p>已显示本次核查范围内的部分记录。</p>}
      <small>核查于 <time dateTime={snapshot.checkedAt}>{new Date(snapshot.checkedAt).toLocaleString()}</time>。文件摘要仅代表核查时的内容。</small>
    </>}
    <div className="cc-export-controls"><button type="button" data-inspect="check" disabled={!!busy} onClick={()=>void inspect('check')}>
      {busy==='check'?'正在核查…':snapshot?'重新核查':'核查现场'}</button>
      {snapshot?.canPickFile && snapshot.files.filter(f=>f.origin==='selected').length<4 && <button type="button" disabled={!!busy} data-inspect="pick" onClick={()=>void inspect('pick')}>{busy==='pick'?'正在选择…':'选取项目文件核对'}</button>}</div>
    {note && <p role="status">{note}</p>}{error && <p className="cc-form-error" role="alert">{error}</p>}
  </section>;
}
