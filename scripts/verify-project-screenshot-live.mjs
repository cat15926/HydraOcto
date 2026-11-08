// Isolated real project conversation. Each invocation permits at most one model turn.
import assert from 'node:assert/strict';
import {createHash, randomInt, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, realpath, writeFile} from 'node:fs/promises';
import {basename, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createApplication} from '../server/index.ts';
import {createCollaborationRuntime} from '../server/collaboration/runtime.ts';
import {readProjectVm} from '../server/collaboration/project-vm.ts';
import {acquireProjectVm} from '../server/collaboration/project-vm-mount.ts';

const [mode,member] = process.argv.slice(2);
assert(mode==='--live' && ['codex','claude'].includes(member),'Usage: --live codex|claude');
const vm=readProjectVm(resolve(process.env.SCREENSHOT_VM_CONFIG || '.local-data/validation/native-project-p7/p03.json'));
assert(vm?.instance==='p03' && vm.manageMount && basename(vm.hostRoot).startsWith('multi-agent-vm-project-'));
const marker=String(randomInt(10000000,99999999));
const output=resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/project-screenshots/live');
await mkdir(output,{recursive:true,mode:0o700});
const run=await mkdtemp(join(output,member+'-'));
const project=await mkdtemp(join(await realpath(vm.hostRoot),'screenshot-'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const mountSource=async()=>JSON.parse(await readFile(join(vm.limaHome,vm.instance,'lima.yaml'),'utf8')).mounts[0].location;
assert.equal(await mountSource(),vm.hostRoot,'p03 must be idle at its registered root');
const {default:puppeteer}=await import(process.env.PUPPETEER_PATH ? pathToFileURL(process.env.PUPPETEER_PATH).href : 'puppeteer-core');
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking','--no-first-run']});
let png;
try {
  const page=await browser.newPage(); await page.setViewport({width:700,height:240});
  await page.setContent('<body style="margin:0;background:white;color:black;display:grid;place-content:center;text-align:center;font:20px sans-serif"><p>ORDER NUMBER</p><strong style="font: bold 72px monospace">'+marker+'</strong></body>');
  png=Buffer.from(await page.screenshot({type:'png'}));
} finally {await browser.close();}
const original={path:vm.hostRoot,device:vm.device,inode:vm.inode,mode:'project-work',memberIds:[member],conversationId:'restore-image-test',revision:1};
const proof={member,sourceSha256:sha(png),expectedDigits:marker,realCalls:0,project};
let app,restore=false;
try {
  process.env.CLAUDE_CONFIG_DIR=join(run,'claude-home'); await mkdir(process.env.CLAUDE_CONFIG_DIR,{mode:0o700});
  const base=createCollaborationRuntime({projectVm:vm,timeoutMs:220000});
  const runtime={...base,async invoke(req) {
    assert(req.projectWork); assert.equal(req.member.id,member);
    assert.equal(req.account.auth,member==='codex'?'cli':'api');
    assert.equal(req.images?.length,1);
    assert.equal(req.images[0].digest,sha(png)); assert.equal(sha(Buffer.from(req.images[0].base64,'base64')),sha(png));
    assert(!req.prompt.includes(marker) && !req.prompt.includes(req.images[0].base64));
    assert.equal(proof.realCalls,0); proof.realCalls++; proof.imageInputVerified=true;
    return base.invoke(req);
  }};
  app=await createApplication({port:0,workspace:join(run,'workspace'),dataDir:join(run,'db'),collaborationRuntime:runtime});
  const {url}=await app.start(), store=app.collaborationStore;
  const post=async(path,params)=>{
    const res=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':app.csrfToken},body:JSON.stringify(params)});
    const result=await res.json(); if (!res.ok) throw new Error(path+' HTTP '+res.status+' '+result.error); return result;
  };
  const account=member==='codex' ? {id:'image-codex',name:'Codex 官方登录',provider:'codex',auth:'cli'} :
    {id:'image-claude',name:'Claude Code 智谱 API',provider:'claude',auth:'api',baseUrl:'https://open.bigmodel.cn/api/anthropic',apiKeyEnv:'COLLAB_GLM_API_KEY'};
  if(member==='claude') assert(process.env[account.apiKeyEnv],'missing configured GLM account');
  const name=member==='codex'?'Codex':'Claude Code';
  store.saveAccount(account);
  store.saveMember({id:member,name,carrier:member==='codex'?'codex-app-server':'claude-cli',enabled:true,accountId:account.id,
    instructions:'依用户委托读取提供的截图并处理项目。',modelBinding:'override',accountBinding:'override',...(member==='claude'?{model:'glm-5.3'}:{})});
  const {conversation}=await post('/api/conversations',{title:'读取收据截图',memberIds:[member],defaultMemberId:member,requestId:randomUUID()});
  const path='/api/conversations/'+conversation.id;
  const selected=await post(path+'/workspace-preview',{path:project,mode:'project-work'});
  restore=true;await post(path+'/workspace-apply',{previewId:selected.id,requestId:randomUUID()});
  const attachment=await post(path+'/attachments',{name:'photo.png',mediaType:'image/png',base64:png.toString('base64'),requestId:randomUUID()});
  assert.equal(attachment.result.digest,sha(png));
  await post(path+'/messages',{attachmentIds:[attachment.result.id],content:'@'+name+' 请在此项目中工作：读取随消息附上的截图，在项目目录创建 receipt.txt，将截图中八位订单号原样写入文件，并在聊天里回复这个号码。仅使用图片上看到的号码。',requestId:randomUUID()});
  const deadline=Date.now()+240000;
  let invocation;
  while(Date.now()<deadline) {
    invocation=store.detail(conversation.id).invocations[0];
    if(invocation && !['running','prepared','cancel_requested'].includes(invocation.status)) break;
    await delay(300);
  }
  assert(invocation,'invocation did not start');
  const detail=store.detail(conversation.id);
  Object.assign(proof,{invocationId:invocation.id,status:invocation.status,acceptance:invocation.acceptance,teardown:invocation.teardown,
    error:invocation.error,replyMatches:detail.messages.some(m=>m.memberId===member && m.content.includes(marker)),fileMatches:await readFile(join(project,'receipt.txt'),'utf8').then(s=>s.trim()===marker,()=>false)});
  assert.deepEqual([proof.status,proof.acceptance,proof.teardown,proof.replyMatches,proof.fileMatches],['succeeded','accepted','confirmed',true,true]);
  proof.passed=true;
} catch(e){proof.passed=false;proof.reason=String(e.message).slice(0,450);process.exitCode=1;}
finally {
  try { await app?.close(); }
  finally {
    if(restore) {
      try {const lease=await acquireProjectVm(vm,original,AbortSignal.timeout(180000)); await lease.release(true);
      proof.mountRestored=await mountSource()===vm.hostRoot;}
      catch {proof.mountRestored=false;}
      if(!proof.mountRestored){proof.passed=false;process.exitCode=1;}
    }
    await writeFile(join(run,'result.json'),JSON.stringify(proof,null,2)+'\n',{mode:0o600});
    console.log(proof.passed?'PASS':'FAIL',join(run,'result.json'));
  }
}
