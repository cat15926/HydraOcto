import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type RequestListener } from 'node:http';
import { createProjectGateway, type ProjectGatewayResponse } from '../server/collaboration/project-vm-gateway.js';
import type { RuntimeRequest } from '../shared/collaboration.js';

async function endpoint(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((ok, fail) => server.once('error',fail).listen(0,'127.0.0.1',ok));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(ok => server.close(() => ok())); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return 'http://127.0.0.1:' + address.port;
}
async function request(t: TestContext, claude: boolean, baseUrl?: string) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'project-gateway-')));
  t.after(() => rm(cwd,{recursive:true,force:true}));
  const st = await stat(cwd);
  const envName = 'GATEWAY_TEST_' + randomUUID().replaceAll('-','').toUpperCase();
  const key = 'synthetic-' + randomUUID();
  process.env[envName] = key;
  t.after(() => {delete process.env[envName];});
  const controller = new AbortController(), calls: string[] = [];
  const req: RuntimeRequest = {
    projectWork:true, invocationId:'run',conversationId:'c',cwd,prompt:'test in a temporary directory',signal:controller.signal,
    member:{id:'m',name:'test',enabled:true,carrier:claude?'claude-cli':'codex-app-server',accountId:'a',model:'frozen',instructions:''},
    account:{id:'a',name:'fixture',provider:claude?'claude':'codex',auth:'api',apiKeyEnv:envName,baseUrl},
    workspaceGrant:{path:cwd,device:st.dev,inode:st.ino,mode:'project-work',authorizedAt:new Date().toISOString(),revision:1,conversationId:'c',memberIds:['m']},
    toolPolicyVersion:'cross-action-v1',onEvent:()=>{},onToolCall:async(name,_args,id)=>{ calls.push(name + '/' + id); return {ok:true}; }
  };
  return {req,key,calls,controller,send:createProjectGateway(req)};
}
function frame(path: string, value: unknown, id = randomUUID() as string) {
  return {id,path,bodyBase64:Buffer.from(JSON.stringify(value)).toString('base64')};
}
const decode = (r: ProjectGatewayResponse) => Buffer.from(r.bodyBase64,'base64').toString('utf8');

test('project screenshot requests permit the frozen Codex image and only replay observed GLM image receipts as plain text', async t => {
  const img = {attachmentId:'fixture', digest:'fixture', mediaType:'image/png' as const, base64:'cGl4ZWxz'};
  const use = {type:'mcp_tool_use', name:'analyze_image', id:'receipt-1', server_name:'upstream', input:{}};
  const receipt = {type:'mcp_tool_result', tool_use_id:'receipt-1', content:[{type:'text',text:'12345'}]};
  const requests: any[] = [];
  t.mock.method(globalThis,'fetch',async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const events = [use,receipt].map(content_block => ({type:'content_block_start',content_block}));
    const body = [...events,{type:'message_stop'},{type:'response.completed'}].map(e => 'data: '+JSON.stringify(e)+'\n').join('\n');
    return new Response(body,{headers:{'content-type':'text/event-stream'}});
  });
  const {req:codex} = await request(t,false,'https://example.invalid/v1');
  const sendCodex = createProjectGateway({...codex,images:[img]});
  const sendImage = (url:string) => sendCodex(frame('/model/v1/responses',{model:'frozen',input:[{type:'message',content:[{type:'input_image',image_url:url}]}]}));
  assert.equal((await sendImage('data:image/png;base64,YW5vdGhlcg==')).status,400);
  assert.equal((await sendImage('https://example.invalid/private.png')).status,400);
  assert.equal((await sendImage('data:image/png;base64,'+img.base64)).status,200);
  const {req:claude} = await request(t,true,'https://open.bigmodel.cn/api/anthropic');
  const sendClaude = createProjectGateway({...claude,images:[img]});
  const replay = (role:string,content:unknown[]) => sendClaude(frame('/model/v1/messages',{model:'frozen',messages:[{role,content}]}));
  assert.equal((await replay('assistant',[use,receipt])).status,400);
  assert.equal((await replay('user',[{type:'image',source:{type:'base64',media_type:img.mediaType,data:img.base64}}])).status,200);
  assert.equal((await replay('user',[use,receipt])).status,400);
  assert.equal((await replay('assistant',[{...receipt,tool_use_id:'unrelated'}])).status,400);
  assert.equal((await replay('assistant',[{...use,name:'other_tool'}])).status,400);
  assert.equal((await replay('assistant',[use,{...receipt,content:[{type:'text',text:'guest-supplied replacement'}]}])).status,200);
  const history = requests.at(-1).messages[0].content;
  assert(history.every((b:{type:string})=>b.type==='text'));
  assert.equal(history[1].text,'12345');
  assert.equal(requests.length,3);
});

test('project model request binds to account, API, endpoint, local tools and one canonical input', async t => {
  const seen: {path?:string; auth?:string; body:string}[] = [];
  const url = await endpoint(t,async(req,res)=>{
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({path:req.url,auth:req.headers.authorization,body});
    res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','x-internal-info':'private'});
    res.end('data: {"type":"response.completed"}\n\n');
  });
  const {req,key,send} = await request(t,false,url + '/v1');
  const path = '/model/v1/responses', good = {model:'frozen',input:'test',tools:[{type:'function',name:'read',parameters:{type:'object'}}],stream:true};
  assert.equal((await send(frame('/model/v1/messages',good))).status,404);
  assert.equal((await send(frame(path, {...good,model:'other'}))).status,400);
  assert.equal((await send(frame(path, {...good,tools:[{type:'web_search'}]}))).status,400);
  assert.equal((await send(frame(path, {...good,previous_response_id:'other'}))).status,400);
  assert.equal((await send(frame(path, {...good,input:[{type:'input_image',image_url:'https://invalid.test'}]}))).status,400);
  const payload = frame(path,good);
  const response = await send({...payload,headers:{authorization:'Bearer guest-dummy',host:'example.invalid'}});
  assert.equal(seen.length,1); assert.equal(seen[0]!.auth,'Bearer '+key); assert.equal(seen[0]!.path,'/v1/responses');
  assert.deepEqual(JSON.parse(seen[0]!.body),good);
  assert.equal(decode(response),'data: {"type":"response.completed"}\n\n'); assert.deepEqual(response.headers,{'content-type':'text/event-stream'});
  assert.equal((await send(payload)).status,409);
  assert.equal((await send(frame(path,{...{stream:true},...good}))).status,409); assert.equal(seen.length,1);
  assert.throws(()=>createProjectGateway({...req,projectWork:undefined}));
  assert.throws(()=>createProjectGateway({...req,account:{...req.account,auth:'cli'}}));
});

test('project gateway denies provider redirects and echoed secrets, bounds data, and aborts exposed requests without replay', async t => {
  let count = 0; let lastAuth: string | undefined;
  const ready = Promise.withResolvers<void>();
  const url = await endpoint(t,async(req,res)=>{
    count++; lastAuth = req.headers.authorization; let raw=''; for await (const chunk of req) raw+=chunk;
    const action = JSON.parse(raw).messages;
    if (action === 'redirect') { res.writeHead(307,{location:'/destination'}); res.end(); }
    else if (action === 'partial') { res.writeHead(200,{'content-type':'text/event-stream'}); res.end('data: {"type":"message_start"}\n\n'); }
    else if (action === 'wait') { res.writeHead(200,{'content-type':'text/event-stream'}); res.write('data: a\n\n'); ready.resolve(); }
    else { res.writeHead(200,{'content-type':'application/json'}); res.end(action === 'oversize' ? Buffer.alloc(8 * 1024 * 1024 + 1,120) : JSON.stringify({echo:lastAuth})); }
  });
  const {req,key,send,controller} = await request(t,true,url+'/anthropic');
  const path='/model/v1/messages?beta=true';
  assert.equal((await send({id:'too-big',path,bodyBase64:'a'.repeat(6*1024*1024)})).status,413);
  for (const action of ['redirect','echo','oversize','partial']) {
    const gate = createProjectGateway(req);
    const r = await gate(frame(path,{model:'frozen',messages:action}));
    assert.equal(r.status,502); assert.ok(!decode(r).includes(key)); assert.deepEqual(r.headers,{'content-type':'application/json'});
    assert.equal((await gate(frame(path,{model:'frozen',messages:action,metadata:{different:'retry'}}))).status,409);
  }
  const wait = frame(path,{model:'frozen',messages:'wait'});
  const pending = send(wait); await ready.promise; controller.abort();
  assert.equal((await pending).status,502); assert.equal((await send(wait)).status,409);
  assert.equal(count,5);
});

test('project Claude MCP handshake, fixed tool authority and nested request identity prevent duplicate effects', async t => {
  const { send,calls } = await request(t,true);
  const mcp = (method: string, params?: unknown, id?: string | number) => send(frame('/mcp',{jsonrpc:'2.0',method,params,id}));
  assert.equal(JSON.parse(decode(await mcp('tools/list',{},1))).error.code,-32002);
  assert.equal(JSON.parse(decode(await mcp('initialize',{protocolVersion:'2025-06-18'},2))).result.protocolVersion,'2025-06-18');
  assert.equal((await mcp('notifications/initialized')).status,202);
  const tools: {name:string}[] = JSON.parse(decode(await mcp('tools/list',{},3))).result.tools;
  assert.ok(!tools.some(t=>t.name.startsWith('workspace_'))); assert.ok(tools.some(t=>t.name==='task_list'));
  assert.equal(JSON.parse(decode(await mcp('tools/call',{name:'workspace_read',arguments:{path:'fixture'}},4))).error.code,-32602);
  const call = {name:'task_list',arguments:{}};
  assert.ok(JSON.parse(decode(await mcp('tools/call',call,'call-1'))).result.content.length);
  assert.equal(JSON.parse(decode(await mcp('tools/call',call,'call-1'))).error.code,-32600);
  assert.equal(calls.length,1);
});
