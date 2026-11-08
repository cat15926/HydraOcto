// Run against p03, a fresh database and a synthetic project. Only git mode can push, to the dedicated test repository.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,realpath,writeFile} from 'node:fs/promises';
import {basename,join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {createApplication} from '../server/index.ts';
import {createCollaborationRuntime} from '../server/collaboration/runtime.ts';
import {readProjectVm} from '../server/collaboration/project-vm.ts';
import {officialProjectNetworkEnv} from '../server/collaboration/project-official-network.ts';
import {acquireProjectVm} from '../server/collaboration/project-vm-mount.ts';

const [flag,member,scenario] = process.argv.slice(2);
assert(flag==='--live' && ['codex','claude'].includes(member) && ['search','read','git','pr'].includes(scenario));
const checkPr=scenario==='pr';
const gitScenario=checkPr || scenario==='git';
assert(!checkPr || member==='codex');
const vm=readProjectVm(resolve(process.env.ACCEPTANCE_VM_CONFIG || '.local-data/validation/native-project-p7/p03.json'));
assert(vm.instance==='p03' && vm.manageMount && basename(vm.hostRoot).startsWith('multi-agent-vm-project-'));
const mount=async()=>JSON.parse(await readFile(join(vm.limaHome,vm.instance,'lima.yaml'),'utf8')).mounts[0].location;
assert.equal(await mount(),vm.hostRoot);
const out=resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/native-project-p8/web-git-development/live');
await mkdir(out,{recursive:true,mode:0o700});
const folder=await mkdtemp(join(out,member+'-'+scenario+'-'));
const project=await mkdtemp(join(await realpath(vm.hostRoot),'web-git-'));
const original={path:vm.hostRoot,device:vm.device,inode:vm.inode,mode:'project-work',memberIds:[member],conversationId:'stage-restore',revision:1};
const repo='https://github.com/cat15926/multi-agent-collab-tools.git';
const exec=promisify(execFile);
const gitEnv=await officialProjectNetworkEnv({...process.env,GIT_TERMINAL_PROMPT:'0'});
const git=async(...args)=>(await exec('git',['-c','http.version=HTTP/1.1','--no-optional-locks','-c','core.hooksPath=/dev/null','-C',project,...args],{timeout:90000,env:gitEnv})).stdout.trim();
const filename=checkPr?'fixtures/multi-agent-delivery/amount.ts':'fixtures/p8-delivery-'+randomUUID()+'.txt',marker='DELIVERY-'+randomUUID();
const indexDigest=async()=>createHash('sha256').update(await readFile(join(project,'.git/index'))).digest('hex');
const stage=async()=>git('ls-files','--stage','-z');
let initialStage,app,invocations=0,attempted=false,restoring=false;
const proof={member,scenario,status:'failed',testRepository:gitScenario?repo:undefined,approvals:[]};
const originalCode='export function amountInCents(units: number): number {\n  return Math.round(units * 100);\n}\n';
const goodCode='// '+marker+'\n'+originalCode;
const redCode=goodCode.replace('return Math.round(units * 100);','return Math.abs(Math.round(units * 100));');

try {
  if(gitScenario) {
    await git('init','-q','-b','main');
    await git('remote','add','origin',repo); await git('fetch','--depth=1','origin','main'); await git('checkout','-q','-B','main','FETCH_HEAD');
    await mkdir(join(project,'fixtures'),{recursive:true});
    await writeFile(join(project,'user-draft.txt'),'staged from user'); await git('add','user-draft.txt');
    await writeFile(join(project,'user-draft.txt'),'unstaged from user');
    if(checkPr) assert.equal(await readFile(join(project,filename),'utf8'),originalCode);
    proof.base=await git('rev-parse','HEAD'); proof.index=await indexDigest();initialStage=await stage();
  }
  const claude=member==='claude',name=claude?'Claude Code':'Codex';
  process.env.CLAUDE_CONFIG_DIR=join(folder,'claude-home'); await mkdir(process.env.CLAUDE_CONFIG_DIR);
  const base=createCollaborationRuntime({projectVm:vm,timeoutMs:230000});
  app=await createApplication({port:0,workspace:join(folder,'default'),dataDir:join(folder,'db'),collaborationRuntime:{
    ...base,async invoke(req) {assert.equal(req.member.id,member);if(gitScenario) assert(req.gitDelivery); else assert(req.webResearch);
      restoring ||= req.projectWork===true;assert(++invocations<=(checkPr?2:1),'real invocation budget'); return base.invoke(req);}
  }});
  const store=app.collaborationStore,{url}=await app.start();
  const post=async(path,body)=>{
    const res=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':app.csrfToken},body:JSON.stringify(body)});
    const data=await res.json(); assert(res.ok,path+' '+JSON.stringify(data.error)); return data;
  };
  const acct=claude?{provider:'claude',auth:'api',apiKeyEnv:'COLLAB_GLM_API_KEY',baseUrl:'https://open.bigmodel.cn/api/anthropic'}:{provider:'codex',auth:'cli'};
  store.saveAccount({id:'accept',name, ...acct});
  store.saveMember({id:member,name,enabled:true,accountId:'accept',accountBinding:'override',modelBinding:'override',...(claude&&{model:'glm-5.3'}),
    carrier:claude?'claude-cli':'codex-app-server',instructions:'使用本轮可用的平台工具完成用户的请求，根据真实结果回答。'});
  const {conversation}=await post('/api/conversations',{title:'查证与交付验收',memberIds:[member],defaultMemberId:member,requestId:randomUUID()});
  const path='/api/conversations/'+conversation.id;
  const preview=await post(path+'/workspace-preview',{path:project,mode:'project-work'});
  await post(path+'/workspace-apply',{previewId:preview.id,requestId:randomUUID()});
  const task=scenario==='search'?'请上网用关键词“Node.js 官网”搜索，然后打开官网原文，核实它是否跨平台，给出来源链接。':
    scenario==='read'?'请直接读取 https://www.rfc-editor.org/rfc/rfc2606.txt ，在末页 Acknowledgement 中，哪个组织为 RFC Editor 提供资金？按原文英文作答并附来源链接。':
    checkPr?'在已授权的专用合成仓库验证 CI 退修。用原生 apply_patch 修改 '+filename+'。第一轮文件内容必须完全等于 '+JSON.stringify(redCode)+
      '（故意先触发负数回归）。仅用该文件提 PR 到 main，CI 失败就继续修。收到实际失败消息后，保留首行注释，恢复负数的符号，更新同一个 PR。请使用 project_git_deliver，等待我的每次确认。':
    '在本项目中用原生 apply_patch 文件工具新建 '+filename+'，只写一行 '+marker+'。将这个文件作为本次提交推送到测试仓库当前 main 分支，请发起可确认的推送请求。';
  const admission=await post(path+'/messages',{content:'@'+name+' '+task,requestId:randomUUID()}); assert(!admission.intent);
  let detail,run,approval;
  const deadline=Date.now()+(checkPr?840000:280000);
  while(Date.now()<deadline) {
    detail=store.detail(conversation.id);run=detail.invocations[0];
    const pending=detail.interactions.find(i=>i.gitDelivery && i.state==='pending');
    if(checkPr && pending) {
      const plan=pending.gitDelivery, previous=proof.approvals.at(-1);
      assert.equal(plan.remote,repo);
      assert.equal(plan.pull?.base,'main');
      assert.equal(plan.pull.repair,true);
      assert.equal(plan.branch,'codex/collab-'+(previous?.invocationId ?? pending.invocationId));
      assert.deepEqual(plan.files,[filename]);
      assert.equal(plan.parent,previous?.commit ?? proof.base);
      assert.equal(plan.pull.expectedHead,previous?.commit ?? null);
      assert.equal(await readFile(join(project,filename),'utf8'),previous?goodCode:redCode);
      if(previous) {
        assert.equal(proof.approvals.length,1);
        const first=detail.interactions.find(c=>c.id===previous.id);
        assert.equal(first.pullStatus?.state,'failed');
        assert.equal(first.pullStatus.commit,previous.commit);
        assert.equal(first.pullStatus.number,plan.pull.number);
        const failure=first.pullStatus.checks.find(c=>c.state==='failed' && c.url);
        assert(failure);
        const source=detail.sources.find(s=>s.id===first.repairSourceId);
        assert.equal(source?.parentInvocationId,previous.invocationId);
        assert(source.content.includes(failure.url));
        proof.failed=first.pullStatus;
      }
      assert.equal((await git('ls-remote','--refs',repo,'refs/heads/main')).split(/\s+/)[0],proof.base);
      const expected=previous?.commit ?? '';
      assert.equal((await git('ls-remote','--refs',repo,'refs/heads/'+plan.branch)).split(/\s+/)[0],expected);
      assert.equal(await stage(),initialStage);
      if (!proof.indexBeforeApproval) {
        proof.indexBeforeApproval=await indexDigest();
        await writeFile(join(folder,'before-first-approval.json'),JSON.stringify({index:proof.indexBeforeApproval,base:proof.base,staging:initialStage}),{flag:'wx',mode:0o600});
      }
      await post('/api/runtime-interactions/'+pending.id+'/answer',{requestId:randomUUID(),expectedRevision:pending.revision,payloadDigest:pending.payloadDigest,decision:'allow_once'});
      proof.approvals.push({id:pending.id,invocationId:pending.invocationId,branch:plan.branch,commit:plan.commit});
    }
    if(scenario==='git' && pending && !attempted) {
      const plan=pending.gitDelivery;
      assert.equal(plan.remote,repo); assert.equal(plan.branch,'main');assert.deepEqual(plan.files,[filename]);assert(plan.diff.includes(marker));assert.equal(plan.parent,proof.base);
      assert.equal((await git('ls-remote','--refs',repo,'refs/heads/main')).split(/\s+/)[0],proof.base);
      proof.indexBeforeApproval=await indexDigest();assert.equal(await stage(),initialStage);
      approval=pending.id;attempted=true;
      await post('/api/runtime-interactions/'+pending.id+'/answer',{requestId:randomUUID(),expectedRevision:pending.revision,payloadDigest:pending.payloadDigest,decision:'allow_once'});
      proof.approvedCommit=plan.commit;
    }
    if(checkPr) {
      const bad=detail.invocations.find(i=>['failed','interrupted','cancelled'].includes(i.status));
      if(bad) throw new Error('Project execution failed: '+bad.status+' '+(bad.error ?? ''));
      if(proof.approvals.length===2 && detail.invocations.every(i=>i.status==='succeeded' && i.teardown==='confirmed') &&
          detail.interactions.find(c=>c.id===proof.approvals[1].id)?.pullStatus?.state==='passed') break;
    } else if(run && !['prepared','running','cancel_requested'].includes(run.status)) break;
    await delay(300);
  }
  proof.invocation=run?.id;proof.runStatus=run?.status;proof.acceptance=run?.acceptance;proof.teardown=run?.teardown;
  proof.error=run?.error;
  proof.reply=detail.messages.filter(m=>m.author==='member' && m.memberId===member).at(-1)?.content;
  proof.events=detail.evidence.filter(e=>['project_git','git_file_change','project_web'].includes(e.detail.origin)).map(e=>e.detail);
  assert.deepEqual([run?.status,run?.acceptance,run?.teardown],['succeeded','accepted','confirmed']);
  if(checkPr) {
    assert.equal(invocations,2);
    assert.deepEqual(detail.invocations.map(i=>[i.acceptance,i.status,i.teardown]),Array(2).fill(['accepted','succeeded','confirmed']));
    assert.equal(proof.approvals.length,2);
    const [first,last]=proof.approvals;
    const green=detail.interactions.find(c=>c.id===last.id)?.pullStatus;
    assert.equal(green?.state,'passed');
    assert.equal(green.number,proof.failed.number);
    assert.equal(green.commit,last.commit);
    assert.notEqual(first.commit,last.commit);
    assert.equal(first.branch,last.branch);
    proof.passed=green;
    const receipts=proof.events.filter(e=>e.origin==='project_git' && e.state==='completed');
    assert.deepEqual(receipts.map(e=>e.commit),[first.commit,last.commit]);
    assert.equal((await git('ls-remote','--refs',repo,'refs/heads/main')).split(/\s+/)[0],proof.base);
    assert.equal((await git('ls-remote','--refs',repo,'refs/heads/'+last.branch)).split(/\s+/)[0],last.commit);
    const bare=join(folder,'verified.git');
    const inspect=async(...args)=>(await exec('git',['--git-dir='+bare,...args],{env:gitEnv,timeout:90000})).stdout;
    await exec('git',['init','--bare','-q',bare]);await inspect('fetch','--depth=3',repo,last.branch);
    assert.equal(await inspect('show',first.commit+':'+filename),redCode);
    assert.equal(await inspect('show',last.commit+':'+filename),goodCode);
    assert.equal((await inspect('rev-parse',last.commit+'^')).trim(),first.commit);
    for(const sha of [first.commit,last.commit]) assert.equal((await inspect('diff-tree','--no-commit-id','--name-only','-r',sha)).trim(),filename);
    assert.equal(await stage(),initialStage);
    assert.equal(proof.indexBeforeApproval,await indexDigest());
    assert.equal(await git('show',':user-draft.txt'),'staged from user');
    assert.equal(await readFile(join(project,'user-draft.txt'),'utf8'),'unstaged from user');
    proof.userStagingVerified=true;
  } else if(scenario==='git') {
    assert(approval); const receipt=proof.events.find(e=>e.origin==='project_git' && e.state==='completed');assert.equal(receipt?.commit,proof.approvedCommit);
    assert.equal((await git('ls-remote','--refs',repo,'refs/heads/main')).split(/\s+/)[0],proof.approvedCommit);
    proof.indexAfterPush=await indexDigest();
    assert.equal(await stage(),initialStage);
    const verification=join(folder,'remote-inspect');await mkdir(verification);
    const inspect=async(...args)=>(await exec('git',['-c','http.version=HTTP/1.1','-c','core.hooksPath=/dev/null','-C',verification,...args],{env:gitEnv,timeout:90000})).stdout.trim();
    await inspect('init','--bare','-q');await inspect('fetch','--depth=2',repo,'main');
    assert.equal(await inspect('show','FETCH_HEAD:'+filename),marker);
    assert.equal(await inspect('diff-tree','--no-commit-id','--name-only','-r',proof.approvedCommit),filename);
    assert.equal(await git('show',':user-draft.txt'),'staged from user');assert.equal(await readFile(join(project,'user-draft.txt'),'utf8'),'unstaged from user');
    assert.equal(proof.indexBeforeApproval,proof.indexAfterPush,'approval and delivery must leave the index byte-for-byte intact');
    proof.userStagingVerified=true;
  } else {
    const reads=proof.events.filter(e=>e.name==='project_web_read' && e.state==='completed');
    if(scenario==='search') assert(proof.events.some(e=>e.name==='project_web_search' && e.state==='completed' && e.result.results.length));
    const read=reads.find(e=>scenario==='search'?new URL(e.result.url).hostname==='nodejs.org':e.result.url==='https://www.rfc-editor.org/rfc/rfc2606.txt');
    assert(read,'expected original source');
    assert(proof.reply?.includes(read.result.url),'reply must cite the actual source');
    assert((scenario==='read'?/Internet Society/i:/跨平台|cross.platform/i).test(proof.reply));
    assert((scenario==='read'?/Internet Society/i:/跨平台|cross.platform/i).test(read.result.text));
  }
  proof.status='passed';
} catch(error) { proof.failure=String(error.message).slice(0,450);process.exitCode=1; }
finally {
  await app?.close();
  if(restoring && await mount() !== vm.hostRoot) {
    const lease=await acquireProjectVm(vm,original,AbortSignal.timeout(180000));await lease.release(true);
  }
  proof.realInvocations=invocations;proof.mountRestored=!restoring || await mount()===vm.hostRoot;
  await writeFile(join(folder,'result.json'),JSON.stringify(proof,null,2)+'\n',{mode:0o600});
  console.log(proof.status,proof.failure ?? '',join(folder,'result.json')); if(!proof.mountRestored)process.exitCode=1;
}
