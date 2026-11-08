/** Synthetic native index and transcript for repeatable browser/HTTP acceptance. No credentials or models. */
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
export async function historyFixture(root) {
  const profile = join(root, 'profile');
  await mkdir(profile);
  const sessions = join(profile, 'sessions');
  await mkdir(sessions);
  const project = join(root, 'project');
  await mkdir(project);
  const cwd = await realpath(project),
    session = randomUUID(),
    foreign = randomUUID(),
    file = join(sessions, session + '.jsonl');
  const db = new DatabaseSync(join(profile, 'state_5.sqlite'));
  db.exec(
    'CREATE TABLE threads(id TEXT,rollout_path TEXT,creator_account_id TEXT,creator_user_id TEXT,cwd TEXT,updated_at INT)',
  );
  const add = db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)');
  add.run(session, file, 'account-a', 'user-a', cwd, 2);
  add.run(foreign, file, 'account-b', 'user-b', cwd, 1);
  db.close();
  const time = new Date().toISOString();
  const data = [
    { type: 'session_meta', payload: { id: session, cwd } },
    ...[
      '第一轮 @claude：历史工具请求 task_create',
      '已收到；当时的审批文字：同意执行',
      '保留这个结论',
      '选中回复',
      '排除标记',
      '末轮回复',
    ].map((text, i) => ({
      type: 'event_msg',
      timestamp: time,
      payload: {
        type: 'item_completed',
        thread_id: session,
        item: {
          id: randomUUID(),
          type: i % 2 ? 'AgentMessage' : 'UserMessage',
          phase: i % 2 ? 'final_answer' : undefined,
          content: [{ type: i % 2 ? 'Text' : 'text', text }],
        },
      },
    })),
    { type: 'response_item', timestamp: time, payload: { type: 'reasoning', text: '内部推理标记' } },
  ];
  await writeFile(file, data.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const calls = [];
  const runtime = {
    probe: async () => [],
    historyIdentity: async () => ({
      supported: true,
      fingerprint: 'test-id',
      historyOwner: { account: 'account-a', user: 'user-a' },
    }),
    invoke: async (r) => {
      calls.push(r);
      r.onEvent({ kind: 'accepted', detail: { source: 'synthetic' } });
      r.onEvent({ kind: 'process_exit', detail: { confirmed: true } });
      return { text: '合成回复', continuity: 'fresh' };
    },
  };
  return { profile, cwd, session, foreign, file, calls, runtime };
}
