import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';
import { startProjectExecutorBridge } from '../server/collaboration/project-executor-bridge.js';
import type { CliTransport } from '../server/collaboration/runtime-common.js';

function guest() {
  const lines: string[] = [];
  const signals: NodeJS.Signals[] = [];
  let receive!: (data: string) => void;
  let exit!: () => void;
  const transport: CliTransport = {
    connect(onData, onExit) { receive = onData; exit = () => onExit(0, null, true); },
    write(data) { lines.push(data); },
    end() { throw new Error('unexpected end'); },
    kill(signal) { signals.push(signal); }
  };
  return { transport, lines, signals, output: (text: string) => receive(text), exit: () => exit() };
}

async function refused(url: string, headers: Record<string, string>) {
  const socket = new WebSocket(url, { headers });
  assert.match(String((await once(socket, 'error'))[0]), /socket hang up|ECONNREFUSED/);
}

test('executor bridge restricts authority, origin and bearer, then relays one JSONL session', async t => {
  const process = guest();
  const bridge = await startProjectExecutorBridge(()=>process.transport);
  t.after(bridge.close);
  const headers = { Authorization: 'Bearer ' + bridge.capability };
  assert.ok(!bridge.url.includes(bridge.capability));
  await refused(bridge.url, {});
  await refused(bridge.url, { Authorization: 'Bearer wrong' });
  await refused(bridge.url, { ...headers, Origin: 'http://localhost' });
  await refused(bridge.url, { ...headers, Host: 'other.test' });
  await refused(bridge.url + 'other', headers);

  const ws = new WebSocket(bridge.url, { headers });
  await once(ws, 'open');
  await refused(bridge.url, headers);
  ws.send('{\n "id":1,"method":"initialize"\n}');
  await t.waitFor(() => assert.equal(process.lines.length, 1));
  assert.deepEqual(process.lines, ['{  "id":1,"method":"initialize" }\n']);
  const response = once(ws, 'message');
  process.output('{"id":1,');
  process.output('"result":{}}\n');
  assert.equal(String((await response)[0]), '{"id":1,"result":{}}');
  const closed = once(ws, 'close');
  ws.close();
  await closed;
  await t.waitFor(() => assert.equal(process.signals.length, 1));
  await refused(bridge.url, headers);
  bridge.close();
  assert.deepEqual(process.signals, ['SIGTERM']);
});

test('executor bridge terminates the domain on oversized or invalid messages', async t => {
  for (const direction of ['client JSON', 'guest JSON', 'client binary', 'guest oversized', 'client oversized']) {
    await t.test(direction, async t => {
      const process = guest();
      const bridge = await startProjectExecutorBridge(()=>process.transport);
      t.after(bridge.close);
      const ws = new WebSocket(bridge.url, { headers: { Authorization: 'Bearer ' + bridge.capability } });
      await once(ws, 'open');
      const closed = once(ws, 'close');
      switch (direction) {
        case 'client JSON': ws.send('{}\n{}'); break;
        case 'guest JSON': process.output('[]\n'); break;
        case 'client binary': ws.send(Buffer.from('{}')); break;
        case 'guest oversized': process.output(' '.repeat(2_000_001)); break;
        case 'client oversized': ws.send(' '.repeat(2_000_001)); break;
      }
      await closed;
      await t.waitFor(() => assert.equal(process.signals.length, 1));
      assert.deepEqual(process.lines, []);
    });
  }
});

test('guest exit invalidates the connection without fabricating another stop', async t => {
  const process = guest();
  const bridge = await startProjectExecutorBridge(()=>process.transport);
  t.after(bridge.close);
  const ws = new WebSocket(bridge.url, { headers: { Authorization: 'Bearer ' + bridge.capability } });
  await once(ws, 'open');
  const closed = once(ws, 'close');
  process.exit();
  await closed;
  assert.deepEqual(process.signals, []);
});
