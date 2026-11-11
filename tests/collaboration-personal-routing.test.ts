import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { RuntimeRequest } from '../shared/collaboration.js';
import type { Obligation } from '../shared/obligations.js';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { memberContextTool, runtimeMemberContextMode } from '../server/collaboration/member-context.js';
import { executeTool, runtimeTools } from '../server/collaboration/runtime-common.js';

function fixture(workspace?: string) {
  const db = new Store(':memory:');
  let time = Date.now();
  const store = new CollaborationStore(db, {clock: () => time, workspace, projectWorkAvailability: () => ({available:true})});
  store.saveMember({...store.members()[0]!, id:'reader', name:'档案员'});
  const members = ['codex','claude','reader'];
  const room = store.create({title:'选稿讨论',memberIds:members,defaultMemberId:'codex',requestId:randomUUID()}).conversation.id;
  const send = (content:string, privateTo?:string[]) => store.send(room,{content,requestId:randomUUID(),privateTo,deliveryMode:'next_turn'}).source;
  const accept = (id:string) => store.recordEvidence(id,{kind:'accepted',detail:{source:'test-adapter'}});
  const start = (id=store.admitNext()!.invocations[0]!.id) => { store.startInvocation(id); accept(id); return id; };
  const finish = (id:string,reply='已完成本轮工作。') => {
    store.recordEvidence(id,{kind:'process_exit',detail:{confirmed:true,code:0}});
    store.finish(id,'succeeded',reply);
  };
  const tool = (id:string,name:string,args:Record<string,unknown>) =>
    (store.obligations.tool(id,name,args,randomUUID()) as {obligation:Obligation}).obligation;
  const request = (id:string):RuntimeRequest => {
    const run = store.invocation(id), contract = store.contract(id);
    return {
      ...contract, memberContextMode:runtimeMemberContextMode(contract.memberContext),
      invocationId:id, conversationId:room, member:run.member, account:store.accounts().find(a=>a.id===run.member.accountId)!,
      cwd:workspace ?? process.cwd(), prompt:store.prompt(id), signal:new AbortController().signal, onEvent:()=>{},
      onToolCall: async (name,args,callId) => {
        assert.equal(name,'collaboration_request');
        return store.requestCollaboration(id,callId,args as Parameters<typeof store.requestCollaboration>[2]);
      },
    };
  };
  const prepareChoice = () => {
    const secret='private-stamp-9744', approved='第二件作品值得复核。', unused='第一件作品可以入选。';
    const {factorId} = store.factors.issue(room,{memberId:'claude',requestId:randomUUID(),content:secret,expressionOptions:[unused,approved]});
    send('@Claude 读取材料，选择一个允许公开的判断。',['claude']);
    const privateId = start();
    const selection=memberContextTool(store,privateId,'member_expression_select',{observationId:factorId,choice:2},randomUUID()) as {expressionId:string};
    finish(privateId);
    return {approved, hidden:[secret,unused,factorId,selection.expressionId]};
  };
  const ordinary = (id:string, choice:ReturnType<typeof prepareChoice>) => {
    const runtime = request(id);
    const names = runtimeTools(runtime).map(t=>t.name);
    const baseline = runtimeTools({...runtime,memberContextMode:undefined}).map(t=>t.name);
    assert.deepEqual(names.filter(name=>name!=='member_context_read'),baseline);
    if (store.contract(id).obligationPolicy) assert.ok(names.includes('obligation_open'));
    assert.ok(names.includes('collaboration_request'));
    assert.notEqual(runtime.memberContextMode,'writing');
    const text = JSON.stringify([runtime.prompt,store.input(id)!.manifest]);
    for (const secret of [choice.approved,...choice.hidden]) assert.ok(!text.includes(secret), 'ordinary turn exposed '+secret);
  };
  return {db,store,room,members,send,accept,start,finish,tool,request,prepareChoice,ordinary,advance:(ms:number)=>{time+=ms;},now:()=>time};
}

for (const kind of ['event','timer'] as const) {
  test('an approved expression leaves ordinary work and its '+kind+' wake intact',()=>{
    const h=fixture();
    try {
      const choice = h.prepareChoice();
      h.send('@Claude 待资料齐备后交我一份说明。');
      const actor = h.start();
      h.ordinary(actor,choice);
      const root = h.tool(actor,'obligation_open',{goal:'提交说明。'});
      const wait = h.tool(actor,'obligation_wait',{obligationId:root.id,kind,condition:'检查资料状态',deadline:new Date(h.now()+60000).toISOString()});
      h.finish(actor);
      if (kind==='timer') h.advance(61000);
      else h.store.obligations.signal(h.room,root.id,{requestId:randomUUID(),waitId:wait.wait!.id,expectedRevision:wait.revision,condition:wait.wait!.condition,summary:'资料齐备。'});
      h.store.obligations.reconcile();
      const resumed = h.start();
      assert.equal(h.store.invocation(resumed).memberId,'claude');
      h.ordinary(resumed,choice);
      h.tool(resumed,'obligation_deliver',{obligationId:root.id,summary:'说明已备好。'});
      h.finish(resumed,'说明已备好。');
      assert.equal(h.store.obligations.list(h.room).find(o=>o.id===root.id)!.state,'delivered');
    } finally { h.db.close(); }
  });
}

test('a recipient of an ordinary A2A or a consultation retains its usual capabilities and sees no personal expression',()=>{
  const h=fixture();
  try {
    const choice = h.prepareChoice();
    h.send('@Codex 请邀请同事整理两类资料。');
    const sender = h.start();
    h.store.requestCollaboration(sender,'delegate',{targets:['claude'],content:'核对展签。'});
    h.finish(sender);
    const peer = h.start();
    assert.equal(h.store.invocation(peer).memberId,'claude');
    h.ordinary(peer,choice);
    h.finish(peer);
    h.store.cooperation.createGroup(h.room,{requestId:randomUUID(),targets:['claude','reader'],question:'列出主要意见。'});
    const replies=h.store.admitNext()!.invocations;
    assert.ok(replies.some(i=>i.memberId==='claude'));
    for(const reply of replies) {
      h.start(reply.id);
      h.ordinary(reply.id,choice);
      h.finish(reply.id);
    }
  } finally { h.db.close(); }
});

for (const sender of ['codex','claude']) {
  test('an explicit public statement requested by '+sender+' delivers precisely once and only the speaker reads its wording',async()=>{
    const h=fixture();
    try {
      const choice = h.prepareChoice();
      h.send((sender==='codex'?'@Codex':'@Claude')+' 请安排一段限定发言。');
      const id=h.start();
      h.ordinary(id,choice);
      const args={targets:['claude'],content:'请发表你的判断。',publicStatement:true};
      const runtime = h.request(id);
      const spec=runtimeTools(runtime).find(t=>t.name==='collaboration_request')!;
      assert.ok('publicStatement' in spec.inputSchema.properties);
      const command = () => executeTool(runtime,'collaboration_request',args,'request-public');
      await command();
      await command();
      const sources=h.store.detail(h.room).sources.filter(s=>s.parentInvocationId===id);
      assert.equal(sources.length,1);
      assert.deepEqual(sources[0]!.requestedTargets,['claude']);
      const deliveries=h.store.detail(h.room).deliveries.filter(d=>d.sourceId===sources[0]!.id);
      assert.equal(deliveries.length,1);
      h.finish(id);
      const speech=h.start();
      assert.equal(h.store.invocation(speech).memberId,'claude');
      const speechRequest=h.request(speech);
      assert.deepEqual(runtimeTools(speechRequest).map(t=>t.name),['member_context_read']);
      const record=memberContextTool(h.store,speech,'member_context_read',{},'read');
      const visible=JSON.stringify([record,speechRequest.prompt,h.store.input(speech)!.manifest]);
      assert.ok(visible.includes(choice.approved));
      for(const marker of choice.hidden) assert.ok(!visible.includes(marker));
      await assert.rejects(executeTool(speechRequest,'collaboration_request',args,'loop'));
      h.finish(speech);
      assert.equal(h.store.admitNext(),undefined);
    } finally { h.db.close(); }
  });
}

for (const state of ['private','project','unaccepted','cancelled','retired','group'] as const) {
  test('a '+state+' request cannot create an authorized public statement',()=>{
    const workspace = mkdtempSync(join(tmpdir(),'statement-routing-'));
    const h=fixture(workspace);
    try {
      h.store.factors.issue(h.room,{memberId:'claude',requestId:randomUUID(),content:'仅供查阅',publicExpression:'建议继续评审。'});
      if (state==='project') {
        const preview=h.store.workbench.previewWorkspace(h.room,{path:workspace,mode:'project-work'});
        h.store.workbench.applyPreview({previewId:preview.id,requestId:randomUUID()},h.room);
        const submitted=h.store.projects.submit(h.room,{requestId:randomUUID(),content:'@Codex 修改本项目的月报文件。'});
        assert.ok('source' in submitted && submitted.source.projectWork);
      } else h.send('@Codex 整理资料。',state==='private'?['codex']:undefined);
      const actor=h.store.admitNext()!.invocations[0]!;
      h.store.startInvocation(actor.id);
      if(state!=='unaccepted') h.accept(actor.id);
      if(state==='cancelled') h.store.cancel(actor.id);
      if(state==='retired') {
        // A delayed callback can retain a previously valid contract across a roster transaction.
        h.store.roomMembers.sync(h.room,['claude','reader']);
        h.store.roomMembers.sync(h.room,h.members);
        assert.ok(!h.store.roomMembers.isCurrent(actor.roomMember!));
      }
      const args={targets:state==='group'?['claude','reader']:['claude'],content:'请给出你的判断。',publicStatement:true};
      assert.throws(()=>h.store.requestCollaboration(actor.id,'forbidden',args));
      assert.equal(h.store.detail(h.room).sources.filter(s=>s.parentInvocationId===actor.id).length,0);
    } finally { h.db.close(); rmSync(workspace,{recursive:true,force:true}); }
  });
}
