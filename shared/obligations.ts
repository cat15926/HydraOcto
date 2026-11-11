export type ObligationState = 'open' | 'delegated' | 'waiting' | 'delivery_pending' | 'awaiting_acceptance' | 'delivered' | 'blocked' | 'cancelled';
export interface ObligationEndpoint {
  memberId: string;
  instanceId: string;
  generation: number;
}
export interface ObligationDelegation {
  obligationId: string;
  version: string;
  acceptance: string;
}
export interface ObligationReport {
  outcome: 'passed' | 'failed' | 'blocked';
  version: string;
  summary: string;
  invocationId: string;
  evidenceIds: string[];
  authority: 'member' | 'project_test';
}
export interface ObligationWait {
  kind?: 'event' | 'timer';
  /** The member who must receive the result, even after a restart. */
  returnTo?: ObligationEndpoint;
  ownerRevision?: number;
  firedAt?: string;
  id: string;
  condition: string;
  deadline: string;
  signal?: { requestId: string; summary: string; receivedAt: string };
}
export interface Obligation {
  id: string;
  conversationId: string;
  parentId?: string;
  taskId?: string;
  ownerRevision?: number;
  owner: ObligationEndpoint;
  returnTo?: ObligationEndpoint;
  goal: string;
  acceptance: string;
  acceptBy: 'delivery' | 'user' | 'report';
  userAcceptance?: {sourceRevision: number; quote: string} & (
    {messageId: string; taskId?: never} | {taskId: string; messageId?: never}
  );
  state: ObligationState;
  originSourceId: string;
  originInvocationId: string;
  currentSourceId: string;
  /** Each committed wake owns a separate source and never reuses the original authority. */
  wakeSourceId?: string;
  version?: string;
  projectReview?: true;
  testArgv?: string[];
  report?: ObligationReport;
  wait?: ObligationWait;
  waitCount?: number;
  activeGroupId?: string;
  groupCount?: number;
  delivery?: { invocationId: string; summary: string; messageId?: string };
  /** A failed report may still have one intentional return to the owner. */
  blockedReturnSourceId?: string;
  reminderCount: number;
  reason?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
