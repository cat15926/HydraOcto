import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, appendFile, readFile, writeFile, rename, mkdir, realpath, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../server/index.js';
import { historyFixture } from '../scripts/runtime/history-fixture.mjs';
import type { CollaborationAccount, CollaborationRuntime, Member } from '../shared/collaboration.js';
import { HistoryRecording } from '../server/collaboration/history-recording.js';
import { parseHistory } from '../server/collaboration/history-files.js';
test('native import filters accounts and raw events, checks drift, commits privately and can replay after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'history-')),
    f = await historyFixture(root),
    prior = process.env.CODEX_HOME;
  process.env.CODEX_HOME = f.profile;
  const options = { port: 0, workspace: f.cwd, dataDir: join(root, 'private'), collaborationRuntime: f.runtime };
  let app = await createApplication(options),
    address = await app.start();
  const post = async (op: string, body: unknown, csrf = app.csrfToken) => {
    const r = await fetch(address.url + '/api/native-history/' + op, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: (await r.json()) as any };
  };
  try {
    const store = app.collaborationStore;
    assert.equal((await post('options', {}, '')).status, 403);
    const opts = await post('options', {});
    assert.equal(opts.status, 200, JSON.stringify(opts.data));
    const projects = opts.data.projects;
    const bounds = { projectId: projects[0].id, memberId: 'codex' },
      target = { ...bounds, session: f.session };
    assert.deepEqual(
      (await post('list', bounds)).data.choices.map((c: any) => c.id),
      [f.session],
    );
    assert.equal((await post('preview', { ...target, session: f.foreign })).status, 409);
    const preview = async () => {
      const r = await post('preview', target);
      assert.equal(r.status, 200);
      return r.data;
    };
    const first = await preview();
    assert.equal(first.lines.length, 6);
    assert(!JSON.stringify(first).includes('内部推理标记'));
    const old = await readFile(f.file);
    await appendFile(f.file, JSON.stringify({ type: 'metric', timestamp: new Date().toISOString() }) + '\n');
    assert.equal((await post('confirm', { token: first.token, first: 0, last: 3 })).status, 409);
    await writeFile(f.file, old);
    const second = await preview();
    const member = store.members()[0]!;
    store.saveMember({ ...member, name: '重命名' });
    assert.equal((await post('confirm', { token: second.token, first: 0, last: 3 })).status, 409);
    assert.equal(store.list().length, 0);
    const third = await preview();
    await rename(f.cwd, f.cwd + '-old');
    await mkdir(f.cwd);
    assert.equal((await post('confirm', { token: third.token, first: 0, last: 3 })).status, 409);
    await rm(f.cwd, { recursive: true });
    await rename(f.cwd + '-old', f.cwd);
    const p = await preview(),
      body = { token: p.token, first: 0, last: 3 };
    const t = store.db.prepare('SELECT count(*) AS n FROM cc_events').get()!.n;
    store.db.exec(
      "CREATE TEMP TRIGGER break_import BEFORE INSERT ON cc_messages BEGIN SELECT RAISE(ABORT,'fixture rollback'); END",
    );
    assert.equal((await post('confirm', body)).status, 500);
    assert.equal(store.list().length, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM cc_events').get()!.n, t);
    store.db.exec('DROP TRIGGER break_import');
    const [a, b] = await Promise.all([post('confirm', body), post('confirm', body)]);
    assert.equal(a.status, 200);
    assert.deepEqual(a, b);
    const cid = a.data.conversationId;
    const d = store.detail(cid);
    assert.equal(d.messages.length, 4);
    assert.deepEqual(
      d.messages.map((m) => [m.author, m.content, m.importedOrigin?.anchor, m.importedOrigin?.timestamp]),
      p.lines.slice(0, 4).map((l) => [l.role === 'user' ? 'user' : 'member', l.text, l.anchor, l.time]),
    );
    assert(d.messages.every((m) => m.importedOrigin && !m.sourceId && !m.responseId));
    assert.equal(d.sources.length + d.tasks!.length + d.deliveries.length + d.invocations.length, 0);
    assert(!d.conversation.workspaceGrant);
    assert.equal(f.calls.length, 0);
    assert.equal((await post('confirm', { ...body, last: 5 })).status, 409);
    store.send(cid, { content: '继续', requestId: randomUUID() });
    app.collaborationEngine.kick();
    for (let i = 0; i < 100 && !f.calls.length; i++) await new Promise((r) => setTimeout(r, 30));
    assert.equal(f.calls.length, 1);
    assert(f.calls[0].prompt.includes('选中回复'));
    assert(!f.calls[0].prompt.includes('排除标记'));
    store.updateConversation(cid, { memberIds: ['codex', 'claude'], defaultMemberId: 'codex' });
    assert(!JSON.stringify(store.visibility.export(cid, 'claude')).includes('选中回复'));
    assert(!JSON.stringify(store.visibility.export(cid)).includes('排除标记'));
    assert(!store.visibility.history(cid, 'claude', 'public').some((m) => m.importedOrigin));
    assert.equal((await store.memory.search({ query: '排除标记', conversationId: cid })).hits.length, 0);
    assert.equal(
      (await store.memory.search({ query: '选中回复', conversationId: cid, memberId: 'claude' })).hits.length,
      0,
    );
    assert(
      (await store.memory.search({ query: '选中回复', conversationId: cid, memberId: 'codex' })).hits.length > 0,
    );
    store.send(cid, { content: '给新成员的独立问题', privateTo: ['claude'], requestId: randomUUID() });
    app.collaborationEngine.kick();
    for (let i = 0; i < 100 && f.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 30));
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].member.id, 'claude');
    assert(!f.calls[1].prompt.includes('选中回复') && !f.calls[1].prompt.includes('排除标记'));
    await app.close();
    app = await createApplication(options);
    address = await app.start();
    assert.deepEqual(await post('confirm', body), a);
    assert.equal(app.collaborationStore.list().length, 1);
  } finally {
    await app.close();
    if (prior === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prior;
    await rm(root, { recursive: true, force: true });
  }
});
test('Claude imports only visible main-chain text and rejects incomplete ancestry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'history-claude-')),
    previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    const dir = join(root, 'projects');
    await mkdir(dir);
    const session = randomUUID(),
      path = join(dir, session + '.jsonl'),
      cwd = '/test',
      time = new Date().toISOString();
    let parentUuid: string | null = null;
    const rows = ['user', 'assistant', 'user', 'assistant', 'user', 'assistant'].map((type, i) => {
      const uuid = randomUUID(),
        row = {
          type,
          uuid,
          parentUuid,
          sessionId: session,
          cwd,
          timestamp: time,
          message: {
            role: type,
            content:
              i === 1
                ? [{ type: 'thinking', thinking: 'secret' }]
                : i === 2
                  ? [{ type: 'tool_result', content: 'secret' }]
                  : 'visible' + i,
          },
        };
      parentUuid = uuid;
      return row;
    });
    rows.push({ ...rows[0]!, uuid: randomUUID(), isSidechain: true } as (typeof rows)[number]);
    await writeFile(path, rows.map((r) => JSON.stringify(r)).join('\n'));
    assert.deepEqual(
      parseHistory('claude-cli', path, session, cwd).lines.map((m) => m.text),
      ['visible0', 'visible3', 'visible4', 'visible5'],
    );
    rows[3]!.parentUuid = randomUUID();
    await writeFile(path, rows.map((r) => JSON.stringify(r)).join('\n'));
    assert.throws(() => parseHistory('claude-cli', path, session, cwd));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('terminal registration rejects already attested text changed between CLI turns', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'history-terminal-')));
  const prior = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    const session = randomUUID();
    const folder = join(root, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'));
    await mkdir(folder, { recursive: true });
    const file = join(folder, session + '.jsonl');
    const directory = join(root, 'receipts');
    let parent: string | null = null;
    const runtime = {
      sessionIdentity: async () => ({ supported: true, fingerprint: 'test' }),
      invoke: async (req) => {
        for (const [role, text] of [
          ['user', req.prompt],
          ['assistant', '回复'],
        ]) {
          const uuid = randomUUID();
          await appendFile(
            file,
            JSON.stringify({
              type: role,
              uuid,
              parentUuid: parent,
              sessionId: session,
              cwd: root,
              timestamp: new Date().toISOString(),
              message: { role, content: text },
            }) + '\n',
          );
          parent = uuid;
        }
        req.onEvent({ kind: 'session', detail: { historyVerified: true, anchor: parent } });
        req.onEvent({ kind: 'process_exit', detail: { confirmed: true } });
        return { nativeSessionId: session, text: '回复' };
      },
    } as CollaborationRuntime;
    const recorder = new HistoryRecording(
      runtime,
      { carrier: 'claude-cli' } as Member,
      { id: 'test' } as CollaborationAccount,
      root,
      directory,
    );
    await recorder.turn('第一轮');
    const receipt = join(directory, (await readdir(directory))[0]!, session + '.json');
    const original = await readFile(receipt, 'utf8');
    await writeFile(file, (await readFile(file, 'utf8')).replace('第一轮', '变更后的第一轮'));
    await assert.rejects(recorder.turn('第二轮'), /此前登记的消息已经变化/);
    assert.equal(await readFile(receipt, 'utf8'), original);
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior;
    await rm(root, { recursive: true, force: true });
  }
});
