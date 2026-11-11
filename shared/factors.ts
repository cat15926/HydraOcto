export type FactorKind = 'observation' | 'expression' | 'note' | 'request' | 'message' | 'evidence' | 'obligation';
export interface FactorRef {
  kind: 'room-record' | 'source' | 'message' | 'evidence' | 'obligation';
  id: string;
  version: number;
}
export interface FactorView {
  id: string;
  roomId: string;
  /** Position within this authorized projection. */
  sequence: number;
  createdAt: string;
  kind: FactorKind;
  issuer: string;
  memberId?: string;
  sourceRef: FactorRef;
  version: number;
  content: string;
  parentIds: string[];
  expressionOptions?: string[];
  obligationRef?: {
    id: string;
    revision: number;
    parentId?: string;
    ownerId: string;
    ownerGeneration: number;
    ownerRevision?: number;
    returnToId?: string;
    state: string;
    acceptance: string;
    version?: string;
  };
}
export interface IssueFactorInput {
  requestId: string;
  memberId: string;
  content: string;
  publicExpression?: string;
  expressionOptions?: string[];
}
export interface FactorNoteInput {
  requestId: string;
  content: string;
  parentIds?: string[];
}
