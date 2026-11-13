import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {Store} from '../server/store.js';
import {CollaborationStore} from '../server/collaboration/store.js';
import {checkItemEvidence, requestedEvidenceField, requestedItemNames} from '../server/collaboration/item-evidence.js';
import {runtimeTools} from '../server/collaboration/runtime-common.js';
import {sessionFingerprint} from '../server/collaboration/continuity.js';
import type {Obligation} from '../shared/obligations.js';

const request='@Codex 请只交付一个 JSON 数组，每项含 item（项目名）、status（现况）、refs（支撑本项判断的原始回执编号数组）。';
const good=JSON.stringify([{item:'待确认的另一用途',refs:['QZ-618-3']}]);
const invalid=JSON.stringify([{item:'替代方案',refs:[]}]);
function fixture(){
  const owner=new Store(':memory:'),store=new CollaborationStore(owner);
  const room=()=>store.create({requestId:randomUUID(),title:'证据交付',memberIds:['codex','claude'],defaultMemberId:'codex'}).conversation.id;
  const cid=room();
  const attachment=(cid:string,content:string)=>store.workbench.upload(cid,{requestId:randomUUID(),name:'record.txt',mediaType:'text/plain',base64:Buffer.from(content).toString('base64')}).result;
  const file=attachment(cid,'QZ-618-3 第一份范围仅限第一次使用。\nQZ-618-7 其他信息。正文中另有 16:00 和 937。');
  const ask=()=>store.send(cid,{requestId:randomUUID(),content:request,attachmentIds:[file.id]}).source;
  const run=()=>{const r=store.admitNext()!.invocations[0]!;
    store.startInvocation(r.id);store.recordEvidence(r.id,{kind:'accepted',detail:{source:'fixture'}});
    return r.id;
  };
  const finish=(id:string,body:string)=>{store.recordEvidence(id,{kind:'process_exit',detail:{confirmed:true,code:0}});store.finish(id,'succeeded',body);};
  const tool=(id:string,name:string,args:Record<string,unknown>,callId:string=randomUUID())=>(store.obligations.tool(id,name,args,callId) as {obligation:Obligation}).obligation;
  const open=(id:string)=>tool(id,'obligation_open',{goal:'整理范围及依据'});
  const read=(id:string)=>store.obligations.list(cid).find(o=>o.id===id)!;
  return {owner,store,cid,room,attachment,file,ask,run,finish,tool,open,read};
}

test('only an explicit per-item record-ID array request activates the field',()=>{
  assert.equal(requestedEvidenceField(request),'refs');
  assert.equal(requestedEvidenceField('Return a JSON array. Each row includes sources (a list of original document IDs).'),'sources');
  assert.equal(requestedEvidenceField('请输出 JSON 数组，每条给出“refs”（原始材料编号列表）'),'refs');
  for(const line of ['普通 JSON 回答即可。','请输出 JSON 数组，每项含 refs（网址列表）','示例：\n'+request,'例如请输出 JSON 数组，每项含 refs（原始记录编号列表）',
    '示例：“'+request+'”','说明：“'+request+'”。请用文字答复。','不要输出 JSON 数组，每项含 refs（原始回执编号数组）。',
    '请返回 JSON 数组，每项含 refs（原始回执编号列表，可为空）。','> '+request,
    '我想知道对方的英文要求是什么："Return a JSON array. Each row includes sources (a list of original document IDs)."',
    '请只交付一段文字。\n\x60\x60\x60\n'+request+'\n\x60\x60\x60'])assert.equal(requestedEvidenceField(line),undefined,line);
});

test('only whole identifiers declared by active materials count, including explicit numeric and non-Latin identifiers',()=>{
  const materials=['QZ-618-3 限定批准范围\nR71 记录\n回执编号：937 待核实。\n记录编号：章甲 另案。\nDocument ID: AS-99 已确认。\n会议时间 16:00、2026-11-14、https://x.test/A1、数量 512。原文提到并未收到 ZZ-73。\n2026-11-14 当天'];
  for(const id of ['R71','QZ-618-3','937','章甲','AS-99'])checkItemEvidence(JSON.stringify([{sources:[id]}]),'sources',materials);
  for(const id of ['16:00','2026-11-14','https://x.test/A1','512','ZZ-73','QZ-618','Ref','原始','x.test','']) {
    assert.throws(()=>checkItemEvidence(JSON.stringify([{sources:[id]}]),'sources',materials),/第 1 行/);
  }
  for(const value of [{sources:['AS-99']},[],[{refs:['AS-99']}],[{sources:['AS-99']},{sources:[]}],[{sources:[937]}]]){
    assert.throws(()=>checkItemEvidence(JSON.stringify(value),'sources',materials));
  }
});

test('owner return can correct a rejected row, cannot use peer or another room as a record, and replays once',()=>{
  const f=fixture();
  try {
    const other=f.room();f.attachment(other,'OTHER-78 独立房间记录。');
    f.ask();const first=f.run(),contract=f.store.contract(first),root=f.open(first);
    assert.equal(contract.itemEvidenceField,'refs');assert.equal(f.store.prepareInput(first).manifest.renderVersion,'room-item-evidence-v1');
    const identity={supported:true,fingerprint:'stable',reason:'fixture'};
    assert.notEqual(sessionFingerprint(contract,identity),sessionFingerprint({...contract,itemEvidenceField:undefined},identity));
    f.store.requestCollaboration(first,'check',{targets:['claude'],content:'请独立核对。',delivery:{obligationId:root.id,version:'v1',acceptance:'给出意见'}});
    f.finish(first,'已邀请核对。');assert(f.store.detail(f.cid).messages.some(m=>m.content==='已邀请核对。'));
    const peer=f.run();assert.equal(f.store.contract(peer).itemEvidenceField,undefined);
    const child=f.store.obligations.context(peer)[0]!;
    f.tool(peer,'obligation_report',{obligationId:child.id,version:'v1',outcome:'passed',summary:'记录编号：PEER-33。个人判断。'});
    f.finish(peer,'我已回报。');const author=f.run();assert.equal(f.store.contract(author).itemEvidenceField,'refs');
    const deliver=(summary:string,key='delivery')=>f.tool(author,'obligation_deliver',{obligationId:root.id,summary},key);
    for(const body of [invalid,JSON.stringify([{refs:['OTHER-78']}]),JSON.stringify([{refs:['PEER-33']}]),JSON.stringify([{refs:['16:00']}])]){
      assert.throws(()=>deliver(body),/第 1 行/);assert.equal(f.read(root.id).state,'open');assert.equal(f.read(root.id).delivery,undefined);
    }
    assert.throws(()=>f.tool(author,'obligation_deliver',{obligationId:root.id,summary:good,publication:'reply'}),/JSON/);
    assert.equal(deliver(good).state,'delivery_pending');assert.equal(deliver(good).state,'delivery_pending');
    f.finish(author,'核对完毕');const o=f.read(root.id);
    assert.equal(o.state,'delivered');assert.equal(f.store.detail(f.cid).messages.filter(m=>m.content===good).length,1);
    assert(!f.store.detail(f.cid).messages.some(m=>m.content===invalid));
  } finally {f.owner.close();}
});

test('missing original evidence blocks by name, preserves the owner, and a user supplement is checked against the same root',async()=>{
  const f=fixture();
  try {
    f.ask();const first=f.run(),root=f.open(first),args={obligationId:root.id,missingEvidence:'缺少第二地点的登记。'};
    assert.throws(()=>f.tool(first,'obligation_deliver',{...args,summary:invalid}));
    const blocked=f.tool(first,'obligation_deliver',args,'gap');
    assert.equal(blocked.state,'blocked');assert.equal(blocked.owner.instanceId,root.owner.instanceId);assert.match(blocked.reason!,/第二地点/);
    assert.equal(f.tool(first,'obligation_deliver',args,'gap').revision,blocked.revision);f.finish(first,'原委托等待用户补充。');
    assert.equal(f.store.admitNext(),undefined);
    const retry={requestId:'recheck',decision:'retry' as const,expectedRevision:blocked.revision,reason:'记录编号：NEW-57 仅证实已收到申请。'};
    await f.store.obligations.decide(f.cid,root.id,retry);await f.store.obligations.decide(f.cid,root.id,retry);
    const author=f.run(),body=JSON.stringify([{item:'待核实',refs:['NEW-57']}]);
    assert.equal(f.store.contract(author).itemEvidenceField,'refs');
    f.tool(author,'obligation_deliver',{obligationId:root.id,summary:body});f.finish(author,'已交付。');
    assert.equal(f.read(root.id).state,'delivered');assert.equal(f.read(root.id).itemEvidenceSupplements?.length,1);
  } finally {f.owner.close();}
});

test('withdrawing the original public material between registration and release retains responsibility and withholds the body',()=>{
  const f=fixture();
  try{
    const source=f.ask(),first=f.run(),root=f.open(first),m=f.store.visibility.messages(f.cid).find(m=>m.sourceId===source.id)!;
    f.tool(first,'obligation_deliver',{obligationId:root.id,summary:good});
    f.store.visibility.put('cc_messages',{...m,deletedAt:new Date().toISOString()});f.finish(first,'结束。');
    assert.equal(f.read(root.id).state,'blocked');assert.equal(f.read(root.id).delivery?.messageId,undefined);
    assert(!f.store.detail(f.cid).messages.some(m=>m.content===good));
  } finally {f.owner.close();}
});

test('attachment content changes or private reuse invalidate the original material check',()=>{
  for(const mode of ['changed','restricted']) {
    const f=fixture();
    try {
      const s=f.ask();const first=f.run(),root=f.open(first);
      if(mode==='changed')f.store.db.prepare('UPDATE cc_attachment_contents SET content=? WHERE attachment_id=?').run('QZ-618-3 完全不同的内容',f.file.id);
      else{
        const user=f.store.visibility.messages(f.cid).find(m=>m.sourceId===s.id)!;
        f.store.visibility.put('cc_messages',{...user,visibility:{kind:'private',memberIds:['claude'],epoch:1}});
      }
      assert.throws(()=>f.tool(first,'obligation_deliver',{obligationId:root.id,summary:good}));
      assert.equal(f.read(root.id).state,'open');
    } finally{f.owner.close();}
  }
});

test('a formal whole handoff transfers the original requirement only after acceptance',()=>{
  const f=fixture();
  try{
    f.ask();const old=f.run(),root=f.open(old),t=f.store.tasks.getTask(root.taskId!);
    const offer=f.store.tasks.handoff(t.id,{requestId:'transfer',expectedRevision:t.revision,expectedOwnerRevision:t.ownerRevision,targetMemberId:'claude',reason:'请接着完成。'},old);
    f.finish(old,'已邀请交接。');const candidate=f.run();assert.equal(f.store.contract(candidate).itemEvidenceField,undefined);
    f.store.tasks.tool(candidate,'task_handoff_decide',{handoffId:offer.handoff.id,decision:'accept',reason:'接手。'},'accept');
    f.finish(candidate,'已接手。');const next=f.run();assert.equal(f.store.contract(next).itemEvidenceField,'refs');
    assert.throws(()=>f.tool(next,'obligation_deliver',{obligationId:root.id,summary:invalid}),/第 1 行/);
    f.tool(next,'obligation_deliver',{obligationId:root.id,summary:good});f.finish(next,'已汇报。');assert.equal(f.read(root.id).state,'delivered');
  } finally{f.owner.close();}
});

test('an unregistered valid direct table or progress reply stays ordinary; an invalid direct table gets one private correction opportunity',()=>{
  for(const body of [good,'我已收到材料。','[进度] 已邀请成员复核。',invalid]) {
    const f=fixture();
    try {
      f.ask();const first=f.run();f.finish(first,body);f.store.finish(first,'succeeded',body);
      if(body!==invalid){
        assert.equal(f.store.obligations.list(f.cid).length,0);assert(f.store.detail(f.cid).messages.some(m=>m.content===body));continue;
      }
      assert(!f.store.detail(f.cid).messages.some(m=>m.content===invalid));
      const root=f.store.obligations.list(f.cid)[0]!;assert.equal(root.owner.memberId,'codex');assert.equal(root.reminderCount,1);
      const author=f.run();assert.equal(f.store.contract(author).itemEvidenceField,'refs');
      f.finish(author,invalid);assert.equal(f.read(root.id).state,'blocked');assert.equal(f.store.admitNext(),undefined);
    } finally{f.owner.close();}
  }
});

test('an old source, quoted example, attachment instruction or private invitation does not enable the tool or change output',()=>{
  for(const mode of ['legacy','attachment','private','ordinary']){
    const f=fixture();
    try{
      const file=f.attachment(f.cid,request);
      const source=f.store.send(f.cid,{requestId:randomUUID(),content:mode==='ordinary'?'@Codex 输出 JSON 数组即可':mode==='attachment'?'@Codex 请阅读附件':request,
        ...(mode==='private'&&{privateTo:['codex']}),attachmentIds:[file.id]}).source;
      if(mode==='legacy'){delete source.itemEvidenceField;f.store.visibility.put('cc_sources',source);}
      const run=f.run(),contract=f.store.contract(run);assert.equal(contract.itemEvidenceField,undefined);
      const spec=runtimeTools(contract).find(t=>t.name==='obligation_deliver');
      assert(!spec||!JSON.stringify(spec.inputSchema).includes('missingEvidence'));
      f.finish(run,invalid);assert.equal(f.store.obligations.list(f.cid).length,0);
    } finally{f.owner.close();}
  }
});

const labelled='甲站：门牌需核对。\n北区 B-2：核对场地。\n交接单请只交付一个 JSON 数组，每项含 item（上述项目名）、status（现况）、refs（原始回执编号数组）。';
const names=['甲站','北区 B-2'];

test('only an explicit item label contract freezes a single unambiguous original list',()=>{
  assert.deepEqual(requestedItemNames(labelled),names);
  assert.deepEqual(requestedItemNames(labelled.replace('item（上述项目名）','item=上述项目名称')),names);
  assert.deepEqual(requestedItemNames(labelled.replace('item（上述项目名）','item（原样使用上文标签）')),names);
  assert.deepEqual(requestedItemNames('Return a JSON array. Each row includes item (the labels listed below), sources (a list of original document IDs).\n- Desk A: one.\n- Desk B: two.'),['Desk A','Desk B']);
  for(const text of [
    labelled.replace('上述项目名','项目名'),labelled.replace('上述项目名','上述项目'),
    labelled.replace('上述项目名','上述项目名称及说明'), labelled.replace('上述项目名','下列项目名'),
    labelled.replace('item（上述项目名）','item（描述）、other（上述项目名）'),
    labelled.replace('item（上述项目名）','spec.item（上述项目名）'),
    labelled.replace('甲站：','北区 B-2：'), '旧项：先前事项。\n\n'+labelled,
    labelled.replace('北区 B-2：','北区 B-2（旧）：'),'示例：\n'+labelled,
    labelled.split('\n').map(line=>'> '+line).join('\n'), '“'+labelled+'”','\x60\x60\x60\n'+labelled+'\n\x60\x60\x60',
    labelled.replace('item（上述项目名）','title').replace('。\n交接单','。\n请保留 item（上述项目名）。\n交接单'),
    labelled.replace('refs（原始回执编号数组）','refs（可选）'),
    labelled.replace('请只交付','不要交付')
  ])assert.equal(requestedItemNames(text),undefined,text);
});

test('published labels are exact strings; the returned owner may repair the same tool receipt once',()=>{
  const f=fixture();
  try{
    const ask=f.store.send(f.cid,{requestId:randomUUID(),content:'@Codex '+labelled.replace('甲站：','核对以下材料。\n甲站：'),attachmentIds:[f.file.id]}).source;
    assert.deepEqual(ask.itemNames,names);
    const first=f.run(),root=f.open(first);
    assert.deepEqual(f.store.contract(first).itemNames,names);
    assert.equal(f.store.prepareInput(first).manifest.renderVersion,'room-exact-item-names-v1');
    f.store.requestCollaboration(first,'check',{targets:['claude'],content:'请独立核对。',delivery:{obligationId:root.id,version:'v1',acceptance:'给出意见'}});
    f.finish(first,'已邀请核对。');
    const peer=f.run();assert.equal(f.store.contract(peer).itemNames,undefined);
    const child=f.store.obligations.context(peer)[0]!;
    f.tool(peer,'obligation_report',{obligationId:child.id,version:'v1',outcome:'passed',summary:'北区 B-2 已核对。'});f.finish(peer,'已回报。');
    const author=f.run();
    assert.deepEqual(f.store.contract(author).itemNames,names);
    const table=(keys:unknown[])=>JSON.stringify(keys.map(item=>({item,refs:['QZ-618-3']})));
    const deliver=(body:string)=>f.tool(author,'obligation_deliver',{obligationId:root.id,summary:body},'deliver');
    for(const [keys,error] of [
      [['甲站（门牌需核对）','北区 B-2'],/第 1 行/],[['甲站','北区 B-2 '],/第 2 行/],
      [['甲站','北区 b-2'],/第 2 行/],[['甲站','甲站'],/第 2 行重复/],[['甲站','北区 B-2','新增'],/第 3 行/],
      [[null,'北区 B-2'],/第 1 行/],[['北区 B-2'],/缺少.*甲站/],[[],/缺少/]
    ] as [unknown[],RegExp][]){
      assert.throws(()=>deliver(table(keys)),e=>e instanceof Error && error.test(e.message) && names.every(n=>e.message.includes(n)));
      assert.equal(f.read(root.id).state,'open');assert.equal(f.read(root.id).delivery,undefined);
    }
    const body=table([...names].reverse());
    assert.equal(deliver(body).state,'delivery_pending');assert.equal(deliver(body).state,'delivery_pending');
    f.finish(author,'交接单已整理。');
    assert.equal(f.read(root.id).state,'delivered');assert.equal(f.store.detail(f.cid).messages.filter(m=>m.content===body).length,1);
  }finally{f.owner.close();}
});

test('prior sources and attachment-only lists keep their original evidence-only contract',()=>{
  for(const old of [true,false]){
    const f=fixture();
    try{
      const attachment=f.attachment(f.cid,labelled+'\nG-37 已收到。');
      const source=f.store.send(f.cid,{requestId:randomUUID(),content:old?'@Codex 请核对。\n'+labelled:'@Codex '+labelled.split('\n').at(-1),attachmentIds:[attachment.id]}).source;
      if(old){assert.deepEqual(source.itemNames,names);delete source.itemNames;f.store.visibility.put('cc_sources',source);}
      const run=f.run();assert.equal(f.store.contract(run).itemEvidenceField,'refs');assert.equal(f.store.contract(run).itemNames,undefined);
      const root=f.open(run),body=JSON.stringify([{item:'自由标题',refs:['G-37']}]);
      f.tool(run,'obligation_deliver',{obligationId:root.id,summary:body});f.finish(run,'就绪。');assert.equal(f.read(root.id).state,'delivered');
    }finally{f.owner.close();}
  }
});
