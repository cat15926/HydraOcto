// Read-only MCP search services are provisioned by the platform operator with read-only credentials.
import {createHash, randomUUID} from 'node:crypto';
import type {McpReaderGrant} from '../../shared/collaboration.js';
import {AppError} from '../store.js';

const PROTOCOL = '2025-06-18';
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
const namePattern = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
type Reader = {grant:McpReaderGrant;url:string;parameter:string;token?:string};

export class McpReaders {
  private readonly entries = new Map<string,Reader>();
  constructor(config:string|undefined, env:NodeJS.ProcessEnv = {}) {
    if (!config) return;
    const rows:unknown = JSON.parse(config);
    if (!Array.isArray(rows) || rows.length > 12) throw new Error('只读 MCP 配置无效。');
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Object.keys(row).some(k => !['id','label','url','tool','parameter','tokenEnv','readOnly'].includes(k)) ||
          row.readOnly !== true || typeof row.id !== 'string' || !namePattern.test(row.id) || this.entries.has(row.id) ||
          typeof row.tool !== 'string' || !namePattern.test(row.tool) || typeof row.parameter !== 'string' || !namePattern.test(row.parameter) ||
          typeof row.label !== 'string' || !row.label.trim() || row.label.length > 70 || /[\x00-\x1f\x7f]/.test(row.label) ||
          typeof row.url !== 'string') throw new Error('请登记只读服务标识、名称、端点和只读搜索工具。');
      const url = new URL(row.url);
      if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','[::1]'].includes(url.hostname))) ||
          url.username || url.password || url.search || url.hash) throw new Error('只读 MCP 端点需要 HTTPS 或本机回环地址。');
      let token:string|undefined;
      if (row.tokenEnv !== undefined) {
        if (typeof row.tokenEnv !== 'string' || !/^COLLAB_MCP_TOKEN_[A-Z0-9_]+$/.test(row.tokenEnv) || !(token = env[row.tokenEnv]) || !/^[\x21-\x7e]+$/.test(token)) throw new Error('只读 MCP 服务凭据配置无效。');
      }
      const grant = {id:row.id,label:row.label,origin:url.origin,tool:row.tool,
        revision:hash(JSON.stringify([row.id,row.label,url.href,row.tool,row.parameter,row.tokenEnv ?? null]))};
      this.entries.set(grant.id,{grant,url:url.href,parameter:row.parameter,token});
    }
  }
  catalog():McpReaderGrant[] { return [...this.entries.values()].map(entry => ({...entry.grant})); }
  lookup(id:unknown):McpReaderGrant {
    const entry = typeof id === 'string' && this.entries.get(id);
    if (!entry) throw new AppError(409,'该只读资料源已不可用，请重新选择。');
    return {...entry.grant};
  }
  private redactSecrets(text:string) {
    for (const {token} of this.entries.values()) {
      if (token) text = text.split(token).join('[redacted]');
    }
    return text;
  }
  async search(grant:McpReaderGrant, query:string, signal:AbortSignal, verify:()=>void) {
    const reader = this.entries.get(grant.id);
    if (!reader || reader.grant.revision !== grant.revision) throw new AppError(409,'资料源配置已变化，请重新授权。');
    if (this.redactSecrets(query) !== query) throw new AppError(400,'查询含有受保护信息。');
    let session:string|undefined;
    const headers = () => ({
      Accept:'application/json, text/event-stream', 'Content-Type':'application/json',
      ...(reader.token ? {Authorization:'Bearer '+reader.token} : {}), ...(session ? {'Mcp-Session-Id':session} : {})
    });
    const timed = AbortSignal.any([signal,AbortSignal.timeout(15_000)]);
    async function send(method:string, params?:Record<string,unknown>, notify=false) {
      verify();
      const id = notify ? undefined : randomUUID();
      const response = await fetch(reader!.url,{method:'POST',signal:timed,redirect:'error',
        headers:{...headers(),...(method === 'initialize' ? {} : {'MCP-Protocol-Version':PROTOCOL})},
        body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
      if (!response.ok || (notify && response.status !== 202)) { await response.body?.cancel(); throw new Error('MCP 请求未获服务接受。'); }
      if (notify) { await response.body?.cancel(); return; }
      if (method === 'initialize') {
        const value = response.headers.get('mcp-session-id');
        if (value && !/^[\x21-\x7e]{1,256}$/.test(value)) { await response.body?.cancel(); throw new Error('MCP 会话标识无效。'); }
        session = value ?? undefined;
      }
      return readReply(response,id!);
    }
    try {
      const init = await send('initialize',{protocolVersion:PROTOCOL,clientInfo:{name:'multi-agent-reader',version:'1'},capabilities:{}});
      if (init?.protocolVersion !== PROTOCOL || !init.capabilities || typeof init.capabilities !== 'object' || !('tools' in init.capabilities)) throw new Error('资料源不支持受管只读协议。');
      await send('notifications/initialized',undefined,true);
      const result = await send('tools/call',{name:reader.grant.tool,arguments:{[reader.parameter]:query}});
      verify();
      if (result?.isError || !Array.isArray(result?.content) || result.content.some((v:Record<string,unknown>) => v?.type !== 'text' || typeof v.text !== 'string')) throw new Error('资料源未返回文本结果。');
      const text = this.redactSecrets(result.content.map((v:{text:string}) => v.text).join('\n'));
      if (Buffer.byteLength(text) > 16_384) throw new Error('资料源结果过大，请缩小查询范围。');
      return text;
    } finally {
      if (session) {
        try {
          const closed = await fetch(reader.url,{method:'DELETE',headers:{...headers(),'MCP-Protocol-Version':PROTOCOL},signal:AbortSignal.timeout(2000),redirect:'error'});
          await closed.body?.cancel();
        } catch { /* Session termination is optional; the server owns its lifetime. */ }
      }
    }
  }
}

async function readReply(response:Response,id:string) {
  const contentType = response.headers.get('content-type')?.split(';')[0].trim();
  if (!response.body || (contentType !== 'application/json' && contentType !== 'text/event-stream')) {
    await response.body?.cancel(); throw new Error('MCP 返回类型无效。');
  }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8',{fatal:true});
  let bytes = 0, text = '';
  const resultOf = (value:Record<string,unknown>) => {
    if (value?.jsonrpc !== '2.0' || value.id !== id || value.error || !value.result || typeof value.result !== 'object') throw new Error('MCP 回执未对应本次查询。');
    return value.result as Record<string,unknown>;
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if ((bytes += chunk.value.byteLength) > 65_536) throw new Error('MCP 回执过大。');
      text += decoder.decode(chunk.value,{stream:true});
      if (contentType === 'text/event-stream') {
        let end;
        while ((end = /\r?\n\r?\n/.exec(text))) {
          const event = text.slice(0,end.index);
          text = text.slice(end.index + end[0].length);
          const payload = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!payload) continue;
          const message = JSON.parse(payload);
          if (message?.id === undefined && typeof message?.method === 'string') continue;
          return resultOf(message);
        }
      }
    }
    text += decoder.decode();
    if (contentType === 'application/json') return resultOf(JSON.parse(text));
    throw new Error('MCP 流缺少终态回执。');
  } finally { await reader.cancel(); }
}
