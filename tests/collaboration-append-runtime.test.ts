import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { invokeCodex, supportsCodexAppend } from '../server/collaboration/runtime-codex.js';
import type { AppendObservation, InputHandoff, RuntimeRequest } from '../shared/collaboration.js';

const script = String.raw`
const fs = require('node:fs'), path = require('node:path');
if (process.argv.includes('generate-json-schema')) {
 const dir=process.argv[process.argv.indexOf('--out')+1]; fs.mkdirSync(path.join(dir,'v2'),{recursive:true});
 const files = {
  TurnSteerParams: {required:['threadId','expectedTurnId','input'],properties:{clientUserMessageId:{}}},
  TurnSteerResponse:{required:['turnId']},
  ThreadReadResponse:{definitions:{ThreadItem:{oneOf:[{properties:{type:{enum:['userMessage']},clientId:{}}}]}}}
 };
 for (const [name,value] of Object.entries(files)) fs.writeFileSync(path.join(dir,'v2',name+'.json'),JSON.stringify(value)); process.exit(0);
}
const send=v=>console.log(JSON.stringify(v)); let clientId;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line), p=m.params||{};
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='config/read')send({id:m.id,result:{config:{mcp_servers:{}}}});
 if(m.method==='account/read')send({id:m.id,result:{account:{type:'chatgpt'}}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread'}}});
 if(m.method==='turn/start')send({id:m.id,result:{turn:{id:'turn'}}});
 if(m.method==='turn/steer'){
  if(p.threadId!=='thread'||p.expectedTurnId!=='turn'||p.clientUserMessageId!=='delivery'||!p.input[0].text.includes('unique-body'))process.exit(9);
  clientId=p.clientUserMessageId;
  if(MODE==='reject')send({id:m.id,error:{code:-32600,message:'no active turn'}});
  else {
   if(MODE==='read-first')send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{type:'userMessage',clientId}}});
   // A forged foreign thread read notification must never bind to this append.
   send({method:'item/completed',params:{threadId:'foreign',turnId:'turn',item:{type:'userMessage',clientId}}});
   send({id:m.id,result:{turnId:MODE==='wrong-turn'?'different':'turn'}});
  }
 }
 if(m.method==='thread/read'){
  send({id:m.id,result:{thread:{id:'thread',turns:[{id:'different',items:[{type:'userMessage',clientId}]},{id:'turn',items:MODE==='reject'||MODE==='wrong-turn'?[]:[{type:'userMessage',clientId}]}]}}});
  setTimeout(()=>send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed',items:[{type:'agentMessage',text:'done'}]}}}),30);
 }
});
`;

for (const mode of ['ack', 'read-first', 'wrong-turn', 'reject'] as const) test('N6 Codex protocol: ' + mode + ' binds exact thread/expectedTurnId/clientId, never guesses from another turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'n6-append-protocol-'));
  try {
    const command = join(dir, 'codex.cjs');
    await writeFile(command, '#!' + process.execPath + '\nconst MODE=' + JSON.stringify(mode) + ';\n' + script); await chmod(command, 0o700);
    assert.equal(await supportsCodexAppend(command), true);
    const h: InputHandoff = { id: 'handoff', conversationId: 'conversation', sourceId: 'source', sourceRevision: 1, sourceDigest: 'digest', deliveryId: 'delivery-row', deliveryRevision: 2, memberId: 'codex', invocationId: 'invocation', responseId: 'response', inputRevision: 1, cancelRevision: 0, nativeSessionId: 'thread', nativeTurnId: 'turn', nativeDeliveryId: 'delivery', content: 'unique-body', state: 'sent', revision: 1, createdAt: '', updatedAt: '', requiresCompletion: false };
    const reads: AppendObservation[] = [], states: string[] = []; let operation: Promise<void> | undefined;
    const request: RuntimeRequest = { invocationId: 'invocation', conversationId: 'conversation', member: { id: 'codex', name: 'codex', instructions: '', carrier: 'codex-app-server', accountId: 'account', model: 'test', enabled: true }, account: { id: 'account', name: 'account', provider: 'codex', auth: 'cli' }, toolPolicyVersion: 'cooperation-v2', prompt: 'primary', cwd: dir, signal: AbortSignal.timeout(10000), onEvent: () => {}, onToolCall: async () => ({}), onInputRead: observation => reads.push(observation),
      onAppendReady: dispatcher => { operation = (async () => { states.push((await dispatcher.send(h)).state); states.push((await dispatcher.inspect(h)).state); })(); },
    };
    assert.equal((await invokeCodex(request, command)).text, 'done'); await operation;
    assert.deepEqual(states, mode === 'reject' ? ['not_accepted', 'unknown'] : mode === 'wrong-turn' ? ['unknown', 'unknown'] : ['accepted', 'read']);
    assert.equal(reads.length, mode === 'read-first' ? 1 : 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
