import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createApplication } from '../server/index.js';
import { textDigest } from '../server/collaboration/visibility.js';
import type { RuntimeRequest } from '../shared/collaboration.js';
const rid = () => randomUUID();
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'n8-http-')), workspace = join(root, 'project'); await mkdir(workspace);
  const calls: RuntimeRequest[] = [], probes: unknown[] = [];
  const app = await createApplication({ port: 0, dataDir: join(root, 'private'), workspace, collaborationRuntime: {
    probe: async () => [], invoke: async r => {
      calls.push(r); r.onEvent({ kind: 'accepted', detail: { source: 'synthetic' } });
      if (r.visibility?.kind === 'private' && r.prompt.includes('TEST_TOOL_BOUNDARY')) {
        await assert.rejects(r.onToolCall('collaboration_request', { targets: ['claude'], content: 'SHOULD_NOT_ESCAPE' }, 'bad'), /私聊/);
        probes.push(await r.onToolCall('material_search', { query: 'PUBLIC' }, 'search'));
        probes.push(await r.onToolCall('memory_propose', { key: 'private-memory', content: 'PRIVATE_MEMORY_VALUE' }, 'memory'));
      }
      r.onEvent({ kind: 'process_exit', detail: { confirmed: true } }); return { text: r.visibility ? 'PRIVATE_SYNTHETIC_REPLY' : 'PUBLIC_SYNTHETIC_REPLY', continuity: 'fresh' };
    },
  } });
  const { url } = await app.start(); const boot: any = await (await fetch(url + '/api/collaboration/bootstrap')).json();
  const api = async (path: string, body?: unknown, csrf = boot.csrfToken) => { const r = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, data: await r.json() as any }; };
  const c = (await api('/api/conversations', { requestId: rid(), title: 'N8 HTTP', memberIds: ['codex', 'claude'], defaultMemberId: 'codex' })).data.conversation;
  const path = '/api/conversations/' + c.id;
  const wait = async (count: number) => { const deadline = Date.now() + 5000; while (app.collaborationStore.invocations().filter(i => i.status === 'succeeded').length < count) { if (Date.now() > deadline) throw new Error('timeout'); await new Promise(r => setTimeout(r, 20)); } };
  return { app, url, boot, api, calls, probes, c, path, wait, close: async () => { await app.close(); await rm(root, { recursive: true, force: true }); } };
}

test('memory library: owner administration is independent of selected conversation, excludes session entries and trashed origins', async () => {
  const h = await setup(); try {
    const library = (await h.api(h.path + '/memory-candidates', { requestId: rid(), key: 'Library private', content: 'LIBRARY_PRIVATE', scope: 'library', privateTo: ['codex'] })).data.result;
    await h.api(h.path + '/memory-candidates', { requestId: rid(), key: 'Session only', content: 'SESSION_ONLY' });
    const other = (await h.api('/api/conversations', { requestId: rid(), title: 'Other origin', memberIds: ['claude'], defaultMemberId: 'claude' })).data.conversation;
    const second = (await h.api(`/api/conversations/${other.id}/memory-candidates`, { requestId: rid(), key: 'Other library', content: 'OTHER_LIBRARY', scope: 'library' })).data.result;
    const read = await h.api('/api/collaboration/memory-library'); assert.equal(read.status, 200);
    assert.deepEqual(new Set(read.data.memories.map((e: any) => e.id)), new Set([library.entry.id, second.entry.id]));
    assert.deepEqual(read.data.memories.find((e: any) => e.id === library.entry.id).visibility.memberIds, ['codex']);
    assert.equal(read.data.memoryVersions.length, 2); assert.equal(read.data.conversations.length, 2);
    assert.equal((await h.api('/api/collaboration/memory-library?viewer=claude')).status, 400);
    assert.equal(h.app.collaborationStore.memory.current(other.id, 'claude').length, 0, 'owner administration never grants recall');
    await h.api(h.path + '/visibility-organize', { requestId: rid(), action: 'delete', expectedRevision: h.app.collaborationStore.visibility.conversation(h.c.id).revision });
    const after = (await h.api('/api/collaboration/memory-library')).data;
    assert.deepEqual(after.memories.map((e: any) => e.id), [second.entry.id]); assert.deepEqual(after.memoryVersions.map((v: any) => v.id), [second.version.id]);
    assert.ok(after.conversations.every((c: any) => c.id !== h.c.id)); assert.equal(h.calls.length, 0);
  } finally { await h.close(); }
});

test('N8 HTTP: private -> exact tool boundaries -> refs-only selected share -> isolated public prompt with CSRF and metadata projection', async () => {
  const h = await setup(); try {
    assert.equal(h.boot.version, '0.25.0-p8-pr-ci');
    assert.equal((await h.api(h.path + '/messages', { requestId: rid(), content: '', excerptTargets: ['codex'], excerptRefs: [null] })).status, 400);
    assert.equal((await h.api(h.path + '/visibility-organize', { requestId: rid(), expectedRevision: 1, action: 'groups', groups: [null] })).status, 400);
    const input = { requestId: rid(), content: 'TEST_TOOL_BOUNDARY PRIVATE_UNSELECTED TOKEN_TO_SHARE', privateTo: ['codex'] };
    assert.equal((await h.api(h.path + '/messages', input, '')).status, 403);
    assert.equal((await h.api(h.path + '/messages', input)).status, 201); await h.wait(1);
    assert.equal(h.probes.length, 2); assert.deepEqual(h.calls[0]!.visibility!.memberIds, ['codex']);
    const owner = (await h.api(h.path)).data, hidden = (await h.api(h.path + '?viewer=claude')).data;
    assert.deepEqual(hidden.messages, []); assert.equal(JSON.stringify(hidden).includes('PRIVATE_'), false); assert.equal('events' in hidden, false); assert.equal('contracts' in hidden, false);
    const m = owner.messages[0], start = m.content.indexOf('TOKEN_TO_SHARE');
    const share = { requestId: rid(), content: 'shared data', excerptTargets: ['claude'], excerptRefs: [{ messageId: m.id, revision: m.revision, digest: textDigest(m.content), start, end: m.content.length }] };
    assert.equal((await h.api(h.path + '/messages', share)).status, 201); await h.wait(2);
    assert.equal(h.calls[1]!.member.id, 'claude'); assert.ok(h.calls[1]!.prompt.includes('TOKEN_TO_SHARE')); assert.equal(h.calls[1]!.prompt.includes('PRIVATE_UNSELECTED'), false); assert.equal(h.calls[1]!.prompt.includes('PRIVATE_MEMORY_VALUE'), false);
    assert.equal((await h.api(h.path + '/messages', { requestId: rid(), content: '@claude PUBLIC' })).status, 201); await h.wait(3);
    assert.equal(h.calls[2]!.prompt.includes('TOKEN_TO_SHARE'), false, 'private shared fragment is not automatically in later public context');
    const exportResult = await h.api(h.path + '/export?viewer=claude'); assert.equal(exportResult.status, 200); assert.equal(JSON.stringify(exportResult.data).includes('PRIVATE_UNSELECTED'), false);
    assert.equal((await h.api('/api/collaboration/search?q=PRIVATE_UNSELECTED&conversationId=' + h.c.id + '&viewer=claude')).data.hits.length, 0);
    assert.equal((await h.api('/api/collaboration/search?q=anything&mode=semantic')).status, 503);
    assert.equal((await h.api(h.path + '?viewer=invalid')).status, 404);
  } finally { await h.close(); }
});

test('N8 HTTP: memory candidate/approval/materialization events and actual prompt, then revoke and new execution excludes memory', async () => {
  const h = await setup(); try {
    const p = (await h.api(h.path + '/memory-candidates', { requestId: rid(), key: 'HTTP decision', content: 'HTTP_MEMORY_MARKER' })).data.result;
    const transition = (action: string, vr: number, er: number) => h.api('/api/collaboration/memory-transition', { requestId: rid(), versionId: p.version.id, action, expectedRevision: vr, expectedEntryRevision: er });
    assert.equal((await transition('approve', 1, 1)).status, 200);
    assert.equal((await h.api('/api/collaboration/search?q=HTTP_MEMORY_MARKER')).data.hits.length, 0);
    assert.equal((await transition('materialize', 2, 1)).status, 200);
    assert.equal((await h.api('/api/collaboration/search?q=HTTP_MEMORY_MARKER')).data.hits.length, 1);
    await h.api(h.path + '/messages', { requestId: rid(), content: 'PUBLIC use facts' }); await h.wait(1); assert.ok(h.calls[0]!.prompt.includes('HTTP_MEMORY_MARKER'));
    assert.equal((await transition('revoke', 3, 2)).status, 200);
    await h.api(h.path + '/messages', { requestId: rid(), content: 'PUBLIC second' }); await h.wait(2); assert.equal(h.calls[1]!.prompt.includes('HTTP_MEMORY_MARKER'), false);
    const events = (await h.api(h.path)).data.events.map((e: any) => e.type); for (const t of ['memory.candidate', 'memory.approve', 'memory.materialize', 'memory.revoke']) assert.ok(events.includes(t));
  } finally { await h.close(); }
});

test('N8 HTTP: group targeting, branch no implicit call, human read cursor, trash restore and version conflicts', async () => {
  const h = await setup(); try {
    const groups = { requestId: rid(), expectedRevision: 1, action: 'groups', groups: [{ name: 'team', memberIds: ['codex', 'claude'] }] };
    assert.equal((await h.api(h.path + '/visibility-organize', groups, '')).status, 403);
    assert.equal((await h.api(h.path + '/visibility-organize', groups)).status, 200);
    await h.api(h.path + '/messages', { requestId: rid(), content: '@team PUBLIC group' }); await h.wait(2);
    const d = (await h.api(h.path)).data, m = d.messages[0];
    assert.equal((await h.api(h.path + '/read-cursor', { sequence: m.sequence })).status, 200); assert.equal((await h.api(h.path + '/read-cursor', { sequence: 0 })).data.sequence, m.sequence);
    assert.equal((await h.api(h.path + '/read-cursor', { sequence: 99999 })).status, 400);
    const branch = (await h.api(h.path + '/branch', { requestId: rid(), title: 'HTTP branch', messageId: m.id, expectedRevision: 1, memberIds: ['claude'] })).data.result;
    assert.equal(h.calls.length, 2); assert.equal((await h.api('/api/conversations/' + branch.id)).data.invocations.length, 0);
    assert.equal((await h.api(h.path + '/visibility-organize', { requestId: rid(), expectedRevision: 1, action: 'delete' })).status, 409);
    assert.equal((await h.api(h.path + '/visibility-organize', { requestId: rid(), expectedRevision: 2, action: 'delete' })).status, 200);
    assert.equal((await h.api(h.path + '/messages', { requestId: rid(), content: 'not sent' })).status, 404);
    assert.equal((await h.api(h.path + '/visibility-organize', { requestId: rid(), expectedRevision: 3, action: 'undelete' })).status, 200);
    assert.equal(h.calls.length, 2);
  } finally { await h.close(); }
});
