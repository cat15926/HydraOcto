import type { ConversationMessage } from './collaboration.js';
import type { ObligationState } from './obligations.js';

export interface PublicRoomView {
  conversation: { id: string; title: string };
  messages: (Pick<ConversationMessage, 'id' | 'memberId' | 'author' | 'content' | 'createdAt'> & { authorName?: string })[];
  progress: { requestMessageId: string; state: ObligationState; deliveryMessageId?: string }[];
  factors: { id: string; kind: 'message'; messageId: string }[];
}
