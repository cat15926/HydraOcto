import type { CollaborationRuntime } from '../../shared/collaboration.js';
import { AppError } from '../store.js';
import { managedProbeArgv } from './native-command-approval.js';
import type { CollaborationStore } from './store.js';

export async function runEnvironmentCheck(store: CollaborationStore, invocationId: string, args: Record<string, unknown>, callId: string,
  signal: AbortSignal, execute: CollaborationRuntime['runProjectReviewTest'], cancel: () => void) {
  if (!execute || Object.keys(args).length !== 1 || typeof args.command !== 'string' || !callId || callId.length > 150) {
    throw new AppError(400,'请提供一个可以在项目副本运行的环境检查命令。');
  }
  const argv = managedProbeArgv(args.command);
  const run = store.invocation(invocationId);
  const grant = store.contract(invocationId).workspaceGrant;
  const {nativeSessionId, nativeTurnId} = run;
  const providerRequestId = 'project-check:'+callId;
  if (!grant || !nativeSessionId || !nativeTurnId || run.member.carrier !== 'codex-app-server') {
    throw new AppError(409,'当前项目执行无法核对环境检查请求。');
  }
  function verifyAuthorization() {
    signal.throwIfAborted();
    const current = store.invocation(invocationId);
    if (!store.checkNativeFilePermission(invocationId) || current.nativeSessionId !== nativeSessionId || current.nativeTurnId !== nativeTurnId) {
      throw new AppError(409,'原执行或项目授权已变化，环境检查已停止。');
    }
  }
  verifyAuthorization();
  const decision = await store.interactions.wait(invocationId,{
    kind:'approval',operation:'project_environment_check',nativeSessionId,nativeTurnId,nativeItemId:callId,providerRequestId,
    nativeCommand:{command:args.command,cwd:'/work'},payload:{grantRevision:grant.revision},
  },'project-check',signal);
  if (decision.cancelledByUser) cancel();
  if (decision.state !== 'answered' || !store.interactions.canReturn(invocationId,providerRequestId,nativeSessionId,nativeTurnId,callId)) {
    throw new AppError(409,'本次环境检查未获允许。');
  }
  verifyAuthorization();
  const evidence = {origin:'project_environment',name:'project_environment_check',nativeSessionId,nativeTurnId,callId,argv};
  store.recordEvidence(invocationId,{kind:'tool',detail:{...evidence,state:'started'}});
  try {
    const result = await execute({grant,argv,signal,authorInvocationId:invocationId,verifyAuthorization});
    verifyAuthorization();
    if (result.treeExited !== true || !Number.isInteger(result.exitCode) || !/^[a-f0-9]{64}$/.test(result.snapshotSha256) ||
        JSON.stringify(result.argv) !== JSON.stringify(argv)) throw new AppError(409,'没有收到此环境检查的完整执行回执。');
    store.recordEvidence(invocationId,{kind:'tool',detail:{...evidence,state:result.exitCode === 0 ? 'completed' : 'failed',
      exitCode:result.exitCode,snapshotSha256:result.snapshotSha256,treeExited:true}});
    return {...result,executor:'project_environment',cwd:'/work'};
  } catch (error) {
    store.recordEvidence(invocationId,{kind:'tool',detail:{...evidence,state:'failed'}});
    throw error;
  }
}
