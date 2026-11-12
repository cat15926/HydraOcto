import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Obligation } from '../shared/obligations.js';
import type { VersionPackageView } from '../shared/version-packages.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { Store } from '../server/store.js';

function fixture(userAccept=false) {
  const dir=mkdtempSync(join(tmpdir(),'versions-')),db=new Store(join(dir,'room.sqlite')),store=new CollaborationStore(db,{workspace:dir});
  const room=store.create({requestId:randomUUID(),title:'资料室',defaultMemberId:'codex',memberIds:['codex','claude']}).conversation;
  const run=()=>{
    const i=store.admitNext()!.invocations[0]!;store.startInvocation(i.id);store.recordEvidence(i.id,{kind:'accepted',detail:{source:'synthetic'}});return i.id;
  };
  const finish=(id:string,reply:string)=>{store.recordEvidence(id,{kind:'process_exit',detail:{confirmed:true}});store.finish(id,'succeeded',reply);};
  store.send(room.id,{requestId:randomUUID(),content:'准备活动资料。'+(userAccept?'最终由我确认。':'')});
  const id=run(),ob=(store.obligations.tool(id,'obligation_open',{goal:'形成资料包',...(userAccept&&{acceptance:'user'})},'root') as {obligation:Obligation}).obligation;
  const invoke=(tool:string,args:Record<string,unknown>,who=id,callId:string=randomUUID())=>store.versionPackages.tool(who,tool,args,callId) as VersionPackageView;
  const open=(parts:object[],materials:object[]=[{key:'venue',name:'地点',content:'西馆'}])=>invoke('package_open',{obligationId:ob.id,title:'活动资料',parts,materials});
  const submit=(pkg:VersionPackageView,key:string,content:string,basis?:{key:string;versionId:string}[],who=id)=>invoke('package_submit',{packageId:pkg.id,key,content,basis,expectedPartVersionId:pkg.parts.find(p=>p.key===key)?.versionId??null},who);
  const sign=(pkg:VersionPackageView,key:string,versionId?:string,who=id)=>invoke('package_review',{packageId:pkg.id,key,versionId:versionId??pkg.parts.find(p=>p.key===key)!.versionId,verdict:'accept',note:'核对版本的正文及依据。'},who);
  const publish=(p:VersionPackageView,who=id)=>invoke('package_publish',{packageId:p.id,expectedRevision:p.revision},who);
  const deliver=(who=id)=>store.obligations.tool(who,'obligation_deliver',{obligationId:ob.id,summary:'本次资料交付'},randomUUID());
  return {dir,db,store,room,id,ob,run,finish,invoke,open,submit,sign,publish,deliver,close(){db.close();rmSync(dir,{recursive:true,force:true});}};
}

test('venue changes preserve independent acceptance, late old review and new published package use different versions',()=>{
  const f=fixture();try {
    let p=f.open([{key:'map',label:'地图',dependsOn:['venue']},{key:'copy',label:'文案',dependsOn:['venue']},{key:'bio',label:'嘉宾简介',dependsOn:[]}]);
    const west=[{key:'venue',versionId:p.materials[0]!.versionId}];
    p=f.invoke('package_submit',{packageId:p.id,key:'bio',content:'讲师周老师',basis:[]});
    assert.throws(()=>f.invoke('package_submit',{packageId:p.id,key:'bio',content:'并发写',basis:[]}),/已有交付/);
    assert.throws(()=>f.invoke('package_submit',{packageId:p.id,key:'map',content:'路线',basis:west,expectedPartVersionId:west[0]!.versionId}),/首次提交/);
    p=f.invoke('package_submit',{packageId:p.id,key:'map',content:'书写西馆信息',basis:west,expectedPartVersionId:'null'});
    assert.throws(()=>f.invoke('package_submit',{packageId:p.id,key:'map',content:'并发写',basis:west,expectedPartVersionId:'null'}),/已有交付/);
    p=f.submit(p,'copy','书写西馆信息',west);
    p=f.sign(f.sign(p,'copy'),'bio');
    const bio=p.parts.find(x=>x.key==='bio')!,map=p.parts.find(x=>x.key==='map')!;
    assert.throws(()=>f.deliver(),/资料包/);
    const change={requestId:randomUUID(),expectedRevision:p.revision,expectedMaterialVersionId:p.materials.find(m=>m.key==='venue')!.versionId,key:'venue',content:'东馆'};
    p=f.store.versionPackages.change(f.room.id,p.id,change);
    assert.equal(f.store.versionPackages.change(f.room.id,p.id,change).revision,p.revision);
    p=f.sign(p,'map',map.versionId);
    assert.deepEqual(p.parts.map(x=>x.state),['needs_review','needs_review','accepted']);
    assert.equal(p.parts[0]!.history[0]?.verdict,'accept');assert.equal(p.parts[0]!.history[0]?.current,false);
    assert.deepEqual(p.parts.find(x=>x.key==='bio'),bio);
    assert.throws(()=>f.publish(p),/有效验收/);
    assert.throws(()=>f.submit(p,'map','东馆路线',[{key:'venue',versionId:'missing'}]),/不可核验/);
    const east=[{key:'venue',versionId:p.materials[0]!.versionId}];
    for(const k of ['map','copy'])p=f.sign(f.submit(p,k,'东馆核对正文',east),k);
    p=f.publish(p);assert.equal(p.edition!.parts.find(x=>x.key==='bio')!.reviewId,bio.evidenceId);
    assert.equal(f.store.versionPackages.deliveryProof(f.ob.id),p.edition!.id);
    f.deliver();f.finish(f.id,'本次资料交付');
    assert.equal(f.store.obligations.list(f.room.id)[0]!.state,'delivered');
    assert.throws(()=>f.store.versionPackages.change(f.room.id,p.id,{...change,requestId:randomUUID(),expectedRevision:p.revision}));
  }finally{f.close();}
});

test('a live writer can add exact references to an empty plan, and cannot label quoted material independent',()=>{
  const f=fixture();try {
    const old='秋枫厅a36c52',latest='海棠厅a36c52';
    let p=f.open(['notice','route','bio'].map(key=>({key,label:key,dependsOn:[]})),[{key:'location',name:'地点',content:old}]);
    const basis=[{key:'location',versionId:p.materials[0]!.versionId}];
    p=f.submit(p,'notice','欢迎来'+old,basis);
    assert.deepEqual(p.parts[0]!.dependsOn,['location']);
    assert.throws(()=>f.submit(p,'route','主入口直达'+old,[]),/完整材料原文/);
    assert.equal(f.store.versionPackages.list(f.room.id)[0]!.parts[1]!.state,'missing');
    p=f.submit(p,'route','主入口直达'+old,basis);
    p=f.sign(f.submit(f.sign(p,'notice'),'bio','青林，摄影师',[]),'bio');
    const bio=p.parts[2]!,route=p.parts[1]!;
    p=f.store.versionPackages.change(f.room.id,p.id,{requestId:randomUUID(),expectedRevision:p.revision,expectedMaterialVersionId:basis[0]!.versionId,key:'location',content:latest});
    assert.deepEqual(p.parts.map(x=>x.state),['needs_review','needs_review','accepted']);
    p=f.sign(p,'route',route.versionId);assert.equal(p.parts[1]!.history[0]?.current,false);
    assert.throws(()=>f.publish(p),/有效验收/);
    const fresh=[{key:'location',versionId:p.materials[0]!.versionId}];
    assert.throws(()=>f.submit(p,'route','主入口直达'+old,fresh),/完整材料原文/);
    assert.throws(()=>f.submit(p,'route','请咨询工作人员',[]),/不能省略/);
    for(const k of ['notice','route'])p=f.sign(f.submit(p,k,'新地址 '+latest,fresh),k);
    assert.deepEqual(p.parts[2],bio);assert.equal(f.publish(p).state,'published');
  }finally{f.close();}
});

test('legacy unexplained literal stays unresolved after changes, retains its receipt and can be corrected',()=>{
  const f=fixture();try{
    let p=f.open([{key:'card',label:'卡片',dependsOn:[]}]);
    p=f.sign(f.submit(p,'card','普通卡片',[]),'card');p=f.publish(p);
    const previous=p.parts[0]!,oldReceipt=previous.evidenceId!;
    // Re-create the exact old writer format. Old releases accepted a copied material under basis:[].
    const db=f.db.db,stored=JSON.parse(String(db.prepare('SELECT value FROM cc_version_packages WHERE id=?').get(p.id)!.value));
    const old=stored.parts[0].submissions[0];old.content='旧卡片指引：西馆';old.digest=createHash('sha256').update(old.content).digest('hex');
    delete old.literalMatches;delete old.incidentalMatches;delete old.reviews[0].confirmedIncidental;
    db.prepare('UPDATE cc_version_packages SET value=? WHERE id=?').run(JSON.stringify(stored),p.id);
    p=f.store.versionPackages.list(f.room.id)[0]!;
    assert.equal(p.parts[0]!.state,'unknown');assert.match(p.parts[0]!.reason!,/未说明/);
    assert.equal(p.parts[0]!.history[0]!.reviewId,oldReceipt);assert.equal(p.parts[0]!.history[0]!.current,false);
    assert.throws(()=>f.deliver(),/待核验/);assert.throws(()=>f.publish(p),/有效验收/);
    p=f.store.versionPackages.change(f.room.id,p.id,{requestId:randomUUID(),expectedRevision:p.revision,key:'venue',expectedMaterialVersionId:p.materials[0]!.versionId,content:'展厅2'});
    assert.equal(p.parts[0]!.state,'unknown');
    f.invoke('package_list',{packageId:p.id});
    p=f.sign(f.submit(p,'card','新指引：展厅2',[{key:'venue',versionId:p.materials[0]!.versionId}]),'card');
    assert.equal(p.parts[0]!.number,2);assert.equal(p.parts[0]!.history[0]!.reviewId,oldReceipt);
    assert.notEqual(f.publish(p).edition!.parts[0]!.reviewId,oldReceipt);
  }finally{f.close();}
});

test('coincidences require exact material and part identities, a reason, and a matching review',()=>{
  const f=fixture();try{
    let p=f.open([{key:'author',label:'署名',dependsOn:[]}],['place','series'].map(key=>({key,name:key,content:'A'})));
    const [place,series]=p.materials.map(({key,versionId})=>({key,versionId}));
    const submit=(matches:object[])=>f.invoke('package_submit',{packageId:p.id,key:'author',content:'Ada',basis:[],incidentalMatches:matches});
    assert.throws(()=>submit([]),/完整材料原文/);
    assert.throws(()=>submit([{...place,reason:'人名'}]),/完整材料原文/);
    assert.throws(()=>submit([{...place,versionId:series!.versionId,reason:'人名'}]),/不可核验/);
    p=submit([place!,series!].map(b=>({...b,reason:'Ada 是署名。'})));
    assert.equal(p.parts[0]!.incidentalMatches?.length,2);assert.throws(()=>f.sign(p,'author'),/逐项确认/);
    const approve={packageId:p.id,key:'author',versionId:p.parts[0]!.versionId,verdict:'accept',note:'核对人名与材料。'};
    assert.throws(()=>f.invoke('package_review',{...approve,confirmedIncidental:[place,place]}),/逐项确认/);
    assert.throws(()=>f.invoke('package_review',{...approve,versionId:place!.versionId,confirmedIncidental:[place,series]}),/不可核验/);
    p=f.invoke('package_review',{...approve,confirmedIncidental:[place,series]});const accepted=p.parts[0]!;
    p=f.store.versionPackages.change(f.room.id,p.id,{requestId:randomUUID(),expectedRevision:p.revision,key:'place',expectedMaterialVersionId:place!.versionId,content:'B'});
    assert.deepEqual(p.parts[0],accepted);assert.equal(f.publish(p).state,'published');
    const read=f.store.versionPackages.tool(f.id,'package_list',{packageId:p.id,materialRef:place},'read-old') as {material:{content:string}};
    assert.equal(read.material.content,'A');
    assert.throws(()=>f.invoke('package_list',{packageId:p.id,materialRef:{...series,versionId:place!.versionId}}),/不可用/);
  }finally{f.close();}
});

test('unknown basis is explicit, new executions must have received the cited material and actors are room scoped',()=>{
  const f=fixture();try {
    let p=f.open([{key:'plan',label:'路线计划',memberId:'claude'}]);
    assert.throws(()=>f.submit(p,'plan','wrong writer',[]),/约定的房间成员/);
    const writer=f.run(),basis=[{key:'venue',versionId:p.materials[0]!.versionId}];
    assert.throws(()=>f.submit(p,'plan','guessed',basis,writer),/先用 package_list/);
    f.invoke('package_list',{packageId:p.id},writer);
    p=f.submit(p,'plan','未声明依据',undefined,writer);assert.equal(p.parts[0]!.state,'unknown');
    assert.throws(()=>f.publish(p));
    p=f.submit(p,'plan','西馆路线',basis,writer);
    assert.throws(()=>f.sign(p,'plan',undefined,writer),/约定的房间成员/);
    f.invoke('package_list',{packageId:p.id});p=f.sign(p,'plan');assert.throws(()=>f.publish(p),/有效验收/);
    f.finish(writer,'完成资料');p=f.publish(p);assert.equal(p.state,'published');
    const other=f.store.create({requestId:randomUUID(),title:'隔离',defaultMemberId:'claude',memberIds:['claude']}).conversation;
    f.store.send(other.id,{requestId:randomUUID(),content:'读取会话资料'});const otherRun=f.run();
    assert.throws(()=>f.invoke('package_list',{packageId:p.id},otherRun),/不可用/);
    assert.deepEqual(f.invoke('package_list',{},otherRun),{packages:[]});
    assert(!JSON.stringify(f.store.visibility.observer(f.room.id)).includes(p.edition!.id));
  }finally{f.close();}
});

test('a change after delivery request but before settlement prevents the original obligation from closing',()=>{
  const f=fixture();try {
    let p=f.open([{key:'map',label:'路线',dependsOn:['venue']}]);
    p=f.submit(p,'map','西馆路线',[{key:'venue',versionId:p.materials[0]!.versionId}]);p=f.publish(f.sign(p,'map'));f.deliver();
    f.store.versionPackages.change(f.room.id,p.id,{requestId:randomUUID(),expectedRevision:p.revision,expectedMaterialVersionId:p.materials.find(m=>m.key==='venue')!.versionId,key:'venue',content:'东馆'});
    f.finish(f.id,'本次资料交付');assert.equal(f.store.obligations.list(f.room.id)[0]!.state,'blocked');
  }finally{f.close();}
});

test('a material change during manual acceptance reopens the original obligation once',()=>{
  const f=fixture(true);try {
    let p=f.open([{key:'map',label:'地图',dependsOn:['venue']}],[{key:'venue',name:'会场',content:'西馆'},{key:'other',name:'无关资料',content:'原件'}]);
    p=f.sign(f.submit(p,'map','西馆',[{key:'venue',versionId:p.materials[0]!.versionId}]),'map');p=f.publish(p);
    f.deliver();f.finish(f.id,'本次资料交付');assert.equal(f.store.obligations.list(f.room.id)[0]!.state,'awaiting_acceptance');
    const edition=p.edition!.id;
    p=f.store.versionPackages.change(f.room.id,p.id,{requestId:randomUUID(),expectedRevision:p.revision,expectedMaterialVersionId:p.materials.find(m=>m.key==='other')!.versionId,key:'other',content:'其他材料改版'});
    assert.equal(p.edition!.id,edition);assert.equal(f.store.obligations.list(f.room.id)[0]!.state,'awaiting_acceptance');
    const change={requestId:randomUUID(),expectedRevision:p.revision,expectedMaterialVersionId:p.materials.find(m=>m.key==='venue')!.versionId,key:'venue',content:'改成东馆'};
    f.store.versionPackages.change(f.room.id,p.id,change);f.store.versionPackages.change(f.room.id,p.id,change);
    const o=f.store.obligations.list(f.room.id)[0]!;assert.equal(o.state,'open');assert.equal(o.delivery,undefined);
    assert(o.currentSourceId!==o.originSourceId);assert.equal(f.store.detail(f.room.id).sources.length,2);
    const resume=f.run();
    assert.equal(f.store.contract(resume).coordinationPolicy,'decision-material-v1');
    const current=f.store.versionPackages.list(f.room.id)[0]!;
    const latest=current.materials.find(m=>m.key==='venue')!;
    const amend={packageId:p.id,key:latest.key,content:'东馆二楼',expectedRevision:current.revision,expectedMaterialVersionId:latest.versionId};
    assert.throws(()=>f.invoke('package_change',amend,resume),/先用 package_list/);
    f.invoke('package_list',{packageId:p.id},resume);
    assert.throws(()=>f.invoke('package_change',{...amend,expectedMaterialVersionId:change.expectedMaterialVersionId},resume),/材料基版/);
    assert.equal(f.invoke('package_change',amend,resume).materials.find(m=>m.key==='venue')?.content,'东馆二楼');
  }finally{f.close();}
});

test('assigned writer and reviewer act on separate notifications; package wait returns once to the exact root owner',()=>{
  const f=fixture();try {
    f.store.saveMember({...f.store.members().find(m=>m.id==='claude')!,id:'reader',name:'独立评审'});
    // Use a new room with the third member present at creation.
    const room=f.store.create({requestId:randomUUID(),title:'三人制作资料',defaultMemberId:'codex',memberIds:['codex','claude','reader']}).conversation;
    f.store.send(room.id,{requestId:randomUUID(),content:'制作交通说明，等评审后交付'});
    const root=f.run(),o=(f.store.obligations.tool(root,'obligation_open',{goal:'交付准确交通说明'},'root') as {obligation:Obligation}).obligation;
    let p=f.invoke('package_open',{obligationId:o.id,title:'交通',materials:[{key:'venue',name:'地点',content:'西馆'}],
      parts:[{key:'map',label:'路线',memberId:'claude',reviewerMemberId:'reader',dependsOn:['venue']}]},root);
    f.store.obligations.tool(root,'obligation_wait',{obligationId:o.id,kind:'event',condition:'package:'+o.id,deadline:new Date(Date.now()+60000).toISOString()},'wait');
    f.finish(root,'等审核');const writer=f.run();assert.equal(f.store.invocation(writer).memberId,'claude');
    f.invoke('package_list',{packageId:p.id},writer);
    p=f.submit(p,'map','去西馆',[{key:'venue',versionId:p.materials[0]!.versionId}],writer);
    f.finish(writer,'路线已登记');const reader=f.run();assert.equal(f.store.invocation(reader).memberId,'reader');
    f.invoke('package_list',{packageId:p.id},reader);p=f.sign(p,'map',undefined,reader);
    assert.equal(f.store.versionPackages.readyToReview(f.store.obligations.list(room.id)[0]!),false);
    f.finish(reader,'已独立验收');f.store.obligations.reconcile();f.store.obligations.reconcile();
    const resumed=f.run();assert.equal(f.store.invocation(resumed).memberId,'codex');
    p=f.publish(p,resumed);assert.equal(p.state,'published');
    const delivery={obligationId:o.id,summary:'路线资料可交付'};
    f.store.obligations.tool(resumed,'obligation_deliver',delivery,'deliver');f.finish(resumed,delivery.summary);
    assert.equal(f.store.obligations.list(room.id)[0]?.state,'delivered');
    assert.equal(f.store.invocations(room.id).length,4);assert.equal(f.store.admitNext(),undefined);
  }finally{f.close();}
});

test('rejected referenced artifact removes derived content, parent ids and receipts from member results including replay',()=>{
  const f=fixture();try {
    const doc=f.store.artifacts.propose(f.room.id,{requestId:randomUUID(),name:'依据.txt',content:'NEVER_SHOW_AFTER_WITHDRAWAL'}).version;
    let p=f.open([{key:'map',label:'路线',dependsOn:['venue']}],[{key:'venue',name:'地点',artifactVersionId:doc.id}]);
    const basis=[{key:'venue',versionId:p.materials[0]!.versionId}],callId=randomUUID();
    const args={packageId:p.id,key:'map',basis,content:'DERIVED_PRIVATE_TEXT',expectedPartVersionId:null};
    p=f.invoke('package_submit',args,f.id,callId);
    const old=p.parts[0]!.versionId!;p=f.sign(p,'map');const evidence=p.parts[0]!.evidenceId!;
    const approval=f.store.artifacts.detail(f.room.id).artifactApprovals.find(a=>a.id===doc.approvalId)!;
    const opened=p.materials[0]!;
    const base={key:opened.key,content:opened.content,expectedRevision:p.revision,expectedMaterialVersionId:opened.versionId};
    const ownerCmd={...base,requestId:randomUUID()}, signedCmd={...base,packageId:p.id}, signedCall=randomUUID();
    f.store.versionPackages.change(f.room.id,p.id,ownerCmd);
    f.invoke('package_change',signedCmd,f.id,signedCall);
    assert.throws(()=>f.store.versionPackages.change(f.room.id,p.id,{...ownerCmd,requestId:randomUUID(),expectedMaterialVersionId:undefined}),/基版/);
    f.store.artifacts.decide(approval.id,{requestId:randomUUID(),decision:'reject',operationDigest:approval.operationDigest,expectedRevision:approval.revision});
    const stored=f.db.db.prepare('SELECT version_id FROM cc_version_package_reads WHERE invocation_id=? AND package_id=?');
    const proofs=()=>stored.all(f.id,p.id).map(row=>String(row.version_id)).sort();
    const beforeProbe=proofs(), allowed=f.store.versionPackages.readableVersions(f.room.id,p.id);
    for (const captured of [opened.versionId,old,'meta:'+evidence,'meta:'+opened.versionId,'meta:'+old]) {
      assert(beforeProbe.includes(captured),'missing disclosure: '+captured);
      assert(!allowed.has(captured),'withdrawn disclosure: '+captured);
    }
    assert.deepEqual(proofs(),beforeProbe);assert.deepEqual(f.store.versionPackages.readableVersions('other-room',p.id),new Set());
    const cachedText=opened.content+' 已被用户编辑';
    assert.throws(()=>f.store.versionPackages.change(f.room.id,p.id,{...ownerCmd,requestId:randomUUID(),content:cachedText}),/不可读取/);
    assert.throws(()=>f.invoke('package_change',{...signedCmd,content:cachedText}),/不可读取/);
    assert.equal(f.store.versionPackages.list(f.room.id)[0]?.revision,p.revision);
    for (const v of [f.invoke('package_list',{}),f.invoke('package_submit',args,f.id,callId),f.invoke('package_change',signedCmd,f.id,signedCall),f.store.versionPackages.change(f.room.id,p.id,ownerCmd)]) {
      for(const secret of [doc.id,old,evidence,basis[0]!.versionId,'DERIVED_PRIVATE_TEXT','NEVER_SHOW_AFTER_WITHDRAWAL'])assert(!JSON.stringify(v).includes(secret),secret);
    }
    assert.equal(f.store.versionPackages.list(f.room.id)[0]?.parts[0]?.state,'unknown');
    assert.throws(()=>f.publish(p));
  }finally{f.close();}
});

for (const when of ['still-readable','before-plan','before-dispatch'] as const) {
  test('native package reader checks historical rights '+when,()=>{
    const f=fixture(true);
    try {
      const secret='ORIGINAL_RESTRICTED_TEXT', priorSession='historical-reader';
      const proposed=f.store.artifacts.propose(f.room.id,{requestId:randomUUID(),name:'地点.txt',content:secret});
      let pkg=f.open([{key:'bio',label:'嘉宾',dependsOn:[]}],[{key:'venue',name:'地点',artifactVersionId:proposed.version.id}]);
      pkg=f.publish(f.sign(f.submit(pkg,'bio','嘉宾简介',[]),'bio'));
      f.deliver();f.finish(f.id,'本次资料交付');
      const identity={supported:true,version:'fixture-1',fingerprint:'same-reader-and-account',reason:'test'};
      function admitReader(){
        f.store.send(f.room.id,{requestId:randomUUID(),content:'@claude 阅读会话资料'});
        const i=f.store.admitNext()!.invocations[0]!;
        assert.equal(i.memberId,'claude');
        return i.id;
      }
      f.store.saveMember({...f.store.members().find(m=>m.id==='claude')!,model:'fixture-model'});
      const first=admitReader();
      assert.equal(f.store.prepareSession(first,identity).mode,'fresh');
      f.store.startInvocation(first);
      f.store.recordEvidence(first,{kind:'session',detail:{nativeSessionId:priorSession,anchor:'first-turn',continuity:'fresh',historyVerified:true}});
      f.store.recordEvidence(first,{kind:'accepted',detail:{nativeSessionId:priorSession}});
      const read=f.store.versionPackages.tool(first,'package_list',{packageId:pkg.id},'read-current') as {packages:VersionPackageView[]};
      const original=read.packages[0]!.materials[0]!;
      assert.equal(original.content,secret);
      f.finish(first,'资料已读。');
      f.store.versionPackages.change(f.room.id,pkg.id,{requestId:randomUUID(),expectedRevision:pkg.revision,key:original.key,
        expectedMaterialVersionId:original.versionId,content:'现行公开地址'});
      const current=f.store.versionPackages.list(f.room.id)[0]!.materials[0]!;
      assert.notEqual(current.versionId,original.versionId);
      assert(current.history.some(v=>v.versionId===original.versionId));
      function withdrawOldSource(){
        f.store.artifacts.decide(proposed.approval.id,{requestId:randomUUID(),decision:'reject',
          operationDigest:proposed.approval.operationDigest,expectedRevision:proposed.approval.revision});
        assert(!f.store.versionPackages.readableVersions(f.room.id,pkg.id).has(original.versionId));
      }
      if(when==='before-plan')withdrawOldSource();
      const next=admitReader(), planned=f.store.prepareSession(next,identity);
      assert.equal(planned.mode,when==='before-plan'?'replace':'resume',planned.reason);
      assert.equal(planned.nativeSessionId,when==='before-plan'?undefined:priorSession);
      if(when==='before-dispatch')withdrawOldSource();
      const started=f.store.startInvocation(next);
      assert.equal(started.sessionPlan?.mode,when==='still-readable'?'resume':'replace');
      assert.equal(started.sessionPlan?.nativeSessionId,when==='still-readable'?priorSession:undefined);
      assert.equal(f.store.invocation(next).sessionPlan?.nativeSessionId,started.sessionPlan?.nativeSessionId);
      assert(!f.store.prompt(next).includes(secret));
    }finally{f.close();}
  });
}
