import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { ProjectPreviews } from '../server/collaboration/project-preview.js';
import { ProjectBrowser } from '../server/collaboration/project-browser.js';
import { runtimeTools } from '../server/collaboration/runtime-common.js';

test('a browser receipt can only be replayed for its accepted run, same preview and unchanged grant',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'browser-grant-')),project=join(dir,'site');mkdirSync(project);
  const owner=new Store(join(dir,'db','platform.sqlite')),store=new CollaborationStore(owner,{projectWorkAvailability:()=>({available:true})});
  const previews=new ProjectPreviews(cid=>store.workbench.conversation(cid));
  try {
    const cid=store.create({title:'预览',memberIds:['codex'],defaultMemberId:'codex',requestId:randomUUID()}).conversation.id;
    const grant=store.workbench.previewWorkspace(cid,{path:project,mode:'project-work'});store.workbench.applyPreview({previewId:grant.id,requestId:randomUUID()},cid);
    store.projects.submit(cid,{content:'@Codex 核对当前预览的页面',requestId:randomUUID()});
    const run=store.admitNext()!.invocations[0]!,contract=store.contract(run.id);
    assert(runtimeTools(contract).some(t=>t.name==='project_browser_check'));
    assert(!runtimeTools({...contract,projectBrowser:undefined}).some(t=>t.name==='project_browser_check'));
    const steps=[{action:'expect',target:'已完成'}], idle=new AbortController().signal;
    const receipt={passed:true,asserted:true},state={status:'running' as const,id:'first',url:'http://preview-first.localhost:1234/.project-preview',logs:[]};
    previews.state=()=>({...state});
    const browser=new ProjectBrowser(store,previews,dir), invoke=()=>browser.check(run.id,{steps},'one',idle);
    await assert.rejects(invoke());
    store.startInvocation(run.id);store.recordEvidence(run.id,{kind:'accepted',detail:{source:'fixture'}});
    await assert.rejects(browser.check(run.id,{steps:[{action:'inspect',url:'http://example.invalid'}]},'bad',idle),/可见/);
    store.recordEvidence(run.id,{kind:'tool',detail:{origin:'project_browser',callId:'one',signature:createHash('sha256').update(JSON.stringify(steps)).digest('hex'),previewId:state.id,grantRevision:contract.workspaceGrant!.revision,result:receipt}});
    assert.deepEqual(await invoke(),receipt);
    state.id='replacement';await assert.rejects(invoke(),/失效/);
    store.workbench.revokeWorkspace(cid,store.workbench.conversation(cid).revision!,randomUUID());state.id='first';
    await assert.rejects(invoke());
  } finally { await previews.close();owner.close();rmSync(dir,{recursive:true,force:true}); }
});
