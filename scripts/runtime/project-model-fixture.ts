// A loopback model asks the installed native CLI to act. This process never edits the project.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

type Frame = Record<string, any>;

export function nativeFixtureStream(carrier: 'codex' | 'claude', model: string, sequence: string, answer: string, action?: {name:string;args:Frame}) {
  const events: Frame[] = [];
  if (carrier === 'codex') {
    const id = 'resp_' + sequence;
    const base = { id, object: 'response', model, status: 'in_progress', output: [] };
    const item = action ? { type: 'function_call', id: 'fc_' + sequence, call_id: 'call_' + sequence, name: action.name, arguments: JSON.stringify(action.args) }
      : { type: 'message', id: 'msg_' + sequence, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] };
    events.push({ type: 'response.created', response: base }, { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { ...base, status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 12, total_tokens: 32 } } });
  } else {
    const message = { id: 'msg_' + sequence, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } };
    const block = action ? { type: 'tool_use', id: 'toolu_' + sequence, name: action.name, input: {} } : { type: 'text', text: '' };
    const delta = action ? { type: 'input_json_delta', partial_json: JSON.stringify(action.args) } : { type: 'text_delta', text: answer };
    events.push({ type: 'message_start', message }, { type: 'content_block_start', index: 0, content_block: block },
      { type: 'content_block_delta', index: 0, delta }, { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: action ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }, { type: 'message_stop' });
  }
  return events.map(e => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join('');
}

export async function startProjectModelFixture(carrier: 'codex' | 'claude', folder: string, token: string, credential: string, pauseForStop = false) {
  // Claude's Bash tool can retain a changed working directory between successful calls.
  if (!/^(codex|claude)-monthly-[A-Za-z0-9]+$/.test(folder)) throw new Error('Unexpected synthetic case directory');
  const project = '/mnt/project/' + folder;
  const scoped = 'python3 verify-child.py && ';
  const commands = pauseForStop ? [
    `cd ${project} && ${scoped}printf '%s' FIRST_${token} > first.txt && while ! test -f release.flag; do sleep 0.1; done && printf '%s' SECOND_${token} > second.txt`
  ] : [
    `cd ${project} && ${scoped}python3 check.py`,
    `cd ${project} && sed -i 's/if amount:/if amount is not None:/' export.py && echo FIX_${token}`,
    `cd ${project} && python3 check.py`,
  ];
  const markers = ['FAIL_', 'FIX_', 'PASS_'].map(prefix => prefix + token);
  const rounds: { step: number; previousResultMatched: boolean; tool: string }[] = [];
  const diagnostics: string[] = [];
  const server = createServer(async (req, res) => {
    const json = (status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      if (req.method !== 'POST' || req.headers.authorization !== 'Bearer ' + credential) return json(403, {});
      let raw = '';
      for await (const chunk of req) {
        raw += chunk.toString();
        if (raw.length > 4_194_304) return json(413, {});
      }
      if (req.url?.split('?')[0] === '/v1/messages/count_tokens') return json(200, { input_tokens: 100 });
      const input = JSON.parse(raw);
      const names = (input.tools ?? []).flatMap((t: Frame) => [t.name, ...(t.tools ?? []).map((s: Frame) => s.name)]).filter(Boolean);
      const tool = carrier === 'claude' ? 'Bash' : names.includes('exec_command') ? 'exec_command' : 'shell_command';
      const auxiliary = !names.includes(tool);
      if (auxiliary) diagnostics.push('auxiliary:' + names.slice(0, 8).join(','));
      const step = auxiliary ? 3 : rounds.length;
      if (step > 3) return json(400, {});
      const previous = step > 0 && step <= 3 ? markers[step - 1] : undefined;
      const returned = carrier === 'codex'
        ? (input.input ?? []).filter((item: Frame) => item.type === 'function_call_output')
        : (input.messages ?? []).flatMap((item: Frame) => Array.isArray(item.content) ? item.content.filter((b: Frame) => b.type === 'tool_result') : []);
      const matched = previous === undefined || JSON.stringify(returned).includes(previous);
      if (!auxiliary && !matched) diagnostics.push('synthetic tool result: ' +
        JSON.stringify(returned.at(-1) ?? {}).replaceAll(credential,'[fixture credential]').slice(0,800));
      if (!auxiliary) rounds.push({ step, previousResultMatched: matched, tool: step < 3 ? tool : 'finish' });
      const command = commands[step];
      const args = carrier === 'claude' ? { command, description: 'Verify synthetic monthly report' }
        : tool === 'exec_command' ? { cmd:command, ...(pauseForStop ? {yield_time_ms:30000} : {}) } : { command };
      res.writeHead(200, { 'Content-Type':'text/event-stream' });
      res.end(nativeFixtureStream(carrier,input.model,'p01_'+step,matched ? 'Verified.' : 'Expected tool evidence missing.',
        step < 3 && matched ? {name:tool,args} : undefined));
    } catch { if (!res.headersSent) json(400, {}); else res.end(); }
  });
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  return { baseUrl: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1', rounds, diagnostics,
    close: async () => { server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); } };
}
