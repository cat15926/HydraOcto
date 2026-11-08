import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import test from 'node:test';
import {Store} from '../server/store.js';
import {CollaborationStore} from '../server/collaboration/store.js';
import {McpReaders} from '../server/collaboration/mcp-reader.js';
import {runtimeTools} from '../server/collaboration/runtime-common.js';

const config = {id:'manual',label:'团队资料',tool:'search_docs',parameter:'keywords',readOnly:true};
test('project reader registry allows only a fixed approved tool and an operator-owned credential', () => {
  const row = {...config,url:'https://kb.example.org/mcp'};
  for (const extra of [{readOnly:false},{url:'https://someone@kb.example.org/mcp'},{url:'https://kb.example.org/mcp?q=a'},{url:'file:///tmp/mcp'},{url:'http://10.1.1.1:1234/mcp'},{tokenEnv:'OPENAI_API_KEY'},{token:'direct'},{readOnly:undefined}]) {
    assert.throws(() => new McpReaders(JSON.stringify([{...row,...extra}])));
  }
  assert.deepEqual(new McpReaders(undefined).catalog(),[]);
  const clients = new McpReaders(JSON.stringify([{...row,tokenEnv:'COLLAB_MCP_TOKEN_KB'}]),{COLLAB_MCP_TOKEN_KB:'test-secret'});
  assert.doesNotMatch(JSON.stringify(clients.catalog()),/test-secret|COLLAB_MCP_TOKEN|keywords|\/mcp/);
  assert.throws(() => clients.lookup('invented'));
});

test('project workspace selection binds concrete MCP calls, unique evidence, failure retry and grant revocation',async () => {
  const methods:string[] = [], queries:string[] = [];
  const arrived = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const srv = createServer(async (req,res) => {
    assert.equal(req.url,'/mcp');
    assert.equal(req.headers.authorization,'Bearer fixture-token');
    if (req.method === 'DELETE') {methods.push('DELETE');res.writeHead(204).end();return;}
    let raw = ''; for await (const chunk of req) raw += chunk;
    const msg = JSON.parse(raw);
    methods.push(msg.method);
    if (msg.method === 'initialize') {
      assert.equal(msg.params.protocolVersion,'2025-06-18');
      res.writeHead(200,{'content-type':'application/json','mcp-session-id':'test-session'});
      res.end(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}}}}));
      return;
    }
    assert.equal(req.headers['mcp-session-id'],'test-session');
    assert.equal(req.headers['mcp-protocol-version'],'2025-06-18');
    if (msg.method === 'notifications/initialized') {res.writeHead(202).end();return;}
    assert.equal(msg.method,'tools/call');assert.equal(msg.params.name,'search_docs');
    assert.deepEqual(Object.keys(msg.params.arguments),['keywords']);
    const query = msg.params.arguments.keywords;
    queries.push(query);
    if (query === 'first') {res.writeHead(503).end('private diagnostic');return;}
    if (query === 'slow') {arrived.resolve(); await release.promise;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.write('event: message\r\ndata: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/progress',params:{}})+'\r\n\r\n');
    res.end('event: message\r\ndata: '+JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{content:[{type:'text',text:'hit '+query+' fixture-token'}]}})+'\r\n\r\n');
  });
  srv.listen(0,'127.0.0.1'); await once(srv,'listening');
  const address = srv.address();
  assert.ok(address && typeof address !== 'string');
  const clients = new McpReaders(JSON.stringify([{...config,tokenEnv:'COLLAB_MCP_TOKEN_KB',url:'http://127.0.0.1:'+address.port+'/mcp'}]),{COLLAB_MCP_TOKEN_KB:'fixture-token'});
  const dir = mkdtempSync(join(tmpdir(),'mcp-reader-')), project = join(dir,'project');mkdirSync(project);
  const owner = new Store(join(dir,'private','db.sqlite'));
  const store = new CollaborationStore(owner,{mcpReaders:clients,projectWorkAvailability:()=>({available:true})});
  const cid = store.create({title:'MCP',memberIds:['codex'],defaultMemberId:'codex',requestId:randomUUID()}).conversation.id;
  try {
    assert.throws(() => store.workbench.previewWorkspace(cid,{path:project,mode:'project-work',mcpReaderId:'https://other.example.org'}));
    const preview = store.workbench.previewWorkspace(cid,{path:project,mode:'project-work',mcpReaderId:'manual'});
    assert.equal(store.workbench.conversation(cid).workspaceGrant,undefined);
    store.workbench.applyPreview({previewId:preview.id,requestId:randomUUID()},cid);
    store.projects.submit(cid,{content:'@Codex 请修改项目并查阅术语',requestId:randomUUID()});
    const i = store.admitNext()!.invocations[0]!;
    const contract = store.contract(i.id);
    assert.ok(runtimeTools(contract).some(t => t.name === 'project_mcp_search'));
    assert.ok(!runtimeTools({...contract,projectWork:undefined}).some(t => t.name === 'project_mcp_search'));
    const query = (args: Record<string,unknown>,callId:string) => store.searchProjectMcp(i.id,args,callId,new AbortController().signal);
    await assert.rejects(query({query:'hi'},'before-acceptance'));
    store.startInvocation(i.id); store.recordEvidence(i.id,{kind:'accepted',detail:{source:'fixture'}});
    await assert.rejects(query({query:'hi',url:'https://other.example.org'},'bad'));
    await assert.rejects(query({query:'https://other.example.org'},'url'));
    assert.equal(methods.length,0);
    const expected = {source:'团队资料',text:'hit second [redacted]'};
    await assert.rejects(query({query:'first'},'1'),/未完成/);
    await assert.rejects(query({query:'first'},'1'),/已使用/);
    assert.deepEqual(await query({query:'second'},'2'),expected);
    assert.deepEqual(await query({query:'second'},'2'),expected);
    await assert.rejects(query({query:'changed'},'2'));
    assert.deepEqual(queries,['first','second']);
    const slow = query({query:'slow'},'3');
    await arrived.promise;
    const revokeRevision = store.workbench.conversation(cid).revision!, revokeId = randomUUID();
    const revoked = store.workbench.revokeWorkspace(cid,revokeRevision,revokeId);
    assert.equal(revoked.result.grant.mcpReader,undefined);
    const replay = store.workbench.revokeWorkspace(cid,revokeRevision,revokeId);
    assert.equal(replay.replayed,true);
    assert.deepEqual(replay.result,revoked.result);
    assert.equal(store.workbench.conversation(cid).revision,revokeRevision+1);
    release.resolve();
    await assert.rejects(slow);
    await assert.rejects(query({query:'after'},'4'));
    assert.deepEqual(queries,['first','second','slow']);
    assert.deepEqual(methods,Array(3).fill(['initialize','notifications/initialized','tools/call','DELETE']).flat());
    const receipts = store.detail(cid).evidence.filter(e => e.detail.origin === 'project_mcp').map(e => e.detail);
    assert.deepEqual(receipts.map(d => d.state),['started','failed','started','succeeded','started','failed']);
    assert.doesNotMatch(JSON.stringify(receipts),/fixture-token|private diagnostic|hit slow/);
  } finally {release.resolve();owner.close();rmSync(dir,{recursive:true,force:true});srv.closeAllConnections();await new Promise<void>(r => srv.close(() => r()));}
});
