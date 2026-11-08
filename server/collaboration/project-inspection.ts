import { relative, isAbsolute } from 'node:path';
import type { AcceptanceEvidence, CollaborationInvocation, ProjectInspectionSnapshot } from '../../shared/collaboration.js';
import { AppError, now } from '../store.js';
import type { CollaborationStore } from './store.js';
import { projectFileDigest, safeProjectPath } from './project-file-read.js';

type Domain = ProjectInspectionSnapshot['domain'];
const unauthorizedDomain:Domain={state:'unknown',reason:'原项目授权已变化，现仅展示已保存的执行回执。'};
type Probe = (id:string,evidence:AcceptanceEvidence[])=>Promise<Domain>;
const unknownDomain = ():Domain => ({state:'unknown',reason:'缺少可核对的原执行域证据。'});
const operationNames = new Set(['Read','Edit','Write','Glob','Grep','Bash','commandExecution','fileChange']);
const operationStates = new Set(['started','completed','failed','unknown']);

function exactNative(run: CollaborationInvocation, detail:Record<string,unknown>) {
  if (!run.nativeSessionId || detail.nativeSessionId!==run.nativeSessionId) return false;
  if (run.member.carrier==='codex-app-server') return !!run.nativeTurnId && detail.nativeTurnId===run.nativeTurnId;
  return run.member.carrier==='claude-cli' && detail.nativeTurnId===undefined;
}

function summarize(run:CollaborationInvocation, evidence:AcceptanceEvidence[]) {
  const operations = new Map<string,ProjectInspectionSnapshot['operations'][number]>();
  const terminals = new Set<'succeeded'|'failed'>();
  let truncated=false;
  for (const event of evidence) {
    const d = event.detail;
    if (!exactNative(run,d)) {
      if (event.kind==='diagnostic' && d.observation==='native_tool_limit' && d.nativeSessionId===run.nativeSessionId) truncated=true;
      continue;
    }
    if (event.kind==='diagnostic' && d.observation==='native_terminal' && d.protocol===run.member.carrier &&
      (d.status==='succeeded' || d.status==='failed')) terminals.add(d.status);
    if (event.kind!=='tool' || d.origin!=='native' || typeof d.callId!=='string' || !/^[\w.:-]{1,200}$/.test(d.callId) ||
      typeof d.name!=='string' || !operationNames.has(d.name) || typeof d.state!=='string' || !operationStates.has(d.state)) continue;
    const prior=operations.get(d.callId);
    if (prior && (prior.state!=='started' || prior.name!==d.name)) continue;
    const paths=[...new Set([...(prior?.paths ?? []),d.path,...(Array.isArray(d.paths)?d.paths:[])].filter(safeProjectPath))];
    truncated ||= d.pathsTruncated===true || paths.length>32;
    operations.delete(d.callId); // Keep order of last observation, even when two tools overlap.
    operations.set(d.callId,{callId:d.callId,name:d.name,state:d.state as 'started'|'completed'|'failed'|'unknown',paths:paths.slice(0,32),
      observedAt:event.createdAt,...(typeof d.exitCode==='number' && Number.isSafeInteger(d.exitCode)?{exitCode:d.exitCode}:{})});
  }
  return {operations:[...operations.values()].slice(-32),terminal:terminals.size===1 ? [...terminals][0]! : 'unknown' as const,
    truncated:truncated || operations.size>32};
}

export class ProjectInspection {
  constructor(private readonly store:CollaborationStore, private readonly probe?:Probe) {}

  private context(cid:string,id:string) {
    const run=this.store.invocation(id);
    if (run.conversationId!==cid) throw new AppError(404,'找不到此会话的项目执行。');
    const conversation=this.store.visibility.assertConversation(cid), contract=this.store.contract(id), source=this.store.visibility.primary(id);
    if (conversation.importedFor || contract.invocationId!==id || contract.memberSnapshot.id!==run.memberId || !contract.projectWork ||
      contract.visibility || contract.projectReview || !source.projectWork || source.visibility || source.withdrawnAt ||
      source.excerptRefs?.length || source.conversationId!==cid || !source.requestedTargets.includes(run.memberId)) {
      throw new AppError(404,'此执行没有可访问的项目现场。');
    }
    return {run,contract};
  }

  private activeGrant(cid:string,id:string) {
    const {run,contract}=this.context(cid,id), g=contract.workspaceGrant;
    if (!g || g.mode!=='project-work' || g.conversationId!==cid || !g.memberIds?.includes(run.memberId)) return;
    try {
      this.store.visibility.validateInvocation(id);
      return this.store.projectReviews.requireGrant(cid,run.memberId,g.revision,g);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
    }
  }
  pickRoot(cid:string,id:string) {
    const grant=this.activeGrant(cid,id);
    if (!grant) throw new AppError(409,'原项目授权已变化，请在当前授权范围内操作。');
    return grant.path;
  }
  selectedPath(cid:string,id:string,absolute:string) {
    const root=this.pickRoot(cid,id), path=relative(root,absolute);
    if (!isAbsolute(absolute) || !safeProjectPath(path)) throw new AppError(400,'请选择原授权项目中的普通文件。');
    return path;
  }

  async check(cid:string,id:string,selection:unknown,signal?:AbortSignal):Promise<ProjectInspectionSnapshot> {
    if (!Array.isArray(selection) || selection.length>4 || selection.some(path=>!safeProjectPath(path))) throw new AppError(400,'每次最多核对 4 个所选项目文件。');
    const {run}=this.context(cid,id);
    const rows=this.store.db.prepare("SELECT value FROM cc_evidence WHERE invocation_id=? AND json_extract(value,'$.kind') IN ('prepared','tool','diagnostic') ORDER BY rowid").all(id) as {value:string}[];
    const evidence=rows.map(row=>JSON.parse(row.value) as AcceptanceEvidence).filter(e=>e.invocationId===id);
    const summary=summarize(run,evidence);
    const paths=[...new Set(summary.operations.slice().reverse().flatMap(op=>op.paths))];
    const files: ProjectInspectionSnapshot['files']=[];
    const pending=new Map<string,'receipt'|'selected'>(paths.slice(0,8).map(p=>[p,'receipt']));
    for(const selected of selection) pending.set(selected,paths.includes(selected)?'receipt':'selected');

    const authorized=!!this.activeGrant(cid,id);
    const domain=authorized && this.probe ? await this.probe(id,evidence).catch(unknownDomain) : unknownDomain();
    for(const [path,origin] of pending) {
      signal?.throwIfAborted();
      const grant=this.activeGrant(cid,id);
      const entry={path,origin,status:'unavailable' as const};
      if (!grant) {files.push(entry); continue;}
      try {
        const digest=await projectFileDigest(grant,path,signal);
        files.push({...entry,status:'present',...digest});
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        files.push(entry);
      }
    }
    signal?.throwIfAborted();
    const canPickFile=!!this.activeGrant(cid,id);
    return {invocationId:id,checkedAt:now(),acceptance:run.acceptance,teardown:run.teardown,domain:canPickFile ? domain : unauthorizedDomain,...summary,
      files:canPickFile ? files : files.map(({path,origin})=>({path,origin,status:'unavailable'})),
      truncated:summary.truncated || paths.length>8,canPickFile};
  }
}
