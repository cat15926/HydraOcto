// Providers can return a buffered JSON message or an SSE stream to the same request.
import type { Json } from './runtime-common.js';

export async function readProviderMessage(response: Response, anthropic: boolean, emit: (text: string) => void) {
  if (!response.body) throw new Error('Model API returned no body.');
  const streamed = response.headers.get('content-type')?.includes('text/event-stream') === true;
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', dataLines: string[] = [], bytes = 0, ended = false;
  let message: Json | undefined;
  const calls = new Map<number, Json>(), inputs = new Map<number, string>();
  function dispatch() {
    if (!dataLines.length) return;
    const payload = dataLines.join('\n');
    dataLines = [];
    if (payload === '[DONE]') { ended = true; return; }
    const frame = JSON.parse(payload);
    if (frame.error) throw new Error('Model stream failed.');
    if (anthropic) {
      if (frame.type === 'message_start') message = frame.message;
      if (!message) return;
      if (frame.type === 'content_block_start') message.content[frame.index] = frame.content_block;
      if (frame.type === 'content_block_delta') {
        const block = message.content[frame.index], delta = frame.delta;
        if (block.type === 'text' && delta.type === 'text_delta') { block.text += delta.text; emit(delta.text); }
        if (delta.type === 'input_json_delta') inputs.set(frame.index,(inputs.get(frame.index) ?? '') + delta.partial_json);
        if (delta.type === 'thinking_delta') block.thinking += delta.thinking;
        if (delta.type === 'signature_delta') block.signature = delta.signature;
      }
      if (frame.type === 'content_block_stop' && inputs.has(frame.index)) message.content[frame.index].input = JSON.parse(inputs.get(frame.index)!);
      if (frame.type === 'message_delta') message.stop_reason = frame.delta.stop_reason;
      if (frame.type === 'message_stop') ended = true;
    } else {
      const choice = frame.choices?.find((c: Json) => c.index === 0);
      if (!choice) return;
      message ??= { id:frame.id, choices:[{message:{content:''}}] };
      const out = message.choices[0], delta = choice.delta ?? {};
      if (delta.role) out.message.role = delta.role;
      if (typeof delta.content === 'string') { out.message.content += delta.content; emit(delta.content); }
      if (typeof delta.reasoning_content === 'string') out.message.reasoning_content = (out.message.reasoning_content ?? '') + delta.reasoning_content;
      for (const part of delta.tool_calls ?? []) {
        const call = calls.get(part.index) ?? {function:{name:'',arguments:''}};
        if (part.id) call.id = part.id;
        if (part.type) call.type = part.type;
        call.function.name += part.function?.name ?? '';
        call.function.arguments += part.function?.arguments ?? '';
        calls.set(part.index,call);
      }
      if (choice.finish_reason) out.finish_reason = choice.finish_reason;
    }
  }
  try {
    for (;;) {
      const {value,done} = await reader.read();
      bytes += value?.byteLength ?? 0;
      if (bytes > 2_000_000) throw new Error('Model response exceeds 2 MB.');
      buffer += decoder.decode(value,{stream:!done});
      if (streamed) {
        const lines = buffer.split('\n');
        buffer = done ? '' : lines.pop()!;
        for (const raw of lines) {
          const line = raw.replace(/\r$/, '');
          if (!line) dispatch();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /,''));
        }
      }
      if (done) break;
    }
    if (!streamed) return {data:JSON.parse(buffer) as Json,streamed};
    dispatch();
    if (!ended || !message) throw new Error('Incomplete model stream.');
    if (calls.size) message.choices[0].message.tool_calls = [...calls.values()];
    return {data:message,streamed};
  } catch (error) { await reader.cancel().catch(()=>{}); throw error; }
}
