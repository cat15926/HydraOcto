import {carrierNames,type CollaborationBootstrap,type Member} from '../shared/collaboration';
/** Configuration labels are intentionally distinct from the execution's native model receipt. */
export function memberRuntimeDescription(data:CollaborationBootstrap,member:Member) {
  const defaults=data.defaults?.find(d=>d.carrier===member.carrier);
  const accountId=member.accountBinding==='follow'?defaults?.accountId:member.accountId;
  const account=data.accounts.find(a=>a.id===accountId);
  const model=member.modelBinding==='follow'?defaults?.model:member.model;
  return `运行时 ${carrierNames[member.carrier]} · 配置模型 ${model || '运行时默认'} · 认证 ${account?.auth==='api'?'API 密钥':account?.auth==='cli'?'官方 CLI 登录':'未配置'}`;
}
