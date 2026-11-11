import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Conversation, RoomMemberInstance } from '../../shared/collaboration.js';
import { AppError } from '../store.js';

interface MemberRow { id: string; conversation_id: string; member_id: string; generation: number; active: number }

function instance(row: MemberRow): RoomMemberInstance {
  return { id: row.id, conversationId: row.conversation_id, memberId: row.member_id, generation: row.generation, active: row.active === 1 };
}

/** Called by the room store inside its admission, migration or roster transaction. */
export class RoomMemberService {
  constructor(private readonly db: DatabaseSync) {}

  migrate(backfill: boolean): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS cc_room_members (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES cc_conversations(id),
      member_id TEXT NOT NULL REFERENCES cc_members(id), generation INTEGER NOT NULL CHECK(generation >= 1),
      active INTEGER NOT NULL CHECK(active IN (0,1)), UNIQUE(conversation_id,member_id,generation));
      CREATE UNIQUE INDEX IF NOT EXISTS cc_room_member_active ON cc_room_members(conversation_id,member_id) WHERE active=1;
      CREATE INDEX IF NOT EXISTS cc_invocation_session_identity ON cc_invocations(json_extract(value,'$.nativeSessionId'),json_extract(value,'$.member.carrier'))`);
    if (!backfill) return;
    for (const row of this.db.prepare('SELECT value FROM cc_conversations').all()) {
      const conversation = JSON.parse(String(row.value)) as Conversation;
      this.sync(conversation.id, conversation.memberIds);
    }
  }

  sync(conversationId: string, memberIds: readonly string[]): void {
    const rows = this.db.prepare('SELECT * FROM cc_room_members WHERE conversation_id=? ORDER BY generation').all(conversationId) as unknown as MemberRow[];
    const latest = new Map(rows.map(row => [row.member_id, row]));
    const roster = new Set(memberIds);
    for (const row of latest.values()) {
      if (row.active && !roster.has(row.member_id)) this.db.prepare('UPDATE cc_room_members SET active=0 WHERE id=?').run(row.id);
    }
    for (const memberId of roster) {
      const previous = latest.get(memberId);
      if (previous?.active) continue;
      const generation = (previous?.generation ?? 0) + 1;
      const id = createHash('sha256').update(JSON.stringify([conversationId,memberId,generation])).digest('hex');
      this.db.prepare('INSERT INTO cc_room_members(id,conversation_id,member_id,generation,active) VALUES(?,?,?,?,1)').run(id,conversationId,memberId,generation);
    }
  }

  resolve(conversationId: string, memberId: string): RoomMemberInstance {
    const row = this.db.prepare('SELECT * FROM cc_room_members WHERE conversation_id=? AND member_id=? AND active=1').get(conversationId, memberId) as unknown as MemberRow | undefined;
    if (!row) throw new AppError(409, '该成员已离开会话。', 'room_member_inactive');
    return instance(row);
  }

  isCurrent(member: RoomMemberInstance): boolean {
    return !!this.db.prepare('SELECT 1 FROM cc_room_members WHERE id=? AND conversation_id=? AND member_id=? AND generation=? AND active=1').get(member.id, member.conversationId, member.memberId, member.generation);
  }

  assertCurrent(member: RoomMemberInstance, conversationId: string, memberId: string): void {
    if (member.conversationId !== conversationId || member.memberId !== memberId || !this.isCurrent(member)) {
      throw new AppError(409, '执行所属的房间成员已变化。', 'room_member_inactive');
    }
  }
}
