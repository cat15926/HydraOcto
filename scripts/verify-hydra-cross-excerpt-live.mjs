// Development evidence for scenario 08. Node 24 --import tsx, isolated data, max two paid calls.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedClaude } from './hydra-test-native.mjs';
import { createApplication } from '../server/index.ts';
import { createCollaborationRuntime } from '../server/collaboration/runtime.ts';

const output=process.env.VALIDATION_OUTPUT_DIR || tmpdir();await mkdir(output,{recursive:true,mode:0o700});
const dir=await mkdtemp(join(output,'hydra-disclosure-')),workspace=join(dir,'workspace'),profile=join(dir,'cli'),dataDir=join(dir,'service');
await mkdir(workspace,{mode:0o700});await mkdir(profile,{mode:0o700});
const digest=value=>createHash('sha256').update(value).digest('hex');
const marker=randomUUID().slice(0,8),email=marker+'@example.invalid',order='ORDER-'+marker;
const excerpt='现象：列表把 12 排在 2 前。解决步骤：按编号的数值排序。请用一句话写成帮助说明。';
const content='此为合成客服报告，请确认收到即可。用户 '+email+'，工单 '+order+'。'+excerpt;
const result={case:'08 / approved excerpts',cap:2,calls:[]};
let app,url,home,target,origin;
async function post(path,body) {
  const res=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':app.csrfToken},body:JSON.stringify({requestId:randomUUID(),...body})});
  assert(res.ok,'HTTP '+res.status+' '+path);return res.json();
}
async function settled(cid) {
  const end=Date.now()+150000;
  while(Date.now()<end) {
    const runs=app.collaborationStore.invocations(cid);assert(runs.length<=1);
    const run=runs[0];if(run && ['succeeded','cancelled','interrupted','failed'].includes(run.status)){
      assert.equal(run.status,'succeeded');assert.equal(run.acceptance,'accepted');assert.equal(run.teardown,'confirmed');assert(run.roomMember && run.nativeSessionId);return run;
    }await delay(150);
  }throw Error('Native invocation did not finish');
}
try {
  const {selected,account}=await isolatedClaude(resolve(process.env.HYDRA_CONFIG_ROOT||'.'),profile);
  const native=createCollaborationRuntime({timeoutMs:90000,privateRoots:[dataDir]});
  app=await createApplication({workspace,dataDir,port:0,collaborationRuntime:{...native,async invoke(req){
    assert(result.calls.length<result.cap);assert.equal(req.cwd,workspace);
    const entry={id:req.invocationId,room:req.conversationId,inputSha256:digest(req.prompt),tools:[]};result.calls.push(entry);
    if(req.conversationId===target){assert(req.prompt.includes(excerpt));for(const v of [email,order,origin.id,digest(content)])assert(!req.prompt.includes(v),'Private source metadata in recipient input');entry.approvedOnly=true;}
    return native.invoke({...req,async onToolCall(name,args,id){entry.tools.push(name);return req.onToolCall(name,args,id);}});
  }}});
  const s=app.collaborationStore;s.saveAccount(account);
  s.saveMember({id:'writer',name:'阿岚',carrier:selected.carrier,model:selected.model,accountId:account.id,modelBinding:'override',accountBinding:'override',enabled:true,instructions:'根据获准看见的资料回应房间里的请求。'});
  ({url}=await app.start());assert.notEqual(new URL(url).port,'4310');
  async function room(title){return (await post('/api/conversations',{title,memberIds:['writer'],defaultMemberId:'writer'})).conversation.id;}
  home=await room('客服');target=await room('帮助文档');
  await post('/api/conversations/'+home+'/messages',{content});const first=await settled(home);
  origin=s.detail(home).messages.find(m=>m.content===content);assert(origin);
  const cmd={requestId:randomUUID(),homeMemberId:'writer',targetConversationId:target,targetMemberId:'writer',refs:[{messageId:origin.id,revision:origin.revision??1,digest:digest(content),start:content.indexOf(excerpt),end:content.length}]};
  const path='/api/conversations/'+home+'/share-excerpts';
  const receipt=(await post(path,cmd)).result;assert.deepEqual((await post(path,cmd)).result,receipt);
  const second=await settled(target);assert.notEqual(first.nativeSessionId,second.nativeSessionId);assert.notEqual(first.roomMember.id,second.roomMember.id);
  const detail=s.detail(target);const answer=detail.messages.find(m=>m.author==='member');
  assert(answer&&/排序|数值|数字/.test(answer.content));for(const v of [email,order,origin.id])assert(!answer.content.includes(v));
  assert.equal(detail.invocations.length,1);assert.equal(s.cross.transfers().length,1);
  Object.assign(result,{passed:true,home,target,receipt,consumptions:detail.consumptions.map(({id,sourceId,responseId})=>({id,sourceId,responseId})),answer:answer.content,instances:[first.roomMember.id,second.roomMember.id]});
} catch(e){result.passed=false;result.error=String(e.message).slice(0,300);process.exitCode=1;}
finally{if(app)await app.close();const path=join(dir,'result.json');await writeFile(path,JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({passed:result.passed,path,error:result.error}));}
