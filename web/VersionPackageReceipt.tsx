import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { VersionPackageView } from '../shared/version-packages';
import type { WorkbenchCommand } from './WorkbenchPanel';
import './review-progress.css';

type Material = VersionPackageView['materials'][number];
type Part = VersionPackageView['parts'][number];
type Props = {bundle: VersionPackageView; conversationId: string; command: WorkbenchCommand; refresh: () => Promise<void>};
type Edit = {key: string; baseVersionId: string; content: string; revision: number; original: string};
const packageLabels: Record<VersionPackageView['state'], string> = {draft:'准备中', needs_review:'需要复核', published:'已发布'};
const partLabels: Record<Part['state'], string> = {missing:'等待交付',unknown:'依据待核实',needs_review:'需要重验',pending:'等待验收',accepted:'已验收'};

export function VersionPackageReceipt({bundle, conversationId, command, refresh}: Props) {
  const [edit, setEdit] = useState<Edit>(), [busy,setBusy] = useState(false), [error,setError] = useState(''), [notice,setNotice] = useState('');
  const [uncertain,setUncertain] = useState(false);
  const request = useRef<{id:string; body:string} | undefined>(undefined);
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement | null>(null), sending = useRef(false);
  const summary = useRef<HTMLElement>(null), titleId = useId(), retry = useRef<HTMLButtonElement>(null);
  const material = bundle.materials.find(m => m.key === edit?.key);
  // Revocation may change the readable projection even when the package revision stays the same.
  const canReadBase = !!edit && !!material?.versionId && material.history.some(v => v.versionId === edit.baseVersionId);
  const stale = edit && (bundle.revision !== edit.revision || material?.versionId !== edit.baseVersionId);
  useEffect(() => {
    if (!edit || canReadBase) return;
    request.current = undefined;
    close();
    setNotice('原资料已无法读取，编辑已关闭。');
  }, [edit, canReadBase]);
  function open(m:Material, button:HTMLButtonElement) {
    trigger.current = button; request.current = undefined;
    setEdit({key:m.key,baseVersionId:m.versionId,content:m.content,original:m.content,revision:bundle.revision});setError('');setNotice('');setUncertain(false);
    dialog.current?.showModal();
  }
  function close() {
    dialog.current?.close();setEdit(undefined);setError('');setUncertain(false);
    const target = trigger.current;
    requestAnimationFrame(() => (target?.isConnected && !target.disabled ? target : summary.current)?.focus({preventScroll:true}));
  }
  async function save(event:FormEvent) {
    event.preventDefault();
    if (!edit || !canReadBase || sending.current || (!uncertain && (stale || !bundle.editable || !edit.content.trim() || edit.content === edit.original))) return;
    const fields = {key:edit.key,content:edit.content,expectedRevision:edit.revision,expectedMaterialVersionId:edit.baseVersionId};
    const body = JSON.stringify(fields);
    if (request.current?.body !== body) request.current = {body,id:crypto.randomUUID()};
    sending.current=true; setBusy(true);setError('');
    try {
      await command(`/api/conversations/${conversationId}/version-packages/${bundle.id}/change`,{...fields,requestId:request.current.id});
      close();setNotice('已保存新版本。');await refresh().catch(()=>undefined);
    } catch(e) {
      const problem = e as Error & {status?:number};
      const lost = !problem.status || problem.status === 408 || problem.status >= 500;
      setUncertain(lost);setError(problem.message);
      if (!lost) request.current=undefined;
      await refresh().catch(()=>undefined);
      if (lost) requestAnimationFrame(()=>retry.current?.focus());
    } finally { sending.current=false;setBusy(false); }
  }
  const accepted = bundle.parts.filter(p=>p.state==='accepted').length;
  function basisLabel(part:Part, key:string) {
    const material=bundle.materials.find(m=>m.key===key);
    if (!material) return '关联资料';
    if (material.number === undefined) return material.name;
    const usedId=part.basis?.find(ref=>ref.key===key)?.versionId;
    const used=material.history.find(version=>version.versionId===usedId);
    if (!used) return material.name;
    return used.number===material.number ? `${material.name} v${used.number}` : `${material.name} v${used.number}（当前 v${material.number}）`;
  }
  return <details className="cc-review-progress" data-version-package={bundle.id}>
    <summary ref={summary}><strong>{bundle.title}</strong><span>{packageLabels[bundle.state]} · 已验收 {accepted}/{bundle.parts.length} 项</span></summary>
    <h4>依据资料</h4>
    <ul className="cc-review-rows">{bundle.materials.map(m=><li key={m.key}>
      <strong>{m.name}{m.number !== undefined && ` · v${m.number}`}</strong><p>{m.content}</p>
      {bundle.editable && !!m.versionId && <button type="button" aria-label={'修改'+m.name} onClick={e=>open(m,e.currentTarget)}>修改资料</button>}
    </li>)}</ul>
    <h4>分项交付</h4>
    <ul className="cc-review-rows">{bundle.parts.map(part=><li key={part.key}>
      <strong>{part.label}</strong><small>{partLabels[part.state]}</small>
      <p>{part.dependsOn === undefined ? '依据待核实' : part.dependsOn.length
        ? '依赖资料 · '+part.dependsOn.map(key=>basisLabel(part,key)).join('、') : '独立交付'}</p>
      {part.reason && <p>{part.reason}</p>}
      {(part.content || !!part.history.length) && <details><summary>查看交付与验收记录</summary>
        {part.content && <p>{part.content}</p>}
        <ul className="cc-review-rows">{part.history.map(entry=><li key={entry.reviewId ?? entry.submissionId}>
          <strong>v{entry.number} · {entry.verdict==='accept'?'验收通过':entry.verdict==='changes_requested'?'需要修改':'已提交'}</strong>
          <small>{entry.current?'当前依据':'历史记录'}</small>{entry.note && <p>{entry.note}</p>}
        </li>)}</ul>
      </details>}
    </li>)}</ul>
    {notice && <p role="status">{notice}</p>}
    <dialog ref={dialog} aria-labelledby={titleId} className="cc-version-dialog" onCancel={e=>{e.preventDefault();if (!busy) close();}}>
      {edit && canReadBase && <form className="cc-settings-form" onSubmit={save}>
        <h3 id={titleId}>修改{material?.name ?? '资料'}</h3>
        <label>新版内容<textarea autoFocus required value={edit.content} readOnly={busy || uncertain} onChange={e=>setEdit({...edit,content:e.target.value})}/></label>
        <p>保存后，引用旧版的交付需要复核。</p>
        {stale && !uncertain && <div role="status"><p>资料包已更新。当前原文为</p><blockquote>{material?.content}</blockquote>
          {material && bundle.editable && <button type="button" onClick={()=>{setEdit({...edit,original:material.content,baseVersionId:material.versionId,revision:bundle.revision});setError('');}}>按当前版本继续编辑</button>}
        </div>}
        {error && <p role="alert">{error}</p>}
        <div><button disabled={busy} type="button" onClick={close}>{uncertain ? '关闭' : '取消'}</button><button ref={retry} type="submit"
          disabled={busy || (!uncertain && (!bundle.editable || !!stale || !edit.content.trim() || edit.content===edit.original))}>
          {busy?'正在保存…':uncertain?'重试保存':'保存新版本'}</button></div>
      </form>}
    </dialog>
  </details>;
}
