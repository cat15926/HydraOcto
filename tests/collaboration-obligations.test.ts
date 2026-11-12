import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import {runtimeTools} from '../server/collaboration/runtime-common.js';
import {sessionFingerprint} from '../server/collaboration/continuity.js';
import { userAcceptanceQuote } from '../server/collaboration/user-acceptance.js';
import type { Obligation } from '../shared/obligations.js';

function setup(path = ':memory:', workspace?: string) {
  const owner = new Store(path), store = new CollaborationStore(owner,{workspace,projectWorkAvailability:()=>({available:true})});
  const cid = store.create({title:'责任验收',memberIds:['codex','claude'],defaultMemberId:'codex',requestId:randomUUID()}).conversation.id;
  const run = () => {
    const i = store.admitNext()!.invocations[0]!;
    store.startInvocation(i.id); store.recordEvidence(i.id,{kind:'accepted',detail:{source:'isolated_test'}});
    return i.id;
  };
  const ask = (content='@Codex 核对原始资料并交付。') => { store.send(cid,{requestId:randomUUID(),content}); return run(); };
  const finish = (id:string,summary:string) => {
    store.recordEvidence(id,{kind:'process_exit',detail:{confirmed:true,code:0}}); store.finish(id,'succeeded',summary);
  };
  const tool = (id:string,name:string,args:Record<string,unknown>,key:string = randomUUID()) =>
    (store.obligations.tool(id,name,args,key) as {obligation:Obligation}).obligation;
  const read = (o:Obligation) => store.obligations.list(cid).find(row => row.id === o.id)!;
  const delegate = (id:string,o:Obligation,version='v2',paths?:string[]) => {
    const args = {targets:['claude'],content:'独立核验并回报。',delivery:{obligationId:o.id,acceptance:'就指定版本核验',version},...(paths && {projectReview:{paths}})};
    const once = store.requestCollaboration(id,'handoff',args);
    assert.equal(store.requestCollaboration(id,'handoff',args).sourceId,once.sourceId);
    return store.obligations.list(cid).find(row=>row.parentId === o.id)!;
  };
  return {owner,store,cid,ask,run,finish,tool,read,delegate};
}

test('two members retain root ownership, submit the fixed version, wake once and deliver to user', async () => {
  const h = setup();
  try {
    const writer = h.ask('@Codex 核对原始资料，完成后交我验收。'), root = h.tool(writer,'obligation_open',{goal:'交付核验结果',acceptance:'user'},'open');
    assert.equal(h.tool(writer,'obligation_open',{goal:'交付核验结果',acceptance:'user'},'open').id,root.id);
    assert.throws(()=>h.tool(writer,'obligation_open',{goal:'不同目标'},'open'));
    assert.throws(()=>h.tool(writer,'obligation_wait',{obligationId:root.id,ownerMemberId:'claude'}));
    const child = h.delegate(writer,root);
    h.finish(writer,'我已委托。');
    const reviewer = h.run();
    assert.deepEqual(h.store.obligations.context(reviewer).map(o=>o.id),[child.id]);
    assert.throws(()=>h.tool(reviewer,'obligation_deliver',{obligationId:root.id,summary:'越权交付'}));
    assert.throws(()=>h.tool(reviewer,'obligation_report',{obligationId:child.id,version:'v3',outcome:'passed',summary:'同名版本'}));
    h.tool(reviewer,'obligation_report',{obligationId:child.id,version:'v2',outcome:'passed',summary:'原材料一致。'});
    h.finish(reviewer,'已回报。'); h.store.obligations.reconcile(); h.store.obligations.reconcile();
    assert.equal(h.read(child).state,'delivered'); assert.equal(h.read(root).state,'open');
    assert.equal(h.store.detail(h.cid).sources.filter(s=>s.kind==='job_result').length,1);
    const author = h.run();
    assert.equal(h.store.invocation(author).memberId,'codex');
    h.tool(author,'obligation_deliver',{obligationId:root.id,summary:'两份材料一致。'});
    h.finish(author,'两份材料一致。');
    assert.equal(h.read(root).state,'awaiting_acceptance');
    const t=h.store.tasks.getTask(root.taskId!);
    assert.notEqual(t.status,'done');
    assert.throws(()=>h.store.tasks.update(t.id,{status:'done',expectedRevision:t.revision,expectedOwnerRevision:t.ownerRevision,requestId:'obligation-delivered-'+root.id}),/原消息/);
    assert.throws(()=>h.store.tasks.tool(author,'task_update',{taskId:t.id,status:'done',expectedRevision:t.revision,expectedOwnerRevision:t.ownerRevision},'late'));
    assert.equal(h.read(root).state,'awaiting_acceptance');
    const input = {requestId:'user-decided',expectedRevision:h.read(root).revision,decision:'accept' as const};
    await h.store.obligations.decide(h.cid,root.id,input); await h.store.obligations.decide(h.cid,root.id,input);
    assert.equal(h.read(root).state,'delivered'); assert.equal(h.store.tasks.getTask(root.taskId!).status,'done');
    assert.equal(h.store.admitNext(),undefined);
  } finally { h.owner.close(); }
});

for(const legacy of [false,true])test('grounded delivery distinguishes signed opinion from direct evidence across a peer return; legacy='+legacy,()=>{
 const h=setup();
 try {
   const source=h.store.send(h.cid,{requestId:randomUUID(),content:'@Codex 对照两份材料：新版签批仅适用于 A 项目，B 项目只有成员建议。请核实后汇报。'}).source;
   if(legacy){delete source.deliveryEvidencePolicy;h.store.visibility.put('cc_sources',source);}
   function start(){
     const run=h.store.admitNext()!.invocations[0]!,input=h.store.prepareInput(run.id);
     h.store.startInvocation(run.id);h.store.recordEvidence(run.id,{kind:'accepted',detail:{source:'isolated_test'}});
     return {id:run.id,input,contract:h.store.contract(run.id)};
   }
   const writer=start(),policy=legacy?undefined:'source-grounded-v1';
   assert.equal(writer.contract.deliveryEvidencePolicy,policy);
   assert.equal(writer.input.manifest.renderVersion,legacy?'room-package-reply-v1':'room-exact-delivery-v1');
   assert.equal(writer.input.prompt.includes('原件直接支持的事实'),!legacy);
   assert.equal(writer.input.prompt.includes('可以在该范围给出肯定结论'),!legacy);
   assert(writer.input.prompt.includes('新版签批仅适用于 A 项目'));
   assert.equal(h.store.obligations.list(h.cid).length,0);
   const identity={supported:true,fingerprint:'unchanged-native-account',reason:'test'};
   const older={...writer.contract,deliveryEvidencePolicy:undefined};
   assert.equal(sessionFingerprint(older,identity)===sessionFingerprint(writer.contract,identity),legacy);
   const tools=runtimeTools(writer.contract);
   assert.deepEqual(tools.map(t=>t.name),runtimeTools(older).map(t=>t.name));
   assert.deepEqual(tools.map(t=>t.inputSchema),runtimeTools(older).map(t=>t.inputSchema));
   assert.equal(tools.find(t=>t.name==='obligation_deliver')?.description.includes('pending verification'),!legacy);
   const list=(id:string)=>h.store.obligations.tool(id,'obligation_list',{},randomUUID()) as {receipts:{report:{authority:string;summary:string;version:string}}[];reportGuidance?:string};
   assert.equal(list(writer.id).reportGuidance,undefined);
   const root=h.tool(writer.id,'obligation_open',{goal:'核对变更范围'}),child=h.delegate(writer.id,root);
   h.finish(writer.id,'已请同伴核对。');const reviewer=start();
   assert.equal(reviewer.contract.deliveryEvidencePolicy,policy);
   assert.equal(runtimeTools(reviewer.contract).find(t=>t.name==='obligation_report')?.description.includes('directly inspected'),!legacy);
   h.tool(reviewer.id,'obligation_report',{obligationId:child.id,version:'v2',outcome:'passed',summary:'我的判断是 B 可能可行，但我手头没有 B 的批准件。'});
   h.finish(reviewer.id,'已回报。');const returning=start(),observed=list(returning.id);
   assert.equal(returning.contract.deliveryEvidencePolicy,policy);assert.equal(returning.input.prompt.includes('原件直接支持的事实'),!legacy);
   assert.equal(observed.receipts.length,1);assert.equal(observed.receipts[0]?.report.authority,'member');
   assert.equal(observed.receipts[0]?.report.version,'v2');assert(observed.receipts[0]?.report.summary.includes('没有 B 的批准件'));
   assert.equal(Boolean(observed.reportGuidance?.includes('署名成员')), !legacy);
 } finally {h.owner.close();}
});

test('normal answers create no obligation; missing report gets one reminder then a blocked return', () => {
  const h = setup();
  try {
    h.finish(h.ask(),'已当场答复。');
    assert.deepEqual(h.store.obligations.list(h.cid),[]);
    const writer = h.ask(), root = h.tool(writer,'obligation_open',{goal:'等结论'}), child = h.delegate(writer,root);
    h.finish(writer,'已发出。');
    h.finish(h.run(),'验证通过'); assert.equal(h.read(child).reminderCount,1);
    h.finish(h.run(),'完成了'); assert.equal(h.read(child).state,'blocked'); assert.equal(h.read(root).state,'blocked');
    h.store.obligations.reconcile(); h.store.obligations.reconcile();
    assert.equal(h.store.detail(h.cid).sources.filter(s=>s.kind==='job_result').length,2);
    assert.equal(h.store.tasks.getTask(root.taskId!).status,'todo');
  } finally { h.owner.close(); }
});

test('condition signal is versioned, exact, cancellable, and cannot impersonate a managed CI receipt', async () => {
  const h = setup();
  try {
    const writer = h.ask(), root = h.tool(writer,'obligation_open',{goal:'等待负责人声明'});
    assert.throws(()=>h.tool(writer,'obligation_wait',{obligationId:root.id,condition:'ci:foo:'+ 'a'.repeat(40),deadline:new Date(Date.now()+60000).toISOString()}));
    const waiting = h.tool(writer,'obligation_wait',{obligationId:root.id,condition:'收到确认',deadline:new Date(Date.now()+60000).toISOString()});
    h.finish(writer,'已登记等待。');
    const signal = {requestId:'signal',condition:'收到确认',summary:'说明已收到。',waitId:waiting.wait!.id,expectedRevision:waiting.revision};
    assert.throws(()=>h.store.obligations.signal(h.cid,root.id,{...signal,waitId:'以前的等待'}));
    assert.throws(()=>h.store.obligations.signal(h.cid,root.id,{...signal,expectedRevision:1}));
    h.store.obligations.signal(h.cid,root.id,signal); h.store.obligations.signal(h.cid,root.id,signal);
    assert.equal(h.store.detail(h.cid).sources.filter(s=>s.kind==='job_result').length,1);
    await h.store.obligations.decide(h.cid,root.id,{requestId:'cancel',expectedRevision:h.read(root).revision,decision:'cancel'});
    h.store.obligations.reconcile();
    assert.equal(h.read(root).state,'cancelled'); assert.equal(h.store.admitNext(),undefined);
  } finally { h.owner.close(); }
});

test('a formal task handoff changes only the authority of the root and the new owner can deliver', () => {
  const h = setup();
  try {
    const old = h.ask(), root = h.tool(old,'obligation_open',{goal:'交班'});
    const task = h.store.tasks.getTask(root.taskId!);
    const offer = h.store.tasks.handoff(task.id,{requestId:'takeover',expectedRevision:task.revision,expectedOwnerRevision:task.ownerRevision,targetMemberId:'claude',reason:'请晚班完成'},old);
    assert.throws(()=>h.tool(old,'obligation_deliver',{obligationId:root.id,summary:'旧人交付'}));
    h.finish(old,'办理交班。');
    const candidate = h.run();
    assert.equal(h.store.tasks.getTask(task.id).ownerMemberId,'codex');
    h.store.tasks.tool(candidate,'task_handoff_decide',{handoffId:offer.handoff.id,decision:'accept',reason:'我接手。'},'accept');
    h.finish(candidate,'已接手。'); const next = h.run();
    assert.deepEqual(h.store.obligations.context(next).map(o=>o.owner.memberId),['claude']);
    h.tool(next,'obligation_deliver',{obligationId:root.id,summary:'晚班已完成。'}); h.finish(next,'晚班已完成。');
    assert.equal(h.read(root).state,'delivered'); assert.deepEqual(h.store.detail(h.cid).sources.filter(s=>s.kind==='job_result').map(s=>s.id),[offer.handoff.offer!.sourceId]);
  } finally { h.owner.close(); }
});

test('project reporting needs matching test and independent reads; a change outside the read list invalidates final delivery',async()=>{
  const rootDir=mkdtempSync(join(tmpdir(),'obligation-version-')), project=join(rootDir,'work'); mkdirSync(project);
  const h=setup(join(rootDir,'db','s.sqlite'),project);
  try {
    writeFileSync(join(project,'f.txt'),'v2');
    const version=createHash('sha256').update(Buffer.from('Ff.txt\0')).update(createHash('sha256').update('v2').digest()).digest('hex');
    const p = h.store.workbench.previewWorkspace(h.cid,{path:project,mode:'project-work',reviewMode:'project'});
    h.store.workbench.applyPreview({previewId:p.id,requestId:randomUUID()},h.cid);
    h.store.projects.submit(h.cid,{requestId:randomUUID(),content:'@codex 修改文件并独立评审'});
    const writer = h.run();
    const root = h.tool(writer,'obligation_open',{goal:'独立核验固定快照'});
    const argv=['npm','test'];
    // Isolate native execution. This test exercises database proofs and the real manifest reader on disk.
    h.store.recordEvidence(writer,{kind:'tool',detail:{origin:'project_author_test',name:'project_npm_test',state:'tested',treeExited:true,snapshotSha256:version,argv,exitCode:0}});
    const child=h.delegate(writer,root,version,['f.txt']); h.finish(writer,'已委托。');
    const reviewer=h.run(),args={obligationId:child.id,version,outcome:'passed',summary:'已通过'};
    assert.throws(()=>h.tool(reviewer,'obligation_report',args));
    await h.store.projectReviews.read(reviewer,{path:'f.txt'},'read',new AbortController().signal);
    const proof={origin:'project_review',name:'project_review_test',state:'tested',treeExited:true,snapshotSha256:version,argv,exitCode:0};
    h.store.recordEvidence(reviewer,{kind:'tool',detail:{...proof,argv:['true']}});
    assert.throws(()=>h.tool(reviewer,'obligation_report',args));
    h.store.recordEvidence(reviewer,{kind:'tool',detail:proof});
    h.tool(reviewer,'obligation_report',args);
    h.store.recordEvidence(reviewer,{kind:'tool',detail:{origin:'project_review',state:'checked',...await h.store.projectReviews.check(h.cid,reviewer)}});
    h.finish(reviewer,'已回报。'); const author=h.run();
    h.tool(author,'obligation_deliver',{obligationId:root.id,summary:'已通过。'});
    await h.store.obligations.verifyDelivery(author);
    writeFileSync(join(project,'new.txt'),'v3');
    await assert.rejects(h.store.obligations.verifyDelivery(author),/复验/);
    h.store.recordEvidence(author,{kind:'process_exit',detail:{confirmed:true}});
    h.store.finish(author,'failed','当前快照已变更，请复验。');
    assert.equal(h.read(root).state,'blocked'); assert.equal(h.read(root).delivery?.messageId,undefined);
    const original=h.store.detail(h.cid).messages.find(m=>m.sourceId===root.originSourceId)!;
    const accepted=h.store.projects.submit(h.cid,{requestId:'authorized-recheck',content:'@Codex 重新修改项目后委托复验。',replyTo:original.id});
    assert.ok('source' in accepted && accepted.source.projectWork);
    const fresh=h.run(); assert.equal(h.store.contract(fresh).projectWork,true);
    assert.deepEqual(h.store.obligations.context(fresh).map(o=>o.id),[root.id]);
    assert.equal(h.tool(fresh,'obligation_open',{goal:'复验最新改动'}).id,root.id);
    assert.equal(h.store.tasks.getTask(root.taskId!).executionRef?.invocationId,fresh);
    assert.throws(()=>h.store.requestCollaboration(fresh,'bypass',{targets:['claude'],content:'普通答复',delivery:{obligationId:root.id,version:'v3',acceptance:'直接通过'}}));
  } finally {h.owner.close();rmSync(rootDir,{recursive:true,force:true});}
});


test('after restart a committed returned result is consumed once, and the owner can transfer from that callback', () => {
  const dir=mkdtempSync(join(tmpdir(),'obligation-resume-')), path=join(dir,'test.sqlite');
  const h=setup(path);
  const a=h.ask(), root=h.tool(a,'obligation_open',{goal:'恢复责任'}), sub=h.delegate(a,root);
  h.finish(a,'已委托。'); const b=h.run();
  h.tool(b,'obligation_report',{obligationId:sub.id,version:'v2',outcome:'passed',summary:'核对通过。'}); h.finish(b,'已回报。');
  const delivery=h.read(root).wakeSourceId!;
  h.owner.close();
  const owner=new Store(path), store=new CollaborationStore(owner);
  try {
    store.obligations.reconcile(); store.obligations.reconcile(); const follow=store.admitNext()!.invocations[0]!;
    assert.equal(store.contract(follow.id).primarySourceId,delivery); assert.equal(store.detail(h.cid).sources.filter(s=>s.kind==='job_result').length,1);
    store.startInvocation(follow.id); store.recordEvidence(follow.id,{kind:'accepted',detail:{}});
    const t=store.tasks.getTask(root.taskId!); assert.equal(t.executionRef?.invocationId,follow.id);
    const handoff=store.tasks.handoff(t.id,{requestId:'new-shift',expectedRevision:t.revision,expectedOwnerRevision:t.ownerRevision,targetMemberId:'claude',reason:'接班交付'},follow.id);
    assert.equal(handoff.handoff.state,'waiting');
    const candidate = store.admitNext()!.invocations[0]!;
    store.startInvocation(candidate.id); store.recordEvidence(candidate.id,{kind:'accepted',detail:{}});
    store.tasks.tool(candidate.id,'task_handoff_decide',{handoffId:handoff.handoff.id,decision:'accept',reason:'我接手。'},'yes');
    store.recordEvidence(candidate.id,{kind:'process_exit',detail:{confirmed:true}}); store.finish(candidate.id,'succeeded','已签收。');
    assert.equal(store.admitNext(),undefined);
    store.recordEvidence(follow.id,{kind:'process_exit',detail:{confirmed:true}}); store.finish(follow.id,'succeeded','交班。');
    const last=store.admitNext()!.invocations[0]!; store.startInvocation(last.id); store.recordEvidence(last.id,{kind:'accepted',detail:{}});
    store.obligations.tool(last.id,'obligation_deliver',{obligationId:root.id,summary:'验收成功'},'result');
    store.recordEvidence(last.id,{kind:'process_exit',detail:{confirmed:true}}); store.finish(last.id,'succeeded','验收成功');
    assert.equal(store.obligations.list(h.cid).find(o=>o.id===root.id)!.state,'delivered');
  } finally {owner.close();rmSync(dir,{recursive:true,force:true});}
});

test('a late report cannot settle or wake a cancelled parent or another member generation', async () => {
  const h=setup();
  try {
    const a=h.ask(), root=h.tool(a,'obligation_open',{goal:'只交原房间成员'}), child=h.delegate(a,root);
    h.finish(a,'等待对方。'); const b=h.run();
    const other=h.store.create({requestId:randomUUID(),title:'另一房间',memberIds:['codex','claude'],defaultMemberId:'claude'}).conversation;
    await assert.rejects(h.store.obligations.decide(other.id,root.id,{requestId:'bad',expectedRevision:h.read(root).revision,decision:'cancel'}));
    h.store.roomMembers.sync(h.cid,['codex']); h.store.roomMembers.sync(h.cid,['codex','claude']);
    const data={obligationId:child.id,version:'v2',outcome:'passed',summary:'迟到的结果'};
    assert.throws(()=>h.tool(b,'obligation_report',data));
    await h.store.obligations.decide(h.cid,root.id,{requestId:'stop',expectedRevision:h.read(root).revision,decision:'cancel'});
    assert.throws(()=>h.tool(b,'obligation_report',data));
    assert.equal(h.read(root).state,'cancelled'); assert.equal(h.read(child).state,'cancelled');
    assert.equal(h.store.detail(h.cid).sources.filter(s=>s.kind==='job_result').length,0);
  } finally {h.owner.close();}
});

test('the returning author can recover from task_update done and deliver in the same execution',()=>{
  const h=setup();
  try {
    const a=h.ask(), root=h.tool(a,'obligation_open',{goal:'核验后向用户回报'}), child=h.delegate(a,root);
    h.finish(a,'已委托。'); const reviewer=h.run();
    h.tool(reviewer,'obligation_report',{obligationId:child.id,version:'v2',outcome:'passed',summary:'独立核验通过'});
    h.finish(reviewer,'已回报。'); const returned=h.run();
    assert.equal(h.store.obligations.context(returned)[0]!.id,root.id);
    const t=h.store.tasks.getTask(root.taskId!), args={taskId:t.id,status:'done',expectedRevision:t.revision,expectedOwnerRevision:t.ownerRevision};
    assert.throws(()=>h.store.tasks.tool(returned,'task_update',args,'close-task'),/obligation_deliver/);
    assert.throws(()=>h.store.tasks.tool(returned,'task_update',{...args,obligationId:root.id},'spoof'));
    assert.throws(()=>h.store.tasks.update(t.id,{...args,requestId:'obligation-delivered-'+root.id}));
    h.store.obligations.reconcile();
    assert.equal(h.read(root).state,'open'); assert.equal(h.store.tasks.getTask(t.id).revision,t.revision);
    h.tool(returned,'obligation_deliver',{obligationId:root.id,summary:'排序验证通过。'});h.finish(returned,'排序验证通过。');
    assert.equal(h.read(root).state,'delivered'); assert.equal(h.store.tasks.getTask(t.id).status,'done');
    const ordinary=h.store.tasks.create(h.cid,{requestId:'ordinary',title:'普通待办',description:''}).task;
    assert.equal(h.store.tasks.update(ordinary.id,{requestId:'done',status:'done',expectedRevision:ordinary.revision,expectedOwnerRevision:ordinary.ownerRevision}).task.status,'done');
  } finally {h.owner.close();}
});

test('only direct user language reserving final approval authorizes an extra manual step',()=>{
  const accepted=[
    '最终由我确认。','由我最终确认。','修好之后我来确认结果。','完成测试后交我确认。','完成测试后，交我确认。',
    "I'll confirm the final result.", 'I’ll personally confirm the final deliverable.', 'A 的结果自动交付，B 的最终成果由我确认。','请将最终结果发给我确认。',
    '请两位核对，完成后交我验收。','请交给我亲自验收。','等我确认后再关闭。','成果由我本人最终批准。',
    'Please wait for my explicit approval before closing the task.',
    'Submit the finished work to me for final approval.', 'I will personally approve the final result.',
    '请解释“自动通过”，成稿交我验收。','修好后我来验收。','未经我验收，不得交付。','Do not close until I approve the final result.','先给我讲个示例。实际修复完成后交我验收。','A 不用我验收；B 交我验收。','A 不用我验收，B 交我验收。',
  ];
  for (const input of accepted) assert.ok(userAcceptanceQuote(input),input);
  const automatic=[
    '请确认收到邮件。','完成测试后我来确认收到邮件。','等我确认后再开始测试。','最终向我确认时间。',
    '最终由我确认交付时间。','最终向我本人确认。','最终由 Codex 确认结果。','I will confirm receipt of the email.',
    'I will confirm the final delivery time.', 'Please confirm the final result with me.',
    '等收到通过的结果后，请你本人向我汇报一次最终结果。','请 @Codex 验收，最后发给我。','独立验证后抄送给我。',
    '最后请你验收，告诉我是否通过。','不用等我确认，直接交付。','别交我验收，只把结果告诉我。',
    '原文写着“交我验收”。请解释这句话。','这里有一个样例：\n交我验收。','示例：交我验收；实际只需发给我。',
    '复述一下：『成果交我验收』。','> 交我验收\n\n请修复问题，回复结果。','把 \x60交我验收\x60 翻译成英语。'.replaceAll('\\x60','\x60'),
    '不用向我汇报，也不要提交给我亲自验收。','假设未来要增加按钮，就交我验收。','是否需要交我验收？','如果可选，是否交我验收？',
    '修好后交我验收。更正，直接自动交付。','原需求是由我验收，现在自动交付。','先等我确认再开始测试，测试通过自动交付。','负责人说：交我验收。请将这条消息转达给团队。','在 README 里添加一行：交我验收。',
    'Report the final results to me after your teammate signs off.', 'Do not wait for my personal approval.',
    'For example: wait for my final approval. Just report the result.',
    '"Wait for my explicit approval" is sample product copy.', 'CC me for approval when the review is complete.',
    "Don't wait for my approval. Send me the result.",
  ];
  for (const input of automatic) assert.equal(userAcceptanceQuote(input),undefined,input);
});

test('quoted messages, attached materials and agent-generated task sources cannot grant human acceptance',()=>{
  const h=setup();
  try {
    const first=h.ask('请准备材料，最后交我验收。');
    const original=h.store.detail(h.cid).messages.find(m=>m.author==='user')!;
    const valid=h.tool(first,'obligation_open',{goal:'保留人工验收',acceptance:'delivery'});
    assert.equal(valid.acceptBy,'user');
    assert.equal(h.tool(first,'obligation_open',{goal:'把同次请求拆成另一个子目标'}).id,valid.id);
    assert.equal(valid.userAcceptance?.messageId,original.id); assert.match(valid.userAcceptance!.quote,/我验收/);
    h.tool(first,'obligation_deliver',{obligationId:valid.id,summary:'材料在此。'}); h.finish(first,'材料在此。');
    h.store.send(h.cid,{requestId:'quote-only',content:'@Codex 解释这条示例；只汇报结果。',replyTo:original.id});
    const second=h.run(),copy=h.tool(second,'obligation_open',{goal:'解释',acceptance:'user'});
    assert.equal(copy.acceptBy,'delivery'); assert.equal(copy.userAcceptance,undefined);
    const attached=h.store.workbench.upload(h.cid,{name:'brief.txt',base64:Buffer.from('等我确认后再关闭。').toString('base64'),mediaType:'text/plain',requestId:'attachment'}).result;
    h.tool(second,'obligation_deliver',{obligationId:copy.id,summary:'已解释。'}); h.finish(second,'已解释。');
    h.store.send(h.cid,{requestId:'attachment-only',content:'@Codex 分析附件的示例，告诉我结论。',attachmentIds:[attached.id]});
    const third=h.run(),fromAttachment=h.tool(third,'obligation_open',{goal:'分析附件',acceptance:'user'});
    assert.equal(fromAttachment.acceptBy,'delivery');
    h.tool(third,'obligation_deliver',{obligationId:fromAttachment.id,summary:'分析完成。'});
    const generated=h.store.tasks.create(h.cid,{requestId:'agent-task',title:'示范任务',description:'交我验收。',ownerMemberId:null},third).task;
    h.finish(third,'分析完成。');
    h.store.tasks.handoff(generated.id,{requestId:'assign',expectedRevision:generated.revision,expectedOwnerRevision:generated.ownerRevision,targetMemberId:'claude',reason:'负责此任务；交我验收。'});
    const fromTask=h.tool(h.run(),'obligation_open',{goal:'执行已有任务',acceptance:'user'});
    assert.equal(fromTask.taskId,generated.id);assert.equal(fromTask.acceptBy,'delivery');
  } finally {h.owner.close();}
});

test('a human task form can reserve approval, but later handoff instructions cannot grant it',()=>{
  const h=setup();
  try {
    const task=h.store.tasks.create(h.cid,{requestId:'form',title:'核对样稿',description:'请复核日期，最后交我验收。',ownerMemberId:'codex'}).task;
    const run=h.run(),root=h.tool(run,'obligation_open',{goal:'核实资料'});
    assert.equal(root.taskId,task.id);assert.equal(root.acceptBy,'user');
    assert.deepEqual(root.userAcceptance,{taskId:task.id,sourceRevision:1,quote:'交我验收'});
    h.tool(run,'obligation_deliver',{obligationId:root.id,summary:'日期核实。'});h.finish(run,'日期核实。');
    assert.equal(h.read(root).state,'awaiting_acceptance');

    const plain=h.store.tasks.create(h.cid,{requestId:'handoff',title:'核对票据',description:'审核通过后回复结果。',ownerMemberId:'codex'}).task;
    const issuer=h.run(),current=h.store.tasks.getTask(plain.id);
    h.store.tasks.handoff(plain.id,{requestId:'peer',expectedRevision:current.revision,expectedOwnerRevision:current.ownerRevision,targetMemberId:'claude',reason:'完成后交我验收。'},issuer);
    h.finish(issuer,'已经交接。');
    const recipient=h.run(),automatic=h.tool(recipient,'obligation_open',{goal:'核对票据',acceptance:'user'});
    assert.equal(automatic.taskId,plain.id);assert.equal(automatic.acceptBy,'delivery');assert.equal(automatic.userAcceptance,undefined);
  } finally {h.owner.close();}
});

test('a user can attach a public observation to a blocked receipt, replay the exact command and let its owner decide', async () => {
  const h = setup();
  try {
    const owner = h.ask(), root = h.tool(owner,'obligation_open',{goal:'核对两份资料'});
    h.finish(owner,'正在核对'); h.finish(h.run(),'还缺一份资料');
    const blocked = h.store.obligations.operatorList(h.cid)[0]!;
    assert.equal(blocked.state,'blocked'); assert.equal(blocked.recovery?.retryUnavailable,undefined);
    const input = {requestId:'public-observation',expectedRevision:blocked.revision,decision:'retry' as const,reason:'第二份材料见本房间的会议记录'};
    await assert.rejects(h.store.obligations.decide(h.cid,root.id,{...input,reason:'x'.repeat(1001)}));
    await h.store.obligations.decide(h.cid,root.id,input);
    await h.store.obligations.decide(h.cid,root.id,input);
    await assert.rejects(h.store.obligations.decide(h.cid,root.id,{...input,reason:'修改同一次操作'}));
    await assert.rejects(h.store.obligations.decide(h.cid,root.id,{...input,requestId:'stale'}));
    const sources = h.store.detail(h.cid).sources.filter(s=>s.content.includes(input.reason));
    assert.equal(sources.length,1); assert.deepEqual(sources[0]!.requestedTargets,['codex']);
    assert.match(sources[0]!.content,/用户补充的公开材料/);
    assert.equal(h.read(root).state,'open'); assert.equal(h.read(root).delivery,undefined);
  } finally { h.owner.close(); }
});

test('reassignment checks the target incarnation and task revision and releases exactly one formal handoff after owner leaves', async () => {
  const h = setup();
  try {
    const writer = h.ask(), root = h.tool(writer,'obligation_open',{goal:'补齐资料并交付'});
    h.finish(writer,'稍后交付'); h.finish(h.run(),'仍在处理');
    const previous = h.store.obligations.operatorList(h.cid)[0]!.recovery!.handoffTargets[0]!;
    h.store.updateConversation(h.cid,{memberIds:['codex'],defaultMemberId:'codex'});
    h.store.updateConversation(h.cid,{memberIds:['claude'],defaultMemberId:'claude'});
    h.store.obligations.reconcile();
    const blocked = h.store.obligations.operatorList(h.cid)[0]!, recovery = blocked.recovery!;
    assert.ok(recovery.retryUnavailable); assert.equal(recovery.handoffTargets.length,1);
    assert.notEqual(previous.instanceId,recovery.handoffTargets[0]!.instanceId);
    const input = {requestId:'replacement',expectedRevision:blocked.revision,taskRevision:recovery.taskRevision!,target:recovery.handoffTargets[0]!,reason:'请核对缺少的会议记录'};
    assert.throws(()=>h.store.obligations.reassign(h.cid,root.id,{...input,target:previous}));
    assert.throws(()=>h.store.obligations.reassign(h.cid,root.id,{...input,taskRevision:input.taskRevision-1}));
    h.store.obligations.reassign(h.cid,root.id,input); h.store.obligations.reassign(h.cid,root.id,input);
    await assert.rejects(h.store.obligations.decide(h.cid,root.id,{requestId:'late-cancel',expectedRevision:blocked.revision,decision:'cancel'}));
    const handoffs = h.store.tasks.handoffs(h.cid);
    assert.equal(handoffs.length,1); assert.equal(handoffs[0]!.state,'applied'); assert.equal(handoffs[0]!.reason,input.reason);
    assert.deepEqual(h.read(root).owner,input.target);
    assert.equal(h.read(root).currentSourceId,handoffs[0]!.sourceId); assert.equal(h.read(root).originSourceId,root.originSourceId);
    const next = h.run();
    assert.deepEqual(h.store.obligations.context(next).map(o=>o.id),[root.id]);
    h.finish(next,'正在重新核对'); h.finish(h.run(),'需要补一份原记录');
    const replacement = h.store.obligations.operatorList(h.cid)[0]!;
    assert.equal(replacement.state,'blocked'); assert.equal(replacement.recovery?.retryUnavailable,undefined);
    await h.store.obligations.decide(h.cid,root.id,{requestId:'verify-again',expectedRevision:replacement.revision,decision:'retry',reason:'已补交原记录'});
    const finishing = h.run(); assert.equal(h.store.invocation(finishing).memberId,'claude');
    h.tool(finishing,'obligation_deliver',{obligationId:root.id,summary:'已核对并补齐记录。'}); h.finish(finishing,'已核对并补齐记录。');
    assert.equal(h.read(root).state,'delivered'); assert.equal(h.store.tasks.getTask(root.taskId!).status,'done');
  } finally { h.owner.close(); }
});

test('reassignment retires only the old unclaimed wake when its owner is disabled before receiving it', () => {
  const h = setup();
  try {
    const writer = h.ask(), root = h.tool(writer,'obligation_open',{goal:'复核资料'});
    h.finish(writer,'稍后再核验');
    const wake = h.read(root).wakeSourceId!;
    assert.ok(wake);
    h.store.saveMember({...h.store.members().find(m=>m.id==='codex')!,enabled:false});
    h.store.obligations.reconcile();
    const blocked = h.store.obligations.operatorList(h.cid)[0]!;
    assert.equal(blocked.state,'blocked');
    const recovery = blocked.recovery!;
    h.store.obligations.reassign(h.cid,root.id,{requestId:'retire-unclaimed',expectedRevision:blocked.revision,
      taskRevision:recovery.taskRevision!,target:recovery.handoffTargets[0]!,reason:'原负责人已停用，请核验并回复。'});
    const detail = h.store.detail(h.cid);
    assert.ok(detail.sources.find(s=>s.id===wake)?.withdrawnAt);
    assert.equal(detail.sources.find(s=>s.id===root.originSourceId)?.withdrawnAt,undefined);
    const next = h.run(); assert.equal(h.store.invocation(next).memberId,'claude');
    assert.deepEqual(h.store.obligations.context(next).map(o=>o.id),[root.id]);
    assert.equal(h.store.admitNext(),undefined);
  } finally { h.owner.close(); }
});

test('the exact public body is the member-authored receipt, published once after confirmed exit', () => {
  const h=setup();
  try {
    const run=h.ask('按原样给我可直接使用的清单，交我验收。'),root=h.tool(run,'obligation_open',{goal:'可直接使用的清单'});
    const body='[\n  {"item":"甲","status":"待确认","refs":["原件4"]}\n]\n';
    const args={obligationId:root.id,summary:body,publication:'exact'};
    assert.deepEqual(h.tool(run,'obligation_deliver',args,'publish'),h.tool(run,'obligation_deliver',args,'publish'));
    const carrier='已准备好清单。';
    h.store.finish(run,'succeeded',carrier);assert.equal(h.read(root).state,'delivery_pending');
    h.store.recordEvidence(run,{kind:'process_exit',detail:{confirmed:true,code:0}});h.store.obligations.reconcile();
    assert.equal(h.read(root).state,'awaiting_acceptance');
    const msg=h.store.detail(h.cid).messages.find(m=>m.id===h.read(root).delivery?.messageId)!;
    assert.equal(msg.memberId,'codex');assert.equal(msg.content,body);
    const res=h.store.response(msg.responseId!);assert.equal(res.content,body);
    assert.equal(res.carrierContentDigest,createHash('sha256').update(JSON.stringify(carrier)).digest('hex'));
    h.store.finish(run,'succeeded',carrier);h.store.obligations.reconcile();
    assert.equal(h.store.detail(h.cid).messages.filter(m=>m.responseId===res.id).length,1);
  }finally{h.owner.close();}
});

test('exact publication is opt-in, frozen to the source, and cannot close a cancelled delivery', () => {
  for(const mode of ['ordinary','legacy','cancel'] as const) {
    const h=setup();try {
      const source=h.store.send(h.cid,{requestId:randomUUID(),content:'交付正文。'}).source;
      if(mode==='legacy'){delete source.finalTextPolicy;h.store.visibility.put('cc_sources',source);}
      const run=h.run(),root=h.tool(run,'obligation_open',{goal:'交付正文'}),args={obligationId:root.id,summary:'登记的正文'};
      if(mode==='legacy') {
        assert.throws(()=>h.tool(run,'obligation_deliver',{...args,publication:'exact'}),/冻结/);
        const spec=runtimeTools(h.store.contract(run)).find(t=>t.name==='obligation_deliver')!;
        assert(!('publication' in spec.inputSchema.properties));continue;
      }
      if(mode==='ordinary'){h.tool(run,'obligation_deliver',args);h.finish(run,'不同的正文');}
      else {
        h.tool(run,'obligation_deliver',{...args,publication:'exact'});
        h.store.cancel(run);h.store.recordEvidence(run,{kind:'process_exit',detail:{confirmed:true}});
        h.store.finish(run,'cancelled','终止');
      }
      assert.equal(h.read(root).state,'blocked');assert.equal(h.read(root).delivery?.messageId,undefined);
      assert(!h.store.detail(h.cid).messages.some(m=>m.content===args.summary));
    }finally{h.owner.close();}
  }
});
