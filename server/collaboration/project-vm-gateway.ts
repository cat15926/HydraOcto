import { createHash } from 'node:crypto';
import type { RuntimeRequest } from '../../shared/collaboration.js';
import { cliApiSettings, executeTool, runtimeTools } from './runtime-common.js';
import { redactRuntimeImages } from './runtime-images.js';
import { canonical } from '../store.js';
import { verifyWorkspace } from './workbench.js';

/** Frames received via the authenticated guest supervisor of this invocation only. */
export interface ProjectGatewayRequest {
  id: string; path: string; method?: string; headers?: Record<string, string>; bodyBase64: string;
}
export interface ProjectGatewayResponse { status: number; headers: Record<string, string>; bodyBase64: string }
const MiB = 1024 * 1024;
const protocolVersion = '2025-06-18';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function json(status: number, data: unknown): ProjectGatewayResponse {
  return { status, headers: {'content-type':'application/json'}, bodyBase64: Buffer.from(JSON.stringify(data)).toString('base64') };
}
function deny(status: number, message: string) { return json(status, {error: { message }}); }
function rpc(id: unknown, result: unknown) { return json(200, {jsonrpc: '2.0', id, result}); }
function rpcError(id: unknown, code: number, message: string) { return json(200, {jsonrpc: '2.0', id, error: {code, message}}); }

const codexFields = new Set('model instructions input tools tool_choice parallel_tool_calls reasoning stream stream_options store include prompt_cache_key prompt_cache_retention text service_tier max_output_tokens temperature top_p truncation metadata client_metadata'.split(' '));
const claudeFields = new Set('model messages max_tokens system tools tool_choice stream thinking output_config context_management metadata temperature top_p top_k stop_sequences cache_control service_tier'.split(' '));

function localTools(tools: unknown, claude: boolean): boolean {
  if (tools === undefined) return true;
  if (!Array.isArray(tools)) return false;
  if (claude) return tools.every(t => object(t) && typeof t.name === 'string' &&
    (t.type === undefined || t.type === 'custom') && object(t.input_schema));
  const local = (t: unknown) => object(t) && (t.type === 'function' || t.type === 'custom' || (t.type === 'tool_search' && t.execution === 'client'));
  return tools.every(t => local(t) || (object(t) && t.type === 'namespace' && Array.isArray(t.tools) && t.tools.every(local)));
}

// Model input may contain text/inline content and local tool results. Hosted resources,
// prior response handles, remote documents and server-side tools belong to other authority scopes.
function localContent(input: unknown, allowedImageUrls: ReadonlySet<string>): boolean {
  const todo = [input];
  while (todo.length) {
    const part = todo.pop();
    if (Array.isArray(part)) { for (const item of part) todo.push(item); continue; }
    if (!object(part)) continue;
    if (part.image_url !== undefined && !(part.type === 'input_image' && typeof part.image_url === 'string' &&
        allowedImageUrls.has(part.image_url))) return false;
    if (part.file_id !== undefined || part.file_url !== undefined ||
        part.type === 'item_reference' || part.type === 'url' || part.type === 'reference' ||
        part.type === 'server_tool_use' || part.type === 'mcp_tool_use' || part.type === 'mcp_tool_result') return false;
    // Descend through protocol content, leaving text and tool argument/schema data opaque.
    for (const key of ['content', 'source', 'output']) if (part[key] !== undefined) todo.push(part[key]);
  }
  return true;
}

// The GLM compatibility endpoint can return its own analyze_image receipt as
// MCP blocks inside the assistant message, even though no hosted tool was
// requested. The CLI replays that message on its next model request. Only
// server-observed receipts from this invocation can become plain history text.
class GlmImageReceipts {
  private readonly results = new Map<string, string | undefined>();

  observe(block: unknown) {
    if (!object(block)) return;
    if (block.type === 'mcp_tool_use' && block.name === 'analyze_image' && typeof block.id === 'string' &&
        /^[\w.:-]{1,160}$/.test(block.id) && this.results.size < 64 && !this.results.has(block.id)) this.results.set(block.id, undefined);
    if (block.type !== 'mcp_tool_result' || typeof block.tool_use_id !== 'string' || !this.results.has(block.tool_use_id)) return;
    const content = typeof block.content === 'string' ? block.content : Array.isArray(block.content)
      ? block.content.filter(object).filter(part => part.type === 'text').map(part => typeof part.text === 'string' ? part.text : '').join('\n') : '';
    this.results.set(block.tool_use_id, redactRuntimeImages(content.slice(0, 32_768)));
  }

  asText(messages: unknown) {
    if (!Array.isArray(messages) || !this.results.size) return;
    for (const message of messages) {
      if (!object(message) || message.role !== 'assistant' || !Array.isArray(message.content)) continue;
      message.content = message.content.map(block => {
        if (!object(block)) return block;
        if (block.type === 'mcp_tool_use' && block.name === 'analyze_image' && typeof block.id === 'string' && this.results.has(block.id)) {
          return {type:'text', text:'所选模型服务已请求分析随消息提供的截图。'};
        }
        if (block.type === 'mcp_tool_result' && typeof block.tool_use_id === 'string' && this.results.get(block.tool_use_id) !== undefined) {
          return {type:'text', text:this.results.get(block.tool_use_id) || '截图分析已完成。'};
        }
        return block;
      });
    }
  }
}
async function readResponse(response: Response): Promise<Buffer | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return;
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > 8 * MiB) { await reader.cancel(); return; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
}
export function createProjectGateway(request: RuntimeRequest) {
  const claude = request.member.carrier === 'claude-cli';
  const allowedImageUrls = new Set((request.images ?? []).map(image => 'data:' + image.mediaType + ';base64,' + image.base64));
  const grant = request.workspaceGrant;
  if (!request.projectWork || !grant || grant.mode !== 'project-work' || grant.path !== request.cwd ||
      grant.conversationId !== request.conversationId || !grant.memberIds?.includes(request.member.id) ||
      request.account.id !== request.member.accountId || request.visibility?.kind === 'private' ||
      (!claude && request.member.carrier !== 'codex-app-server') || request.account.auth !== 'api' ||
      request.account.provider !== (claude ? 'claude' : 'codex')) throw new Error('Project gateway requires a matching project CLI/API execution.');
  verifyWorkspace(grant);
  const { key, model, baseUrl } = cliApiSettings(request);
  const glmImages = request.images?.length && claude && new URL(baseUrl).origin === 'https://open.bigmodel.cn' ? new GlmImageReceipts() : undefined;
  const seen = new Set<string>(), modelBodies = new Set<string>(), toolCalls = new Set<string>();
  const tools = runtimeTools(request).filter(t => t.name !== 'workspace_list' && t.name !== 'workspace_read');
  let initialized = false, ready = false, activeModels = 0, modelOutcomeUnknown = false;
  function uncertain() {
    modelOutcomeUnknown = true;
    return deny(502, 'Model delivery interrupted; inspect the original execution.');
  }

  async function mcp(body: Record<string, unknown>) {
    if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') return deny(400, 'Invalid MCP request.');
    const id = body.id;
    if (body.method === 'notifications/initialized' && id === undefined && initialized) {
      ready = true; return {status:202, headers:{}, bodyBase64:''};
    }
    if (!(typeof id === 'string' && id.length <= 128 || Number.isSafeInteger(id))) return deny(400, 'Invalid MCP request identifier.');
    if (body.method === 'initialize') {
      if (!object(body.params) || typeof body.params.protocolVersion !== 'string') return rpcError(id, -32602, 'Invalid initialize parameters.');
      initialized = true;
      return rpc(id, {protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'platform-collaboration',version:'1'}});
    }
    if (body.method === 'ping') return rpc(id, {});
    if (!ready) return rpcError(id,-32002,'Initialize before requesting tools.');
    if (body.method === 'tools/list') return rpc(id, {tools});
    if (body.method !== 'tools/call') return rpcError(id,-32601,'Method not supported.');
    const params = body.params;
    if (!object(params) || typeof params.name !== 'string' || !tools.some(t => t.name === params.name) ||
        (params.arguments !== undefined && !object(params.arguments))) return rpcError(id,-32602,'Tool or arguments outside this execution policy.');
    const callId = 'project-mcp:' + JSON.stringify(id);
    if (toolCalls.has(callId)) return rpcError(id,-32600,'Tool request already received; inspect the existing invocation.');
    toolCalls.add(callId);
    try {
      const result = await executeTool(request,params.name,params.arguments ?? {},callId);
      const text = JSON.stringify(result) ?? 'null';
      if (Buffer.byteLength(text) > MiB || text.includes(key) || request.signal.aborted) throw new Error();
      return rpc(id,{content:[{type:'text',text}]});
    } catch { return rpc(id,{content:[{type:'text',text:'Platform tool request failed. Inspect this invocation before retrying.'}],isError:true}); }
  }

  return async (frame: ProjectGatewayRequest): Promise<ProjectGatewayResponse> => {
    if (request.signal.aborted) return deny(409,'Execution is no longer active.');
    if (!frame || typeof frame.id !== 'string' || !/^[\w.:-]{1,160}$/.test(frame.id)) return deny(400,'Invalid request identifier.');
    if (frame.method !== undefined && frame.method !== 'POST') return deny(405,'Only POST is available.');
    const isMcp = claude && frame.path === '/mcp';
    const pathname = typeof frame.path === 'string' ? frame.path : '';
    const count = pathname === '/model/v1/messages/count_tokens' || pathname === '/model/v1/messages/count_tokens?beta=true';
    if (!isMcp && !(claude ? count || pathname === '/model/v1/messages' || pathname === '/model/v1/messages?beta=true' : pathname === '/model/v1/responses')) return deny(404,'Endpoint unavailable.');
    const max = isMcp ? 64 * 1024 : 4 * MiB;
    if (typeof frame.bodyBase64 !== 'string' || frame.bodyBase64.length > 4 * Math.ceil(max / 3)) return deny(413,'Request too large.');
    const bytes = Buffer.from(frame.bodyBase64,'base64');
    if (bytes.length > max || bytes.toString('base64') !== frame.bodyBase64) return deny(400,'Invalid request encoding.');
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8',{ fatal:true }).decode(bytes)); }
    catch { return deny(400,'Expected a UTF-8 JSON object.'); }
    if (!object(body)) return deny(400,'Expected an object.');
    if (seen.has(frame.id)) return deny(409,'Request already received; no replay.');
    if (seen.size >= 1024) return deny(429,'Invocation request limit reached.');
    seen.add(frame.id);
    try { verifyWorkspace(grant); } catch { return deny(409,'The authorized project directory changed.'); }
    if (modelOutcomeUnknown) return deny(409, 'Previous model delivery is unresolved. No further calls in this execution.');
    if (isMcp) {
      if (Object.keys(frame.headers ?? {}).some(h => h.toLowerCase() === 'origin')) return deny(403,'Browser origins cannot use this invocation bridge.');
      const version = frame.headers?.['mcp-protocol-version'];
      if (version && version !== protocolVersion) return deny(400,'Unsupported MCP version.');
      return mcp(body);
    }
    glmImages?.asText(body.messages);
    if (body.model !== model) return deny(400,'Model differs from the selected account model.');
    if (Object.keys(body).some(k => !(claude ? claudeFields : codexFields).has(k))) return deny(400,'Model request includes an unsupported option.');
    if (!localTools(body.tools, claude)) return deny(400,'Model request includes a tool outside the project policy.');
    if (!localContent(claude ? body.messages : body.input, allowedImageUrls)) return deny(400,'Model input includes an external resource or tool outside the project policy.');
    if (activeModels >= 4) return deny(429,'Too many concurrent model requests.');
    let payload: string;
    try { payload = canonical(body); } catch { return deny(400,'Model request nesting exceeds the supported depth.'); }
    const digest = createHash('sha256').update(pathname.split('?')[0]!).update(payload).digest('hex');
    if (modelBodies.has(digest)) return deny(409,'Identical model request already submitted; no replay.');
    modelBodies.add(digest);
    const endpoint = claude ? baseUrl.replace(/\/v1$/, '') + pathname.slice('/model'.length) : baseUrl + '/responses';
    const headers: Record<string,string> = {'content-type':'application/json',accept:'application/json, text/event-stream'};
    if (claude) {
      headers['anthropic-version'] = '2023-06-01';
      const beta = frame.headers?.['anthropic-beta'];
      if (typeof beta === 'string' && beta.length <= 1024 && /^[a-zA-Z0-9, -]+$/.test(beta)) headers['anthropic-beta'] = beta;
    }
    if (claude && new URL(endpoint).hostname === 'api.anthropic.com') headers['x-api-key'] = key;
    else headers.authorization = 'Bearer ' + key;
    activeModels++;
    try {
      const res = await fetch(endpoint,{method:'POST',headers,body:payload,signal:request.signal,redirect:'error'});
      const type = res.headers.get('content-type')?.split(';')[0]?.toLowerCase();
      if (!res.ok || (type !== 'application/json' && type !== 'text/event-stream')) {
        await res.body?.cancel();
        if (res.ok || res.status >= 500 || res.status === 408) return uncertain();
        return deny(res.status, 'The selected model endpoint rejected the request.');
      }
      const output = await readResponse(res);
      if (!output || output.includes(key) || request.signal.aborted || modelOutcomeUnknown) return uncertain();
      // A clean HTTP EOF can cut an event stream short. The CLI may retry that
      // turn with different metadata, so fence the invocation before handing it any partial data.
      const text = new TextDecoder('utf-8', {fatal:true}).decode(output);
      if (type === 'application/json') {
        const reply: unknown = JSON.parse(text);
        if (!object(reply)) return uncertain();
        if (glmImages && Array.isArray(reply.content)) reply.content.forEach(block => glmImages.observe(block));
      } else {
        const terminal = claude ? 'message_stop' : 'response.completed';
        let completed = false;
        for (const line of text.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          try {
            const event = JSON.parse(line.slice(5));
            if (event.type === terminal) completed = true;
            if (event.type === 'content_block_start') glmImages?.observe(event.content_block);
          } catch { /* Other event-stream data cannot establish completion. */ }
        }
        if (!completed) return uncertain();
      }
      return {status:res.status,headers:{'content-type':type},bodyBase64:output.toString('base64')};
    } catch { return uncertain(); }
    finally { activeModels--; }
  };
}
