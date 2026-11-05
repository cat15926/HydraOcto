import type { DatabaseSync } from 'node:sqlite';
import type { CollaborationInvocation, ExecutionContractSnapshot, SourceWork } from '../../shared/collaboration.js';
import type { OrdinaryTaskService } from './tasks.js';
export interface ArtifactPort {
  db: DatabaseSync; tasks: OrdinaryTaskService;
  tx<T>(fn: () => T): T;
  command<T>(id: string, input: unknown, fn: () => T): { result: T; replayed: boolean };
  invocation(id: string): CollaborationInvocation;
  contract(id: string): ExecutionContractSnapshot;
  addSource(input: Pick<SourceWork, 'conversationId' | 'kind' | 'content' | 'requestedTargets' | 'depth'> & Partial<Pick<SourceWork, 'parentInvocationId' | 'authorMemberId' | 'reviewRef'>>): SourceWork;
  event(conversationId: string, type: string, data: Record<string, unknown>): void;
}
