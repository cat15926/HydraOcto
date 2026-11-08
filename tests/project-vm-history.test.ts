import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { RuntimeRequest } from '../shared/collaboration.js';
import { beginProjectHistory } from '../server/collaboration/project-vm-history.js';

const previous = randomUUID(), session = randomUUID(), anchor = randomUUID();
const request: RuntimeRequest = {
  invocationId: randomUUID(), conversationId: 'conversation', cwd: '/synthetic', prompt: 'prompt', signal: new AbortController().signal,
  projectWork: true, projectContinuity: true,
  member: { id: 'm', name: 'm', enabled: true, carrier: 'codex-app-server', accountId: 'a', model: 'test', instructions: '' },
  account: { id: 'a', name: 'synthetic', provider: 'codex', auth: 'api' },
  workspaceGrant: { path: '/synthetic', device: 42, inode: 9, mode: 'project-work', revision: 1,
    authorizedAt: new Date().toISOString(), conversationId: 'conversation', memberIds: ['m'] },
  sessionPlan: { mode: 'resume', reason: 'ready', fingerprint: 'frozen plan fingerprint', identity: { supported: true, reason: 'matched' },
    previousInvocationId: previous, previousAnchor: anchor, nativeSessionId: session },
  onEvent: () => {}, onToolCall: async () => {},
};

test('a project checkpoint requests only the exact frozen run, anchor and native session', async () => {
  const calls: string[][] = [];
  const name = '2026/11/08/rollout-2026-11-08T10-01-02-' + session + '.jsonl';
  const checkpoint = await beginProjectHistory(request, 'codex', async args => {
    calls.push(args);
    return JSON.stringify(args[1] === 'begin' ? { restored: true, name } : { saved: true, rows: [] });
  });
  assert.deepEqual(calls[0]?.slice(3), [request.invocationId, 'codex', previous, session, anchor]);
  assert.equal(checkpoint?.history.restoredRolloutPath, '/tmp/home/.codex/sessions/' + name);
  assert.equal(await checkpoint?.history.finish(session, 'not-a-turn'), undefined);
  assert.deepEqual(await checkpoint?.history.finish(session, anchor), []);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]?.slice(3), [request.invocationId, 'codex', '-', session, anchor]);
  await assert.rejects(beginProjectHistory(request, 'codex', async () =>
    JSON.stringify({ restored:true, name:name.replace(session, randomUUID()) })), /上次执行/);
});

test('different grants, principals and fingerprints have separate guest namespaces; pre-P2 work does not access history', async () => {
  const scopes = new Set<string>();
  const empty = async (args: string[]) => {
    scopes.add(args[2]!);
    return '{"restored":false}';
  };
  for (const input of [request, { ...request, conversationId: 'other' },
    { ...request, member: { ...request.member, id: 'other' } },
    { ...request, account: { ...request.account, id: 'other' } },
    { ...request, workspaceGrant: { ...request.workspaceGrant!, revision: 2 } },
    { ...request, sessionPlan: { ...request.sessionPlan!, fingerprint: 'changed' } }]) {
    await beginProjectHistory(input, 'codex', empty);
  }
  assert.equal(scopes.size, 6);
  const unexpected = async () => { throw new Error('unexpected history request'); };
  assert.equal(await beginProjectHistory({ ...request, projectContinuity: undefined }, 'codex', unexpected), undefined);
  assert.equal(await beginProjectHistory({ ...request, sessionPlan: { ...request.sessionPlan!, imageTurnOnly: true } }, 'codex', unexpected), undefined);
  await beginProjectHistory({ ...request, sessionPlan: { ...request.sessionPlan!, previousInvocationId: undefined } }, 'codex', async args => {
    assert.deepEqual(args.slice(-3), ['-', '-', '-']);
    return '{"restored":false}';
  });
});
