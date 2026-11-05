// A per-invocation stdio MCP bridge. Capability token is supplied only through the child environment.
import { createInterface } from 'node:readline';
const endpoint = process.env.COLLAB_BRIDGE_ENDPOINT;
const token = process.env.COLLAB_BRIDGE_TOKEN;
if (!endpoint || !token) process.exit(2);
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  void (async () => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'platform-collaboration', version: '0.2.0' } };
    else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list' || message.method === 'tools/call') {
      const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: message.method, params: message.params, id: message.id }) });
      if (!response.ok) throw new Error('Platform tool request was rejected.');
      result = await response.json();
    } else { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported' } })}\n`); return; }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  })().catch(() => {
    try { const message = JSON.parse(line); if (message.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Platform bridge request failed' } })}\n`); } catch { /* Invalid frames cannot identify a reply. */ }
  });
});
input.on('close', () => process.exit(0));
