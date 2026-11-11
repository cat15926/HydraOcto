// One Codex project invocation or two sequential Claude invocations, in the disposable p03 VM.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,realpath,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import puppeteer from 'puppeteer-core';
import {createApplication} from '../server/index.ts';
import {createCollaborationRuntime} from '../server/collaboration/runtime.ts';
import {readProjectVm} from '../server/collaboration/project-vm.ts';
import {acquireProjectVm} from '../server/collaboration/project-vm-mount.ts';
import {chromiumPath} from '../server/collaboration/project-browser-path.ts';

const [live,member]=process.argv.slice(2);
assert(live==='--live' && ['codex','claude'].includes(member));
const vm=readProjectVm(resolve(process.env.ACCEPTANCE_VM_CONFIG || '.local-data/validation/native-project-p7/p03.json'));
assert(vm?.instance==='p03' && vm.manageMount);
const mount=async()=>JSON.parse(await readFile(join(vm.limaHome,'p03/lima.yaml'),'utf8')).mounts[0].location;
assert.equal(await mount(),vm.hostRoot);
const out=resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/project-guidance/development');
await mkdir(out,{recursive:true,mode:0o700});
const dir=await mkdtemp(join(out,member+'-')),project=await mkdtemp(join(await realpath(vm.hostRoot),'guidance-'));
const file=join(project,'index.html'),initial='FIRST-'+randomUUID().slice(0,12);
await writeFile(file,'<!doctype html><meta charset=utf-8><label>备注<input></label><button>保存</button><footer></footer>');
const codex=member==='codex',name=codex?'Codex':'Claude Code';
const proof={status:'failed',member,invocations:0,project};
let app,browser;
try {
  process.env.CLAUDE_CONFIG_DIR=join(dir,'claude-home');await mkdir(process.env.CLAUDE_CONFIG_DIR,{mode:0o700});
  const base=createCollaborationRuntime({projectVm:vm,timeoutMs:200000});
  app=await createApplication({port:0,dataDir:join(dir,'db'),workspace:join(dir,'default'),collaborationRuntime:{
    ...base,async invoke(req) {
      assert(req.member.id===member && req.projectWork && req.cwd===project);assert(++proof.invocations<=(codex?1:2));
      return base.invoke(req);
    }
  }});
  const {url}=await app.start(),store=app.collaborationStore;
  store.saveAccount({id:'test',provider:member,name,auth:codex?'cli':'api',...(!codex&&{apiKeyEnv:'COLLAB_GLM_API_KEY',baseUrl:'https://open.bigmodel.cn/api/anthropic'})});
  store.saveMember({id:member,carrier:codex?'codex-app-server':'claude-cli',name,enabled:true,accountId:'test',accountBinding:'override',modelBinding:'override',...(!codex&&{model:'glm-5.3'}),instructions:'请按用户要求直接完成项目修改，保留用户先前明确要求显示的文字。'});
  async function post(path,body) {
    const res=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':app.csrfToken},body:JSON.stringify(body)});
    const value=await res.json();assert(res.ok,value.error);return value;
  }
  const {conversation:c}=await post('/api/conversations',{title:'项目中途补充',memberIds:[member],defaultMemberId:member,requestId:randomUUID()});
  const path='/api/conversations/'+c.id;
  const g=await post(path+'/workspace-preview',{path:project,mode:'project-work'});
  await post(path+'/workspace-apply',{previewId:g.id,requestId:randomUUID()});
  await post(path+'/messages',{content:'@'+name+' 修改项目中的 index.html。在页面顶部显示 '+initial+'，保留备注输入和保存按钮。直接修改原文件，然后核对文件。',requestId:randomUUID()});
  const detail=()=>store.detail(c.id);
  async function until(check,timeout=230000) {
    const end=Date.now()+timeout;
    while(Date.now()<end) {const result=check();if(result)return result;await delay(100);}
    throw Error('等待验收条件超时');
  }
  const first=await until(()=>{const i=detail().invocations[0];if(i && !['prepared','running'].includes(i.status))throw Error(i.error||i.status);return i?.acceptance==='accepted' && i;});
  // Generated after the original member received the initial task.
  const marker='LATER-'+randomUUID().slice(0,12);
  const supplement={content:'再加一条校验，备注为空时禁用保存按钮，有文字时启用。请在页面底部显示 '+marker+'，保留已有顶部编号。',requestId:randomUUID()};
  const accepted=await post(path+'/messages',supplement);assert(accepted.source?.projectWork);
  const sid=accepted.source.id;
  assert.equal((await post(path+'/messages',supplement)).source.id,sid);
  assert.equal(detail().deliveries.find(d=>d.sourceId===sid)?.continuation?.invocationId,first.id);
  proof.original=first.id;proof.guidanceSource=sid;
  const finished=await until(()=>{
    const view=detail(),runs=view.invocations;
    if(runs.some(i=>['failed','cancelled','interrupted'].includes(i.status)))throw Error(runs.find(i=>i.error)?.error||'执行失败');
    return runs.length===(codex?1:2) && runs.every(i=>i.status==='succeeded' && i.teardown==='confirmed') && view;
  },400000);
  const delivery=finished.deliveries.find(d=>d.sourceId===sid);
  assert.equal(delivery.status,'consumed');
  const receipt=finished.inputHandoffs?.find(h=>h.sourceId===sid);
  if(codex) {
    assert(receipt && ['accepted','read'].includes(receipt.state));assert.equal(receipt.invocationId,first.id);
    assert.equal(receipt.nativeTurnId,first.nativeTurnId);assert.equal(delivery.responseId,first.responseId);
  } else {
    assert(!receipt && delivery.continuation.fallback);
    assert.notEqual(delivery.responseId,first.responseId);
    assert(!finished.responses.find(r=>r.id===first.responseId).inputSourceIds.includes(sid));
  }
  proof.delivery={status:delivery.status,turn:codex?'same':'next',nativeReceipt:receipt?.state};
  const html=await readFile(file,'utf8');assert(html.includes(marker) && html.includes(initial));
  const preview=await post(path+'/project-preview/start',{previousId:null,grantRevision:store.workbench.conversation(c.id).workspaceGrant.revision});
  let state;for (let i=0;i<80;i++) {state=await (await fetch(url+path+'/project-preview')).json();if(state.status==='running')break;await delay(150);}
  assert.equal(state.status,'running');assert.equal(state.id,preview.id);
  browser=await puppeteer.launch({executablePath:await chromiumPath(),headless:true,args:['--disable-background-networking']});
  const page=await browser.newPage();await page.goto(state.url);
  const frame=await page.waitForFrame(f=>f.parentFrame()===page.mainFrame() && f.url().endsWith('/') && f.url().includes('.localhost:'));
  await frame.waitForFunction((a,b)=>document.body.innerText.includes(a) && document.body.innerText.includes(b),{},initial,marker);
  const button=await frame.waitForSelector('button');assert(await button.evaluate(n=>n.disabled));
  await frame.type('input','验收');await frame.waitForFunction(()=>!document.querySelector('button').disabled);
  await page.screenshot({path:join(dir,'page.png')});proof.browserChecks=['两次标记均可见','为空时禁用','输入后启用'];
  await post(path+'/project-preview/stop',{id:preview.id});proof.status='passed';
} catch(e){proof.error=e.stack;process.exitCode=1;}
finally{
  await browser?.close();await app?.close();
  if(await mount()!==vm.hostRoot){
    const lease=await acquireProjectVm(vm,{path:vm.hostRoot,device:vm.device,inode:vm.inode,mode:'project-work',memberIds:[member],conversationId:'restore',revision:1},AbortSignal.timeout(180000));await lease.release(true);
  }
  proof.mountRestored=await mount()===vm.hostRoot;await writeFile(join(dir,'result.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
}
