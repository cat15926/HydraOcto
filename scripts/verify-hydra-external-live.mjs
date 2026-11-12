// Node 24 --import tsx scripts/verify-hydra-external-live.mjs [--lost-receipt]
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {createApplication} from '../server/index.ts';
import {createCollaborationRuntime} from '../server/collaboration/runtime.ts';
import {isolatedClaude} from './hydra-test-native.mjs';
import {boothAdapter} from '../tests/fixtures/booth-operation-adapter.ts';

const lost=process.argv.includes('--lost-receipt'), maxCalls=lost?5:3;
const base=resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation');
await mkdir(base,{recursive:true,mode:0o700});
const dir=await mkdtemp(join(base,lost?'e09-loss-':'e09-normal-'));
const profile=join(dir,'profile'),workspace=join(dir,'workspace'),dataDir=join(dir,'service');
await Promise.all([profile,workspace].map(p=>mkdir(p,{mode:0o700})));
let app,url,cid='',unknown=lost;
const records=join(dir,'exhibition.sqlite');
const booth=boothAdapter(records,a=>a.conversationId===cid && a.memberId==='clerk',lost,()=>unknown);
const db=new DatabaseSync(records,{readOnly:true});
const proof={accepted:false,lost,maxCalls,calls:[],operators:[],snapshots:[],restarts:0};
const writes=()=>db.prepare('SELECT operation_id AS id,call_no AS attempt FROM reservation_calls ORDER BY call_no').all();
function snapshot() {
  const store=app.collaborationStore,detail=store.detail(cid);
  return {obligation:store.obligations.list(cid)[0],runs:detail.invocations.map(i=>({id:i.id,status:i.status,member:i.roomMember?.id,accepted:i.acceptance,teardown:i.teardown,nativeSessionId:i.nativeSessionId})),
    userMessages:detail.messages.filter(m=>m.author==='user').length,messages:detail.messages.filter(m=>m.author==='member').map(m=>({id:m.id,member:m.memberId,content:m.content.slice(0,2000)})),
    writes:writes(),consumptions:detail.consumptions};
}
async function waitUntil(description,ready) {
  const until=Date.now()+maxCalls*160000;
  while(Date.now()<until) {
    const s=snapshot(),bad=s.runs.find(r=>['failed','cancelled','interrupted'].includes(r.status));
    assert(!bad,description+': failed native execution '+bad?.id);
    if(ready(s))return s;
    if(s.obligation?.state==='blocked' && s.runs.every(r=>r.status==='succeeded') && s.obligation.externalOperation?.stage!=='unknown')
      throw Error(description+': '+s.obligation.reason);
    await delay(250);
  }
  throw Error('Timeout: '+description);
}
async function post(path,body) {
  const resp=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':app.csrfToken},body:JSON.stringify({requestId:randomUUID(),...body})});
  assert(resp.ok,'HTTP '+resp.status+' '+path);return resp.json();
}
try {
  const {selected,account}=await isolatedClaude(resolve(process.env.HYDRA_CONFIG_ROOT || '.'),profile);
  async function start() {
    const real=createCollaborationRuntime({timeoutMs:150000,privateRoots:[dataDir]});
    app=await createApplication({port:0,dataDir,workspace,externalOperations:booth.adapter,collaborationRuntime:{...real,async invoke(req) {
      assert(proof.calls.length<maxCalls,'native call limit');assert.equal(req.cwd,workspace);assert(!req.projectWork);
      const call={id:req.invocationId,tools:[]};proof.calls.push(call);
      return real.invoke({...req,async onToolCall(name,args,key) {
        const result=await req.onToolCall(name,args,key);call.tools.push(name);return result;
      }});
    }}});
    ({url}=await app.start());assert.notEqual(new URL(url).port,'4310');
  }
  await start();app.collaborationStore.saveAccount(account);
  app.collaborationStore.saveMember({id:'clerk',name:'向宁',instructions:'负责落实展会事项。请按用户要求办理，只依据正式账本回执报告结果。',carrier:'claude-cli',accountId:account.id,accountBinding:'override',modelBinding:'override',model:selected.model,enabled:true});
  cid=(await post('/api/conversations',{title:'秋展参展',memberIds:['clerk'],defaultMemberId:'clerk'})).conversation.id;
  proof.room=cid;
  const sent=await post('/api/conversations/'+cid+'/messages',{content:'@向宁 帮我预约秋展的 A12 展位，一次就好。请向我申请这笔授权，办好后告诉我预约回执编号。如果一时查不到，就先告诉我进展。'});
  proof.original=sent.source.id;
  const pending=await waitUntil('await one-object consent',s=>s.obligation?.externalOperation?.stage==='approval' && s.runs.every(r=>r.status==='succeeded'));
  assert.equal(pending.writes.length,0);proof.snapshots.push(pending);
  const o=pending.obligation,op=o.externalOperation,route='/api/conversations/'+cid+'/obligations/'+o.id+'/';
  assert.equal(op.target.title,booth.target.title);
  await post(route+'approve-external',{operationId:op.id,expectedRevision:o.revision});proof.operators.push('approve-external');
  if(lost) {
    const blocked=await waitUntil('owner reports uncertainty',s=>s.obligation?.state==='blocked' && s.obligation.externalOperation.stage==='unknown' && s.runs.every(r=>r.status==='succeeded' && r.teardown==='confirmed'));
    assert.equal(blocked.writes.length,1);assert(/未知|暂未|尚未|未能|还未|无法|待核|未取得|查不到|未查到/.test(blocked.messages.at(-1)?.content));assert.equal(blocked.obligation.owner.instanceId,o.owner.instanceId);
    const issueCall=proof.calls.find(call=>call.tools.includes('obligation_external_execute'));
    assert(issueCall && proof.calls.some(call=>call.id!==issueCall.id && call.tools.includes('obligation_external_lookup')));
    proof.snapshots.push(blocked);
    await app.close();app=undefined;unknown=false;await start();proof.restarts++;
    const revived=snapshot();assert.equal(revived.obligation.externalOperation.id,op.id);assert.equal(revived.writes.length,1);
    await post(route+'retry',{expectedRevision:revived.obligation.revision});proof.operators.push('query-original');
  }
  const done=await waitUntil('member delivers verified receipt',s=>s.obligation?.state==='delivered' && s.runs.every(r=>r.status==='succeeded'));
  assert.equal(done.userMessages,1);assert.equal(done.obligation.owner.instanceId,o.owner.instanceId);
  assert(done.runs.every(r=>r.accepted==='accepted' && r.teardown==='confirmed' && r.nativeSessionId));
  assert.equal(done.writes.length,1);assert.equal(done.writes[0].id,op.id);assert.equal(done.writes[0].attempt,1);
  const row=db.prepare('SELECT reservation_id AS receipt FROM reservations WHERE operation_id=?').get(op.id);
  assert.equal(done.obligation.externalOperation.receipt,row.receipt);
  assert(done.messages.find(m=>m.id===done.obligation.delivery.messageId)?.content.includes(row.receipt));
  proof.snapshots.push(done);proof.accepted=true;
} catch(error) {proof.error=String(error.message).slice(0,500);}
finally {
  if(app && cid && !proof.accepted)proof.snapshots.push(snapshot());
  await app?.close();db.close();booth.close();
  const report=join(dir,'result.json');await writeFile(report,JSON.stringify(proof,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({accepted:proof.accepted,calls:proof.calls.length,error:proof.error,report}));
}
if(!proof.accepted)process.exitCode=1;
