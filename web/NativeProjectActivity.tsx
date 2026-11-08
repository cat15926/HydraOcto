import type { AcceptanceEvidence, CollaborationInvocation, ConversationDetail } from '../shared/collaboration';

import { ProjectWebSources } from './ProjectWebSources';
import { NativeFilePermission } from './NativeFilePermission';
import { ProjectInspectionCard } from './ProjectInspectionCard';
import { ProjectExportCard } from './ProjectExportCard';
import { isNpmDownload, ProjectNpmDownload, ProjectNpmTests } from './ProjectNpmActivity';
import { ProjectRevisionActivity } from './ProjectRevisionActivity';
import { ProjectReviewEvidence } from './ProjectReviewEvidence';
import type { WorkbenchCommand } from './WorkbenchPanel';

const names: Record<string, string> = {
  commandExecution: '运行命令', Bash: '运行命令', fileChange: '修改文件', Edit: '修改文件',
  Write: '写入文件', Read: '读取文件', Glob: '查找文件', Grep: '搜索文件内容',
};
const states: Record<string, string> = { started: '进行中', completed: '已完成', failed: '失败', unknown: '结果待核查' };
type Operation = { key: string; name: string; state: string; paths: string[]; command?: string; exitCode?: number };

function projectOperations(evidence: AcceptanceEvidence[], invocationId: string) {
  const operations = new Map<string, Operation>();
  for (const e of evidence) {
    if (e.invocationId !== invocationId || e.kind !== 'tool' || e.detail.origin !== 'native') continue;
    const { nativeSessionId, nativeTurnId, callId, name, state, path, paths, commandLabel, exitCode } = e.detail;
    const key = typeof nativeSessionId === 'string' && typeof callId === 'string' &&
      (nativeTurnId === undefined || typeof nativeTurnId === 'string')
      ? JSON.stringify([nativeSessionId, nativeTurnId, callId]) : e.id;
    const operation: Operation = operations.get(key) ?? { key, name: '使用工具', state: 'started', paths: [] };
    if (typeof name === 'string') operation.name = Object.hasOwn(names, name) ? names[name] : name;
    if (state !== 'started') operation.state = typeof state === 'string' && Object.hasOwn(states, state) ? state : 'unknown';
    const reported = Array.isArray(paths) ? paths : [path];
    for (const item of reported) {
      if (typeof item === 'string' && item && !operation.paths.includes(item)) operation.paths.push(item);
    }
    if (typeof commandLabel === 'string' && commandLabel !== 'Shell') operation.command = commandLabel;
    if (typeof exitCode === 'number') operation.exitCode = exitCode;
    operations.set(key, operation);
  }
  return [...operations.values()];
}

export function NativeProjectActivity({ detail, run, cancelling, stop, command, refresh }: {
  detail: ConversationDetail; run: CollaborationInvocation; cancelling?: boolean; stop?: (id: string) => void;
  command: WorkbenchCommand; refresh: () => Promise<void>;
}) {
  const operations = projectOperations(detail.evidence, run.id);
  const contract = detail.contracts?.find(c => c.id === run.contractId);
  const projectWork = contract?.projectWork, review = contract?.projectReview;
  const reviewSourceId = review && (review.initialReviewSourceId ?? contract?.primarySourceId);
  const reviewSource = reviewSourceId && detail.sources.find(s => s.id === reviewSourceId && s.kind === 'a2a');
  const author = reviewSource && detail.invocations.find(i => i.id === reviewSource.parentInvocationId);
  const request = author && detail.messages.find(m => m.sourceId === reviewSourceId && m.memberId === author.memberId && !m.deletedAt);
  const exports = detail.projectExports?.filter(item => item.invocationId === run.id) ?? [];
  const approvals = (detail.interactions ?? []).filter(i => i.invocationId === run.id && i.kind === 'approval');
  if (!approvals.length && !operations.length && !projectWork && !review && !exports.length && !detail.evidence.some(e => e.invocationId === run.id && e.detail.origin === 'project_web')) return null;
  const replacement = detail.evidence.find(event => event.invocationId === run.id && event.kind === 'session_replaced');
  const reason = typeof replacement?.detail.reason === 'string' ? replacement.detail.reason :
    run.sessionPlan?.mode === 'replace' ? run.sessionPlan.reason : undefined;
  const running = ['prepared', 'running', 'cancel_requested'].includes(run.status);
  return <div className="cc-native-project-activity">
    {projectWork && run.continuity === 'resumed' && <p className="cc-note">已接续该成员上次的项目会话</p>}
    {projectWork && reason && <p className="cc-note">已新建项目会话 · {reason}</p>}
    {approvals.map(i =>
      <NativeFilePermission key={i.id} item={i} latestPull={i.gitDelivery?.pull ? detail.interactions?.slice().reverse().find(other=>
        other.state==='answered' && other.gitDelivery?.pull && other.gitDelivery.remote===i.gitDelivery?.remote &&
        other.gitDelivery.branch===i.gitDelivery?.branch && (other.pullStatus || detail.evidence.some(e=>e.invocationId===other.invocationId &&
          e.detail.origin==='project_git' && e.detail.callId===other.nativeItemId && e.detail.state==='completed'))) : undefined} stopped={!running || run.status === 'cancel_requested'} evidence={detail.evidence} member={run.member.name} command={command} refresh={refresh}/>)}
    {(detail.interactions ?? []).filter(i => i.invocationId === run.id && isNpmDownload(i)).map(i =>
      <ProjectNpmDownload key={i.id} item={i} memberName={run.member.name} stopped={!running || run.status === 'cancel_requested'} command={command} refresh={refresh}/>)}
    <ProjectWebSources events={detail.evidence} invocationId={run.id} running={running}/>
    <ProjectRevisionActivity detail={detail} run={run} source={detail.sources.find(s => s.id === contract?.primarySourceId)}/>
    <ProjectNpmTests events={detail.evidence} run={run}/>
    {exports.map(item => <ProjectExportCard key={item.id} item={item} memberName={run.member.name} command={command} refresh={refresh} />)}
    {review && <ProjectReviewEvidence key={run.id} run={run} paths={review.paths} projectScope={review.mode === 'project'}
      origin={request && author ? {messageId:request.id, memberName:author.member.name} : undefined}
      requestedAgain={detail.sources.some(source => !source.withdrawnAt && source.projectReview?.rereadOf === run.id)}
      evidence={detail.evidence} command={command} refresh={refresh} />}
    {operations.length > 0 && <details><summary>项目执行记录 · {operations.length} 项操作</summary><ol>{operations.map(op => {
      const state = op.state === 'started' && !running ? 'unknown' : op.state;
      return <li key={op.key}><span>{op.name} · {states[state]}</span>{op.paths.map(path => <code key={path}>{path}</code>)}{op.command && <code>{op.command}</code>}{op.exitCode !== undefined && <small>退出码 {op.exitCode}</small>}</li>;
    })}</ol></details>}
    {running && stop && !approvals.some(item => item.state === 'pending' && Date.parse(item.expiresAt) > Date.now()) && <button className="cc-reply-button" disabled={cancelling || run.status === 'cancel_requested'} onClick={() => stop(run.id)}>{run.status === 'cancel_requested' ? '正在等待退出' : '停止本次执行'}</button>}
    {projectWork && (['interrupted','cancelled','failed'].includes(run.status) || !running && run.teardown === 'unknown') &&
      <ProjectInspectionCard key={run.id+':'+String(detail.conversation.workspaceGrant?.revision ?? 0)+':'+String(detail.conversation.archivedAt ?? detail.conversation.deletedAt ?? '')} run={run} command={command} />}
  </div>;
}
