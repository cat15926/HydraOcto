/** Independently implemented continuous-collaboration protocol, round 1. */
export type Carrier = 'codex-app-server' | 'claude-cli' | 'openai-api' | 'anthropic-api';
export type ExecutionMode = 'serial' | 'parallel';
export type InvocationStatus = 'prepared' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'cancel_requested' | 'cancelled';
export interface CollaborationAccount {
  id: string; name: string; provider: 'codex' | 'claude' | 'openai' | 'anthropic';
  auth: 'cli' | 'api'; apiKeyEnv?: string; baseUrl?: string; revision?: number;
}
export interface Member {
  id: string; name: string; instructions: string; carrier: Carrier; accountId: string;
  model?: string; enabled: boolean; revision?: number;
}
export interface Conversation {
  id: string; title: string; memberIds: string[]; defaultMemberId: string;
  createdAt: string; updatedAt: string; revision?: number;
  preferredMemberIds?: string[]; routingMode?: 'normal' | 'concierge';
}
export interface ConversationMessage {
  id: string; conversationId: string; author: 'user' | 'member' | 'system';
  memberId?: string; sourceId?: string; responseId?: string; content: string; createdAt: string; sequence?: number;
}
export interface SourceWork {
  id: string; conversationId: string; kind: 'user' | 'a2a' | 'a2a_failure' | 'mention' | 'task' | 'task_handoff';
  content: string; requestedTargets: string[]; bindingState: 'bound' | 'unresolved';
  parentInvocationId?: string; authorMemberId?: string; revision: number; sequence: number;
  depth: number; createdAt: string; routingDecisionId?: string;
  taskRef?: { taskId: string; ownerRevision: number; handoffId?: string };
}
export interface Delivery {
  id: string; sourceId: string; memberId: string; status: 'pending' | 'consumed' | 'held' | 'withdrawn';
  responseId?: string; holdReason?: string; revision: number;
}
export interface DispatchBatch {
  id: string; sourceId: string; targets: string[]; mode: ExecutionMode; createdAt: string; historyCutoff?: number;
}
export interface CollaborationInvocation {
  id: string; conversationId: string; batchId: string; responseId: string; memberId: string;
  member: Member; status: InvocationStatus; acceptance: 'unknown' | 'accepted' | 'not_accepted';
  nativeSessionId?: string; nativeTurnId?: string; continuity: 'fresh' | 'resumed' | 'unknown';
  teardown: 'unknown' | 'confirmed'; dispatchStarted: boolean;
  error?: string; createdAt: string; startedAt?: string; finishedAt?: string;
  contractId?: string; invocationRevision?: number; cancelRevision?: number;
  interruptionCause?: 'service_restart' | 'service_stop' | 'user_cancel' | 'legacy_unknown' | 'runtime_unknown';
  recoveryState?: 'none' | 'pending' | 'resolved'; resolutionId?: string;
  blockedReason?: string; sessionPlan?: NativeSessionPlan; usage?: RuntimeUsage;
  taskBindings?: { taskId: string; ownerRevision: number; fence: string }[];
}
export interface CollaborationResponse {
  id: string; invocationId: string; conversationId: string; memberId: string;
  status: InvocationStatus; content: string; inputSourceIds: string[]; inputRevision: number;
  createdAt: string; finishedAt?: string;
}
export interface Consumption {
  id: string; sourceId: string; deliveryId: string; memberId: string; responseId: string;
  kind: 'prompt'; createdAt: string;
}
export interface AcceptanceEvidence {
  id: string; invocationId: string; kind: RuntimeEvent['kind']; detail: Record<string, unknown>; createdAt: string;
}
export interface CollaborationEvent {
  id: number; conversationId: string; type: string; data: Record<string, unknown>; createdAt: string;
}
export interface ConversationDetail {
  conversation: Conversation; messages: ConversationMessage[]; sources: SourceWork[]; deliveries: Delivery[];
  batches: DispatchBatch[]; invocations: CollaborationInvocation[]; responses: CollaborationResponse[];
  consumptions: Consumption[]; evidence: AcceptanceEvidence[]; events: CollaborationEvent[];
  contracts?: ExecutionContractSnapshot[]; inputManifests?: InputManifest[];
  routingDecisions?: RoutingDecision[]; recoveryChecks?: RecoveryCheck[]; holdRechecks?: HoldRecheck[];
  nativeSessions?: NativeSessionBinding[];
  tasks?: OrdinaryTask[]; taskHandoffs?: TaskHandoff[]; responsibility?: ResponsibilityItem[];
}
export type OrdinaryTaskStatus = 'todo' | 'doing' | 'blocked' | 'done';
export interface TaskExecutionRef {
  invocationId: string; responseId: string; conversationId: string; memberId: string;
  sourceId: string; sourceRevision: number; inputRevision: number; fence: string;
  nativeSessionId?: string; nativeTurnId?: string;
}
export type TaskActor = { kind: 'user' } | { kind: 'agent'; invocationId: string; memberId: string; sourceId: string; sourceRevision: number; cancelRevision: number };
export interface OrdinaryTask {
  id: string; conversationId: string; title: string; description: string; status: OrdinaryTaskStatus;
  ownerMemberId: string | null; ownerRevision: number; revision: number;
  executionRef?: TaskExecutionRef; lastExecutionRef?: TaskExecutionRef; currentSourceId?: string; pendingHandoffId?: string;
  createdBy: TaskActor; createdAt: string; updatedAt: string; statusReason?: string;
  disposition?: { kind: 'frozen' | 'degraded' | 'abandoned'; reason: string; actor: TaskActor; createdAt: string };
}
export interface TaskHandoff {
  id: string; taskId: string; conversationId: string; expectedOwnerRevision: number;
  fromMemberId: string | null; toMemberId: string; actor: TaskActor; executionRef?: TaskExecutionRef;
  sourceId: string; sourceRevision: number; sourceDigest: string; state: 'waiting' | 'applied' | 'cancelled' | 'refused';
  reason: string; revision: number; stopRequested: boolean; createdAt: string; updatedAt: string;
}
export interface TaskCommandVersion { requestId: string; expectedRevision: number; expectedOwnerRevision: number }
export interface CreateOrdinaryTask { requestId: string; title: string; description: string; ownerMemberId?: string | null }
export interface UpdateOrdinaryTask extends TaskCommandVersion {
  status?: OrdinaryTaskStatus; reason?: string; disposition?: 'frozen' | 'degraded' | 'abandoned';
}
export interface HandoffOrdinaryTask extends TaskCommandVersion { targetMemberId: string; reason: string; stopCurrent?: boolean }
export interface ResponsibilityItem {
  key: string; kind: 'task' | 'message'; taskId?: string; sourceId?: string; memberId?: string; ownerMemberId?: string | null; invocationId?: string;
  state: 'pending' | 'active' | 'waiting' | 'resolved' | 'attention'; reason: string;
  diagnostic?: 'dead' | 'void' | 'zombie'; disposition?: 'frozen' | 'degraded' | 'abandoned';
}
/** A native binding belongs to one conversation/member, never to an account alone. */
export interface NativeSessionIdentity {
  supported: boolean; version?: string; fingerprint?: string; reason: string;
}
export interface NativeSessionPlan {
  bindingId?: string; mode: 'fresh' | 'resume' | 'replace' | 'unsupported'; reason: string;
  nativeSessionId?: string; previousAnchor?: string; identity?: NativeSessionIdentity;
}
export interface NativeSessionBinding {
  id: string; conversationId: string; memberId: string; sequence: number; previousBindingId?: string;
  status: 'reserved' | 'ready' | 'sealed'; reason: string; fingerprint: string;
  accountId: string; accountRevision: number; model?: string; workspaceScope: string;
  carrier: Carrier; runtimeVersion?: string; createdAt: string; updatedAt: string;
  nativeSessionId?: string; anchor?: string; lastInvocationId: string; evidenceId?: string;
}
/** Values are native reports, not estimates or billing guarantees. Absent means unknown. */
export interface RuntimeUsage {
  source: string; scope: 'last_model_request' | 'invocation'; inputTokens?: number; outputTokens?: number;
  cachedInputTokens?: number; cacheWriteInputTokens?: number; totalTokens?: number; costUsd?: number;
}
export interface RoutingDecision {
  id: string; sourceId?: string; targets: string[]; reason: string; policyVersion: string;
  historyCursor: number; configurationRevision: number; excludedTargets?: string[];
}
/** Frozen background visibility is not delivery to the current response. */
export interface HistorySourceResponsibility {
  sourceId: string; sourceRevision: number; requestedTargets: string[]; visibilityOnly: true;
  deliveries: {
    deliveryId: string; memberId: string; status: Delivery['status']; revision: number;
    responseId?: string; holdReason?: string;
    consumptions: Pick<Consumption, 'id' | 'responseId' | 'kind'>[];
  }[];
}
export interface ExecutionContractSnapshot {
  id: string; invocationId: string; behaviorVersion: string; routingDecisionId?: string; routingPolicyVersion: string;
  contextPolicyVersion: string; toolPolicyVersion: string; adapterCapabilityVersion: string;
  memberSnapshot: Member; accountMetadataSnapshot: CollaborationAccount; workspaceScope: string;
  roster: Member[]; historyCutoff: number; historyMessageIds: string[]; createdAt: string;
  snapshotOrigin?: 'admission' | 'legacy_reconstructed';
  historySnapshot?: ConversationMessage[]; sourceRevision?: number; sourceDigest?: string;
  historySourceSnapshots?: HistorySourceResponsibility[];
  taskSnapshot?: OrdinaryTask;
}
export interface InputManifestItem {
  kind: string; reference: string; representation: string; reason?: string; characters: number; complete: boolean;
  visibilityOnly?: true; responsibilityEvidence?: 'frozen' | 'not_captured' | 'not_applicable';
  sourceResponsibility?: HistorySourceResponsibility;
}
export interface InputManifest {
  id: string; invocationId: string; responseId: string; inputRevision: number; sourceRevision: number; contractId: string;
  historyCutoff: number; items: InputManifestItem[];
  budget: { maxEstimatedTokens: number; usedEstimatedTokens: number; method: string };
  payloadRef: string; renderVersion: string; renderDigest: string; digestStage: 'platform_prompt';
  assemblyState: 'prepared'; createdAt: string; caller?: { memberId: string; invocationId: string };
}
export interface RecoveryRequest {
  requestId: string; expectedInvocationRevision: number; expectedCancelRevision: number; expectedInputRevision: number;
}
export interface RuntimeInspectionRequest {
  invocationId: string; conversationId: string; member: Member; account: CollaborationAccount;
  nativeSessionId?: string; nativeTurnId?: string; workspaceScope?: string;
}
export interface RuntimeInspection {
  invocationId: string; carrier: Carrier; nativeSessionId?: string; nativeTurnId?: string;
  state: 'running' | 'settled' | 'unknown' | 'unsupported';
  acceptance: 'accepted' | 'not_accepted' | 'unknown'; teardown: 'confirmed' | 'unknown';
  result?: { status: 'succeeded' | 'failed'; content: string };
  reason: string; observedAt: string; evidence: RuntimeEvent[];
}
export interface RecoveryCheck {
  id: string; invocationId: string; requestId: string; expectedInvocationRevision: number;
  expectedCancelRevision: number; expectedInputRevision: number;
  resolution: 'running' | 'unresolved' | 'closed_result_unknown' | 'resolved' | 'already_settled';
  reason: string; observation: RuntimeInspection; createdAt: string;
}
export interface HoldRecheck {
  id: string; sourceId: string; deliveryId: string; memberId: string; requestId: string;
  expectedDeliveryRevision: number; expectedSourceRevision: number;
  outcome: 'pending' | 'held'; reason: string; createdAt: string;
}
export interface RuntimeCapability {
  carrier: Carrier; installed: boolean; version?: string; available: boolean; reason?: string;
  append: false; authentication: 'cli' | 'api'; verified: 'unverified' | 'protocol_tested' | 'live_tested';
}
export interface CollaborationBootstrap {
  version: string; workspace: string; csrfToken: string; members: Member[];
  accounts: (CollaborationAccount & { configured: boolean })[];
  conversations: Conversation[]; runtimes: RuntimeCapability[]; eventCursor: number;
}
export interface CreateConversation {
  title: string; memberIds: string[]; defaultMemberId: string; requestId: string;
}
export interface SendMessage { content: string; requestId: string }
export interface RuntimeEvent {
  kind: 'prepared' | 'exposed' | 'accepted' | 'not_accepted' | 'session' | 'session_replaced' | 'usage' | 'text' | 'tool' | 'process_exit' | 'transport_settled' | 'diagnostic';
  detail: Record<string, unknown>;
}
export interface RuntimeRequest {
  invocationId: string; conversationId: string; member: Member; account: CollaborationAccount;
  prompt: string; nativeSessionId?: string; sessionPlan?: NativeSessionPlan; toolPolicyVersion?: string; cwd: string; signal: AbortSignal;
  onEvent: (event: RuntimeEvent) => void;
  onToolCall: (name: string, args: Record<string, unknown>, callId: string) => Promise<unknown>;
}
export interface RuntimeResult {
  text: string; nativeSessionId?: string; nativeTurnId?: string; continuity: 'fresh' | 'resumed' | 'unknown';
}
export interface CollaborationRuntime {
  invoke(request: RuntimeRequest): Promise<RuntimeResult>;
  probe(): Promise<RuntimeCapability[]>;
  inspect?(request: RuntimeInspectionRequest): Promise<RuntimeInspection>;
  sessionIdentity?(request: Pick<RuntimeRequest, 'member' | 'account' | 'cwd'>): Promise<NativeSessionIdentity>;
}
