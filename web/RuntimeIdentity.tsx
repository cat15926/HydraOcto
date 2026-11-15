import type {CollaborationInvocation, ConversationDetail} from '../shared/collaboration';
import {executionIdentity} from '../shared/runtime-identity';
export function RuntimeIdentity({detail,run}:{detail:ConversationDetail;run:CollaborationInvocation}) {
  const identity=executionIdentity(run,detail.contracts?.find(c=>c.id===run.contractId),detail.evidence);
  return <section className="cc-runtime-identity" aria-label="本次执行身份"><dl>
    <div><dt>运行时</dt><dd>{identity.runtime}</dd></div>
    <div><dt>实际模型</dt><dd title={identity.modelEvidence}>{identity.model}</dd></div>
    <div><dt>认证方式</dt><dd>{identity.authentication}</dd></div>
    <div><dt>执行状态</dt><dd>{identity.status}</dd></div>
  </dl><details><summary>模型确认依据</summary><p>{identity.modelEvidence}</p></details></section>;
}
