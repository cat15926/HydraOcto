import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { memberContextTool } from '../server/collaboration/member-context.js';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';
import { executeTool, runtimeTools } from '../server/collaboration/runtime-common.js';
import type { Carrier, RuntimeEvent, RuntimeRequest } from '../shared/collaboration.js';

test('ordinary turns keep their contract; a public speaker sees approved wording without any personal factor handle', () => {
  const owner = new Store(':memory:');
  try {
    const store = new CollaborationStore(owner);
    const room = store.create({title:'记录核验', memberIds:['claude','codex'],defaultMemberId:'claude',requestId:randomUUID()}).conversation.id;
    const send = (content:string) => {
      store.send(room,{requestId:randomUUID(),content});
      const run = store.admitNext()!.invocations[0]!;
      store.startInvocation(run.id);
      store.recordEvidence(run.id,{kind:'accepted',detail:{source:'protocol-fixture'}});
      return run.id;
    };
    const ordinary = send('@Claude 请回答');
    assert.equal(store.contract(ordinary).memberContext,undefined);
    store.recordEvidence(ordinary,{kind:'process_exit',detail:{confirmed:true,code:0}});
    store.finish(ordinary,'succeeded','答复');
    const fact = {memberId:'claude',requestId:randomUUID(),content:'private-observation-marker',publicExpression:'I suggest another discussion.'};
    const {factorId,expressionId} = store.factors.issue(room,fact);
    const id = send('@Claude 请谈谈你的观点');
    const record = memberContextTool(store,id,'member_context_read',{},'read');
    assert.deepEqual(record,{factors:[{kind:'expression',content:fact.publicExpression}],obligations:[]});
    assert.throws(()=>memberContextTool(store,id,'member_note_write',{content:'bad'},'bad-note'));
    const visible = JSON.stringify([store.prompt(id), store.input(id)!.manifest,record]);
    assert.ok(visible.includes(fact.publicExpression));
    for (const hidden of [fact.content,factorId,expressionId!]) assert.ok(!visible.includes(hidden));
    store.factors.revoke(room,{requestId:randomUUID(),factorId});
    assert.throws(()=>memberContextTool(store,id,'member_context_read',{},'after-revoke'),/授权/);
  } finally {owner.close();}
});

test('only the private actor may choose from its frozen authorized wording; open discussion exposes just the selected option', () => {
  const owner = new Store(':memory:');
  try {
    const store = new CollaborationStore(owner);
    const room = store.create({title:'审批用语', memberIds:['claude','codex'],defaultMemberId:'claude',requestId:randomUUID()}).conversation.id;
    const begin = (privateTurn:boolean) => {
      store.send(room,{requestId:randomUUID(), content:'@Claude 请给出你的判断', ...(privateTurn && {privateTo:['claude']})});
      const {id} = store.admitNext()!.invocations[0]!;
      store.startInvocation(id);
      store.recordEvidence(id,{kind:'accepted',detail:{source:'protocol-fixture'}});
      return id;
    };
    const options = ['No conclusion yet.','Review candidate B.'];
    const {factorId} = store.factors.issue(room,{memberId:'claude',requestId:'grant',content:'secret-observation',expressionOptions:options});
    const id = begin(true);
    assert.ok(store.prompt(id).includes(JSON.stringify(options)));
    assert.throws(()=>memberContextTool(store,id,'member_expression_select',{observationId:factorId,choice:3},'out-of-range'));
    assert.throws(()=>memberContextTool(store,id,'member_expression_select',{observationId:factorId,choice:1,content:'leak'},'injected'));
    const selection = memberContextTool(store,id,'member_expression_select',{observationId:factorId,choice:2},'select');
    assert.ok('expressionId' in selection);
    store.recordEvidence(id,{kind:'process_exit',detail:{confirmed:true,code:0}});
    store.finish(id,'succeeded','secret-observation');
    const next = begin(false);
    assert.throws(()=>memberContextTool(store,next,'member_expression_select',{observationId:factorId,choice:1},'public'));
    const projection = JSON.stringify([store.prompt(next), memberContextTool(store,next,'member_context_read',{},'opened')]);
    assert.ok(projection.includes(options[1]!));
    for (const marker of [options[0]!, 'secret-observation',factorId,selection.expressionId]) assert.ok(!projection.includes(marker));
  } finally {owner.close();}
});

test('an oversized personal record fails before sending or storing a truncated prompt', () => {
  const owner = new Store(':memory:');
  try {
    const store = new CollaborationStore(owner);
    const room = store.create({title:'资料预算',memberIds:['claude'],defaultMemberId:'claude',requestId:randomUUID()}).conversation.id;
    for (let i=0; i<35; i++) {
      store.factors.issue(room,{memberId:'claude',requestId:'obs-'+i,content:'z'.repeat(3960)});
    }
    store.send(room,{requestId:'check', privateTo:['claude'],content:'请核对全部材料。'});
    const id = store.admitNext()!.invocations[0]!.id;
    assert.throws(()=>store.prepareInput(id),/必须完整提供的成员资料超出上下文预算/);
    assert.ok(!store.input(id));
  } finally {owner.close();}
});

test('a fresh SQLite connection reconstructs the current instance’s pending promise and wait condition only', () => {
  const dir = mkdtempSync(join(tmpdir(),'member-record-'));
  const database = join(dir,'state.sqlite');
  let owner = new Store(database);
  try {
    let store = new CollaborationStore(owner);
    const room = (title:string) => store.create({title,memberIds:['claude','codex'],defaultMemberId:'claude',requestId:randomUUID()}).conversation.id;
    const first = room('一号房间'), second = room('二号房间');
    const begin = (roomId:string, member:string) => {
      store.send(roomId,{requestId:randomUUID(),content:'@'+member+' 核实待办'});
      const run = store.admitNext()!.invocations[0]!;
      store.startInvocation(run.id);
      store.recordEvidence(run.id,{kind:'accepted',detail:{source:'protocol-fixture'}});
      return run;
    };
    const finish = (id:string) => {
      store.recordEvidence(id,{kind:'process_exit',detail:{confirmed:true,code:0}});
      store.finish(id,'succeeded','等待后续确认。');
    };
    const promise = (roomId:string, member:string, goal:string) => {
      const run = begin(roomId,member);
      const {obligation} = store.obligations.tool(run.id,'obligation_open',{goal},randomUUID()) as {obligation:{id:string}};
      const condition = goal+'-condition';
      store.obligations.tool(run.id,'obligation_wait',{obligationId:obligation.id,condition, deadline:new Date(Date.now()+3_600_000).toISOString()},randomUUID());
      finish(run.id);
      return {id:obligation.id,condition,instanceId:run.roomMember!.id};
    };
    const own = promise(first,'Claude','第一项承诺');
    promise(first,'Codex','其他人的承诺');
    promise(second,'Claude','另一个房间的承诺');
    owner.close();
    owner = new Store(database);
    store = new CollaborationStore(owner);
    const resumed = begin(first,'Claude');
    assert.equal(resumed.roomMember!.id,own.instanceId);
    const record = memberContextTool(store,resumed.id,'member_context_read',{},'read');
    assert.ok('obligations' in record);
    assert.deepEqual(record.obligations.map(o=>[o.id,o.goal,o.state,o.wait]), [[own.id,'第一项承诺','waiting',own.condition]]);
    assert.ok(record.obligations[0]!.revision>1);
    finish(resumed.id);
  } finally {
    owner.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

function privateRequest(carrier:Carrier, events:RuntimeEvent[]) {
  const request:RuntimeRequest = {
    invocationId:randomUUID(), conversationId:'fixture-room',cwd:process.cwd(),signal:new AbortController().signal,
    member:{id:'actor',name:'Actor',enabled:true,carrier,accountId:'acc',instructions:''},
    account:{id:'acc',provider:'claude',auth:'cli',name:'Fixture'}, prompt:'private-runtime-marker',
    visibility:{kind:'private',memberIds:['actor']}, memberContextMode:'private',
    onEvent:e=>events.push(e), onToolCall:async()=>{throw new Error('unexpected platform call');},
  };
  return request;
}

test('private work denies native/host tools and cannot be submitted to an unisolated carrier or a resumed CLI', async () => {
  const runtime = createCollaborationRuntime();
  for (const carrier of ['codex-app-server','hermes-agent','claude-cli'] as const) {
    const events:RuntimeEvent[] = [], request = privateRequest(carrier,events);
    assert.deepEqual(runtimeTools(request).map(t=>t.name),['member_context_read','member_note_write','member_expression_select']);
    await assert.rejects(executeTool(request,'workspace_read',{path:'any'},'bad'));
    await assert.rejects(runtime.invoke(request),/私密工作范围/);
    assert.deepEqual(events.map(e=>e.kind),['not_accepted','transport_settled']);
    assert.ok(!JSON.stringify(events).includes(request.prompt));
  }
  const events:RuntimeEvent[] = [], req = privateRequest('claude-cli',events);
  req.account.auth='api';
  for (const altered of [{nativeSessionId:'old-session'},{projectWork:true},{visibility:{kind:'private' as const,memberIds:['actor','other']}}]) {
    await assert.rejects(runtime.invoke({...req,...altered,invocationId:randomUUID()}),/私密工作范围/);
  }
  assert.ok(events.every(e=>e.kind==='not_accepted'||e.kind==='transport_settled'));
  const writing:RuntimeRequest = {...req, invocationId:randomUUID(), visibility:undefined, memberContextMode:'writing'};
  assert.deepEqual(runtimeTools(writing).map(t=>t.name),['member_context_read']);
  await assert.rejects(executeTool(writing,'collaboration_request',{targets:['other'],content:'test'},'no-forward'));
  await assert.rejects(runtime.invoke({...writing,nativeSessionId:'old-public-session'}),/受限发言/);
});
