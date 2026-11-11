import type { ObligationEndpoint } from './obligations.js';

export interface SignedOpinion {
  id: string;
  instanceId: string;
  memberId: string;
  invocationId: string;
  text: string;
  objection: boolean;
  late: boolean;
  version: number;
  createdAt: string;
}

export interface OpinionRound {
  id: string;
  conversationId: string;
  obligationId: string;
  originInvocationId: string;
  originSourceId: string;
  ownerRevision: number;
  decider: ObligationEndpoint;
  participants: (ObligationEndpoint & { sourceId: string })[];
  minimum: number;
  deadline: string;
  lockMode: 'early' | 'deadline';
  question: string;
  state: 'collecting' | 'ready' | 'locked' | 'expired' | 'cancelled';
  revision: number;
  validCount: number;
  opinions: SignedOpinion[];
  resolutions: {opinionId:string; evidenceMessageId?:string; evidenceRevision?:number; evidenceDigest?:string; finding?:string; valid?:boolean; invocationId:string}[];
  lockedOpinionIds?: string[];
  objectionIds?: string[];
  wakeSourceId?: string;
  reason?: string;
}
