// Run --fixture for a deterministic integration check, or --live with HYDRA_CONFIG_ROOT pointing to the configured installation.
import assert from 'node:assert/strict';
import { createHash, randomUUID, randomInt } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { createApplication } from '../server/index.ts';
import { createCollaborationRuntime } from '../server/collaboration/runtime.ts';

const mode=process.argv[2];
assert(process.argv.length===3 && ['--fixture','--live','--check-config'].includes(mode));
const live=mode==='--live', maxCalls=4;
let model='synthetic', account;
if(mode!=='--fixture') {
  const root=resolve(process.env.HYDRA_CONFIG_ROOT||'.');
  const db=new DatabaseSync(join(root,'.local-data/platform.sqlite'),{readOnly:true});
  try {
    const member=JSON.parse(db.prepare('SELECT value FROM cc_members WHERE id=?').get('claude').value);
    model=member.model;account=JSON.parse(db.prepare('SELECT value FROM cc_accounts WHERE id=?').get(member.accountId).value);
    assert(member.enabled && member.carrier==='claude-cli' && model && account.auth==='api' && account.provider==='claude' &&
      account.apiKeyEnv==='COLLAB_GLM_API_KEY' && account.baseUrl==='https://open.bigmodel.cn/api/anthropic' && !account.deletedAt);
  } finally {db.close();}
  const config=parseEnv(await readFile(join(root,'.env'),'utf8'));
  for (const name of [account.apiKeyEnv,'COLLAB_CLAUDE_PATH']) if(!process.env[name] && config[name]) process.env[name]=config[name];
  assert(process.env[account.apiKeyEnv]);
}
if(mode==='--fixture') account={id:'fixture-api',name:'合成账户',provider:'claude',auth:'api',apiKeyEnv:'HYDRA_PERSONAL_FIXTURE_KEY',baseUrl:'http://127.0.0.1:1'};
if(mode==='--check-config') {console.log(JSON.stringify({model,carrier:'claude-cli',maxCalls}));process.exit(0);}
const base=resolve(process.env.VALIDATION_OUTPUT_DIR||tmpdir());
await mkdir(base,{recursive:true,mode:0o700});
const dir=await mkdtemp(join(base,'hydra-personal-'));
const work=join(dir,'workspace'), profile=join(dir,'native'), dataDir=join(dir,'service');
await mkdir(work,{mode:0o700});await mkdir(profile,{mode:0o700});
process.env.CLAUDE_CONFIG_DIR=profile;
const seal='SEAL_'+randomUUID().replaceAll('-',''), subject=['青枫','白杨','赤杉'][randomInt(3)];
const expressionOptions=['青枫','白杨','赤杉'].map(name=>'我建议再听'+name+'解释昨晚的选择。');
const expression=expressionOptions.find(text=>text.includes(subject));
const unused=expressionOptions.filter(text=>text!==expression);
const hash=s=>createHash('sha256').update(s).digest('hex');
const native=live?createCollaborationRuntime({timeoutMs:100000,privateRoots:[dataDir]}):undefined;
const start=Date.now(), deadline=start+480000, calls=[];
let app,url,phase='private',issued={},note='',activeRoom='',otherRoom='',failure;
const proof={mode,model,maxCalls,authorizedExpression:expression,checks:[],calls};
function protectedValues(){return [seal,issued.factorId,issued.expressionId,note,...unused].filter(Boolean);}
function foreignSecrets(){return [...protectedValues(),expression];}
function clean(data,label,restricted=protectedValues()){
  const text=JSON.stringify(data);
  assert(restricted.every(token=>!text.includes(token)), label+' contains protected material');
}
async function turn(req){
  assert(calls.length<maxCalls && Date.now()<deadline,'Call budget');
  assert(req.member.id==='seer' && req.cwd===work && !req.projectWork && !req.projectReview);
  const record={phase,invocation:req.invocationId,promptDigest:hash(req.prompt),tools:[]};calls.push(record);
  const privateTurn=phase==='private'||phase==='recover';
  const seen=[];
  const observe=async(name,args,id)=>{
    const result=await req.onToolCall(name,args,id);
    const raw=JSON.stringify(result);seen.push(raw);record.tools.push(name);
    if (!privateTurn) clean([args,result],'tool data',phase==='foreign'?foreignSecrets():protectedValues());
    if(name==='member_expression_select') {
      assert.equal(phase,'private');assert.equal(args.observationId,issued.factorId);
      assert.equal(expressionOptions[args.choice-1],expression,'Member selected the wrong expression');
      assert(result.expressionId);issued.expressionId=result.expressionId;record.selectedChoice=args.choice;
    }
    if(name==='member_note_write' && phase==='private')note=args.content;
    return result;
  };
  if(!privateTurn)clean(req.prompt,'public/foreign native input',phase==='foreign'?foreignSecrets():protectedValues());
  const fixture=async()=>{
    req.onEvent({kind:'accepted',detail:{origin:'test'}});
    let state;
    if(phase==='foreign' && !req.memberContextMode)await assert.rejects(observe('member_context_read',{},'read'));
    else state=await observe('member_context_read',{},'read');
    let text;
    if(phase==='private') {
      const observation=state.factors.find(f=>f.kind==='observation');
      const checkedName=observation.content.match(/复核对象是(.*?)。/)[1];
      const choice=observation.expressionOptions.findIndex(text=>text.includes(checkedName))+1;
      await observe('member_expression_select',{observationId:observation.id,choice},'choice');
      await observe('member_note_write',{content:'下轮复核印记 '+seal,parentIds:[issued.factorId]},'note');
      text='已记下私密核对结果。';
    }else if(phase==='recover')text=JSON.stringify(state).includes(seal)?seal:'没有记录';
    else if(phase==='public')text=expression;
    else text='房间中还没有观察记录。';
    req.onEvent({kind:'process_exit',detail:{confirmed:true}});
    return {text,continuity:'fresh'};
  };
  let result;
  try {
    result=live?await native.invoke({...req,onToolCall:observe,onEvent(event){
      if(event.kind==='diagnostic' && ['private_member_tools','member_expression_tools','project_review_tools'].includes(event.detail?.observation)) record.advertisedTools=event.detail.tools;
      req.onEvent(event);
    }}):await fixture();
  } catch(error) {record.error=String(error.message).replaceAll(seal,'[private]').slice(0,240);throw error;}
  const material=[req.prompt,...seen].join('\n');
  if(privateTurn){
    assert(material.includes(seal),'Private reader did not receive its observation');
    if(phase==='private'){assert(issued.expressionId,'Missing member-selected expression');assert(note && note.includes(seal),'Missing member-authored private note');}
    if(phase==='recover')assert(material.includes(note) && result.text.includes(seal),'Note did not survive restart');
  }else if(phase==='public') {
    assert(material.includes(expression) && result.text.includes(subject),'Public writer did not use the authorized expression');
    clean(result.text,'public speech');
  } else {clean(material,'foreign material',foreignSecrets()); clean(result.text,'foreign response',[...foreignSecrets(),subject]);}
  return result;
}
async function boot(){
  app=await createApplication({dataDir,workspace:work,port:0,collaborationRuntime:{...(native||{probe:async()=>[]}),invoke:turn}});
  url=(await app.start()).url;assert.notEqual(new URL(url).port,'4310');
}
async function post(path,body){
  const r=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':app.csrfToken},body:JSON.stringify({requestId:randomUUID(),...body})});
  assert(r.ok, 'HTTP '+r.status+' '+path);return r.json();
}
async function get(path){const r=await fetch(url+path);assert(r.ok,'HTTP '+r.status+' '+path);return r.json();}
async function send(cid,body){
  const s=app.collaborationStore,last=s.invocations(cid).length;
  await post('/api/conversations/'+cid+'/messages',body);
  while(Date.now()<deadline){
    const run=s.invocations(cid)[last];
    if(run && ['failed','succeeded','interrupted','cancelled'].includes(run.status)){
      assert.equal(run.status,'succeeded','Runtime did not finish in phase '+phase+' ('+(run.error??run.status)+')');
      assert.equal(run.acceptance,'accepted');assert.equal(run.teardown,'confirmed');
      const row=calls.find(c=>c.invocation===run.id);
      if(live){assert(run.nativeSessionId,'Missing native session');row.nativeSessionId=run.nativeSessionId;}
      row.status=run.status;row.acceptance=run.acceptance;row.teardown=run.teardown;return;
    }
    await delay(80);
  }
  throw Error('Timed out in '+phase);
}
async function surfaces(cid,preSpeech){
  const prefix='/api/conversations/'+cid;
  const limits=[...protectedValues(),...(preSpeech?[expression]:[])];
  const publicView=await get(prefix+'/observer');
  clean(publicView,'observer',limits);
  for (const path of [prefix+'/factors',prefix+'/factors?viewer=player',prefix+'?viewer=player',prefix+'/export?viewer=player',
    '/api/collaboration/search?q='+encodeURIComponent('查验')+'&viewer=player&conversationId='+cid]) clean(await get(path),path,limits);
  return publicView;
}
try{
  await boot();
  const store=app.collaborationStore;
  if(account)store.saveAccount(account);
  for(const [id,name] of [['seer','阿岚'],['player','同伴']])store.saveMember({id,name,carrier:'claude-cli',model,
    ...(account?{accountId:account.id,accountBinding:'override',modelBinding:'override'}:{}),instructions:'根据本次会话获准使用的资料回答。',enabled:true});
  const room=async title=>(await post('/api/conversations',{title,memberIds:['seer','player'],defaultMemberId:'seer'})).conversation.id;
  activeRoom=await room('山间小镇');otherRoom=await room('独立演练');
  const path='/api/conversations/'+activeRoom;
  const before=await get(path+'/observer');
  issued=await post(path+'/factors/issue',{memberId:'seer',content:'本轮夜间查验的复核对象是'+subject+'。内部核对词 '+seal+'。',expressionOptions});
  assert(issued.factorId && !issued.expressionId);
  const afterIssue=await surfaces(activeRoom,true);
  assert.deepEqual(afterIssue,before,'Registering a private fact changed observer response');
  await send(activeRoom,{content:'请读取个人资料，根据本轮查验对象，从允许公开的几种观点中自行判断最合适的一项，用 member_expression_select 登记。再用 member_note_write 把你自己的下一步计划存成一条私密笔记，写入查验中完整的内部核对词。完成这两项后，私下只需说已记录。',privateTo:['seer']});
  assert.deepEqual(await surfaces(activeRoom,true),before,'Private exchange changed public counts or records');proof.checks.push('private selection and work note hidden, chosen expression unpublished');
  await app.close();app=undefined;
  await rename(profile,profile+'-before-restart');await mkdir(profile,{mode:0o700});
  await boot();phase='recover';
  await send(activeRoom,{content:'请从自己的工作记录恢复刚才的笔记，私下只回答其中完整的内部核对词。',privateTo:['seer']});
  await surfaces(activeRoom,true);proof.checks.push('restored member note with no original CLI profile');
  phase='public';await send(activeRoom,{content:'请读取本轮获准公开使用的个人材料，向大家说出你建议重点听谁解释，只表达你的观点。'});
  assert(JSON.stringify(await surfaces(activeRoom,false)).includes(subject),'Public speech missing');proof.checks.push('public speech without restricted proof or note');
  phase='foreign';await send(otherRoom,{content:'请只根据本房间的个人工作记录，说明是否有夜间查验；没有记录就简短说明。'});
  await surfaces(otherRoom,true);proof.checks.push('same template in another room isolated');
  if(live)assert.equal(new Set(calls.slice(0,3).map(c=>c.nativeSessionId)).size,3,'Secret was carried across independent sessions');
  await post(path+'/factors/revoke',{factorId:issued.factorId});
  for (const endpoint of ['/factors?viewer=seer','/factors','/observer'])clean(await get(path+endpoint),'revoked scope');
  proof.checks.push('revocation preserves only already-delivered public speech');
  proof.passed=true;
}catch(e){failure=e;proof.passed=false;proof.error=String(e.message).replaceAll(seal,'[private]').slice(0,400);}
finally{
  if(app)await app.close();
  await writeFile(join(dir,'result.json'),JSON.stringify(proof,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({passed:proof.passed,report:join(dir,'result.json'),calls:calls.length,error:proof.error}));
}
if(failure)process.exitCode=1;
