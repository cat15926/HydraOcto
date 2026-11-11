import type { MessageVisibility, ProjectReviewScope } from '../../shared/collaboration.js';

const text = { type: 'string', minLength: 1 };
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object', properties, required, additionalProperties: false,
});

export const obligationDeliverySchema = object(
  { obligationId: text, version: text, acceptance: text },
  ['obligationId', 'version', 'acceptance'],
);

const list = {
  name: 'obligation_list',
  description: 'Read the commitments accessible to this room member. Use the current request and version to select the relevant record.',
  inputSchema: object({}, []),
};
const report = {
  name: 'obligation_report',
  description: 'Report the result of the subtask assigned to this exact execution and requested version. For a project pass, read the requested files and run the agreed check. The test receipt snapshotSha256 must equal the requested version. The platform can identify receipts from this execution when evidenceId is omitted. Report failed or blocked when verification fails or cannot be performed.',
  inputSchema: object({
    obligationId: text, version: text, summary: text, evidenceId: text,
    outcome: { type: 'string', enum: ['passed', 'failed', 'blocked'] },
  }, ['obligationId', 'version', 'outcome', 'summary']),
};
const ordinary = [
  list, report,
  {
    name: 'obligation_open',
    description: 'Register your commitment to deliver the user request. Use for work that needs follow-up. Questions you can answer now and information-only messages need no commitment.',
    inputSchema: object({
      goal: text,
      acceptance: { type: 'string', enum: ['delivery', 'user'], description: 'Use delivery for reporting a result, even when another member must verify it first. Only an explicit request from the user for final personal approval can reserve a manual acceptance step. The returned acceptBy is authoritative.' },
    }, ['goal']),
  },
  {
    name: 'obligation_wait',
    description: 'Record the condition you are waiting for and its deadline on your commitment. Explain the exact event or run to observe.',
    inputSchema: object({ obligationId: text, condition: text, deadline: text }, ['obligationId', 'condition', 'deadline']),
  },
  {
    name: 'obligation_deliver',
    description: 'Prepare your final delivery to the user once the acceptance conditions are met. Include summary verbatim in the final public reply of this same execution to establish delivery.',
    inputSchema: object({ obligationId: text, summary: text }, ['obligationId', 'summary']),
  },
];

interface ObligationToolScope {
  obligationPolicy?: boolean;
  toolPolicyVersion?: string;
  visibility?: MessageVisibility;
  projectWork?: boolean;
  projectReview?: ProjectReviewScope;
}

export function obligationTools(scope: ObligationToolScope) {
  if (scope.obligationPolicy !== true || scope.toolPolicyVersion !== 'cross-action-v1' || scope.visibility) return [];
  if (scope.projectReview) return scope.projectWork ? [] : [list, report];
  return ordinary;
}
