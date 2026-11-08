// Exercise the browser and HTTP decisions with isolated scripted worker receipts.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createApplication} from '../server/index.ts';

const {default:puppeteer}=await import(process.env.PUPPETEER_PATH?pathToFileURL(process.env.PUPPETEER_PATH).href:'puppeteer-core');
const temp=await mkdtemp(join(await realpath(tmpdir()),'web-git-ui-'));
const out=resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/native-project-p8/web-git-development/ui-'+randomUUID());
let app,browser;
try{
  await mkdir(out,{recursive:true});
  const project=join(temp,'monthly');await mkdir(project);
  let n=0,head='c'.repeat(40);
  const branch='codex/collab-browser';
  const pull=()=>({number:19,state:'open',base:{ref:'main',repo:{full_name:'example/fixture'}},
    head:{ref:branch,sha:head,repo:{full_name:'example/fixture'}}});
  const fakeGitHub=async path=>{
    if(path.includes('/pulls?')) return [pull()];
    if(path.endsWith('/pulls/19')) return pull();
    if(path.includes('/check-runs')) return {total_count:1,check_runs:[{id:42,name:'verify',head_sha:head,status:'completed',
      conclusion:head.startsWith('c')?'failure':'success',output:{title:'总额断言'},details_url:'https://github.com/example/fixture/actions/runs/21/job/42'}]};
    if(path.includes('/status?')) return {sha:head,total_count:0,statuses:[]};
    throw Error('Unexpected fixture endpoint '+path);
  };
  app=await createApplication({port:0,workspace:join(temp,'default'),dataDir:join(temp,'data'),staticDir:resolve(process.env.VALIDATION_STATIC_DIR || 'dist/web'),
    projectGitHub:async()=>fakeGitHub,
    collaborationRuntime:{projectWorkAvailability:()=>({available:true}),probe:async()=>[],async invoke(req){
      const store=app.collaborationStore;
      req.onEvent({kind:'accepted',detail:{source:'ui-fixture'}});
      if(!req.projectWork){
        assert(req.webResearch);
        for(const [name,callId,result] of [['project_web_search','s',{results:[{}]}],['project_web_read','r',{title:'发布手册',url:'https://example.org/handbook'}]]){
          store.recordEvidence(req.invocationId,{kind:'tool',detail:{origin:'project_web',name,callId,query:'发布手册',state:'completed',checkedAt:new Date().toISOString(),result}});
        }
      }else{
        const callId=randomUUID();
        const gitDelivery={remote:'https://github.com/example/fixture.git',branch:'main',local:'a'.repeat(40),parent:'a'.repeat(40),
          commit:'b'.repeat(40),files:['monthly.txt'],message:'Update monthly total',diff:'--- monthly.txt\n+++ monthly.txt\n@@ -1 +1 @@\n-0\n+12'};
        if(n>=2) {
          gitDelivery.branch=branch;
          gitDelivery.commit=(n===4?'d':'c').repeat(40);
          gitDelivery.pull={localBranch:'main',base:'main',expectedHead:n===4?'c'.repeat(40):null,repair:false,...(n===4 && {number:19})};
        }
        const answer=await store.interactions.wait(req.invocationId,{kind:'approval',operation:'project_git_deliver',providerRequestId:'git:'+callId,
          nativeItemId:callId,gitDelivery,payload:{grantRevision:req.workspaceGrant.revision}},'project-git',req.signal);
        if(answer.state==='answered' && gitDelivery.pull) head=gitDelivery.commit;
        if(answer.state==='answered') store.recordEvidence(req.invocationId,{kind:'tool',detail:{origin:'project_git',callId,state:'completed',commit:gitDelivery.commit}});
        n++;
      }
      req.onEvent({kind:'process_exit',detail:{confirmed:true}});return {text:req.projectWork?'完成。':'见[发布手册](https://example.org/handbook)。',continuity:'unknown'};
    }}});
  const store=app.collaborationStore;
  process.env.WEB_UI_FIXTURE='fixture';
  const acct=store.saveAccount({id:'ui',name:'UI fixture',provider:'codex',auth:'api',apiKeyEnv:'WEB_UI_FIXTURE',baseUrl:'https://example.invalid'});
  store.saveMember({...store.members().find(x=>x.id==='codex'),accountId:acct.id,accountBinding:'override',model:'fixture'});
  const {conversation}=store.create({title:'网页与 Git',memberIds:['codex'],defaultMemberId:'codex',requestId:randomUUID()});
  const preview=store.workbench.previewWorkspace(conversation.id,{path:project,mode:'project-work'});
  store.workbench.applyPreview({previewId:preview.id,requestId:randomUUID()},conversation.id);
  const {url}=await app.start();
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking','--no-first-run']});
  const page=await browser.newPage();page.setDefaultTimeout(16000);
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.setViewport({width:1280,height:860});await page.goto(url,{waitUntil:'networkidle2'});
  const composer='#cc-message-input',cards='.cc-native-file-permission',draft='下一条消息草稿';
  await page.waitForSelector(composer,{visible:true}).catch(async error=>{ console.error(errors,await page.title(),(await page.$eval('body',e=>e.textContent)).slice(0,450)); throw error; });
  const send=async(text)=>{await page.focus(composer);await page.$eval(composer,e=>e.select());await page.keyboard.press('Backspace');await page.type(composer,text);await page.keyboard.press('Enter');};
  const contains=(selector,expected)=>page.waitForFunction((s,t)=>[...document.querySelectorAll(s)].some(e=>e.textContent.includes(t)),{},selector,expected);
  async function press(sel,label){
    const button=await page.waitForFunction((s,t)=>[...document.querySelectorAll(s+' button')].find(e=>e.textContent===t&&!e.disabled),{},sel,label);
    await button.asElement().focus();await page.keyboard.press('Enter');await button.dispose();
  }
  await send('@Codex 查一下发布手册');await contains('details','网页查证记录');
  await page.waitForSelector('.cc-prose a[href="https://example.org/handbook"]',{visible:true});
  const source=await page.waitForFunction(()=>[...document.querySelectorAll('summary')].find(e=>e.textContent.startsWith('网页查证记录')));
  await source.asElement().focus();await page.keyboard.press('Enter');await page.waitForSelector('details a[href="https://example.org/handbook"]',{visible:true});
  assert(await page.$eval('details a[href="https://example.org/handbook"]',e=>e.textContent==='发布手册'&&e.rel.includes('noreferrer')));
  await send('@Codex 请提交并推送本次修改');await contains(cards,'确认推送');await page.type(composer,draft);
  await page.click(cards+' summary');await contains(cards+' pre','+12');
  await page.setViewport({width:320,height:760});
  await page.waitForFunction(()=>document.querySelector('.cc-sidebar').getBoundingClientRect().right<=1);
  await page.$eval(cards,e=>e.scrollIntoView({block:'center'}));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:join(out,'mobile.png')});
  let fail=true;const ids=[];
  await page.setRequestInterception(true);page.on('request',r=>{
    if(r.method()==='POST'&&r.url().endsWith('/answer')){ids.push(JSON.parse(r.postData()).requestId);if(fail){fail=false;void r.respond({status:503,contentType:'application/json',body:JSON.stringify({error:'临时断线'})});return;}}
    void r.continue();
  });
  await press(cards,'确认推送');await contains(cards+' [role=alert]','临时断线');await press(cards,'确认推送');
  await contains(cards,'推送成功');assert.equal(ids[0],ids[1]);assert.equal(await page.$eval(composer,e=>e.value),draft);
  await send('@Codex 请推送这次提交');await page.waitForFunction(s=>document.querySelectorAll(s).length===2,{},cards);
  const second=(await page.$$eval(cards,els=>els.at(-1).dataset.permissionId));await press('[data-permission-id="'+second+'"]','拒绝');await contains(cards,'已拒绝');
  await page.reload({waitUntil:'networkidle2'});await contains(cards,'推送成功');await contains(cards,'已拒绝');
  await send('@Codex 把改动提 PR 到 main');await contains(cards,'确认创建 PR');
  await press(cards,'取消并停止本轮');await contains(cards,'已取消');
  await send('@Codex 把改动提 PR 到 main');await contains(cards,'确认创建 PR');
  await page.type(composer,draft);
  await press(cards,'确认创建 PR');await contains(cards,'CI 失败');
  await contains(cards,'cccccccccc');await contains(cards,'总额断言');
  await page.waitForSelector(cards+' a[href="https://github.com/example/fixture/pull/19"]',{visible:true});
  await press(cards,'刷新检查');assert.equal(await page.$eval(composer,e=>e.value),draft);
  await send('@Codex 修复问题，更新 PR #19');await contains(cards,'确认更新 PR');
  await press(cards,'确认更新 PR');await contains(cards,'CI 已通过');
  await contains(cards,'此卡记录先前提交');await contains(cards,'dddddddddd');
  await page.reload({waitUntil:'networkidle2'});await contains(cards,'CI 失败');await contains(cards,'CI 已通过');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:join(out,'pr-mobile.png')});
  assert.equal(n,5);assert.deepEqual(errors,[]);
  await writeFile(join(out,'result.json'),JSON.stringify({passed:true,realCalls:0,checks:['visible original source','full diff branch and commit','320px and keyboard','retry reuses request ID','draft preserved','decline','reload restores results','cancel PR','PR link and check failure','refresh preserves draft','update same PR and keep prior SHA history']},null,2));
  console.log('PASS',out);
}finally{await browser?.close();await app?.close();await rm(temp,{recursive:true,force:true});}
