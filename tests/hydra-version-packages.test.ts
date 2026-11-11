import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
    const change={requestId:randomUUID(),expectedRevision:p.revision,key:'venue',content:'东馆'};
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
    f.store.versionPackages.change(f.room.id,p.id,{requestId:randomUUID(),expectedRevision:p.revision,key:'venue',content:'东馆'});
    f.finish(f.id,'本次资料交付');assert.equal(f.store.obligations.list(f.room.id)[0]!.state,'blocked');
  }finally{f.close();}
});

test('a material change during manual acceptance reopens the original obligation once',()=>{
  const f=fixture(true);try {
    let p=f.open([{key:'map',label:'地图',dependsOn:['venue']}],[{key:'venue',name:'会场',content:'西馆'},{key:'other',name:'无关资料',content:'原件'}]);
    p=f.sign(f.submit(p,'map','西馆',[{key:'venue',versionId:p.materials[0]!.versionId}]),'map');p=f.publish(p);
    f.deliver();f.finish(f.id,'本次资料交付');assert.equal(f.store.obligations.list(f.room.id)[0]!.state,'awaiting_acceptance');
    const edition=p.edition!.id;
    p=f.store.versionPackages.change(f.room.id,p.id,{requestId:randomUUID(),expectedRevision:p.revision,key:'other',content:'其他材料改版'});
    assert.equal(p.edition!.id,edition);assert.equal(f.store.obligations.list(f.room.id)[0]!.state,'awaiting_acceptance');
    const change={requestId:randomUUID(),expectedRevision:p.revision,key:'venue',content:'改成东馆'};
    f.store.versionPackages.change(f.room.id,p.id,change);f.store.versionPackages.change(f.room.id,p.id,change);
    const o=f.store.obligations.list(f.room.id)[0]!;assert.equal(o.state,'open');assert.equal(o.delivery,undefined);
    assert(o.currentSourceId!==o.originSourceId);assert.equal(f.store.detail(f.room.id).sources.length,2);
    assert.equal(f.store.contract(f.run()).coordinationPolicy,'decision-material-v1');
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
    f.store.artifacts.decide(approval.id,{requestId:randomUUID(),decision:'reject',operationDigest:approval.operationDigest,expectedRevision:approval.revision});
    for (const v of [f.invoke('package_list',{}),f.invoke('package_submit',args,f.id,callId)]) {
      for(const secret of [doc.id,old,evidence,basis[0]!.versionId,'DERIVED_PRIVATE_TEXT','NEVER_SHOW_AFTER_WITHDRAWAL'])assert(!JSON.stringify(v).includes(secret),secret);
    }
    assert.equal(f.store.versionPackages.list(f.room.id)[0]?.parts[0]?.state,'unknown');
    assert.throws(()=>f.publish(p));
  }finally{f.close();}
});
