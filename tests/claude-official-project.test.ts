import assert from 'node:assert/strict';
import { chmod, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { RuntimeEvent, RuntimeRequest } from '../shared/collaboration.js';
import type { ProjectCli } from '../server/collaboration/project-vm.js';
import { invokeClaude } from '../server/collaboration/runtime-claude.js';

async function fixture(t: TestContext, mode: string) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(),'claude-project-work-')));
  t.after(() => rm(cwd,{recursive:true,force:true}));
  const command = join(cwd,'claude.cjs');
  const source = `
    const {createInterface} = require('node:readline');
    const emit = m => process.stdout.write(JSON.stringify(m)+'\\n');
    const mode = ${JSON.stringify(mode)}, args = process.argv.slice(2);
    const email = 'project-fixture@example.test';
    if (args.includes('auth')) {
      emit({loggedIn:true,authMethod:mode === 'not-signed-in' ? 'api_key' : 'claude.ai',apiProvider:'firstParty',email});
      process.exit(0);
    }
    const get = key => args[args.indexOf(key)+1];
    if (process.cwd() === ${JSON.stringify(cwd)} || get('--tools') !== '' || get('--setting-sources') !== '' ||
        !['--safe-mode','--no-chrome','--no-session-persistence','--disable-slash-commands','--strict-mcp-config'].every(key => args.includes(key)) ||
        get('--mcp-config') !== '{"mcpServers":{"platform":{"type":"sdk","name":"platform"}}}' ||
        process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.COLLAB_BRIDGE_TOKEN) process.exit(2);
    const reply = (id,data) => emit({type:'control_response',response:{request_id:id,subtype:'success',response:data}});
    const rpc = (id,method,params) => emit({type:'control_request',request_id:'mcp-'+id,request:{subtype:'mcp_message',server_name:'platform',message:{jsonrpc:'2.0',id,method,params}}});
    const sid = get('--session-id');
    let names = [], init, n = 0;
    createInterface({input:process.stdin}).on('line',line => {
      const m = JSON.parse(line);
      if (m.type === 'control_request' && m.request.subtype === 'initialize') {
        init = m.request_id;
        rpc(1,'tools/list');
      }
      if (m.type === 'control_response' && m.response.request_id === 'mcp-1') {
        names = m.response.response.mcp_response.result.tools.map(t => t.name);
        reply(init,{account:{apiProvider:'firstParty',email:mode === 'switched' ? 'other@example.test' : email,
          subscriptionType:'max',...(mode === 'api-fallback' ? {apiKeySource:'ANTHROPIC_API_KEY'} : {})}});
      }
      if (m.type === 'control_request' && m.request.subtype === 'mcp_status') {
        reply(m.request_id,{mcpServers:[{name:'platform',status:'connected',tools:names.map(name=>({name}))},
          ...(mode === 'extra-mcp' ? [{name:'extra',status:'connected'}] : [])]});
      }
      if (m.type === 'control_request' && m.request.subtype === 'get_settings') {
        reply(m.request_id,{effective:{disableAllHooks:true},sources:[{source:'flagSettings'},
          ...(mode === 'managed-policy' ? [{source:'policySettings'}] : [])]});
      }
      if (m.type === 'user') {
        if (m.message.content[0].text !== 'run project tests') process.exit(3);
        emit({type:'system',subtype:'init',session_id:sid,apiKeySource:'none',tools:[
          ...names.map(name=>'mcp__platform__'+name),...(mode === 'host-tool' ? ['Read'] : [])]});
        emit({type:'assistant',session_id:sid,message:{id:'a1',content:[{type:'tool_use',name:'mcp__platform__project_command'}]}});
        rpc(2,'tools/call',{name:'project_command',arguments:{command:'npm test'}});
      }
      if (m.type === 'control_response' && m.response.request_id === 'mcp-2') {
        if (n++ === 0) {
          const result = m.response.response.mcp_response.result;
          if (!result || result.isError || JSON.parse(result.content[0].text).output !== 'fixture pass') process.exit(4);
          rpc(2,'tools/call',{name:'project_command',arguments:{command:'npm test'}});
        } else {
          if (!m.response.response.mcp_response.error) process.exit(5);
          emit({type:'result',subtype:'success',result:'checked',session_id:sid,is_error:false});
        }
      }
    });
  `;
  await writeFile(command,'#!'+process.execPath+'\n'+source); await chmod(command,0o700);
  const meta = await stat(cwd), events: RuntimeEvent[] = [], commands:string[] = [];
  const request: RuntimeRequest = {
    invocationId:'i',conversationId:'c',cwd,prompt:'run project tests',projectWork:true,
    workspaceGrant:{path:cwd,device:meta.dev,inode:meta.ino,mode:'project-work',revision:1,authorizedAt:'2026-11-08',conversationId:'c',memberIds:['m']},
    member:{id:'m',name:'Claude',instructions:'',accountId:'a',carrier:'claude-cli',enabled:true},
    account:{id:'a',name:'local subscription',auth:'cli',provider:'claude'},
    onEvent:event=>events.push(event), signal:AbortSignal.timeout(4000),onToolCall:async()=>{ throw new Error('unexpected'); },
  };
  const project: ProjectCli = {launched:true,origin:'',ready:Promise.resolve(),treeExited:false,launch(){throw new Error('unexpected guest model');},
    async close(){},officialClaude:{async run(command){commands.push(command);return {exitCode:0,output:'fixture pass'};}}};
  return {request,command,project,events,commands};
}

test('Claude official project checks the actual account and tool set, dispatches only once and attributes the VM tool to the platform', async t => {
  const {request,command,project,events,commands} = await fixture(t,'ok');
  assert.equal((await invokeClaude(request,command,project)).text,'checked');
  assert.deepEqual(commands,['npm test']);
  assert.deepEqual(events.filter(e=>e.kind==='tool').map(e=>[e.detail.origin,e.detail.name,e.detail.state]),[
    ['platform','project_command','started'],['platform','project_command','completed']]);
  assert.ok(events.some(e=>e.kind==='accepted'));
  assert.ok(events.some(e=>e.kind==='diagnostic' && e.detail.observation==='model_process_exit'));
  assert.ok(!events.some(e=>e.kind==='process_exit'));
  assert.ok(!JSON.stringify(events).includes('project-fixture@example.test'));
});

for (const mode of ['not-signed-in','switched','api-fallback','extra-mcp','managed-policy','host-tool']) {
  test('Claude official project refuses '+mode, async t => {
    const {request,command,project,events,commands} = await fixture(t,mode);
    await assert.rejects(invokeClaude(request,command,project),/claude auth login|项目工具|工具范围|项目执行隔离/u);
    assert.deepEqual(commands,[]);
    assert.equal(events.some(e=>e.kind==='exposed'),mode === 'host-tool');
    assert.ok(!events.some(e=>e.kind==='accepted'));
  });
}
