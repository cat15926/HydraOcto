import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeEvent, RuntimeRequest } from '../shared/collaboration.js';
import { NativeToolEvidence } from '../server/collaboration/native-tool-evidence.js';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';

test('native receipts keep separate failed/passing commands and deduplicate terminal replays', () => {
  const events: RuntimeEvent[] = [];
  const evidence = new NativeToolEvidence('/project', event => events.push(event));
  for (const [id, code] of [['first', 1], ['second', 0]] as const) {
    const item = { type: 'commandExecution', id, command: 'npm test -- secret-input', status: 'completed', exitCode: code };
    evidence.codex('thread', 'turn', { ...item, status: 'inProgress', exitCode: null }, 'started');
    evidence.codex('thread', 'turn', item, 'completed');
    evidence.codex('thread', 'turn', item, 'completed');
  }
  evidence.codex('thread', 'turn', { id: 'change', type: 'fileChange', changes: [{ path: '/project/src/main.ts' }], status: 'completed' }, 'completed');
  assert.deepEqual(events.map(e => e.detail.state), ['started', 'failed', 'started', 'completed', 'completed']);
  assert.deepEqual(events.map(e => e.detail.exitCode), [undefined, 1, undefined, 0, undefined]);
  assert.equal(events.at(-1)?.detail.path, 'src/main.ts');
  assert.equal(events[0].detail.commandLabel, 'npm test');
  assert.ok(!JSON.stringify(events).includes('secret-input'));
});

test('Claude pairs tool results only with the observed root session and native call ID', () => {
  const events: RuntimeEvent[] = [];
  const evidence = new NativeToolEvidence('/project', event => events.push(event));
  const use = { session_id: 's', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', id: 'call', input: {file_path: '/outside/secret-name', content: 'private-file-content'} }] } };
  const result = { session_id: 's', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call', is_error: true, content:'private-tool-output' }] } };
  evidence.claude('s', result);
  evidence.claude('s', use);
  evidence.claude('s', { ...result, session_id: 'different' });
  evidence.claude('s', { ...result, parent_tool_use_id: 'subagent' });
  evidence.claude('s', result);
  evidence.claude('s', result);
  assert.deepEqual(events.map(e => e.detail.state), ['started', 'failed']);
  assert.ok(!/outside|secret-name|private-file-content|private-tool-output/.test(JSON.stringify(events)));
});

test('unverified host never launches a read-only CLI in response to a project-write request', async () => {
  const runtime = createCollaborationRuntime({ codexPath: '/does-not-exist', claudePath: '/does-not-exist' });
  for (const [carrier, provider] of [['codex-app-server','codex'],['claude-cli','claude']] as const) {
    for (const auth of ['api', 'cli'] as const) {
      const events: RuntimeEvent[] = [];
      const member = { id: 'm', name: 'm', enabled: true, instructions: '', carrier, accountId: 'a' };
      const account = { id: 'a', name: 'a', provider, auth };
      const capability = runtime.projectWorkAvailability!(member, account);
      assert.equal(capability.available, false);
      const result = runtime.invoke({ member, account, projectWork: true, cwd: '/project', invocationId: carrier + auth, conversationId: 'c', prompt: '', signal: new AbortController().signal, onToolCall: async () => null, onEvent: e => events.push(e) } as RuntimeRequest);
      await assert.rejects(result, error => error instanceof Error && error.message === capability.reason);
      assert.ok(events.some(e => e.kind === 'not_accepted'));
      assert.ok(!events.some(e => e.kind === 'exposed' || e.kind === 'prepared'));
    }
  }
});

test('Codex records completed batch paths even when the started item has none, and retains only project-relative paths', () => {
  const events: RuntimeEvent[] = [];
  const evidence = new NativeToolEvidence('/chosen',event=>events.push(event));
  const item = { id:'files',type:'fileChange' };
  evidence.codex('thread','turn',item,'started');
  evidence.codex('thread','turn',{...item,status:'completed',changes:[{path:'src/a.py'},{path:'/elsewhere/secret'},{path:'/chosen/src/b.py'}]},'completed');
  assert.deepEqual(events[1].detail.paths,['src/a.py','src/b.py']);
  assert.ok(!JSON.stringify(events).includes('secret'));
});
