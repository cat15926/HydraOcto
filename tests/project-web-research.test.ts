import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {Store} from '../server/store.js';
import {CollaborationStore} from '../server/collaboration/store.js';
import {researchPublicWeb} from '../server/collaboration/project-research.js';
import {runtimeTools} from '../server/collaboration/runtime-common.js';

test('web source receipts belong to a live public grant; retries and late results cannot switch the source',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'web-source-')), project=join(dir,'project');mkdirSync(project);
  const owner=new Store(join(dir,'private','db.sqlite'));
  const store=new CollaborationStore(owner,{projectWorkAvailability:()=>({available:true})});
  try {
    const cid=store.create({title:'Web',memberIds:['codex'],defaultMemberId:'codex',requestId:randomUUID()}).conversation.id;
    const grant=store.workbench.previewWorkspace(cid,{path:project,mode:'project-work'});
    store.workbench.applyPreview({previewId:grant.id,requestId:randomUUID()},cid);
    store.projects.submit(cid,{content:'@Codex 这个页面是怎么解释的？',requestId:randomUUID()});
    const run=store.admitNext()!.invocations[0]!, contract=store.contract(run.id);
    assert.ok(!contract.projectWork && runtimeTools(contract).some(t=>t.name==='project_web_read'));
    assert.ok(!runtimeTools({...contract,webResearch:undefined}).some(t=>t.name==='project_web_read'));
    const uri='https://example.org/manual', body=JSON.stringify({url:uri,text:'verified fact'});
    const invoke=(id:string,args:Record<string,unknown>,signal:AbortSignal,fetcher:()=>Promise<string>)=>
      researchPublicWeb(store,run.id,'project_web_read',args,id,signal,s=>s,fetcher);
    const idle=new AbortController().signal;
    await assert.rejects(invoke('early',{url:uri},idle,async()=>body));
    store.startInvocation(run.id);store.recordEvidence(run.id,{kind:'accepted',detail:{source:'fixture'}});
    assert.deepEqual(await invoke('one',{url:uri},idle,async()=>body),JSON.parse(body));
    assert.deepEqual(await invoke('one',{url:uri},idle,async()=>{throw Error('replayed');}),JSON.parse(body));
    await assert.rejects(invoke('one',{url:'https://example.org/other'},idle,async()=>body));
    await assert.rejects(invoke('unreadable',{url:uri},idle,async()=>JSON.stringify({error:'页面不可读'})),/页面不可读/);
    const aborter=new AbortController(), cancelled=Promise.withResolvers<string>();
    const pending=invoke('cancel',{url:uri},aborter.signal,()=>cancelled.promise);
    aborter.abort();cancelled.resolve(JSON.stringify({text:'late body'}));await assert.rejects(pending);
    const revoked=Promise.withResolvers<string>(), late=invoke('revoke',{url:uri},idle,()=>revoked.promise);
    store.workbench.revokeWorkspace(cid,store.workbench.conversation(cid).revision!,randomUUID());
    revoked.resolve(JSON.stringify({text:'late body'}));await assert.rejects(late);
    assert.doesNotMatch(JSON.stringify(store.projectToolEvents(run.id,'project_web')),/late body/);
  } finally {owner.close();rmSync(dir,{recursive:true,force:true});}
});
