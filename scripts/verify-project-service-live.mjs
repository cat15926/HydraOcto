// Use p03, a disposable project, a fresh DB and a loopback port. --vm runs without a model.
import {request as httpRequest} from 'node:http';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,realpath,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createApplication} from '../server/index.ts';
import {createCollaborationRuntime} from '../server/collaboration/runtime.ts';
import {readProjectVm} from '../server/collaboration/project-vm.ts';
import {acquireProjectVm} from '../server/collaboration/project-vm-mount.ts';

const live=process.argv[2]==='--live', browserCheck=['browser','browser-codex'].includes(process.argv[3]), claude=process.argv[3]==='browser';
assert(live || process.argv[2]==='--vm');
const vm=readProjectVm(resolve(process.env.ACCEPTANCE_VM_CONFIG || '.local-data/validation/native-project-p7/p03.json'));
assert.equal(vm.instance,'p03');assert(vm.manageMount);
const mount=async()=>JSON.parse(await readFile(join(vm.limaHome,vm.instance,'lima.yaml'),'utf8')).mounts[0].location;
assert.equal(await mount(),vm.hostRoot);
const root=resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/project-service/development');
await mkdir(root,{recursive:true,mode:0o700});
const out=await mkdtemp(join(root,'check-')), project=await mkdtemp(join(await realpath(vm.hostRoot),'dev-service-'));
const marker=randomUUID(), manifest={name:'preview-fixture',version:'1.0.0',scripts:{dev:'node service.cjs'}};
await writeFile(join(project,'package.json'),JSON.stringify(manifest));
await writeFile(join(project,'package-lock.json'),JSON.stringify({name:manifest.name,version:'1.0.0',lockfileVersion:3,packages:{'':{name:manifest.name,version:'1.0.0'}}}));
const server=`const http=require('node:http');let value='';
const page=()=>'<html><meta charset="utf-8"><h1>项目验收</h1><label>备注<input></label><button>保存</button><p>'+value+'</p><small>'+MARKER+'</small><script>document.querySelector("button").onclick=async()=>{await fetch("/save",{method:"POST",body:document.querySelector("input").value});location.reload()}</script></html>';
http.createServer((r,s)=>{if(r.method==='POST' && r.url==='/save'){r.on('data',b=>value=b.toString().replace(/[^A-Za-z0-9-]/g,'').slice(0,64));r.on('end',()=>s.end('ok'));}else{s.setHeader('Content-Type','text/html; charset=utf-8');s.end(page())}}).listen(Number(process.env.PORT),'127.0.0.1');`;
await writeFile(join(project,'service.cjs'),'const MARKER='+JSON.stringify(marker)+';\n'+server);
let calls=0,app;
const proof={status:'failed',live,browserCheck};
try {
  if(live && claude) {process.env.CLAUDE_CONFIG_DIR=join(out,'claude-home');await mkdir(process.env.CLAUDE_CONFIG_DIR,{mode:0o700});}
  const runtime=createCollaborationRuntime({projectVm:vm,timeoutMs:180000});
  app=await createApplication({port:0,workspace:join(out,'default'),dataDir:join(out,'db'),collaborationRuntime:{...runtime,
    async invoke(request) {assert(live);assert.equal(request.member.id,claude?'claude':'codex');assert.equal(++calls,1);return runtime.invoke(request);}}});
  const {url}=await app.start(),store=app.collaborationStore;
  const post=async(path,body)=>{const r=await fetch(url+path,{method:'POST',headers:{'x-csrf-token':app.csrfToken,'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();assert(r.ok,path+' '+JSON.stringify(v));return v;};
  const member=claude?'claude':'codex',name=claude?'Claude Code':'Codex';
  store.saveAccount(claude?{id:'user',name,provider:'claude',auth:'api',apiKeyEnv:'COLLAB_GLM_API_KEY',baseUrl:'https://open.bigmodel.cn/api/anthropic'}:{id:'user',name,provider:'codex',auth:'cli'});
  store.saveMember({...store.members().find(m=>m.id===member),accountId:'user',accountBinding:'override',...(claude&&{model:'glm-5.3',modelBinding:'override'})});
  const {conversation:c}=await post('/api/conversations',{title:'开发服务验收',memberIds:[member],defaultMemberId:member,requestId:randomUUID()});
  const path='/api/conversations/'+c.id, target=path+'/project-preview';
  const preview=await post(path+'/workspace-preview',{path:project,mode:'project-work'});
  await post(path+'/workspace-apply',{previewId:preview.id,requestId:randomUUID()});
  const request=content=>post(path+'/messages',{content:'@'+name+' '+content,requestId:randomUUID()});
  if(live && !browserCheck) await request('请把这个项目的开发服务跑起来，我要打开本轮页面。使用项目服务工具，收到已发起的回执后结束本轮。');
  else await post(target+'/start',{mode:'service',grantRevision:store.workbench.conversation(c.id).workspaceGrant.revision,previousId:null});
  const read=async()=>(await fetch(url+target)).json();
  let state;
  for(let i=0;i<600;i++) {
    state=await read();
    if(['running','failed','stopped'].includes(state.status))break;
    await delay(500);
  }
  assert.equal(state.status,'running',JSON.stringify(state));
  proof.instance=state.id; proof.snapshot=state.snapshot;proof.logs=state.logs;
  const parsed=new URL(state.url), http='http://127.0.0.1:'+parsed.port;
  const local=(path,init={})=>new Promise((resolve,reject)=>{
    const req=httpRequest(http+path,{method:init.method||'GET',headers:{host:parsed.host,...init.headers},agent:false,signal:AbortSignal.timeout(15000)},res=>{
      const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,text:()=>Buffer.concat(chunks).toString()}));
    });req.on('error',reject);req.end(init.body);
  });
  const home=await local('/');assert.equal(home.status,200);assert(home.text().includes(marker),'missing marker on preview page');
  assert.equal((await read()).id,state.id);
  let value='MANUAL-'+randomUUID().slice(0,8);
  if(live && browserCheck) {
    value='NOTE-'+randomUUID().slice(0,8);
    await request('请操作当前项目预览：在“备注”输入 '+value+'，点击“保存”，刷新后验证页面仍显示 '+value+'。告诉我页面底部真实显示的随机编号，并留下截图。');
  } else {
    assert.equal((await local('/save',{method:'POST',headers:{Origin:'null'},body:value})).status,200);
  }
  if(live) {
    let run;
    for(let i=0;i<480;i++) {
      run=store.detail(c.id).invocations[0];
      if(run && ['succeeded','failed','interrupted','cancelled'].includes(run.status)) break;
      await delay(500);
    }
    assert.deepEqual([run?.status,run?.acceptance,run?.teardown],['succeeded','accepted','confirmed']);
    proof.run=run.id;
    if(browserCheck) {
      const detail=store.detail(c.id);
      assert(detail.messages.some(m=>m.memberId===member && m.content.includes(marker)));
      const evidence=detail.evidence.filter(e=>e.invocationId===run.id && e.detail.origin==='project_browser' && e.detail.state==='completed');
      const steps=evidence.flatMap(e=>e.detail.result.trace.map(s=>s.split(' · ')[0]));
      let next=0; for(const step of steps) if(step===['fill','click','reload','expect'][next]) next++;
      assert.equal(next,4,'缺少填写、点击、刷新或实际核对文字的证据。');
      const verified=evidence.findLast(e=>e.detail.result.asserted && e.detail.result.text.includes(marker) && e.detail.result.text.includes(value));
      assert(verified,'没有同次核对保存结果和随机编号的页面记录。');
      for(const which of ['before','after']){
        const res=await fetch(url+'/api/invocations/'+run.id+'/browser-evidence/'+verified.detail.evidenceId+'/'+which+'.png');
        assert(res.ok);const bytes=Buffer.from(await res.arrayBuffer());assert.equal(bytes.readUInt32BE(0),0x89504e47);
        await writeFile(join(out,which+'.png'),bytes);
      }
      proof.browser={steps,checkedMarker:true,confirmedAfterReload:true,evidenceId:verified.detail.evidenceId,screenshots:['before.png','after.png']};
    }
  }
  assert((await (await local('/')).text()).includes(value));
  proof.pageVerified=true;
  await post(target+'/stop',{id:state.id});
  await assert.rejects(local('/'));
  proof.listenerClosed=true;proof.status='passed';
} catch(e) {proof.error=e.stack;process.exitCode=1;}
finally {
  await app?.close();
  if(await mount()!==vm.hostRoot) {
    const original={path:vm.hostRoot,device:vm.device,inode:vm.inode,mode:'project-work',memberIds:['codex'],conversationId:'restore',revision:1};
    const lease=await acquireProjectVm(vm,original,AbortSignal.timeout(180000));await lease.release(true);
  }
  proof.realModelCalls=calls;proof.mountRestored=await mount()===vm.hostRoot;
  await writeFile(join(out,'result.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}
