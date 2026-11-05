import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { invokeCodex } from '../server/collaboration/runtime-codex.js';
import { invokeClaude } from '../server/collaboration/runtime-claude.js';
import type { RuntimeEvent, RuntimeRequest } from '../shared/collaboration.js';

async function executable(dir: string, code: string) {
  const file = join(dir, 'cli.cjs'); await writeFile(file, `#!${process.execPath}\n${code}`); await chmod(file, 0o700); return file;
}
function input(dir: string, events: RuntimeEvent[], carrier: 'codex-app-server' | 'claude-cli' = 'codex-app-server'): RuntimeRequest {
  return { invocationId: randomUUID(), conversationId: 'test', member: { id: 'm', name: 'm', model: 'm', carrier, accountId: 'a', enabled: true, instructions: '' },
    account: { id: 'a', name: 'a', provider: carrier === 'codex-app-server' ? 'codex' : 'claude', auth: 'cli' },
    cwd: dir, prompt: 'Current exact request', signal: AbortSignal.timeout(8000), onEvent: e => events.push(e), onToolCall: async () => 'unused' };
}
for (const mode of ['resume', 'missing', 'changed_history', 'unknown_error', 'connection_lost'] as const) test(`N3 Codex protocol: ${mode}; no second model input after uncertainty`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'n3-codex-protocol-'));
  try {
    const command = await executable(dir, `
      const fs=require('node:fs'), readline=require('node:readline'); const mode=${JSON.stringify(mode)};
      const send=v=>console.log(JSON.stringify(v)); let sid='old-session';
      readline.createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line), p=m.params||{};
        fs.appendFileSync(${JSON.stringify(join(dir, 'calls.jsonl'))},JSON.stringify({method:m.method,params:p})+'\\n');
        if(m.method==='initialize')send({id:m.id,result:{}});
        if(m.method==='account/read')send({id:m.id,result:{account:{type:'chatgpt'}}});
        if(m.method==='config/read')send({id:m.id,result:{config:{mcp_servers:{}}}});
        if(m.method==='thread/resume') {
          if(mode==='connection_lost')return process.exit(1);
          if(mode==='missing'||mode==='unknown_error')return send({id:m.id,error:{code:-32600,message:mode==='missing'?'no rollout found for thread id old-session':'unclassified native error'}});
          send({id:m.id,result:{thread:{id:sid}}});
        }
        if(m.method==='thread/turns/list')send({id:m.id,result:{data:[{id:mode==='changed_history'?'external-turn':'saved-turn',status:'completed'}]}});
        if(m.method==='thread/start'){sid='new-session';send({id:m.id,result:{thread:{id:sid}}});}
        if(m.method==='turn/start'){
          send({id:m.id,result:{turn:{id:'current-turn'}}});
          send({method:'thread/tokenUsage/updated',params:{threadId:sid,turnId:'current-turn',tokenUsage:{last:{inputTokens:20,outputTokens:3,totalTokens:23}}}});
          send({method:'turn/completed',params:{threadId:sid,turn:{id:'current-turn',status:'completed',items:[{type:'agentMessage',text:'OK'}]}}});
        }
      });`);
    const events: RuntimeEvent[] = [], r = input(dir, events); r.nativeSessionId = 'old-session'; r.sessionPlan = { mode: 'resume', reason: 'fixture', nativeSessionId: 'old-session', previousAnchor: 'saved-turn' };
    if (['unknown_error', 'connection_lost'].includes(mode)) await assert.rejects(invokeCodex(r, command));
    else {
      const result = await invokeCodex(r, command);
      assert.equal(result.continuity, mode === 'resume' ? 'resumed' : 'fresh');
      assert.equal(events.filter(e => e.kind === 'session_replaced').length, mode === 'resume' ? 0 : 1);
      assert.ok(events.some(e => e.kind === 'session' && e.detail.historyVerified && e.detail.anchor === 'current-turn'));
      assert.ok(events.some(e => e.kind === 'usage' && e.detail.inputTokens === 20));
    }
    const calls = (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.filter(c => c.method === 'turn/start').length, ['unknown_error', 'connection_lost'].includes(mode) ? 0 : 1);
    assert.equal(calls.filter(c => c.method === 'thread/start').length, ['missing', 'changed_history'].includes(mode) ? 1 : 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('N3 Claude protocol: transcript-proven fresh → resume; missing history replaces before one input; usage is native', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'n3-claude-protocol-')); const oldConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'config');
  try {
    const command = await executable(dir, `
      const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
      const args=process.argv, resuming=args.includes('--resume'), sid=args[args.indexOf(resuming?'--resume':'--session-id')+1];
      let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
        const project=path.join(process.env.CLAUDE_CONFIG_DIR,'projects',process.cwd().replace(/[^a-zA-Z0-9]/g,'-'));fs.mkdirSync(project,{recursive:true});
        const file=path.join(project,sid+'.jsonl');let old=[];try{old=fs.readFileSync(file,'utf8').trim().split('\\n').map(JSON.parse)}catch{}
        const user=crypto.randomUUID(),assistant=crypto.randomUUID(),parent=old.at(-1)?.uuid||null;
        const rows=[{type:'user',uuid:user,parentUuid:parent,sessionId:sid,cwd:process.cwd(),message:{content:prompt}},{type:'assistant',uuid:assistant,parentUuid:user,sessionId:sid,cwd:process.cwd(),message:{content:[{type:'text',text:'OK'}]}}];
        fs.appendFileSync(file,rows.map(JSON.stringify).join('\\n')+'\\n');
        const send=v=>console.log(JSON.stringify(v));send({type:'system',subtype:'init',session_id:sid});
        send({type:'assistant',session_id:sid,uuid:assistant,message:{id:'api-message',content:[{type:'text',text:'OK'}]}});
        send({type:'result',subtype:'success',is_error:false,session_id:sid,result:'OK',usage:{input_tokens:30,output_tokens:4},total_cost_usd:0.001});
      });`);
    const events: RuntimeEvent[] = [], r = input(dir, events, 'claude-cli');
    const first = await invokeClaude(r, command);
    const proof = events.find(e => e.kind === 'session' && e.detail.historyVerified)!;
    assert.ok(proof?.detail.anchor); assert.equal(first.continuity, 'fresh');
    events.length = 0;
    const resumed = { ...r, prompt: 'Second exact request', nativeSessionId: first.nativeSessionId, sessionPlan: { mode: 'resume' as const, reason: 'fixture', previousAnchor: proof.detail.anchor as string } };
    const second = await invokeClaude(resumed, command);
    assert.equal(second.nativeSessionId, first.nativeSessionId); assert.equal(second.continuity, 'resumed');
    assert.ok(events.some(e => e.kind === 'usage' && e.detail.costUsd === 0.001));
    await rm(join(dir, 'config', 'projects'), { recursive: true }); events.length = 0;
    const replaced = await invokeClaude(resumed, command);
    assert.notEqual(replaced.nativeSessionId, first.nativeSessionId); assert.equal(replaced.continuity, 'fresh');
    assert.equal(events.filter(e => e.kind === 'session_replaced').length, 1);
    assert.equal(events.filter(e => e.kind === 'exposed').length, 1);
  } finally { if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldConfig; await rm(dir, { recursive: true, force: true }); }
});
