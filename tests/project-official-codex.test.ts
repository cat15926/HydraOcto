import assert from 'node:assert/strict';
import { access, appendFile, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { projectAccountFingerprint } from '../server/collaboration/official-codex-history.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RuntimeEvent, RuntimeRequest } from '../shared/collaboration.js';
import { invokeCodex, isolatedCodexArgs } from '../server/collaboration/runtime-codex.js';
import { RuntimeProtocolError } from '../server/collaboration/runtime-common.js';
import type { ProjectCli } from '../server/collaboration/project-vm.js';

async function fixture(fault = '') {
  const dir = await mkdtemp(join(tmpdir(), 'collab-official-codex-test-'));
  const command = join(dir, 'codex.cjs'), log = join(dir, 'calls.jsonl');
  await writeFile(command, `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const fault = ${JSON.stringify(fault)};
const args = process.argv.slice(2);
const send = data => console.log(JSON.stringify(data));
let environmentId;
let thread, turn, rollout;
const projectPath = require('node:path');
const randomId = require('node:crypto').randomUUID;
const projectEnvs = () => [{environmentId, cwd:'/mnt/project',runtimeWorkspaceRoots:['/mnt/project']}];
readline.createInterface({input:process.stdin}).on('line', line => {
  const {id,method,params:p,result:reply,error} = JSON.parse(line);
  const result = value => send({id,result:value});
  if ((fault === 'rpc-controller' && method === 'environment/add') ||
      (fault === 'rpc-discovery' && method === 'config/read' && !process.env.CODEX_EXEC_SERVER_URL)) {
    return send({id,error:{code:-32603,message:'private provider details',data:{method:'private provider details'}}});
  }
  fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({method,
    ...(method === 'initialize' ? {cwd:process.cwd(),sqlite:process.env.CODEX_SQLITE_HOME,defaultExecutor:process.env.CODEX_EXEC_SERVER_URL,
      shell:args[args.indexOf('shell_tool')-1],apiInEnvironment:!!process.env.COLLAB_SELECTED_RUNTIME_API_KEY} : {}),
    ...(method === 'environment/add' ? {bound:p.authBearerToken === 'temporary-executor-capability'} : {}),
    ...(['thread/start','turn/start'].includes(method) ? {environments:p.environments,ephemeral:p.ephemeral,sandbox:p.sandbox,multiAgentMode:p.multiAgentMode} : {})
  })+'\\n');
  if (fault === 'review' && id === 'correct-review') {
    if (!reply?.success || JSON.parse(reply.contentItems[0].text).sourceId !== 'review-source') process.exit(5);
    return send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed',items:[{type:'agentMessage',text:'review requested'}]}}});
  }
  if (fault === 'review' && id === 'stale-review' && !error) process.exit(6);
  switch (method) {
    case 'initialize': return result({});
    case 'account/read': if (fault==='dedicated') return result({account:{type:'chatgpt',email:'fixture@example.invalid'},workspaceRouting:{chatgptAccountId:'fixture-workspace'}}); return result({account:{type:['account','cold'].includes(fault) ? 'apiKey' : 'chatgpt'}});
    case 'config/read': {
      if (fault === 'stall') return;
      const read = ()=> result({config:{
        mcp_servers:{fixture:{enabled:!args.includes('mcp_servers={"fixture"={enabled=false}}')}},
        features:Object.fromEntries(args.flatMap((arg,i) => arg === '--disable' ? [[args[i+1],false]] : [])),
        model_provider:'openai',chatgpt_base_url:'https://chatgpt.com/backend-api/',sqlite_home:process.env.CODEX_SQLITE_HOME}});
      if (fault === 'cold' && !process.env.CODEX_EXEC_SERVER_URL) return setTimeout(read,6300);
      return read();
    }
    case 'environment/add': environmentId=p.environmentId; return result({});
    case 'environment/info': return result({cwd:fault === 'project' ? 'file:///other' : 'file:///mnt/project'});
    case 'environment/status': return result({status:p.environmentId === 'local' && fault !== 'host-visible' ? 'unknown' : fault === 'disconnect' ? 'disconnected' : 'ready'});
    case 'thread/read': return result({thread:{id:thread,path:rollout}});
    case 'thread/turns/list': return result({data:[{id:turn,status:'completed'}]});
    case 'thread/resume': {
      const saved=JSON.parse(fs.readFileSync(p.path));
      thread=saved.thread;turn=saved.turn;rollout=p.path;
      return result({cwd:p.cwd,modelProvider:'openai',model:p.model,instructionSources:[],thread:{id:thread,ephemeral:false,environments:projectEnvs()}});
    }
    case 'thread/start': {
      if (fault==='dedicated') {
        thread=randomId();
        const dir=projectPath.join(process.env.CODEX_HOME,'sessions','2026','11','08');
        fs.mkdirSync(dir,{recursive:true});
        rollout=projectPath.join(dir,'rollout-2026-11-08T12-00-00-'+thread+'.jsonl');
        return result({cwd:p.cwd,modelProvider:'openai',model:p.model,instructionSources:[],thread:{id:thread,ephemeral:p.ephemeral,environments:p.environments}});
      }
      if (fault === 'review' && !p.dynamicTools.some(t=>t.name === 'collaboration_request' && t.inputSchema.properties.projectReview)) process.exit(7);
      const environments = fault === 'local' ? [{...p.environments[0],environmentId:'local'}] : p.environments;
      return result({cwd:p.cwd,modelProvider:'openai',model:p.model,instructionSources:[],
        thread:{id:'thread-1',ephemeral:p.ephemeral,environments}});
    }
    case 'turn/start':
      if (fault==='dedicated') {
        turn=randomId();
        fs.writeFileSync(rollout,JSON.stringify({thread,turn}));
        result({turn:{id:turn}});
        send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed',items:[{type:'agentMessage',text:'complete'}]}}});
        return;
      }
      result({turn:{id:'turn-1'}});
      if (fault === 'review') {
        send({method:'turn/started',params:{threadId:'thread-1',turn:{id:'turn-1'}}});
        for(const [id,turnId] of [['stale-review','different-turn'],['correct-review','turn-1']]) {
          send({id,method:'item/tool/call',params:{threadId:'thread-1',turnId,callId:id,tool:'collaboration_request',
            arguments:{targets:['claude'],content:'核对修复',projectReview:{paths:['export.py']}}}});
        }
        return;
      }
      send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed',items:[
        {type:'commandExecution',id:'command-1',cwd:fault === 'host-command' ? process.cwd() : '/mnt/project',source:'agent',status:'completed',exitCode:0,command:'git status'},
        {type:'agentMessage',text:'done'}]}}});
  }
});`, {mode:0o700});
  const events: RuntimeEvent[] = [];
  const project: ProjectCli = {officialCodex:{url:'ws://127.0.0.1:31234',bearer:'temporary-executor-capability'},
    origin:'',treeExited:false,launched:true,ready:Promise.resolve(),close:async()=>{},
    launch(){throw new Error('The authenticated controller must not start in the guest.');}};
  const request: RuntimeRequest = {invocationId:'inv-1',conversationId:'conversation-1',
    member:{id:'member-1',name:'Codex',carrier:'codex-app-server',accountId:'account-1',model:'chosen-model',instructions:'',enabled:true},
    account:{id:'account-1',name:'Official',provider:'codex',auth:'cli'},
    prompt:'project request',cwd:dir,nativeSessionId:'previous-thread',signal:AbortSignal.timeout(5000),
    projectWork:true,onEvent:e=>events.push(e),onToolCall:async()=>{}};
  const calls = async () => (await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  return {dir,project,command,events,request,calls,close:()=>rm(dir,{recursive:true,force:true})};
}

test('only the official Codex project turn can dispatch its structured file review', async () => {
  const f = await fixture('review');
  try {
    const calls: string[] = [];
    const result = await invokeCodex({...f.request,toolPolicyVersion:'cross-action-v1',mayRequestProjectReview:true,
      onToolCall:async (tool,args,id) => {
        assert.equal(tool,'collaboration_request');
        assert.deepEqual(args,{targets:['claude'],content:'核对修复',projectReview:{paths:['export.py']}});
        assert.ok(f.events.some(e=>e.kind==='accepted' && e.detail.nativeTurnId==='turn-1'));
        calls.push(id);
        return {sourceId:'review-source'};
      }},f.command,f.project);
    assert.equal(result.text,'review requested');
    assert.deepEqual(calls,['correct-review']);
  } finally { await f.close(); }
});

test('official Codex records the rejected RPC from its request ID without disclosing provider text or starting a model turn', async () => {
  for (const [fault,stage,method] of [
    ['rpc-controller','controller','environment/add'], ['rpc-discovery','config_discovery','config/read'],
  ] as const) {
    const f=await fixture(fault);
    try {
      await assert.rejects(invokeCodex(f.request,f.command,f.project),(error:unknown) =>
        error instanceof RuntimeProtocolError && error.message === `Runtime protocol rejected ${method} (-32603).`);
      const failures=f.events.filter(e=>e.detail.observation==='codex_rpc_rejected');
      assert.deepEqual(failures.map(e=>e.detail),[{observation:'codex_rpc_rejected',stage,method,code:-32603}]);
      assert.ok(!f.events.some(e=>e.kind==='exposed' || e.kind==='accepted'));
      assert.ok(!JSON.stringify(f.events).includes('private provider details'));
      assert.ok(!(await f.calls()).some(m=>m.method==='turn/start'));
    } finally { await f.close(); }
  }
});

test('an unknown RPC method and a non-numeric provider error code stay out of diagnostics', () => {
  const rejected=new RuntimeProtocolError({code:'private value',message:'private value'},'private method');
  assert.equal(rejected.method,undefined);
  assert.equal(rejected.code,undefined);
  assert.equal(rejected.message,'Runtime protocol rejected request (unknown).');
});

test('official Codex selects the same isolated executor for thread and turn and keeps its host history ephemeral', async () => {
  const f = await fixture();
  try {
    const result = await invokeCodex(f.request,f.command,f.project);
    assert.equal(result.text,'done'); assert.equal(result.continuity,'fresh');
    const calls = await f.calls();
    const hosts = calls.filter(m=>m.method === 'initialize');
    assert.equal(hosts.length,2);
    for (const host of hosts) {
      assert.notEqual(host.cwd,f.dir); assert.notEqual(host.cwd,'/mnt/project'); assert.equal(host.sqlite,host.cwd);
      assert.equal(host.apiInEnvironment,false); await assert.rejects(access(host.cwd));
    }
    assert.equal(hosts[0].defaultExecutor,undefined);
    assert.equal(hosts[0].shell,'--disable');
    assert.equal(hosts[1].defaultExecutor,f.project.officialCodex?.url);
    assert.equal(hosts[1].shell,'--enable');
    assert.equal(calls.find(m=>m.method==='environment/add').bound,true);
    assert.ok(!calls.some(m=>m.method==='thread/resume'));
    const thread = calls.find(m=>m.method==='thread/start'), turn = calls.find(m=>m.method==='turn/start');
    assert.equal(thread.sandbox,'read-only'); assert.equal(thread.ephemeral,true);
    assert.deepEqual(thread.environments,turn.environments);
    assert.deepEqual(thread.environments[0].runtimeWorkspaceRoots,['/mnt/project']);
    assert.ok(f.events.some(e=>e.kind==='accepted' && e.detail.nativeTurnId==='turn-1'));
    assert.ok(f.events.some(e=>e.kind==='tool' && e.detail.callId==='command-1'));
    assert.ok(!f.events.some(e=>e.kind==='process_exit'));
    assert.ok(f.events.some(e=>e.kind==='diagnostic' && e.detail.observation==='project_controller_exit'));
    assert.ok(!JSON.stringify(f.events).includes('temporary-executor-capability'));
  } finally { await f.close(); }
});

test('cold official config discovery can exceed six seconds without connecting to the project or submitting a turn',async()=>{
  const f=await fixture('cold');
  try {
    await assert.rejects(invokeCodex({...f.request,signal:AbortSignal.timeout(20000)},f.command,f.project),/ChatGPT login/);
    const discovery=f.events.filter(e=>e.detail.observation==='codex_config_discovery');
    assert.ok(discovery.some(e=>e.detail.stage==='config/read' && e.detail.state==='completed' && Number(e.detail.elapsedMs)>=6000));
    const calls=await f.calls();
    assert.equal(calls.filter(m=>m.method==='account/read').length,1);
    assert.ok(!calls.some(m=>m.method==='environment/add' || m.method==='turn/start'));
  } finally { await f.close(); }
});

test('stopping during config discovery closes only the preflight process and reports its actual stage',async()=>{
  const f=await fixture('stall');
  const cancel=new AbortController();
  try {
    await assert.rejects(invokeCodex({...f.request,signal:cancel.signal,onEvent:event=>{
      f.events.push(event);
      if (event.detail.observation==='codex_config_discovery' && event.detail.stage==='config/read' && event.detail.state==='started') {
        setImmediate(()=>cancel.abort());
      }
    }},f.command,f.project),/配置发现已取消（config\/read）/);
    assert.ok(f.events.some(e=>e.detail.state==='cancelled' && e.detail.stage==='config/read'));
    assert.ok(!(await f.calls()).some(m=>m.method==='account/read' || m.method==='environment/add' || m.method==='turn/start'));
  } finally { await f.close(); }
});

test('config discovery deadline identifies the pending operation without exposing a generic SIGKILL',async()=>{
  const f=await fixture('stall');
  try {
    const stages:string[]=[];
    await assert.rejects(isolatedCodexArgs(f.command,f.dir,{PATH:'/usr/bin:/bin'},{timeoutMs:2000,
      progress:(stage,state)=>stages.push(stage+' '+state),
    }),/配置发现超时（config\/read）/);
    assert.equal(stages.at(-1),'config/read timeout');
    assert.ok(!(await f.calls()).some(m=>m.method==='thread/start' || m.method==='turn/start'));
  } finally { await f.close(); }
});

for (const fault of ['account','project','local','disconnect','host-visible']) {
  test(`official Codex rejects ${fault} before exposing project input`,async()=>{
    const f=await fixture(fault);
    try {
      await assert.rejects(invokeCodex(f.request,f.command,f.project));
      assert.ok(!(await f.calls()).some(m=>m.method==='turn/start'));
      assert.ok(!f.events.some(e=>e.kind==='exposed' || e.kind==='accepted'));
    } finally { await f.close(); }
  });
}

test('a command receipt from the host cannot finish the project turn',async()=>{
  const f=await fixture('host-command');
  try {
    await assert.rejects(invokeCodex(f.request,f.command,f.project),/回执/);
    assert.ok(!f.events.some(e=>e.kind==='tool' || e.detail.observation==='native_terminal'));
  } finally { await f.close(); }
});

test('official project invocation without a bound executor fails before launching a controller',async()=>{
  const f=await fixture();
  try {
    const project = {...f.project,officialCodex:undefined};
    await assert.rejects(invokeCodex(f.request,f.command,project),/隔离工具连接/);
    assert.deepEqual(f.events,[]);
  } finally { await f.close(); }
});

test('dedicated official history resumes the same thread and completed turn only for the scoped unchanged rollout', async t => {
  const f = await fixture('dedicated');
  const home = await realpath(await mkdtemp(join(tmpdir(), 'collab-dedicated-login-')));
  const previous = process.env.COLLAB_CODEX_PROJECT_HISTORY_HOME;
  process.env.COLLAB_CODEX_PROJECT_HISTORY_HOME = home;
  t.after(async () => {
    if (previous !== undefined) process.env.COLLAB_CODEX_PROJECT_HISTORY_HOME = previous;
    else delete process.env.COLLAB_CODEX_PROJECT_HISTORY_HOME;
    await rm(home,{recursive:true,force:true});
    await f.close();
  });
  const meta=await stat(f.dir);
  const project={...f.project,treeExited:true};
  const accountFingerprint=projectAccountFingerprint({account:{type:'chatgpt',email:'fixture@example.invalid'},workspaceRouting:{chatgptAccountId:'fixture-workspace'}});
  const req:RuntimeRequest={...f.request,invocationId:randomUUID(),nativeSessionId:undefined,
    account:{...f.request.account,codexHome:'project'},projectContinuity:true,
    workspaceGrant:{path:f.dir,device:meta.dev,inode:meta.ino,mode:'project-work',revision:1,authorizedAt:new Date().toISOString()},
    sessionPlan:{mode:'fresh',reason:'首次',fingerprint:'fixture',identity:{supported:true,reason:'fixture',projectAccountFingerprint:accountFingerprint}}};
  const first=await invokeCodex(req,f.command,project);
  assert.equal(first.continuity,'fresh');
  assert.ok(f.events.some(e=>e.kind==='session' && e.detail.anchor===first.nativeTurnId && e.detail.historyVerified));
  const next:RuntimeRequest={...req,invocationId:randomUUID(),nativeSessionId:first.nativeSessionId,
    sessionPlan:{...req.sessionPlan!,mode:'resume',nativeSessionId:first.nativeSessionId,previousAnchor:first.nativeTurnId,previousInvocationId:req.invocationId}};
  const second=await invokeCodex(next,f.command,project);
  assert.equal(second.continuity,'resumed');
  assert.equal(second.nativeSessionId,first.nativeSessionId);
  assert.notEqual(second.nativeTurnId,first.nativeTurnId);
  const nextPlan={...next.sessionPlan!,previousInvocationId:next.invocationId,previousAnchor:second.nativeTurnId};
  const other=await invokeCodex({...next,invocationId:randomUUID(),conversationId:'other',sessionPlan:nextPlan},f.command,project);
  assert.equal(other.continuity,'fresh');
  const proof=JSON.parse(await readFile(join(home,'platform-checkpoints',next.invocationId+'.json'),'utf8'));
  await appendFile(proof.rollout,' ');
  const changed=await invokeCodex({...next,invocationId:randomUUID(),sessionPlan:nextPlan},f.command,project);
  assert.equal(changed.continuity,'fresh');
  const exposures=f.events.filter(e=>e.kind==='exposed').length;
  await assert.rejects(invokeCodex({...next,invocationId:randomUUID(),sessionPlan:{...nextPlan,identity:{supported:true,reason:'test',projectAccountFingerprint:'different'}}},f.command,project),/身份.*变化/);
  assert.equal(f.events.filter(e=>e.kind==='exposed').length,exposures);
  const calls=await f.calls();
  assert.equal(calls.filter(c=>c.method==='thread/resume').length,1);
  assert.ok(calls.filter(c=>c.method==='turn/start').every(c=>c.environments?.length===1 && c.environments[0].environmentId==='remote'));
});
