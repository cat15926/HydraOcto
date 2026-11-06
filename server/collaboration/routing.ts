import type { CollaborationResponse, Conversation, ConversationMessage, Member } from '../../shared/collaboration.js';
import { AppError } from '../store.js';

export const ROUTING_POLICY_VERSION = 'natural-public-v1';
export type RoutingMessage = ConversationMessage & { sequence?: number; explicitTargets?: string[] };
export interface RoutingInput {
  content: string;
  conversation: Conversation & { preferredMemberIds?: string[]; routingMode?: 'normal' | 'concierge' };
  members: Member[];
  messages: RoutingMessage[];
  responses: CollaborationResponse[];
  historyCursor: number;
  configurationRevision: number;
}
export interface RoutingResolution {
  targets: string[];
  reason: 'explicit_mention' | 'last_user_mention' | 'last_healthy_responder' | 'default_member' | 'available_participant' | 'preferred_parallel' | 'concierge_preferred' | 'preferred_member';
  historyCursor: number;
  configurationRevision: number;
  policyVersion: string;
  excludedTargets: string[];
}

/** Syntax only: policy filtering and busy-member scheduling are separate concerns. */
export function parseMentions(content: string, conversation: Conversation, members: Member[], lineStart = false): string[] {
  const participants = members.filter(member => conversation.memberIds.includes(member.id));
  const aliases = participants.flatMap(member => [...new Set([member.id, member.name, ...(member.aliases ?? [])])].filter(Boolean).map(alias => ({ alias, targets: [member.id] })));
  for (const alias of ['all', '全体', 'thread', '本帖']) aliases.push({ alias, targets: conversation.memberIds.filter(id => participants.some(member => member.id === id)) });
  aliases.sort((a, b) => b.alias.length - a.alias.length);
  const clean = content.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '').replace(/`[^`\n]*`/g, '');
  const targets: string[] = [];
  for (const match of clean.matchAll(lineStart ? /^\s*@/gm : /@/g)) {
    const tail = clean.slice(match.index! + match[0].length);
    const found = aliases.find(({ alias }) => tail.toLocaleLowerCase().startsWith(alias.toLocaleLowerCase()) && !/[A-Za-z0-9_-]/.test(tail[alias.length] ?? ''));
    if (found) for (const id of found.targets) if (!targets.includes(id)) targets.push(id);
  }
  return targets;
}

/** A pure resolver shared by preview and the atomic source-admission transaction. */
export function resolveRouting(input: RoutingInput): RoutingResolution {
  const { conversation, members, historyCursor, configurationRevision } = input;
  const routable = new Set(members.filter(member => member.enabled && conversation.memberIds.includes(member.id)).map(member => member.id));
  const explicit = parseMentions(input.content, conversation, members);
  const excludedTargets = explicit.filter(id => !routable.has(id));
  const result = (targets: string[], reason: RoutingResolution['reason']): RoutingResolution => ({ targets, reason, historyCursor, configurationRevision, policyVersion: ROUTING_POLICY_VERSION, excludedTargets });
  const current = explicit.filter(id => routable.has(id));
  if (current.length) return result(current, 'explicit_mention');
  const preferred = [...new Set(conversation.preferredMemberIds ?? [])].filter(id => routable.has(id));
  if (/#ideate\b/i.test(input.content) && preferred.length > 1) return result(preferred, 'preferred_parallel');
  if (conversation.routingMode === 'concierge' && preferred.length) return result(preferred, 'concierge_preferred');

  const history = input.messages.map((message, index) => ({ message, order: message.sequence ?? index + 1 }))
    .filter(({ message, order }) => message.conversationId === conversation.id && order <= historyCursor)
    .sort((a, b) => b.order - a.order);
  for (const { message } of history) {
    if (message.author !== 'user') continue;
    // Persisted explicit targets preserve the original meaning after a member is renamed.
    const mentioned = message.explicitTargets ?? parseMentions(message.content, conversation, members);
    if (!mentioned.length) continue;
    const target = mentioned.find(id => routable.has(id));
    if (target) return result([target], 'last_user_mention');
    for (const id of mentioned) if (members.some(member => member.id === id) && !routable.has(id) && !excludedTargets.includes(id)) excludedTargets.push(id);
    break;
  }
  const observedMembers = new Set<string>();
  for (const { message } of history) {
    if (message.author !== 'member' || !message.memberId || !routable.has(message.memberId)) continue;
    if (observedMembers.has(message.memberId)) continue;
    const response = input.responses.find(item => item.id === message.responseId && item.conversationId === conversation.id && item.memberId === message.memberId);
    if (!response) continue;
    observedMembers.add(message.memberId);
    if (response?.status === 'succeeded') return result([message.memberId], 'last_healthy_responder');
  }
  if (preferred.length) return result([preferred[0]!], 'preferred_member');
  if (routable.has(conversation.defaultMemberId)) return result([conversation.defaultMemberId], 'default_member');
  const participant = conversation.memberIds.find(id => routable.has(id));
  if (participant) return result([participant], 'available_participant');
  throw new AppError(409, '当前会话没有可接收消息的启用成员，请先启用成员。', 'no_routable_member');
}
