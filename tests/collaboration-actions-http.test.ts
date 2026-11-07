import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApplication } from '../server/index.js';
import type { RuntimeRequest } from '../shared/collaboration.js';
const rid=()=>randomUUID();
async function setup(){const root=await mkdtemp(join(tmpdir(),'n9-http-')),workspace=join(root,'project');await mkdir(workspace);const calls:RuntimeRequest[]=[];
 const app=await createApplication({port:0,dataDir:join(root,'private'),workspace,collaborationRuntime:{probe:async()=>[],invoke:async r=>{
  calls.push(r);r.onEvent({kind:'accepted',detail:{source:'synthetic-http'}});
  if(r.prompt.includes('HTTP_ACTION_TEST')){const listed=await r.onToolCall('action_list',{},'list') as any,a=listed.actions.find((a:any)=>a.executionId===r.invocationId);assert.ok(a);const v={actionId:a.id,expectedRevision:a.revision,expectedGeneration:a.generation};
   if(a.generation===1)await r.onToolCall('action_wait',{...v,condition:{kind:'signal',name:'HTTP ready'},deadline:new Date(Date.now()+60000).toISOString()},'wait');
   else {await assert.rejects(r.onToolCall('action_candidate',{...v,summary:'FORGED',invocationId:'other'},'bad'));await r.onToolCall('action_candidate',{...v,summary:'HTTP_VERIFIED_CANDIDATE'},'candidate');}
  }
  r.onEvent({kind:'process_exit',detail:{confirmed:true}});return {text:'SYNTHETIC_N9_REPLY',continuity:'fresh'};
 }}});const {url}=await app.start(),boot:any=await(await fetch(url+'/api/collaboration/bootstrap')).json();
 const api=async(path:string,body?:unknown,csrf=boot.csrfToken)=>{const r=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json() as any};};
 const home=(await api('/api/conversations',{requestId:rid(),title:'HTTP home',memberIds:['codex','claude'],defaultMemberId:'codex'})).data.conversation,target=(await api('/api/conversations',{requestId:rid(),title:'HTTP target',memberIds:['codex','claude'],defaultMemberId:'claude'})).data.conversation;
 const grant={requestId:rid(),homeMemberId:'codex',targetConversationId:target.id,targetMemberId:'claude',expiresAt:new Date(Date.now()+3600000).toISOString()};
 const until=async(fn:()=>boolean)=>{const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('N9 HTTP timeout');await new Promise(r=>setTimeout(r,20));}};
 return {app,api,boot,home,target,grant,calls,until,close:async()=>{await app.close();await rm(root,{recursive:true,force:true});}};
}
test('N9 HTTP: explicit grant, CSRF, cross-source delivery and revoke with no automatic success return',async()=>{const h=await setup();try{
 assert.equal(h.boot.version,'0.10.0-n9');const path=`/api/conversations/${h.home.id}`;
 assert.equal((await h.api(path+'/cross-grants',h.grant,'')).status,403);assert.equal(h.app.collaborationStore.cross.grants().length,0);
 const g=(await h.api(path+'/cross-grants',h.grant)).data.result;
 assert.equal((await h.api(path+'/cross-send',{requestId:rid(),grantId:g.id,content:'HTTP_CROSS_MARKER',memberId:'claude'})).status,400);
 const t=(await h.api(path+'/cross-send',{requestId:rid(),grantId:g.id,content:'HTTP_CROSS_MARKER'})).data.result;await h.until(()=>h.app.collaborationStore.invocations().some(i=>i.status==='succeeded'));
 assert.equal(h.calls.length,1);assert.equal(h.calls[0]!.conversationId,h.target.id);assert.match(h.calls[0]!.prompt,/HTTP_CROSS_MARKER/);const detail=(await h.api('/api/conversations/'+h.target.id)).data;assert.ok(detail.consumptions.some((c:any)=>c.sourceId===t.sourceId));
 assert.equal((await h.api(`/api/cross-grants/${g.id}/revoke`,{requestId:rid(),expectedRevision:99})).status,409);assert.equal((await h.api(`/api/cross-grants/${g.id}/revoke`,{requestId:rid(),expectedRevision:1})).status,200);
 assert.equal((await h.api(path+'/cross-send',{requestId:rid(),grantId:g.id,content:'No dispatch'})).status,409);assert.equal(h.calls.length,1);
}finally{await h.close();}});

test('N9 HTTP + engine: wait tool -> exact human signal -> one resumed generation -> candidate -> explicit verdict',async()=>{const h=await setup();try{
 const g=(await h.api(`/api/conversations/${h.home.id}/cross-grants`,h.grant)).data.result;
 const a=(await h.api(`/api/conversations/${h.home.id}/actions`,{requestId:rid(),grantId:g.id,title:'HTTP_ACTION_TEST',content:'Wait and produce candidate',completion:'human_acceptance'})).data.result;
 await h.until(()=>h.app.collaborationStore.actions.get(a.id).state==='waiting'&&!h.app.collaborationStore.actions.get(a.id).executionId);const w=h.app.collaborationStore.actions.waits()[0]!;assert.equal(h.calls.length,1);
 const signal={requestId:rid(),expectedRevision:w.revision,episode:w.episode,operation:'signal',name:'HTTP ready',eventId:'http-event-1'};
 assert.equal((await h.api(`/api/conditions/${w.id}/command`,signal,'')).status,403);assert.equal((await h.api(`/api/conditions/${w.id}/command`,signal)).status,200);assert.equal((await h.api(`/api/conditions/${w.id}/command`,signal)).status,200);
 await h.until(()=>h.app.collaborationStore.actions.get(a.id).state==='candidate'&&!h.app.collaborationStore.actions.get(a.id).executionId);
 assert.equal(h.calls.length,2);const current=h.app.collaborationStore.actions.get(a.id);assert.equal(current.generation,2);
 const verify={requestId:rid(),expectedRevision:current.revision,expectedGeneration:current.generation,operation:'verify',candidateId:current.candidateId};assert.equal((await h.api(`/api/actions/${a.id}/command`,verify)).status,200);
 const d=(await h.api('/api/conversations/'+h.home.id)).data;assert.equal(d.actions[0].state,'completed');assert.equal(d.actionVerdicts.length,1);assert.equal(d.conditionEvidence[0].authority,'human_signal');assert.equal(d.actionWaits[0].state,'fired');assert.equal(h.calls.length,2);
}finally{await h.close();}});
