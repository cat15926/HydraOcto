import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {join} from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { runtimeTools } from '../server/collaboration/runtime-common.js';

function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'p3-export-')));
  const source=join(root,'project'), dest=join(root,'destination'), path='月报.csv', buf=Buffer.from('订单,金额\n样例,13\n');
  mkdirSync(source);mkdirSync(dest);writeFileSync(join(source,path),buf);
  const owner=new Store(join(root,'private','export.sqlite'));
  const store=new CollaborationStore(owner,{workspace:source,projectWorkAvailability:()=>({available:true})});
  const cid=store.create({title:'项目导出',memberIds:['codex'],defaultMemberId:'codex',requestId:randomUUID()}).conversation.id;
  const preview=store.workbench.previewWorkspace(cid,{path:source,mode:'project-work'});
  store.workbench.applyPreview({previewId:preview.id,requestId:randomUUID()},cid);
  store.projects.submit(cid,{content:'@Codex 生成月报文件，再导出月报。',requestId:randomUUID()});
  const id=store.admitNext()!.invocations[0]!.id;
  store.startInvocation(id);
  const service=store.projectExports;
  const accept=()=>store.recordEvidence(id,{kind:'accepted',detail:{source:'test'}});
  const request=()=>service.request(id,{path},'export-1');
  const pick=()=>{const e=request();return service.pick(cid,e.id,e.revision,dest);};
  return {id,cid,store,owner,service,root,source,dest,path,buf,accept,request,pick,close(){owner.close();rmSync(root,{recursive:true,force:true});}};
}
const digest=(data:Buffer)=>createHash('sha256').update(data).digest('hex');

test('P3 export: precise active project capability, native picker, once-only disk receipt and original tool delivery',async()=>{
  const h=fixture();
  try{
    const name='project_export_request';
    const contract=h.store.contract(h.id);
    assert(runtimeTools(contract).some(t=>t.name===name));
    assert(!runtimeTools({...contract,mayExportProjectFile:undefined}).some(t=>t.name===name));
    assert(!runtimeTools({...contract,projectWork:undefined}).some(t=>t.name===name));
    assert.throws(h.request);
    h.accept();
    const result=h.service.tool(h.id,{path:h.path},'export-1',new AbortController().signal);
    const e=h.request(); assert.equal(e.state,'pending');assert.equal(e.sha256,digest(h.buf));assert.deepEqual(readdirSync(h.dest),[]);
    assert.throws(()=>h.service.decide(h.cid,e.id,{expectedRevision:e.revision,payloadDigest:e.payloadDigest,decision:'allow',requestId:randomUUID()}));
    const picked=h.service.pick(h.cid,e.id,e.revision,h.dest);
    assert.equal(picked.targetPath,join(h.dest,h.path));
    assert.deepEqual(readdirSync(h.dest),[]);
    assert.throws(()=>h.service.pick('wrong-conversation',e.id,picked.revision,h.dest));
    const command={expectedRevision:picked.revision,payloadDigest:picked.payloadDigest,decision:'allow' as const,requestId:randomUUID()};
    const allowed=h.service.decide(h.cid,e.id,command);
    assert.equal(allowed.export.state,'written');assert.equal(allowed.replayed,false);
    assert.deepEqual(readFileSync(join(h.dest,h.path)),h.buf);
    const receipt=await result;
    assert.deepEqual(receipt,{id:e.id,fileName:h.path,state:'written',executor:'platform',sha256:digest(h.buf),bytes:h.buf.length});
    rmSync(join(h.dest,h.path));
    assert.equal(h.service.decide(h.cid,e.id,command).replayed,true);
    assert.equal(existsSync(join(h.dest,h.path)),false);
    assert.throws(()=>h.service.decide(h.cid,e.id,{...command,requestId:randomUUID()}));
  }finally{h.close();}
});

test('P3 export: decline, expired, cancelled, changed binding and unknown-after-restart never repeat the host copy',()=>{
  for(const event of ['decline','expired','cancel','revoke','recover','input'] as const){
    const h=fixture();
    try{
      h.accept();const e=h.pick();
      const command={expectedRevision:e.revision,payloadDigest:e.payloadDigest,decision:'allow' as const,requestId:randomUUID()};
      if(event==='decline')assert.equal(h.service.decide(h.cid,e.id,{...command,decision:'decline'}).export.state,'declined');
      if(event==='expired')h.owner.db.prepare("UPDATE cc_project_exports SET value=json_set(value,'$.expiresAt',?) WHERE id=?").run(new Date(0).toISOString(),e.id);
      if(event==='cancel')h.store.cancel(h.id);
      if(event==='revoke')h.store.workbench.revokeWorkspace(h.cid,h.store.workbench.conversation(h.cid).revision!,randomUUID());
      if(event==='recover')h.owner.db.prepare("UPDATE cc_project_exports SET value=json_set(value,'$.state','writing') WHERE id=?").run(e.id);
      if(event==='input')h.owner.db.prepare("UPDATE cc_responses SET value=json_set(value,'$.inputRevision',99) WHERE invocation_id=?").run(h.id);
      h.service.recover();
      assert.throws(()=>h.service.decide(h.cid,e.id,{...command,requestId:randomUUID()}));
      const state=h.service.list(h.cid)[0]!.state;
      assert.equal(state,event==='recover'?'unknown':event==='decline'?'declined':event==='expired'?'expired':'cancelled',event);
      assert.deepEqual(readdirSync(h.dest),[]);
    }finally{h.close();}
  }
});

test('P3 export: neither replacing source/selected folder nor creating target in the meantime redirects or overwrites the copy',()=>{
  for(const event of ['source','source-identity','folder','target','target-symlink'] as const){
    const h=fixture();
    try{
      h.accept();const e=h.pick(), target=join(h.dest,h.path), sentinel=join(h.root,'sentinel');writeFileSync(sentinel,'untouched');
      if(event==='source')writeFileSync(join(h.source,h.path),'different bytes');
      if(event==='source-identity'){renameSync(join(h.source,h.path),join(h.source,'old'));writeFileSync(join(h.source,h.path),h.buf);}
      if(event==='folder'){renameSync(h.dest,h.dest+'-before');mkdirSync(h.dest);}
      if(event==='target')writeFileSync(target,'user file');
      if(event==='target-symlink')symlinkSync(sentinel,target);
      const r=h.service.decide(h.cid,e.id,{expectedRevision:e.revision,payloadDigest:e.payloadDigest,decision:'allow',requestId:randomUUID()});
      assert.equal(r.export.state,'failed',event);assert.equal(readFileSync(sentinel,'utf8'),'untouched');
      if(event==='target')assert.equal(readFileSync(target,'utf8'),'user file');
      if(event==='folder')assert.deepEqual(readdirSync(h.dest+'-before'),[]);
      if(!event.startsWith('target'))assert.deepEqual(readdirSync(h.dest),[]);
    }finally{h.close();}
  }
});

test('P3 export: safe ordinary text and destination only; stale picker and wrong digest cannot authorize',()=>{
  const h=fixture();
  try{
    h.accept();
    writeFileSync(join(h.source,'AGENTS.md'),'test');linkSync(join(h.source,h.path),join(h.root,'hard.csv'));
    assert.throws(h.request);rmSync(join(h.root,'hard.csv'));
    for(const path of ['../月报.csv','.git/notes.txt','AGENTS.md','code.sh','code.sh.txt','CMakeLists.txt']) assert.throws(()=>h.service.request(h.id,{path},'invalid'));
    symlinkSync(join(h.source,h.path),join(h.source,'alias.txt'));
    assert.throws(()=>h.service.request(h.id,{path:'alias.txt'},'symlink'));
    const e=h.request();
    const hidden=join(h.root,'.secret');mkdirSync(hidden);
    for(const folder of [hidden,h.source,join(h.root,'private')]) assert.throws(()=>h.service.pick(h.cid,e.id,e.revision,folder));
    const p=h.service.pick(h.cid,e.id,e.revision,h.dest);
    assert.throws(()=>h.service.pick(h.cid,e.id,e.revision,h.dest));
    assert.throws(()=>h.service.decide(h.cid,e.id,{expectedRevision:p.revision,payloadDigest:e.payloadDigest,decision:'allow',requestId:randomUUID()}));
    assert.deepEqual(readdirSync(h.dest),[]);
  }finally{h.close();}
});
