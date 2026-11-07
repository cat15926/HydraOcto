/** Independently implemented continuous-collaboration protocol, round 1. */
export type Carrier = 'codex-app-server' | 'claude-cli' | 'openai-api' | 'anthropic-api';
export type ExecutionMode = 'serial' | 'parallel';
export type InvocationStatus = 'prepared' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'cancel_requested' | 'cancelled';
export interface CollaborationAccount {
  id: string; name: string; provider: 'codex' | 'claude' | 'openai' | 'anthropic';
  auth: 'cli' | 'api'; apiKeyEnv?: string; baseUrl?: string; revision?: number; deletedAt?: string;
}
export interface Member {
  id: string; name: string; instructions: string; carrier: Carrier; accountId: string;
  model?: string; enabled: boolean; revision?: number; aliases?: string[]; deletedAt?: string;
  accountBinding?: 'follow' | 'override'; modelBinding?: 'follow' | 'override'; effort?: string;
}
export interface Conversation {
  id: string; title: string; memberIds: string[]; defaultMemberId: string;
  createdAt: string; updatedAt: string; revision?: number;
  preferredMemberIds?: string[]; routingMode?: 'normal' | 'concierge';
  pinned?: boolean; archivedAt?: string; workspaceGrant?: WorkspaceGrant;
  deletedAt?: string; favorite?: boolean; branch?: { conversationId: string; messageId: string; cutoff: number };
  memberGroups?: { name: string; memberIds: string[] }[];
}
export interface ConversationMessage {
  id: string; conversationId: string; author: 'user' | 'member' | 'system';
  memberId?: string; sourceId?: string; responseId?: string; content: string; createdAt: string; sequence?: number;
  attachmentIds?: string[]; replyTo?: string;
  visibility?: MessageVisibility; revision?: number; deletedAt?: string; excerptRefs?: MessageExcerpt[];
  branchOrigin?: { conversationId: string; messageId: string }; excerptConversationId?: string;
}
export interface SourceWork {
  id: string; conversationId: string; kind: 'user' | 'a2a' | 'a2a_failure' | 'mention' | 'task' | 'task_handoff' | 'artifact_review' | 'job_result' | 'multi_mention' | 'cross_message' | 'action';
  content: string; requestedTargets: string[]; bindingState: 'bound' | 'unresolved';
  parentInvocationId?: string; authorMemberId?: string; revision: number; sequence: number;
  depth: number; createdAt: string; routingDecisionId?: string;
  taskRef?: { taskId: string; ownerRevision: number; handoffId?: string };
  reviewRef?: { reviewId: string; versionId: string; digest: string };
  position?: number; priority?: 'normal' | 'urgent'; enqueuedAt?: string; orderRevision?: number;
  withdrawnAt?: string; groupId?: string;
  routingContent?: string; attachmentIds?: string[]; replyTo?: string;
  visibility?: MessageVisibility; excerptRefs?: MessageExcerpt[];
  crossRef?: { transferId: string }; actionRef?: { actionId: string; generation: number };
}
export interface CollaborationEndpoint { conversationId: string; memberId: string }
export interface CrossGrant { id: string; conversationId: string; home: CollaborationEndpoint; target: CollaborationEndpoint; revision: number; state: 'active' | 'revoked' | 'expired'; homeWorkspace: string; targetWorkspace: string; expiresAt: string; reason?: string; createdAt: string }
export interface CrossTransfer { id: string; conversationId: string; grantId: string; grantRevision: number; from: CollaborationEndpoint; to: CollaborationEndpoint; sourceId: string; origin?: TaskActor; refs: MessageExcerpt[]; content: string; invalidatedAt?: string; createdAt: string }
export interface ActionRecord { id: string; conversationId: string; title: string; content: string; grantId: string; grantRevision: number; home: CollaborationEndpoint; holder: CollaborationEndpoint; predecessor: CollaborationEndpoint; generation: number; revision: number; state: 'preparing' | 'queued' | 'active' | 'candidate' | 'waiting' | 'returning' | 'replaceable' | 'completed' | 'cancelled' | 'blocked'; completion: 'human_acceptance' | 'artifact_published'; refs: MessageExcerpt[]; origin?: TaskActor; taskId?: string; taskOwnerRevision?: number; taskRevision?: number; priorInvocationId?: string; executionId?: string; lastExecutionId?: string; currentSourceId?: string; candidateId?: string; waitId?: string; reason?: string; createdAt: string; updatedAt: string }
export interface ActionCandidate { id: string; conversationId: string; actionId: string; generation: number; revision: number; invocationId: string; responseId: string; inputRevision: number; sourceId: string; sourceRevision: number; sourceDigest: string; summary: string; artifactVersionId?: string; artifactDigest?: string; digest: string; createdAt: string }
export interface ActionVerdict { id: string; conversationId: string; actionId: string; generation: number; candidateId: string; candidateDigest: string; authority: 'human_acceptance' | 'artifact_published'; evidence: Record<string, unknown>; createdAt: string }
export type WaitCondition = { kind: 'timer'; at: string } | { kind: 'signal'; name: string } | { kind: 'job_succeeded'; jobId: string } | { kind: 'artifact_published'; versionId: string; digest: string };
export interface ActionWait { id: string; conversationId: string; actionId: string; generation: number; episode: number; revision: number; invocationId: string; sourceId: string; condition: WaitCondition; state: 'waiting' | 'ready' | 'fired' | 'expired' | 'cancelled'; deadline: string; notBefore: string; evidenceId?: string; wakeSourceId?: string; createdAt: string }
export interface ConditionEvidence { id: string; conversationId: string; waitId: string; episode: number; eventId: string; authority: 'human_signal' | 'platform_timer' | 'managed_job' | 'artifact_receipt'; detail: Record<string, unknown>; createdAt: string }
/** Absence is public for legacy records. Private scope is an immutable audience until explicit reveal. */
export interface MessageVisibility { kind: 'private'; memberIds: string[]; revealedAt?: string }
export interface MessageExcerpt { messageId: string; revision: number; digest: string; start: number; end: number }
export interface ReadCursor { conversationId: string; sequence: number; updatedAt: string }
export interface MemoryEntry { id: string; conversationId: string; key: string; scope: 'conversation' | 'library'; visibility?: MessageVisibility; owner: string; revision: number; headVersionId?: string; createdAt: string; updatedAt: string; revokedAt?: string }
export interface MemoryLibraryDetail { memories: MemoryEntry[]; memoryVersions: MemoryVersion[]; conversations: Conversation[] }
export interface MemoryVersion { id: string; entryId: string; conversationId: string; number: number; baseRevision: number; content: string; digest: string; state: 'candidate' | 'approved' | 'materialized' | 'rejected' | 'revoked' | 'stale'; revision: number; createdAt: string; approvedAt?: string; materializedAt?: string; revokedAt?: string; origin: { kind: 'user' | 'agent'; invocationId?: string; memberId?: string }; sourceRefs: MessageExcerpt[] }
export interface MemorySnapshot { entryId: string; versionId: string; revision: number; key: string; content: string; digest: string }
export interface SearchHit { kind: 'threads' | 'docs' | 'memory' | 'sessions'; conversationId: string; id: string; title: string; excerpt: string }
export interface SearchResult { mode: 'lexical'; hits: SearchHit[]; truncated: boolean; scanned: number; degraded: false; scope: string }
export interface WorkspaceGrant { path: string; device: number; inode: number; authorizedAt: string; revision: number; mode: 'read-only' }
export interface ConversationAttachment { id: string; conversationId: string; name: string; mediaType: 'text/plain'; bytes: number; digest: string; createdAt: string }
export interface RuntimeModel { id: string; name: string; efforts: string[]; isDefault?: boolean }
export interface AccountObservation {
  accountId: string; accountRevision: number; checkedAt: string; installed: boolean; version?: string;
  configured: boolean; connection: 'reachable' | 'unavailable' | 'unknown';
  identity: { state: 'authenticated' | 'not_authenticated' | 'unknown'; label?: string };
  models: RuntimeModel[]; catalogSource: string; reason?: string;
  quota: { state: 'known' | 'unknown'; windows?: { name: string; usedPercent: number; resetsAt?: string }[] };
  latestInvocation?: { id: string; status: InvocationStatus; at: string; accountRevision: number };
}
export interface RuntimeDefault { carrier: Carrier; accountId: string; model?: string; effort?: string; revision: number }
export interface ConfigurationPreview {
  id: string; kind: 'default' | 'workspace'; configurationRevision: number; expiresAt: string;
  value: RuntimeDefault | WorkspaceGrant; conversationId?: string; conversationRevision?: number;
  affectedMemberIds: string[]; unaffectedMemberIds: string[]; appliedAt?: string;
}
export interface Delivery {
  id: string; sourceId: string; memberId: string; status: 'pending' | 'consumed' | 'held' | 'withdrawn';
  responseId?: string; holdReason?: string; revision: number;
  continuation?: { invocationId: string; responseId: string; cancelRevision: number; fallback?: boolean; reason?: string };
  handoffId?: string;
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
  kind: 'prompt' | 'tool' | 'append'; createdAt: string; sourceRevision?: number; sourceDigest?: string;
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
  artifacts?: ManagedArtifact[]; artifactVersions?: ArtifactVersion[]; artifactApprovals?: ArtifactApproval[];
  reviews?: ArtifactReview[]; jobs?: ManagedJob[]; interactions?: RuntimeInteraction[];
  queue?: QueueState; groups?: MentionGroup[]; inputExposures?: InputExposure[]; inputHandoffs?: InputHandoff[];
  attachments?: ConversationAttachment[];
  memories?: MemoryEntry[]; memoryVersions?: MemoryVersion[]; readCursor?: ReadCursor;
  crossGrants?: CrossGrant[]; crossTransfers?: CrossTransfer[]; actions?: ActionRecord[]; actionCandidates?: ActionCandidate[]; actionVerdicts?: ActionVerdict[]; actionWaits?: ActionWait[]; conditionEvidence?: ConditionEvidence[];
}
export interface QueueState {
  revision: number; sources: SourceWork[];
  backoffs: { sourceId: string; invocationId: string; attempts: number; until: string; reason: string }[];
  suppressions: { memberId: string; invocationId: string; cancelRevision: number; until: string }[];
}
export interface InputExposure {
  id: string; conversationId: string; invocationId: string; responseId: string; sourceId: string;
  sourceRevision: number; sourceDigest: string; content: string; kind: Consumption['kind']; inputRevision: number; createdAt: string;
}
export interface MentionGroup {
  id: string; conversationId: string; sourceId: string; targets: string[]; question: string; context: string;
  callerInvocationId?: string; callbackTo?: string; state: 'collecting' | 'done' | 'timeout' | 'cancelled' | 'lost';
  createdAt: string; deadline: string; finishedAt?: string; revision: number;
  results?: { memberId: string; responseId: string; status: 'succeeded' | 'failed'; content: string }[]; missing?: string[];
}
export interface InputHandoff {
  id: string; conversationId: string; sourceId: string; sourceRevision: number; sourceDigest: string;
  deliveryId: string; deliveryRevision: number; memberId: string; invocationId: string; responseId: string;
  inputRevision: number; cancelRevision: number; nativeSessionId: string; nativeTurnId: string; nativeDeliveryId: string;
  content: string; state: 'sent' | 'accepted' | 'read' | 'unknown' | 'not_accepted';
  revision: number; createdAt: string; updatedAt: string; reason?: string; requiresCompletion: false;
  evidence?: AppendObservation[];
}
export interface AppendObservation {
  state: 'accepted' | 'read' | 'not_accepted' | 'unknown'; nativeSessionId: string; nativeTurnId: string; nativeDeliveryId: string;
  reason: string; observedAt: string;
}
export interface AppendDispatcher {
  send(input: InputHandoff): Promise<AppendObservation>;
  inspect(input: InputHandoff): Promise<AppendObservation>;
}
export interface ArtifactOrigin {
  actor: TaskActor; responseId?: string; inputRevision?: number; sourceDigest?: string;
  task?: { id: string; ownerRevision: number; fence: string };
}
export interface ManagedArtifact { id: string; conversationId: string; name: string; revision: number; headVersionId?: string; createdAt: string; updatedAt: string }
export interface ArtifactVersion {
  id: string; artifactId: string; conversationId: string; number: number; baseVersionId: string | null;
  digest: string; bytes: number; origin: ArtifactOrigin; createdAt: string;
  state: 'proposed' | 'published' | 'rejected' | 'expired' | 'stale' | 'cancelled' | 'unknown';
  approvalId: string; jobId?: string; publishedAt?: string; reason?: string;
}
export interface ArtifactApproval {
  id: string; conversationId: string; versionId: string; operationDigest: string; revision: number;
  state: 'pending' | 'approved' | 'rejected' | 'expired' | 'stale' | 'cancelled';
  expiresAt: string; createdAt: string; decidedAt?: string; reason?: string; notifyMemberId?: string;
}
export interface ManagedJob {
  id: string; conversationId: string; versionId: string; approvalId: string; operationDigest: string;
  kind: 'artifact_materialize'; state: 'pending' | 'running' | 'succeeded' | 'unknown' | 'stale' | 'cancelled'; revision: number;
  fence: string; supervisorEpoch?: string; startedAt?: string; finishedAt?: string; createdAt: string;
  receiptDigest?: string; reason?: string; notificationSourceId?: string;
}
export interface ArtifactReview {
  id: string; conversationId: string; artifactId: string; versionId: string; digest: string; reviewerMemberId: string;
  sourceId: string; sourceRevision: number; revision: number; origin: ArtifactOrigin;
  state: 'pending' | 'submitted' | 'expired' | 'stale' | 'cancelled'; verdict?: 'accept' | 'changes_requested'; comment?: string;
  createdAt: string; expiresAt: string; submittedAt?: string; invocationId?: string; headCommit?: string;
  current?: boolean;
  submission?: { responseId: string; inputRevision: number; cancelRevision: number };
}
export interface InteractionQuestion { id: string; question: string; options?: string[] }
export interface NativeInteractionRequest {
  providerRequestId: string; kind: 'question' | 'approval' | 'elicitation'; operation: string;
  nativeSessionId?: string; nativeTurnId?: string; nativeItemId?: string;
  questions?: InteractionQuestion[]; payload: Record<string, unknown>;
}
export interface RuntimeInteraction extends NativeInteractionRequest {
  id: string; conversationId: string; invocationId: string; memberId: string; sourceId: string;
  sourceRevision: number; inputRevision: number; cancelRevision: number; payloadDigest: string; revision: number;
  state: 'pending' | 'answered' | 'declined' | 'expired' | 'cancelled' | 'unsupported';
  transport: 'platform' | 'codex'; createdAt: string; expiresAt: string; answers?: Record<string, string>;
  delivery: 'not_sent' | 'returned_to_adapter' | 'unknown'; reason?: string;
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
  delegationId?: string;
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
  reviewSnapshot?: ArtifactReview;
  primarySourceId?: string;
  workspaceGrant?: WorkspaceGrant;
  visibility?: MessageVisibility; visibilityEpoch?: number; materialDigest?: string; memorySnapshot?: MemorySnapshot[];
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
  append: boolean; authentication: 'cli' | 'api'; verified: 'unverified' | 'protocol_tested' | 'live_tested';
}
export interface CollaborationBootstrap {
  version: string; workspace: string; csrfToken: string; members: Member[];
  accounts: (CollaborationAccount & { configured: boolean })[];
  conversations: Conversation[]; runtimes: RuntimeCapability[]; eventCursor: number;
  defaults?: RuntimeDefault[]; accountObservations?: AccountObservation[]; configurationRevision?: number;
}
export interface CreateConversation {
  title: string; memberIds: string[]; defaultMemberId: string; requestId: string;
}
export interface SendMessage { content: string; requestId: string; deliveryMode?: 'next_turn' | 'continue_current'; resolveWhenIdle?: boolean; attachmentIds?: string[]; replyTo?: string; privateTo?: string[]; excerptRefs?: MessageExcerpt[]; excerptTargets?: string[] }
export interface RuntimeEvent {
  kind: 'prepared' | 'exposed' | 'accepted' | 'not_accepted' | 'session' | 'session_replaced' | 'usage' | 'text' | 'tool' | 'process_exit' | 'transport_settled' | 'diagnostic';
  detail: Record<string, unknown>;
}
export interface RuntimeRequest {
  invocationId: string; conversationId: string; member: Member; account: CollaborationAccount;
  prompt: string; nativeSessionId?: string; sessionPlan?: NativeSessionPlan; toolPolicyVersion?: string; cwd: string; signal: AbortSignal;
  onEvent: (event: RuntimeEvent) => void;
  onToolCall: (name: string, args: Record<string, unknown>, callId: string) => Promise<unknown>;
  onInteraction?: (request: NativeInteractionRequest) => Promise<{ state: RuntimeInteraction['state']; answers?: Record<string, string> }>;
  onInteractionResolved?: (providerRequestId: string) => void;
  onAppendReady?: (dispatcher: AppendDispatcher) => void;
  onInputRead?: (observation: AppendObservation) => void;
  workspaceGrant?: WorkspaceGrant; visibility?: MessageVisibility;
}
export interface RuntimeResult {
  text: string; nativeSessionId?: string; nativeTurnId?: string; continuity: 'fresh' | 'resumed' | 'unknown';
}
export interface CollaborationRuntime {
  invoke(request: RuntimeRequest): Promise<RuntimeResult>;
  probe(): Promise<RuntimeCapability[]>;
  discoverAccount?(account: CollaborationAccount): Promise<AccountObservation>;
  inspect?(request: RuntimeInspectionRequest): Promise<RuntimeInspection>;
  sessionIdentity?(request: Pick<RuntimeRequest, 'member' | 'account' | 'cwd'>): Promise<NativeSessionIdentity>;
}
