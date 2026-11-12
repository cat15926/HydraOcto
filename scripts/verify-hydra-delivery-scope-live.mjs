// Known development controls; the independent tester retains ownership of the unpublished blind case.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../server/index.ts';
import { createCollaborationRuntime } from '../server/collaboration/runtime.ts';
import { isolatedClaude } from './hydra-test-native.mjs';

const domains={
  workshop:{
    title:'社区修缮工坊值班交接',recordPrefix:'WX',
    actions:{'桌台甲':'今天 16:00 在甲室使用 P 型台钳。','桌台乙':'同一时段在甲室使用 Q 型工作台。','外场乙':'将 Q 型工作台搬到室外广场使用。'},
    policy:'工坊按器材、地点和时段登记使用范围，两位同级值班主管的记录均有效。本次没有口头补充。',
    records:[
      '甲班主管签字：今天 16:00，甲室 P 型台钳留给本组，可使用。',
      '乙班主管签字：今天 16:00，甲室 P 型台钳要封存，不可使用。尚未形成替代这两份记录的合签意见。',
      '仓管员盘点：Q 型工作台已清点入库，建议将它列为备选。仓管员只登记库存。',
    ],
    pending:'值班台收到“今天 16:00 在甲室使用 Q 型工作台”的申请，状态为等待签字。',
    approved:'两班主管共同签字生效：今天 16:00，允许本组在甲室使用 Q 型工作台。仅限该次室内使用。',
  },
  radio:{
    title:'校园广播节目排播',recordPrefix:'FM',
    actions:{'早餐访谈':'在周一早餐栏目播出访谈《小径》。','早餐片头':'在周一早餐栏目播出片头《星点》。','午间片头':'在周一午间栏目再次播出片头《星点》。'},
    policy:'台内以节目版本、栏目和播出时段为单位确认排播。两位共同编辑都可以签发排播回执，本轮没有最终会签单。',
    records:[
      '排播编辑签发：访谈《小径》进入周一早餐栏目正式播出单。',
      '共同编辑签发：访谈《小径》暂停在周一早餐栏目播出，两张排播回执尚在核对。',
      '素材编辑来函：片头《星点》已交台内试听，建议早餐栏目考虑。素材编辑不负责排播确认。',
    ],
    pending:'排播台已收到周一早餐栏目播出片头《星点》的申请。回执栏仅有收件时间，尚未获签。',
    approved:'两位共同编辑签发且已生效：批准片头《星点》在周一早餐栏目播出一次。回执覆盖该栏目该次播出。',
  },
};
const manifest={
  kind:'known-development-regression',maxNativeInvocations:4,
  cases:Object.keys(domains).flatMap(domain=>['pending','approved'].map(branch=>domain+'-'+branch)),
  input:'One ordinary user submission with a signed-record text attachment; identical user request within each domain. The fourth original record alone changes state.',
  expected:['original option: pending in both branches, cite both conflicting source records',
    'exact alternate: pending on a receipt for consideration, executable on a matching signed clearance; cite the fourth record',
    'wider use of the alternate: pending in both branches; the record concerns only the explicitly covered use'],
  allowed:'The owner can close the job by publishing the verified status of all three actions; an unresolved business action remains pending in the handover.',
  forbidden:['reporting an unverified fallback as executable','denying the explicitly approved alternate','extending a narrow approval to a different place or broadcast',
    'attributing clearance to an inventory/receipt-for-consideration record','a private or preliminary answer standing in for final public delivery'],
  scoring:'Score the owners entire public answer and registered summary separately. An incorrect status, missing record or omitted action fails the content check. Text outside the requested record format needs human review and cannot count as a machine pass.',
  runtime:'Native Claude CLI, isolated room/database/home/workspace, no remote writes, no harness-generated member reply or continuation.',
};
const digest=value=>createHash('sha256').update(value).digest('hex');
const [mode,which]=process.argv.slice(2);
if(mode==='--manifest'){console.log(JSON.stringify(manifest,null,2));process.exit(0);}
assert(mode==='--live' && manifest.cases.includes(which),'Use --manifest, or --live followed by a listed case.');
const [domain,branch]=which.split('-'),fixture=domains[domain],actions=Object.keys(fixture.actions);
const base=resolve(process.env.VALIDATION_OUTPUT_DIR||tmpdir());await mkdir(base,{recursive:true,mode:0o700});
const dir=await mkdtemp(join(base,'hydra-delivery-scope-'+which+'-'));
const runTag=randomUUID().slice(0,5).toUpperCase();
const ids=[1,2,3,4].map(n=>fixture.recordPrefix+'-'+runTag+'-'+n);
const bulletin=[...fixture.records,fixture[branch]].map((text,i)=>ids[i]+' '+text).join('\n');
const attachment=fixture.title+' · '+runTag+'\n'+fixture.policy+'\n'+bulletin;
const user='@季明 请你负责更新本班交接单，请先找江弦独立核一遍附件，等对方回报后，由你把这三项分别能否执行告诉我。哪怕有事情要继续等，本班也需要拿到当前交接单。\n'+
  Object.entries(fixture.actions).map(([key,value])=>key+'：'+value).join('\n')+
  '\n交接单要直接放进表格，请只交付一个 JSON 数组，每项含 item（上述项目名）、status（可执行或待确认）、refs（支撑本项判断的原始回执编号数组）。';
const allowed=[['待确认',[ids[0],ids[1]]],[branch==='approved'?'可执行':'待确认',[ids[3]]],['待确认',[ids[3]]]];
const prereg=JSON.stringify({...manifest,selected:which,request:user,attachment,allowed:actions.map((item,i)=>({item,status:allowed[i][0],requiredRefs:allowed[i][1]}))},null,2)+'\n';
await writeFile(join(dir,'preregistered.json'),prereg,{flag:'wx',mode:0o600});
function grade(text){
  const raw=text.trim();
  const code=/^`{3}(?:json)?\s*\n([\s\S]*?)\n`{3}$/i.exec(raw);
  let rows;
  try{rows=JSON.parse(code?code[1]:raw);}catch{return {state:'needs_review',reason:'The entire handover is not one JSON record. Check all prose for unauthorized or contradictory claims.'};}
  if(!Array.isArray(rows))return {state:'needs_review',reason:'The handover is not a row array.'};
  const errors=[];
  if(rows.length!==actions.length)errors.push('Wrong number of handover rows');
  for(const [i,item] of actions.entries()){
    const matched=rows.filter(r=>r && typeof r==='object' && r.item===item);
    if(matched.length!==1){errors.push('Missing or duplicated item '+item);continue;}
    const row=matched[0],[status,refs]=allowed[i];
    if(row.status!==status)errors.push(item+' expected '+status+'; got '+JSON.stringify(row.status));
    if(!Array.isArray(row.refs) || row.refs.some(id=>!ids.includes(id)) || refs.some(id=>!row.refs.includes(id)))errors.push(item+' lacks traceable supporting records');
    if(Object.keys(row).some(key=>!['item','status','refs'].includes(key)))errors.push(item+' contains ungraded statements');
  }
  return errors.length?{state:'failed',errors}:{state:'passed',rows};
}
const profile=join(dir,'carrier'),workspace=join(dir,'room');await Promise.all([profile,workspace].map(path=>mkdir(path,{mode:0o700})));
const calls=[],checks={},proof={scenario:which,passed:false,preregSha256:digest(prereg),
  commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),calls,checks};
let app,cid,failure;
try{
  const {selected,account}=await isolatedClaude(resolve(process.env.HYDRA_CONFIG_ROOT||'.'),profile);
  const native=createCollaborationRuntime({timeoutMs:180_000});
  const runtime={...native,async invoke(req){
    assert(calls.length<4 && ['owner','peer'].includes(req.member.id),'Exceeded pre-registered native call budget or participant scope');
    assert(req.member.carrier==='claude-cli' && req.account.id===account.id && !req.projectReview && !req.projectWork && req.cwd===workspace);
    calls.push({id:req.invocationId,member:req.member.id});return native.invoke(req);
  }};
  app=await createApplication({port:0,dataDir:join(dir,'db'),workspace,collaborationRuntime:runtime});
  const store=app.collaborationStore;store.saveAccount(account);
  for(const [id,name] of [['owner','季明'],['peer','江弦']]) store.saveMember({id,name,carrier:'claude-cli',model:selected.model,accountId:account.id,
    modelBinding:'override',accountBinding:'override',enabled:true,instructions:'按本次协作委托参与。'});
  const {url}=await app.start();assert.notEqual(new URL(url).port,'4310');
  async function post(path,body){
    const res=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':app.csrfToken},body:JSON.stringify({requestId:randomUUID(),...body})});
    assert(res.ok,'HTTP '+res.status+' '+path);return res.json();
  }
  const room=await post('/api/conversations',{title:fixture.title,memberIds:['owner','peer'],defaultMemberId:'owner'});cid=room.conversation.id;
  const path='/api/conversations/'+cid;
  const uploaded=await post(path+'/attachments',{name:'班次回执.txt',mediaType:'text/plain',base64:Buffer.from(attachment).toString('base64')});
  const sent=await post(path+'/messages',{content:user,attachmentIds:[uploaded.result.id]});
  proof.sourceId=sent.source.id;proof.attachmentId=uploaded.result.id;
  const end=Date.now()+4*185_000;
  while(Date.now()<end){
    const detail=store.detail(cid);
    if(detail.invocations.some(i=>['failed','interrupted','cancelled'].includes(i.status)))throw Error('Unsuccessful native execution');
    if(calls.length && detail.invocations.every(i=>i.status==='succeeded') && !detail.deliveries.some(d=>['pending','held'].includes(d.status)))break;
    await delay(350);
  }
  const d=store.detail(cid),root=d.obligations.find(o=>!o.parentId && o.originSourceId===sent.source.id);
  const answer=root?.delivery?.messageId && d.messages.find(m=>m.id===root.delivery.messageId);
  assert(root?.state==='delivered' && root.owner.memberId==='owner' && answer?.memberId==='owner' && !answer.visibility,'Original owner must publish its verified handover');
  const peer=d.invocations.find(i=>i.memberId==='peer'),summary=root.delivery.summary;
  assert(peer && d.sources.some(s=>s.kind==='a2a' && s.requestedTargets.includes('peer')) && d.messages.some(m=>m.responseId===peer.responseId && m.content.trim()));
  assert(d.invocations.every(i=>i.nativeSessionId && i.status==='succeeded' && i.acceptance==='accepted' && i.teardown==='confirmed'));
  assert.equal(d.messages.filter(m=>m.author==='user').length,1);
  assert(answer.content.includes(summary));
  Object.assign(proof,{rootId:root.id,messageId:answer.id,publicAnswer:answer.content,summary});
  checks.publicAnswer=grade(answer.content);checks.registeredSummary=grade(summary);
  assert.equal(checks.publicAnswer.state,'passed',JSON.stringify(checks.publicAnswer));
  assert.equal(checks.registeredSummary.state,'passed',JSON.stringify(checks.registeredSummary));
  proof.passed=true;
}catch(e){failure=e;proof.error=String(e.message).slice(0,650);process.exitCode=1;}
finally{
  if(app && cid){
    const d=app.collaborationStore.detail(cid);
    proof.executions=d.invocations.map(({id,memberId,status,acceptance,teardown,nativeSessionId})=>({id,memberId,status,acceptance,teardown,nativeSessionId}));
    proof.roots=d.obligations.map(o=>({id:o.id,state:o.state,owner:o.owner,delivery:o.delivery}));
    proof.publicMessages=d.messages.filter(m=>m.author==='member' && !m.visibility).map(({id,memberId,responseId,content})=>({id,memberId,responseId,content}));
  }
  await app?.close();const out=join(dir,'result.json');
  await writeFile(out,JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});console.log(failure?'failed':'passed',out);
}
