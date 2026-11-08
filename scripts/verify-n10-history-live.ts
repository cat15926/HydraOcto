import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CollaborationBootstrap } from '../shared/collaboration.js';
import { HistoryRecording } from '../server/collaboration/history-recording.js';
import { HistoryImport } from '../server/collaboration/history-import.js';
import { createApplication } from '../server/index.js';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';
const dir = await mkdtemp(join(tmpdir(), 'n10-live-')),
  privateDir = join(dir, 'data');
await mkdir(join(dir, 'project'));
const project = await realpath(join(dir, 'project'));
const output = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/n10a/live');
await mkdir(output, { recursive: true });
const boot = (await (
  await fetch('http://127.0.0.1:4310/api/collaboration/bootstrap')
).json()) as CollaborationBootstrap;
// Give these API-backed native hosts their own actual CLI configuration and history directories.
process.env.CODEX_HOME = join(dir, 'codex-profile');
process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude-profile');
await mkdir(process.env.CODEX_HOME);
await mkdir(process.env.CLAUDE_CONFIG_DIR);
const runtime = createCollaborationRuntime({ timeoutMs: 120_000 });
const app = await createApplication({
  port: 0,
  workspace: project,
  dataDir: privateDir,
  collaborationRuntime: runtime,
});
const store = app.collaborationStore;
const importService = new HistoryImport(store, runtime, privateDir);
const results: Record<string, unknown>[] = [];
const ids = process.argv.slice(2);
let total = 0;
try {
  await app.start();
  for (const id of ids.length ? ids : ['codex', 'claude']) {
    const m = boot.members.find((m) => m.id === id)!,
      a = boot.accounts.find((a) => a.id === m.accountId)!;
    assert.equal(a.auth, 'api');
    store.saveAccount(a);
    store.saveMember(m);
    const bind = { memberId: id, projectId: importService.options().projects[0]!.id };
    const capture = new HistoryRecording(runtime, m, a, project, importService.directory);
    const selected = randomUUID(),
      excluded = randomUUID();
    ++total;
    await capture.turn('只原样回复 ' + selected);
    ++total;
    const second = await capture.turn('只原样回复 ' + excluded);
    const choices = await importService.list(bind);
    assert(choices.choices.some((c) => c.id === second.session));
    const preview = await importService.preview({ ...bind, session: second.session });
    assert.equal(preview.lines.length, 4);
    const result = await importService.confirm({ token: preview.token, first: 0, last: 1 });
    const cid = result.conversationId;
    assert.equal(store.invocations(cid).length, 0);
    ++total;
    store.send(cid, { content: '只回复此前导入的那一轮里要求原样回复的标记。', requestId: randomUUID() });
    app.collaborationEngine.kick();
    const end = Date.now() + 170_000;
    while (!store.invocations(cid).some((i) => ['failed', 'succeeded'].includes(i.status))) {
      if (Date.now() > end) throw new Error('真实执行超时');
      await new Promise((r) => setTimeout(r, 120));
    }
    const detail = store.detail(cid),
      inv = detail.invocations[0]!;
    assert.equal(inv.status, 'succeeded');
    const input = store.prompt(inv.id);
    assert(input.includes(selected) && !input.includes(excluded));
    assert(detail.responses.some((r) => r.content.includes(selected) && !r.content.includes(excluded)));
    assert.equal(inv.teardown, 'confirmed');
    results.push({
      member: id,
      nativeTurns: 2,
      imported: 2,
      fresh: inv.continuity,
      selectedInInput: true,
      excludedAbsent: true,
      realReplyMatched: true,
      exitConfirmed: true,
    });
    console.log('Passed', id);
  }
} finally {
  await app.close();
  await writeFile(join(output, 'result.json'), JSON.stringify({ results, attempts: total, project }, null, 2));
}
