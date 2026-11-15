import {carrierNames, type AcceptanceEvidence, type CollaborationInvocation, type ExecutionContractSnapshot} from './collaboration.js';

/** Display the frozen executor, never the member's subsequently edited configuration. */
export function executionIdentity(run: CollaborationInvocation, contract: Pick<ExecutionContractSnapshot, 'accountMetadataSnapshot' | 'memberSnapshot'> | undefined, evidence: AcceptanceEvidence[]) {
  const member=contract?.memberSnapshot ?? run.member;
  const sessions=evidence.filter(e=>e.invocationId===run.id && e.kind==='session' && typeof e.detail.model==='string' && e.detail.model.trim());
  const confirmed=sessions.at(-1)?.detail.model as string | undefined;
  const auth=contract?.accountMetadataSnapshot.auth;
  const status: Record<string,string>={prepared:'等待启动',running:run.acceptance==='accepted'?'执行中':'启动中，等待接受确认',succeeded:'执行完成',failed:'执行失败',interrupted:'执行中断',cancel_requested:'正在停止',cancelled:'已停止'};
  return {
    runtime:carrierNames[member.carrier],
    model:confirmed ?? (member.model ? member.model+'（配置值，待确认）' : '尚未确认'),
    modelEvidence:confirmed ? '模型名称由本次原生会话回执确认；不代表供应商后台实现的独立核验。' : '尚无本次运行时模型回执，配置值不作为实际模型证明。',
    authentication:auth==='api'?'API 密钥':auth==='cli'?'官方 CLI 登录':'历史认证方式未记录',
    status:(status[run.status]??run.status)+(!['prepared','running','cancel_requested'].includes(run.status) && run.teardown!=='confirmed'?' · 退出待核查':''),
  };
}
