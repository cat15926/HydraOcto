import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ProjectReviewTestRequest } from '../shared/collaboration.js';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { CollaborationEngine } from '../server/collaboration/engine.js';
import { executeTool, runtimeTools } from '../server/collaboration/runtime-common.js';
import { MissingProjectScript } from '../server/collaboration/project-review-tools.js';

function setup(reviewMode?:'project', content='@Codex 修改月报文件，完成后请同伴评审。') {
  const root = mkdtempSync(join(tmpdir(),'peer-review-'));
  const project = join(root,'project');
  mkdirSync(project);
  const owner = new Store(join(root,'data','review.sqlite'));
  const store = new CollaborationStore(owner,{workspace:project,projectWorkAvailability:()=>({available:true})});
  const cid = store.create({title:'项目评审',memberIds:['codex','claude'],defaultMemberId:'codex',requestId:randomUUID()}).conversation.id;
  const preview = store.workbench.previewWorkspace(cid,{path:project,mode:'project-work',reviewMode});
  store.workbench.applyPreview({previewId:preview.id,requestId:randomUUID()},cid);
  const initial = store.projects.submit(cid,{content,requestId:randomUUID()});
  assert.ok('source' in initial && initial.source.projectWork);
  const start = () => {
    const i = store.admitNext()!.invocations[0]!;
    store.startInvocation(i.id);
    return i.id;
  };
  const accept = (id:string) => store.recordEvidence(id,{kind:'accepted',detail:{source:'test_adapter'}});
  const finish = (id:string,status:'succeeded'|'failed',reply:string) => {
    store.recordEvidence(id,{kind:'process_exit',detail:{confirmed:true}});
    store.finish(id,status,reply);
  };
  const close = () => {owner.close(); rmSync(root,{recursive:true,force:true});};
  return {root,project,cid,store,initial:initial.source,start,accept,finish,close};
}

test('isolated npm checks distinguish an absent script from a failing check, replay its evidence, and continue', async () => {
  const h = setup('project');
  const signal = new AbortController().signal;
  try {
    const reviewer = inviteReviewer(h);
    h.accept(reviewer);
    const reviews = h.store.projectReviews;
    let launched = 0;
    const run = async (request: ProjectReviewTestRequest) => {
      launched++;
      assert.ok(request.npm);
      assert.equal(request.projectNpmChecks,true);
      if (request.argv[2] === 'build') throw new MissingProjectScript('build','f'.repeat(64));
      return {argv:request.argv,exitCode:0,output:'ok',truncated:false,treeExited:true as const,snapshotSha256:'f'.repeat(64)};
    };
    const build = {argv:['npm','run','build']};
    for (const argv of [['npm','run','build','--if-present'], ['npm','run','install'], ['npm','test','--']]) {
      await assert.rejects(reviews.verifyTests(reviewer,{argv},'invalid',signal,run),/超出/);
    }
    assert.equal(launched,0);
    const skipped = await reviews.verifyTests(reviewer,build,'build',signal,run);
    assert.ok('state' in skipped && skipped.state === 'skipped');
    assert.ok(!('exitCode' in skipped));
    const replay = await reviews.verifyTests(reviewer,build,'build',signal,run);
    assert.ok('replayed' in replay && replay.replayed);
    const checked = await reviews.verifyTests(reviewer,{argv:['npm','run','typecheck']},'types',signal,run);
    assert.equal(checked.exitCode,0);
    assert.equal(launched,2);
    const evidence = h.store.detail(h.cid).evidence.filter(e => e.detail.callId === 'build' && e.detail.state === 'test_skipped');
    assert.equal(evidence.length,1);
    assert.equal(evidence[0]!.detail.snapshotSha256,'f'.repeat(64));
    assert.ok(!('exitCode' in evidence[0]!.detail));
  } finally { h.close(); }
});

test('frozen npm test capability keeps its tool arguments and cannot request new npm checks via the offline review route', async () => {
  const h = setup('project');
  const signal = new AbortController().signal;
  try {
    const {author,reviewer} = startRevisionReview(h,true);
    const reviews = h.store.projectReviews;
    const before = runtimeTools(h.store.contract(author)).find(t => t.name === 'project_npm_test')!;
    assert.deepEqual(Object.keys(before.inputSchema.properties),['args']);
    assert.throws(() => reviews.authorNpmTest(author,{script:'build'},'bad-author',signal),/参数/);
    const execute = async (request: ProjectReviewTestRequest) => {
      assert.ok(!request.projectNpmChecks);
      return {argv:request.argv,exitCode:0,output:'ok',truncated:false,treeExited:true as const,snapshotSha256:'a'.repeat(64)};
    };
    const args = {argv:['npm','run','build']};
    await assert.rejects(reviews.verifyTests(reviewer,args,'bad-reviewer',signal,execute),/超出/);
    await reviews.verifyTests(reviewer,{argv:['npm','test','--']},'legacy',signal,execute);
    h.store.db.prepare("UPDATE cc_contracts SET value=json_remove(value,'$.projectReview.npmTest') WHERE invocation_id=?").run(reviewer);
    await assert.rejects(reviews.verifyTests(reviewer,args,'offline',signal,execute),/超出/);
  } finally { h.close(); }
});

test('P2: a review uses a single A2A, exact native acceptance, and independent reads tied to the recipient and file version', async () => {
  const h=setup(), question='确认报告包含本次新增的记录。';
  const bytes='金额为零的记录 '+randomUUID();
  const target='report.txt', untouched='notes.txt';
  const invocations:string[]=[];
  const engine=new CollaborationEngine(h.store,{async invoke(request) {
    invocations.push(request.member.id);
    request.onEvent({kind:'accepted',detail:{source:'test_adapter'}});
    if(request.projectWork) {
      assert.ok(request.mayRequestProjectReview);
      assert.match(request.prompt,/先等其确认/);
      writeFileSync(join(h.project,target),bytes);
      const args={targets:['claude'],content:question,projectReview:{paths:[target,untouched]}};
      const first=await executeTool(request,'collaboration_request',args,'a2a') as {sourceId:string};
      const again=await executeTool(request,'collaboration_request',args,'a2a') as {sourceId:string;replayed:boolean};
      assert.equal(again.sourceId,first.sourceId); assert.equal(again.replayed,true);
    } else {
      assert.equal(request.member.id,'claude'); assert.equal(request.projectReview?.originalSourceId,h.initial.id);
      assert.deepEqual(runtimeTools(request).map(t=>t.name),['project_review_read']);
      assert.match(request.prompt,/金额|修改月报文件/);
      assert.ok(request.prompt.includes(question));
      await assert.rejects(executeTool(request,'workspace_read',{path:target},'wrong-tool'));
      const read=await executeTool(request,'project_review_read',{path:target},'read1') as {text:string;sha256:string;bytes:number};
      assert.equal(read.text,bytes); assert.equal(read.sha256,createHash('sha256').update(bytes).digest('hex'));
      assert.equal(read.bytes,Buffer.byteLength(bytes));
      writeFileSync(join(h.project,target),bytes+' 外部编辑');
    }
    request.onEvent({kind:'process_exit',detail:{confirmed:true}});
    // The writer's final acknowledgement often names the peer who already has the structured request.
    return {continuity:'unknown',text:request.projectWork?'文件已更新。\n@Claude Code 已收到上述评审委托。':'阅读后完成评审。'};
  }},{workspace:h.project});
  try {
    engine.start();
    const end=Date.now()+6000;
    while(Date.now()<end && !h.store.invocations(h.cid).some(i=>i.memberId==='claude' && i.status==='succeeded')) await new Promise(r=>setTimeout(r,15));
    const d=h.store.detail(h.cid);
    assert.deepEqual(d.invocations.map(i=>i.status),['succeeded','succeeded'],JSON.stringify(d.responses));
    assert.deepEqual(invocations,['codex','claude']); assert.equal(d.sources.length,2);
    const [author,reader]=d.invocations;
    assert.equal(d.sources[1]!.parentInvocationId,author!.id);
    const receipts=d.evidence.filter(e=>e.detail.origin==='project_review');
    assert.deepEqual(receipts.map(e=>[e.invocationId,e.detail.state]),[[reader!.id,'read'],[reader!.id,'checked']]);
    assert.ok(!JSON.stringify(receipts).includes(bytes));
    assert.deepEqual((receipts[1]!.detail.files as {status:string}[]).map(f=>f.status),['changed','unread']);
    await engine.stop();
    writeFileSync(join(h.project,target),bytes);
    const checked=await h.store.projectReviews.check(h.cid,reader!.id);
    assert.deepEqual(checked.files.map(f=>f.status),['unchanged','unread']);
    assert.equal(h.store.invocations(h.cid).length,2);

    const ticket=randomUUID();
    const retry=h.store.projectReviews.reread(h.cid,reader!.id,ticket);
    assert.equal(h.store.projectReviews.reread(h.cid,reader!.id,ticket).replayed,true);
    assert.equal(h.store.projectReviews.reread(h.cid,reader!.id,randomUUID()).result.sourceId,retry.result.sourceId);
    const source=h.store.detail(h.cid).sources.at(-1)!;
    assert.equal(source.id,retry.result.sourceId); assert.equal(source.kind,'user'); assert.equal(source.parentInvocationId,undefined);
    assert.equal(source.projectReview?.initialReviewSourceId,d.sources[1]!.id);
    assert.equal(source.projectReview?.rereadOf,reader!.id);
    assert.equal(h.store.detail(h.cid).messages.find(m=>m.sourceId===source.id)?.author,'user');
    const second=h.start(); h.accept(second); h.finish(second,'failed','未能重读。');
    assert.equal(h.store.detail(h.cid).sources.length,3);
  } finally {await engine.stop();h.close();}
});

test('P2: unaccepted sender, ordinary consultant, unsafe paths, changed grants, aborted or cross-scope callbacks do not confer review access',async()=>{
  const h=setup();
  try {
    const writer=h.start(), paths=['chapter.txt','link.txt','shared.txt','data.bin','large.txt'];
    const input={targets:['claude'],content:'核对章节。',projectReview:{paths}};
    assert.throws(()=>h.store.requestCollaboration(writer,'early',input));
    h.accept(writer);
    for(const path of ['../private','/absolute','.env','sub//x','sub/../x','a\\b']) {
      assert.throws(()=>h.store.requestCollaboration(writer,'bad-'+path,{...input,projectReview:{paths:[path]}}));
    }
    const task=h.store.tasks.create(h.cid,{requestId:randomUUID(),title:'作者任务',description:'',ownerMemberId:'codex'},writer).task;
    const sent=h.store.requestCollaboration(writer,'review',input);
    const review=h.start(), signal=new AbortController().signal;
    assert.equal(h.store.contract(review).projectWork,undefined);
    assert.equal(h.store.visibility.primary(review).id,sent.sourceId);
    assert.equal(h.store.tasks.getTask(task.id).ownerMemberId,'codex');
    h.accept(review);
    const read=(path:string,id=path)=>h.store.projectReviews.read(review,{path},id,signal);
    writeFileSync(join(h.project,'chapter.txt'),'internal');
    writeFileSync(join(h.root,'private.txt'),'outside');
    symlinkSync(join(h.root,'private.txt'),join(h.project,'link.txt'));
    linkSync(join(h.root,'private.txt'),join(h.project,'shared.txt'));
    writeFileSync(join(h.project,'data.bin'),Buffer.from([0,0xff]));
    writeFileSync(join(h.project,'large.txt'),Buffer.alloc(131073));
    for(const path of ['link.txt','shared.txt','data.bin','large.txt','other.txt','../private.txt']) await assert.rejects(read(path));
    await assert.rejects(h.store.projectReviews.read(writer,{path:'chapter.txt'},'wrong',signal));
    await assert.rejects(h.store.projectReviews.read(review,{path:'chapter.txt'},'aborted',AbortSignal.abort()));
    assert.equal((await h.store.projectReviews.check(h.cid,review)).files.every(f=>f.status==='unread'),true);
    assert.equal((await read('chapter.txt')).text,'internal');
    writeFileSync(join(h.project,'chapter.txt'),'edited');
    await assert.rejects(read('chapter.txt'),/之前的文件版本/);
    assert.equal((await read('chapter.txt','new-call')).text,'edited');
    await assert.rejects(h.store.projectReviews.check('another',review));
    assert.throws(()=>h.store.visibility.assertTool(review,'task_update'));
    assert.throws(()=>h.store.requestCollaboration(review,'upstream',{targets:['codex'],content:'回传'}));
    const again=h.store.detail(h.cid).evidence.filter(e=>e.detail.origin==='project_review');
    assert.equal(again.length,2);
    renameSync(h.project,h.project+'-old'); mkdirSync(h.project);
    writeFileSync(join(h.project,'chapter.txt'),'replacement');
    await assert.rejects(read('chapter.txt','wrong-root'));
    assert.equal((await h.store.projectReviews.check(h.cid,review)).files[0]?.status,'unavailable');
    h.finish(review,'failed','合成读取失败'); h.finish(writer,'succeeded','结束');
    const report=h.store.detail(h.cid).sources.filter(s=>s.kind==='a2a_failure');
    assert.equal(report.length,1); assert.deepEqual(report[0]!.requestedTargets,['codex']);
    h.store.workbench.revokeWorkspace(h.cid,h.store.workbench.conversation(h.cid).revision!,randomUUID());
    assert.throws(()=>h.store.projectReviews.reread(h.cid,review,randomUUID()),/授权/);
    // Release the failure report first, then evaluate the ordinary consultant's own contract.
    const failure=h.start(); h.accept(failure); h.finish(failure,'succeeded','已收到。');
    const consultation=h.store.send(h.cid,{content:'普通咨询',requestId:randomUUID()});
    const ordinary=h.start(); h.accept(ordinary);
    assert.equal(h.store.contract(ordinary).primarySourceId,consultation.source.id);
    assert.throws(()=>h.store.requestCollaboration(ordinary,'ordinary',input));
  } finally {h.close();}
});

function inviteReviewer(h: ReturnType<typeof setup>) {
  const writer = h.start();
  h.accept(writer);
  h.store.requestCollaboration(writer,'invite',{targets:['claude'],content:'请独立核查项目。',projectReview:{paths:['main.py']}});
  h.finish(writer,'succeeded','修改完成。');
  return h.start();
}

test('expanded review lists normal files, reads its own discoveries, records fresh digests and preserves the file-list default',async()=>{
  const h=setup('project'), ordinary=setup();
  const signal = new AbortController().signal;
  try {
    const old=inviteReviewer(ordinary); ordinary.accept(old);
    await assert.rejects(ordinary.store.projectReviews.list(old,{},'list',signal));
    await assert.rejects(ordinary.store.projectReviews.read(old,{path:'notes.md'},'read',signal));
    await assert.rejects(ordinary.store.projectReviews.verifyTests(old,{argv:['false']},'test',signal));
    const reviewer=inviteReviewer(h), reviews=h.store.projectReviews;
    assert.equal(h.store.contract(reviewer).projectReview?.mode,'project');
    await assert.rejects(reviews.list(reviewer,{},'not-accepted',signal));
    h.accept(reviewer);
    mkdirSync(join(h.project,'docs')); mkdirSync(join(h.project,'node_modules'));
    writeFileSync(join(h.project,'docs','notes.md'),'review me');
    writeFileSync(join(h.project,'.env'),'hidden');
    writeFileSync(join(h.root,'outside.txt'),'private');
    symlinkSync(h.root,join(h.project,'alias'));
    linkSync(join(h.root,'outside.txt'),join(h.project,'shared.txt'));
    const page=await reviews.list(reviewer,{},'list',signal);
    assert.deepEqual(page,{path:'',entries:[{name:'docs',kind:'directory'}]});
    for(const path of ['alias','../','node_modules','.env']) await assert.rejects(reviews.list(reviewer,{path},path,signal));
    for(const path of ['alias/outside.txt','shared.txt','node_modules/mod','../outside.txt','.env']) {
      await assert.rejects(reviews.read(reviewer,{path},path,signal));
    }
    const result=await reviews.read(reviewer,{path:'docs/notes.md'},'notes',signal);
    assert.equal(result.text,'review me');
    writeFileSync(join(h.project,'docs','notes.md'),'new');
    const statuses=(await reviews.check(h.cid,reviewer)).files.map(f=>[f.path,f.status]);
    assert.deepEqual(statuses,[['main.py','unread'],['docs/notes.md','changed']]);
    for(let n=0;n<70;n++) writeFileSync(join(h.project,'docs','file-'+String(n).padStart(2,'0')),'x');
    const first=await reviews.list(reviewer,{path:'docs'},'page1',signal);
    const second=await reviews.list(reviewer,{path:'docs',after:first.nextAfter},'page2',signal);
    assert.equal(first.entries.length,64); assert.equal(second.entries.length,7);
    assert.equal(new Set([...first.entries,...second.entries].map(e=>e.name)).size,71);
    await assert.rejects(reviews.list(reviewer,{path:'docs'},'stop',AbortSignal.abort()));
  } finally { h.close(); ordinary.close(); }
});

test('expanded review binds a test to its reviewer, deduplicates concurrent callbacks, and preserves incomplete outcomes',async()=>{
  const h=setup('project'), signal = new AbortController().signal;
  try {
    const reviewer=inviteReviewer(h); h.accept(reviewer);
    const reviews=h.store.projectReviews, args={argv:['python3','check.py']}, digest='a'.repeat(64);
    let calls=0; const done=Promise.withResolvers<void>();
    const run=async({argv,grant,verifyAuthorization}:ProjectReviewTestRequest)=>{
      calls++; verifyAuthorization(); assert.equal(grant.path,realpathSync(h.project));
      await done.promise; verifyAuthorization();
      return {argv,exitCode:1,output:'assertion failed',truncated:false,snapshotSha256:digest,treeExited:true as const};
    };
    await assert.rejects(reviews.verifyTests(reviewer,{argv:[]},'wrong',signal,run));
    const pending=reviews.verifyTests(reviewer,args,'same',signal,run);
    await assert.rejects(reviews.verifyTests(reviewer,args,'same',signal,run));
    await assert.rejects(reviews.verifyTests(reviewer,args,'second',signal,run));
    done.resolve(); assert.equal((await pending).exitCode,1);
    const replay=await reviews.verifyTests(reviewer,args,'same',signal,run);
    assert.equal('replayed' in replay && replay.replayed,true); assert.equal(calls,1);
    await assert.rejects(reviews.verifyTests(reviewer,{argv:['true']},'same',signal,run));
    await assert.rejects(reviews.verifyTests(reviewer,args,'lost',signal,async()=>{throw new Error('lost');}));
    await assert.rejects(reviews.verifyTests(reviewer,args,'retry',signal,run));
    const evidence=h.store.detail(h.cid).evidence.filter(e=>e.invocationId===reviewer && e.detail.name==='project_review_test');
    assert.deepEqual(evidence.map(e=>e.detail.state),['test_started','tested','test_started','test_incomplete']);
    assert.equal(evidence[1]?.detail.snapshotSha256,digest);
    assert.equal(evidence[1]?.detail.exitCode,1);
    assert.ok(!JSON.stringify(evidence).includes('assertion failed'));
    assert.equal(calls,1);
  } finally {h.close();}
});

const revisionRequest='@Codex 修改项目，完成后请 Claude Code 评审，有问题就继续改。';
const revisionSignal=new AbortController().signal;
const revisionArgs={argv:['npm','test','--','zero']};

async function testReceipt(h: ReturnType<typeof setup>, run:string, exitCode:number, snapshot:string, argv=revisionArgs.argv) {
  const reviews=h.store.projectReviews;
  await reviews.read(run,{path:'main.js'},'read',revisionSignal);
  await reviews.verifyTests(run,{argv},'test',revisionSignal,async({argv})=>({
    argv,exitCode,output:'test output',truncated:false,treeExited:true,snapshotSha256:snapshot.repeat(64),
  }));
  const check=await reviews.check(h.cid,run);
  h.store.recordEvidence(run,{kind:'tool',detail:{origin:'project_review',state:'checked',...check}});
}

async function authorTest(h: ReturnType<typeof setup>, id:string) {
  await h.store.projectReviews.authorNpmTest(id,{args:['zero']},'repair-test',revisionSignal,async({argv})=>({
    argv,exitCode:0,output:'ok',truncated:false,treeExited:true,snapshotSha256:'b'.repeat(64),
  }));
}

function startRevisionReview(h: ReturnType<typeof setup>, legacyContract = false) {
  writeFileSync(join(h.project,'main.js'),'zero-case');
  const author=h.start(); h.accept(author);
  if (legacyContract) {
    h.store.db.prepare("UPDATE cc_contracts SET value=json_remove(value,'$.projectNpmChecks') WHERE invocation_id=?").run(author);
  }
  h.store.requestCollaboration(author,'review',{targets:['claude'],content:'复核零值。',projectReview:{paths:['main.js']}});
  const reviewer=h.start(); h.accept(reviewer);
  return {author,reviewer};
}

test('a frozen P7 contract returns one failed check after both exits and verifies that exact command against a new snapshot',async()=>{
  const h=setup('project',revisionRequest);
  try {
    const {author,reviewer}=startRevisionReview(h,true);
    const duplicate=h.store.requestCollaboration(author,'another-tool-call',{targets:['claude'],content:'复核零值。',projectReview:{paths:['main.js']}});
    assert.equal(duplicate.sourceId,h.store.visibility.primary(reviewer).id);
    await testReceipt(h,reviewer,1,'a');
    await h.store.projectReviews.verifyTests(reviewer,{argv:['npm','test','--','other']},'other',revisionSignal,async({argv})=>({
      argv,exitCode:0,output:'other test passed',truncated:false,treeExited:true,snapshotSha256:'a'.repeat(64),
    }));
    h.finish(reviewer,'succeeded','零值用例失败。');
    assert.equal(h.store.detail(h.cid).sources.length,2);
    h.finish(author,'succeeded','初次修复。');
    const repair=h.start(); h.accept(repair);
    const source=h.store.visibility.primary(repair);
    assert.equal(source.projectRepair?.authorInvocationId,author);
    assert.equal(source.projectRepair?.reviewInvocationId,reviewer);
    assert.equal(source.parentInvocationId,reviewer);
    assert.equal(h.store.invocation(repair).memberId,h.store.invocation(author).memberId);
    assert.deepEqual(source.projectRepair?.failedTest.argv,revisionArgs.argv);
    assert.equal(source.projectRepair?.checks,undefined);
    assert.equal(h.store.contract(repair).projectNpmChecks,undefined);
    assert.ok(h.store.contract(repair).projectWork);
    assert.throws(()=>h.store.requestCollaboration(repair,'again',{targets:['claude'],content:'再复验。',projectReview:{paths:['main.js']}}),/交回原评审/);
    await authorTest(h,repair);
    await h.store.projectReviews.authorNpmTest(repair,{},'baseline',revisionSignal,async({argv})=>({
      argv,exitCode:0,output:'baseline passed',truncated:false,treeExited:true,snapshotSha256:'b'.repeat(64),
    }));
    h.finish(repair,'succeeded','已修复。\n@Claude Code 再复核。');
    h.store.finish(repair,'succeeded','已修复。\n@Claude Code 再复核。');
    const recheck=h.start(); h.accept(recheck);
    assert.equal(h.store.visibility.primary(recheck).projectReview?.retestOfRepairInvocationId,repair);
    assert.equal(h.store.contract(recheck).projectReview?.projectNpmChecks,undefined);
    assert.equal(h.store.contract(recheck).projectWork,undefined);
    writeFileSync(join(h.project,'main.js'),'fixed');
    await testReceipt(h,recheck,0,'b');
    h.finish(recheck,'succeeded','已复查。');
    const detail=h.store.detail(h.cid);
    const verdict=detail.evidence.find(e=>e.invocationId===recheck && e.detail.state==='revision_verdict')!;
    assert.equal(verdict.detail.outcome,'passed');
    assert.equal(detail.sources.length,4);
    assert.deepEqual(detail.invocations.map(i=>i.memberId),['codex','claude','codex','claude']);
    assert.equal(h.store.admitNext(),undefined);
  } finally { h.close(); }
});

test('P7 never automatically returns a review-only instruction, a cancelled review or an approved revision with no failed test',async()=>{
  for(const mode of ['review-only','cancelled','no-failure','negated'] as const) {
    const content=mode==='review-only'?'@Codex 修改项目，完成后只需评审。':
      mode==='negated'?'@Codex 修改项目，完成后请同伴评审，有问题就继续改之前先等我确认。':revisionRequest;
    const h=setup('project',content);
    try {
      const {author,reviewer}=startRevisionReview(h);
      h.finish(author,'succeeded','已修。');
      if(mode!=='no-failure') await testReceipt(h,reviewer,1,'a');
      if(mode==='cancelled') h.store.cancel(reviewer);
      h.finish(reviewer,'succeeded','请继续改。');
      assert.equal(h.store.detail(h.cid).sources.length,2,mode);
    } finally {h.close();}
  }
});

test('P7 retest stops after one return and cannot pass on a different check or the old snapshot',async()=>{
  for(const [status,argv,snapshot,expected] of [[1,revisionArgs.argv,'b','failed'],[0,['true'],'b','unverified'],[0,revisionArgs.argv,'a','unverified'],[0,revisionArgs.argv,'c','unverified']] as const) {
    const h=setup('project',revisionRequest);
    try {
      const {author,reviewer}=startRevisionReview(h);
      h.finish(author,'succeeded','完成。');
      await testReceipt(h,reviewer,1,'a'); h.finish(reviewer,'succeeded','原检查失败。');
      const repair=h.start(); h.accept(repair); await authorTest(h,repair); h.finish(repair,'succeeded','修订。');
      const rerun=h.start();h.accept(rerun);
      await testReceipt(h,rerun,status,snapshot,[...argv]);h.finish(rerun,'succeeded','已复验。');
      const d=h.store.detail(h.cid);
      assert.equal(d.sources.length,4);
      assert.equal(d.evidence.find(e=>e.detail.state==='revision_verdict')?.detail.outcome,expected);
    } finally {h.close();}
  }
});

test('P7 preserves the failure without starting another writer after withdrawal or a manual reread',async()=>{
  const h=setup('project',revisionRequest);
  try {
    const {author,reviewer}=startRevisionReview(h);
    h.finish(author,'succeeded','完成。');
    await testReceipt(h,reviewer,1,'a');
    h.finish(reviewer,'succeeded','应退修。');
    const retry=h.store.projectReviews.reread(h.cid,reviewer,randomUUID());
    const follow=h.store.detail(h.cid).sources.find(s=>s.id===retry.result.sourceId)!;
    assert.equal(follow.projectReview?.revisionAuthorInvocationId,undefined);
    h.store.workbench.revokeWorkspace(h.cid,h.store.workbench.conversation(h.cid).revision!,randomUUID());
    assert.equal(h.store.admitNext(),undefined);
    const d=h.store.detail(h.cid), repair=d.sources.find(s=>s.projectRepair)!;
    assert.equal(d.deliveries.find(row=>row.sourceId===repair.id)?.status,'held');
    assert.equal(d.invocations.length,2);
  } finally {h.close();}
});

test('P7 retains a repair without evidence of a successful changed-snapshot author test for the failing command',async()=>{
  const h=setup('project',revisionRequest);
  try {
    const {author,reviewer}=startRevisionReview(h);
    h.finish(author,'succeeded','初次完成。');
    await testReceipt(h,reviewer,1,'a');
    h.finish(reviewer,'succeeded','复现失败。');
    const repair=h.start(); h.accept(repair);
    h.finish(repair,'succeeded','自述已通过。');
    assert.equal(h.store.admitNext(),undefined);
    const d=h.store.detail(h.cid);
    assert.equal(d.sources.length,3);
    assert.ok(d.evidence.some(e=>e.invocationId===repair && e.detail.state==='revision_blocked'));
  } finally {h.close();}
});

test('P7 drives the repair loop from a single conversation request and the engine tool callbacks',async()=>{
  const h=setup('project',revisionRequest);
  const target=join(h.project,'main.js');
  let changed=false;
  const engine=new CollaborationEngine(h.store,{
    async runProjectReviewTest({argv,verifyAuthorization}) {
      verifyAuthorization();
      return {argv,output:changed?'pass':'failure on zero',exitCode:changed?0:1,truncated:false,
        treeExited:true,snapshotSha256:(changed?'b':'a').repeat(64)};
    },
    async invoke(request) {
      const source=h.store.visibility.primary(request.invocationId);
      request.onEvent({kind:'accepted',detail:{source:'test_adapter'}});
      if(source.projectRepair) {
        writeFileSync(target,'0'); changed=true;
        assert.match(request.prompt,/project_npm_test/);
        await executeTool(request,'project_npm_test',{args:['zero']},'selftest');
      } else if(request.projectWork) {
        writeFileSync(target,'missing zero');
        await executeTool(request,'collaboration_request',{targets:['claude'],content:'检查零值。',
          projectReview:{paths:['main.js']}},'invite');
      } else {
        await executeTool(request,'project_review_read',{path:'main.js'},'read');
        await executeTool(request,'project_review_test',revisionArgs,'test');
      }
      request.onEvent({kind:'process_exit',detail:{confirmed:true}});
      return {text:'已执行。',continuity:'unknown'};
    }
  },{workspace:h.project});
  try {
    engine.start();
    const end=Date.now()+6000;
    while(Date.now()<end && !h.store.detail(h.cid).evidence.some(e=>e.detail.state==='revision_verdict')) await new Promise(r=>setTimeout(r,30));
    const d=h.store.detail(h.cid);
    assert.deepEqual(d.invocations.map(i=>[i.memberId,i.status]),[['codex','succeeded'],['claude','succeeded'],['codex','succeeded'],['claude','succeeded']],JSON.stringify(d.responses));
    assert.ok(d.evidence.some(e=>e.detail.state==='revision_verdict' && e.detail.outcome==='passed'));
  } finally {await engine.stop();h.close();}
});

test('P7: download permission is bound to the author, original lock and one test call',async()=>{
  const h=setup('project');
  const lock='{"lockfileVersion":3}\n', lockSha256=createHash('sha256').update(lock).digest('hex');
  writeFileSync(join(h.project,'package-lock.json'),lock);
  const id=h.start(); h.accept(id);
  const controller=new AbortController();
  let launches=0;
  try {
    const execute=async (req:ProjectReviewTestRequest)=>{
      assert.equal(req.authorInvocationId,id);
      await req.npm!.authorizeDownload({lockSha256,packages:['ms@2.1.3']});
      launches++;
      throw new Error('should not launch after the lock edit');
    };
    const pending=h.store.projectReviews.authorNpmTest(id,{},'lock-edit',controller.signal,execute);
    const rejected=assert.rejects(pending,/锁文件已变化/);
    const until=Date.now()+4000;
    while (!h.store.interactions.list(h.cid).length && Date.now()<until) await new Promise(r=>setTimeout(r,10));
    const item=h.store.interactions.list(h.cid)[0]!;
    assert.equal(item.transport,'project-npm');
    assert.equal(item.payload.lockSha256,lockSha256);
    writeFileSync(join(h.project,'package-lock.json'),lock+' ');
    h.store.interactions.answer(item.id,{expectedRevision:item.revision,payloadDigest:item.payloadDigest,requestId:randomUUID(),answers:{download:'允许此次下载'}});
    await rejected;
    await assert.rejects(h.store.projectReviews.authorNpmTest(id,{},'lock-edit',controller.signal,execute),/已发起/);
    assert.equal(h.store.interactions.list(h.cid).length,1);
    assert.equal(launches,0);
  } finally {controller.abort();h.close();}
});

test('P7 discards failed checks superseded by a newer snapshot and checks later outcomes by the exact command',async()=>{
  for(const mode of ['other-snapshot','now-passed','incomplete','two-failures'] as const) {
    const h=setup('project',revisionRequest);
    try {
      const {author,reviewer}=startRevisionReview(h);
      h.finish(author,'succeeded','修改完成。');
      await testReceipt(h,reviewer,1,'a');
      const argv=mode==='other-snapshot' || mode==='two-failures'?['npm','test','--','second']:revisionArgs.argv;
      const latter=h.store.projectReviews.verifyTests(reviewer,{argv},'later',revisionSignal,async({argv})=>{
        if(mode==='incomplete') throw new Error('unconfirmed');
        return {argv,exitCode:mode==='two-failures'?1:0,output:'test',truncated:false,treeExited:true,
          snapshotSha256:(mode==='other-snapshot'?'b':'a').repeat(64)};
      });
      if(mode==='incomplete') await assert.rejects(latter); else await latter;
      h.finish(reviewer,'succeeded','核对结束。');
      const repair=h.store.detail(h.cid).sources.find(s=>s.projectRepair);
      if(mode==='two-failures') {
        assert.deepEqual(repair?.projectRepair?.failedTest.argv,revisionArgs.argv);
        assert.match(repair!.content,/second/);
      } else assert.equal(repair,undefined,mode);
    } finally {h.close();}
  }
});

test('P8 requires every observed npm check on one repaired snapshot and detects regressions in previously passing checks',async () => {
  const commands = [
    {argv:['npm','run','typecheck'], authorArgs:{script:'typecheck'}},
    {argv:['npm','test','--','edge'], authorArgs:{args:['edge']}},
    {argv:['npm','run','build'], authorArgs:{script:'build'}},
  ];
  for (const scenario of ['pass','incomplete-author','author-split-snapshots','missing-review','test-regression','skipped-build'] as const) {
    const h=setup('project',revisionRequest);
    const receipt=(argv:string[],exitCode:number,version:string) => ({
      argv,exitCode,output:'fixture',truncated:false,treeExited:true as const,snapshotSha256:version.repeat(64),
    });
    try {
      const {author,reviewer}=startRevisionReview(h);
      h.finish(author,'succeeded','请检查。');
      const reviews=h.store.projectReviews;
      async function checkReads(id:string) {
        await reviews.read(id,{path:'main.js'},'read',revisionSignal);
        h.store.recordEvidence(id,{kind:'tool',detail:{origin:'project_review',state:'checked',...await reviews.check(h.cid,id)}});
      }
      for (const {argv} of commands) {
        await reviews.verifyTests(reviewer,{argv},argv.join(' '),revisionSignal,async()=>receipt(argv,argv[1]==='test'?0:1,'a'));
      }
      await checkReads(reviewer);
      h.finish(reviewer,'succeeded','类型检查和构建失败。');
      const repair=h.start(); h.accept(repair);
      const repairSource=h.store.visibility.primary(repair);
      assert.deepEqual(repairSource.projectRepair?.checks?.map(item=>item.argv),commands.map(item=>item.argv));
      assert.deepEqual(repairSource.projectRepair?.failedTest.argv,commands[0]!.argv);
      assert.ok(h.store.prompt(repair).includes(JSON.stringify(commands.map(item=>item.authorArgs))));

      for (const {argv,authorArgs} of commands) {
        if (scenario==='incomplete-author' && argv[2]==='build') continue;
        await reviews.authorNpmTest(repair,authorArgs,argv.join(' '),revisionSignal,async(req)=>{
          assert.deepEqual(req.argv,argv);
          return receipt(argv,0,scenario==='author-split-snapshots' && argv[2]==='build'?'c':'b');
        });
      }
      h.finish(repair,'succeeded','修订完成。');
      if (scenario==='incomplete-author' || scenario==='author-split-snapshots') {
        assert.equal(h.store.admitNext(),undefined);
        assert.ok(h.store.detail(h.cid).evidence.some(e=>e.invocationId===repair && e.detail.state==='revision_blocked'));
        continue;
      }
      const retest=h.start(); h.accept(retest);
      assert.equal(h.store.contract(retest).projectReview?.projectNpmChecks,true);
      for (const {argv} of commands) {
        if (scenario==='missing-review' && argv[2]==='build') continue;
        await reviews.verifyTests(retest,{argv},argv.join(' '),revisionSignal,async()=>{
          if (scenario==='skipped-build' && argv[2]==='build') throw new MissingProjectScript('build','b'.repeat(64));
          return receipt(argv,scenario==='test-regression' && argv[1]==='test'?1:0,'b');
        });
      }
      await checkReads(retest);
      h.finish(retest,'succeeded','复验完成。');
      const verdict=h.store.detail(h.cid).evidence.find(e=>e.detail.state==='revision_verdict')!;
      assert.ok(verdict,scenario);
      assert.equal(verdict.detail.outcome,scenario==='pass'?'passed':scenario==='test-regression'?'failed':'unverified');
      assert.deepEqual(verdict.detail.checks.map((result:{argv:string[]})=>result.argv),commands.map(item=>item.argv));
      assert.equal(h.store.admitNext(),undefined);
    } finally {h.close();}
  }
});
