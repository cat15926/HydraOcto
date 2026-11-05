export const TOOL_NAMES = ['workspace_list', 'workspace_read', 'artifact_write', 'artifact_read'] as const;
export type ToolName = typeof TOOL_NAMES[number];
export type Mode = 'demo' | 'api';
export type TaskStatus = 'queued' | 'running' | 'waiting_approval' | 'needs_review' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
export type RunStatus = 'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
export type StepStatus = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
export interface Role { id: string; name: string; description: string; instructions: string; tools: ToolName[]; createdAt: string }
export interface Task { id: string; title: string; goal: string; acceptance: string; roleIds: string[]; mode: Mode; status: TaskStatus; latestRunId: string; createdAt: string; updatedAt: string; summary?: string }
export interface Run { id: string; taskId: string; attempt: number; status: RunStatus; createdAt: string; startedAt?: string; finishedAt?: string; error?: string }
export interface ModelMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_call_id?: string; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
export interface Step { id: string; runId: string; position: number; role: Role; status: StepStatus; output?: string; error?: string; round: number; createdAt: string; startedAt?: string; finishedAt?: string; messages: ModelMessage[] }
export interface ToolCall { id: string; providerCallId?: string; taskId: string; runId: string; stepId: string; name: ToolName; args: Record<string, unknown>; status: 'pending' | 'waiting_approval' | 'approved' | 'succeeded' | 'failed' | 'rejected' | 'cancelled'; result?: string; error?: string; approvalId?: string; createdAt: string; updatedAt: string }
export interface Approval { id: string; taskId: string; runId: string; stepId: string; toolCallId: string; toolName: ToolName; args: Record<string, unknown>; digest: string; status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled'; createdAt: string; expiresAt: string; decidedAt?: string }
export interface Artifact { id: string; taskId: string; runId: string; toolCallId: string; name: string; mime: string; bytes: number; sha256: string; createdAt: string; url: string }
export interface TaskEvent { id: number; taskId: string; runId?: string; type: string; message: string; createdAt: string; data?: Record<string, unknown> }
export interface TaskDetail { task: Task; runs: Run[]; steps: Step[]; toolCalls: ToolCall[]; approvals: Approval[]; artifacts: Artifact[]; events: TaskEvent[] }
export interface ToolInfo { name: ToolName; description: string; requiresApproval: boolean }
export interface Bootstrap { meta: { name: string; version: string; apiConfigured: boolean; model?: string; workspace: string; tools: ToolInfo[] }; roles: Role[]; tasks: Task[]; eventCursor: number; csrfToken: string }
export interface CreateTask { title: string; goal: string; acceptance: string; roleIds: string[]; mode: Mode; requestId: string }
export interface CreateRole { name: string; description: string; instructions: string; tools: ToolName[] }
export interface ErrorResponse { error: string; code?: string }
