import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApplication } from '../server/index.js';
import type { CollaborationRuntime, ConversationDetail, RuntimeRequest } from '../shared/collaboration.js';

async function until<T>(get: () => T | undefined | Promise<T | undefined>, reason: string) {
  const deadline = Date.now() + 10_000;
  do {
    const result = await get();
    if (result) return result;
    await delay(20);
  } while (Date.now() < deadline);
  throw Error(reason);
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'hydra-join-http-'));
  let app: Awaited<ReturnType<typeof createApplication>>;
  let url = '', path = '', cid = '';
  const calls: string[] = [];
  let beforeAnswer: (q:RuntimeRequest)=>Promise<void> = async()=>{};

  async function answer(req:RuntimeRequest) {
    const store = app.collaborationStore;
    const primary = store.visibility.primary(req.invocationId);
    const tool = (name:string, args:Record<string,unknown>) => req.onToolCall(name,args,name) as Promise<any>;
    await beforeAnswer(req);
    if (req.member.id === 'left' || req.member.id === 'right') {
      const round = /ROUND-(\d+)/.exec(primary.content);
      assert.ok(round, 'Each invited speaker receives their own round source');
      return req.member.id + ' reply ROUND-' + round[1];
    }
    if (req.member.id === 'referee') {
      const child = (await tool('obligation_list',{})).obligations[0];
      const summary = 'After five rounds, the left case is more persuasive.';
      await tool('obligation_report',{obligationId:child.id,version:child.version,summary,outcome:'passed'});
      return summary;
    }

    assert.equal(req.member.id,'chair');
    const {obligations, receipts} = await tool('obligation_list',{});
    const root = obligations[0] ?? (await tool('obligation_open',{goal:'Collect five rounds of opinions, invite a judge and return the verdict.'})).obligation;
    if (receipts.length) {
      const summary = 'Verdict: ' + receipts[0].report.summary;
      await tool('obligation_deliver',{obligationId:root.id,summary});
      return summary;
    }
    // These decisions represent the test member. They are taken inside genuine admitted
    // runtime calls, never by the observing user or by the recovery harness.
    const previous = /ROUND-(\d+)/.exec(primary.content);
    const round = primary.kind === 'user' ? 1 : Number(previous?.[1]) + 1;
    assert(Number.isInteger(round) && round >= 1 && round <= 6, 'A wake must contain its round results');
    if (round === 6) {
      await tool('collaboration_request',{targets:['referee'],content:'Evaluate both sides of the completed five rounds.',
        delivery:{obligationId:root.id,version:'debate-ended',acceptance:'Provide a verdict and a reason.'}});
      return 'Asked for a verdict.';
    }
    await tool('multi_mention',{targets:['left','right'],question:'ROUND-' + round + ' present your arguments.',
      obligationId:root.id,timeoutMs:120000});
    return 'Invited both speakers for ROUND-' + round;
  }
  const runtime:CollaborationRuntime = {probe:async()=>[],invoke:async req=>{
    calls.push(req.member.id);
    req.onEvent({kind:'accepted',detail:{nativeTurnId:'turn-'+req.invocationId}});
    const text = await answer(req);
    req.onEvent({kind:'process_exit',detail:{confirmed:true,code:0}});
    return {text,continuity:'fresh'};
  }};
  async function start() {
    app = await createApplication({dataDir:dir,workspace:join(dir,'workspace'),port:0,collaborationRuntime:runtime,startWorker:false});
    url = (await app.start()).url;
    assert.notEqual(new URL(url).port,'4310');
  }
  async function post(end:string,body:Record<string,unknown>) {
    const res = await fetch(url+end,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':app.csrfToken},body:JSON.stringify(body)});
    const data = await res.json();
    assert(res.ok,JSON.stringify(data));
    return data;
  }
  await start();
  for (const id of ['chair','left','right','referee']) {
    app!.collaborationStore.saveMember({id,name:id,accountId:'codex-cli',carrier:'codex-app-server',instructions:'Participate in the discussion.',enabled:true});
  }
  const room = await post('/api/conversations',{requestId:randomUUID(),title:'Exhibition format',memberIds:['chair','left','right','referee'],defaultMemberId:'chair'});
  cid = room.conversation.id; path = '/api/conversations/'+cid;
  return {
    get app(){return app;}, cid, calls, path, post, setBeforeAnswer(f:typeof beforeAnswer){beforeAnswer=f;},
    send:()=>post(path+'/messages',{requestId:randomUUID(),content:'@chair Arrange a five-round debate, invite a judge after round five, and send me the verdict.'}),
    detail:async():Promise<ConversationDetail>=> (await fetch(url+path)).json(),
    restart:async()=>{await app.close();await start();app.collaborationEngine.start();},
    close:async()=>{await app.close();await rm(dir,{recursive:true,force:true});}
  };
}

test('C: a five-round coordinator resumes its pending first wake after restart; replaying first-round responses during round two cannot advance round two',async()=>{
  const f=await fixture();
  let resume!:()=>void;
  const release = new Promise<void>(r=>{resume=r;});
  f.setBeforeAnswer(async req=>{
    if(req.member.id==='right' && f.app.collaborationStore.visibility.primary(req.invocationId).content.includes('ROUND-2')) await release;
  });
  try {
    const store = f.app.collaborationStore;
    const admit = store.admitNext.bind(store);
    store.admitNext = () => store.cooperation.groups(f.cid).some(g=>g.state==='done') ? undefined : admit();
    f.app.collaborationEngine.start();
    await f.send();
    const first = await until(async()=> (await f.detail()).groups?.find(g=>g.state==='done'),'first group did not settle before restart');
    const firstWake = first.contract!.wakeSourceId!;
    assert.ok(firstWake);
    assert.equal((await f.detail()).consumptions.filter(c=>c.sourceId===firstWake).length,0);
    await f.restart();
    const firstAnswer = first.results![0]!;
    const second = await until(async()=> (await f.detail()).groups?.find(g=>g.question.includes('ROUND-2') && g.results?.length===1),'second group never reached exactly one reply');
    f.app.collaborationStore.finish(firstAnswer.invocationId!,'succeeded',firstAnswer.content);
    f.app.collaborationStore.cooperation.groupTick();
    const waiting = (await f.detail()).groups!.find(g=>g.id===second.id)!;
    assert.equal(waiting.state,'collecting');
    assert.equal(waiting.results!.length,1);
    assert.equal(waiting.contract?.wakeSourceId,undefined);
    resume();
    const final = await until(async()=>{
      const d = await f.detail();
      return d.obligations?.some(o=>!o.parentId && o.state==='delivered') ? d : undefined;
    },'did not deliver after all five groups');
    const groups = final.groups!.toSorted((a,b)=>a.createdAt.localeCompare(b.createdAt));
    assert.equal(groups.length,5);
    assert.equal(groups[0]!.contract!.wakeSourceId,firstWake);
    const roundIds = new Set<string>();
    for (const [i,g] of groups.entries()) {
      assert.equal(g.state,'done');
      assert.deepEqual(g.results!.map(x=>x.memberId).sort(),['left','right']);
      assert(g.results!.every(x=>x.content.endsWith('ROUND-'+(i+1)) && x.status==='succeeded'));
      assert.equal(final.consumptions.filter(c=>c.sourceId===g.contract!.wakeSourceId && c.memberId==='chair').length,1);
      for(const answer of g.results!)roundIds.add(answer.invocationId!);
    }
    assert.equal(roundIds.size,10);
    assert.equal(f.calls.filter(m=>m==='referee').length,1);
    assert.equal(f.calls.filter(m=>m==='chair').length,7);
    assert.equal(final.messages.filter(m=>m.author==='user').length,1);
    const root=final.obligations!.find(o=>!o.parentId)!;
    assert.match(final.messages.find(m=>m.id===root.delivery?.messageId)!.content,/left case/);
  }finally{resume();await f.close();}
});

test('C: cancelling the root while a group has one reply never forwards the late second answer to the chair',async()=>{
  const f=await fixture();
  let resume!:()=>void;
  const release = new Promise<void>(r=>{resume=r;});
  f.setBeforeAnswer(async req=>{if(req.member.id==='right')await release;});
  try {
    f.app.collaborationEngine.start();await f.send();
    const partial=await until(async()=>{
      const d = await f.detail();
      return d.groups?.some(g=>g.state==='collecting' && g.results?.length===1)? d:undefined;
    },'one reply was not persisted');
    const root=partial.obligations!.find(o=>!o.parentId)!;
    await f.post(f.path+'/obligations/'+root.id+'/cancel',{requestId:randomUUID(),expectedRevision:root.revision,reason:'Meeting adjourned.'});
    resume();
    await until(async()=>{
      const d=await f.detail();
      return d.invocations.every(i=>!['running','prepared','cancel_requested'].includes(i.status))?d:undefined;
    },'participant did not exit');
    await f.restart();
    const d=await f.detail();
    assert.equal(d.obligations!.find(o=>o.id===root.id)!.state,'cancelled');
    assert.equal(d.groups![0]!.contract?.wakeSourceId,undefined);
    assert.deepEqual(f.calls.filter(m=>m==='chair'),['chair']);
    assert.equal(d.groups!.length,1);
  }finally{resume();await f.close();}
});
