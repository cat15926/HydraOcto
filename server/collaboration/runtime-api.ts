import { apiUserContent } from './runtime-images.js';
import type { RuntimeRequest, RuntimeResult } from '../../shared/collaboration.js';
import { executeTool, runtimeTools, type Json } from './runtime-common.js';

export async function invokeApi(request: RuntimeRequest): Promise<RuntimeResult> {
  const keyName = request.account.apiKeyEnv;
  if (!keyName || !/^[A-Z_][A-Z0-9_]{0,100}$/.test(keyName) || !process.env[keyName]) {
    request.onEvent({ kind: 'not_accepted', detail: { reason: 'Configured credential environment variable is missing; nothing sent.' } });
    request.onEvent({ kind: 'transport_settled', detail: { scope: 'request', confirmed: true, reason: 'not sent' } });
    throw new Error('API account credential is not configured.');
  }
  if (!request.member.model) throw new Error('API members require an explicit model.');
  const anthropic = request.member.carrier === 'anthropic-api';
  const base = (request.account.baseUrl ?? (anthropic ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
  const url = new URL(`${base}/${anthropic ? 'messages' : 'chat/completions'}`);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('API endpoint must use HTTPS, or HTTP on localhost for testing.');
  const messages: Json[] = [{ role: 'user', content: apiUserContent(request, anthropic) }];
  const tools = anthropic ? runtimeTools(request).map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) : runtimeTools(request).map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
  let awaitingProvider = false, explicitlySettled = false;
  const settle = (detail: Json) => { explicitlySettled = true; request.onEvent({ kind: 'transport_settled', detail: { scope: 'request', confirmed: true, ...detail } }); };
  try {
  for (let round = 0; round < 12; round++) {
    request.signal.throwIfAborted();
    request.onEvent({ kind: 'exposed', detail: { transport: 'http', round } });
    awaitingProvider = true;
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: request.signal, headers: { 'content-type': 'application/json', ...(anthropic ? { 'x-api-key': process.env[keyName]!, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${process.env[keyName]}` }) }, body: JSON.stringify({ model: request.member.model, messages, tools, ...(anthropic ? { max_tokens: 4096 } : {}) }) });
    if (!response.ok) {
      await response.body?.cancel();
      awaitingProvider = false;
      if (round === 0 && [400, 401, 403, 404, 422, 429].includes(response.status)) request.onEvent({ kind: 'not_accepted', detail: { status: response.status, round, evidence: 'explicit HTTP rejection' } });
      settle({ status: response.status });
      if (request.images?.length && [400, 413, 415, 422].includes(response.status)) {
        throw new Error(`模型接口拒绝了含截图的输入（HTTP ${response.status}）。请确认所选模型支持图像，或缩小截图后重新发送。`);
      }
      throw new Error(`Model API returned HTTP ${response.status}.`);
    }
    let raw = '';
    if (!response.body) throw new Error('Model API returned no body.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      raw += decoder.decode(item.value, { stream: true });
      if (raw.length > 2_000_000) { await reader.cancel(); throw new Error('Model response exceeds 2 MB.'); }
    }
    raw += decoder.decode();
    awaitingProvider = false;
    let data: Json;
    try { data = JSON.parse(raw) as Json; } catch { throw new Error('Model API returned malformed JSON.'); }
    const reply = anthropic ? data : data.choices?.[0]?.message;
    const validCall = (call: Json) => call && typeof call.id === 'string' && call.id && call.type === 'function' && typeof call.function?.name === 'string' && typeof call.function?.arguments === 'string';
    const validBlock = (item: Json) => item && ((item.type === 'text' && typeof item.text === 'string') || (item.type === 'tool_use' && typeof item.id === 'string' && typeof item.name === 'string' && item.input && typeof item.input === 'object' && !Array.isArray(item.input)) || (item.type === 'thinking' && typeof item.thinking === 'string') || (item.type === 'redacted_thinking' && typeof item.data === 'string'));
    const valid = reply && reply.role === 'assistant' && (anthropic
      ? reply.type === 'message' && Array.isArray(reply.content) && reply.content.every(validBlock) && typeof reply.stop_reason === 'string'
      : (typeof reply.content === 'string' || reply.content === null || (reply.content === undefined && Array.isArray(reply.tool_calls) && reply.tool_calls.length > 0)) && (reply.tool_calls === undefined || (Array.isArray(reply.tool_calls) && reply.tool_calls.every(validCall))));
    if (!valid) throw new Error('Model API returned an invalid assistant message.');
    request.onEvent({ kind: 'accepted', detail: { transport: 'http', round, evidence: 'validated assistant response', providerResponseId: typeof data.id === 'string' ? data.id : undefined } });
    const calls: Json[] = anthropic ? reply.content.filter((item: Json) => item.type === 'tool_use') : reply.tool_calls ?? [];
    const text = anthropic ? reply.content.filter((item: Json) => item.type === 'text').map((item: Json) => item.text).join('\n') : reply.content ?? '';
    if (text) request.onEvent({ kind: 'text', detail: { text } });
    if (!calls.length) {
      if ((anthropic && data.stop_reason !== 'end_turn') || (!anthropic && data.choices?.[0]?.finish_reason !== 'stop')) throw new Error('Model response did not reach a successful terminal condition.');
      settle({ round, providerResponseId: data.id });
      return { text, continuity: 'fresh' };
    }
    if (calls.length > 16) throw new Error('Too many tool calls in one response.');
    messages.push(anthropic ? { role: 'assistant', content: reply.content } : reply);
    const results: Json[] = [];
    for (const call of calls) {
      const callId = call.id;
      if (typeof callId !== 'string' || !callId) throw new Error('Tool call is missing its native identity.');
      let output: string, error = false;
      try {
        const args = anthropic ? call.input : JSON.parse(call.function.arguments);
        output = JSON.stringify(await executeTool(request, anthropic ? call.name : call.function.name, args, callId));
      } catch { output = 'Tool request was rejected by platform.'; error = true; }
      if (anthropic) results.push({ type: 'tool_result', tool_use_id: callId, content: output, is_error: error });
      else messages.push({ role: 'tool', tool_call_id: callId, content: output });
    }
    if (anthropic) messages.push({ role: 'user', content: results });
  }
  settle({ reason: 'tool round limit; no request outstanding' });
  throw new Error('Model exceeded the 12-round tool limit.');
  } finally {
    if (!awaitingProvider && !explicitlySettled) settle({ reason: 'No HTTP request remains outstanding; response parsing or local tool processing ended.' });
  }
}
