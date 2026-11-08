/** P3 chat exercise with an isolated real service, scripted member and disposable picker results. */
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { access,mkdir,mkdtemp,readFile,realpath,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../server/index.ts';
import { RuntimeOutcomeUnknown,executeTool } from '../server/collaboration/runtime-common.ts';

const root = await mkdtemp(join(await realpath(tmpdir()),'project-permissions-ui-'));
const output = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/native-project-p3/ui/'+new Date().toISOString().replace(/[:.]/g,'-'));
const project=join(root,'月报'), occupied=join(root,'已有文件'), destination=join(root,'导出目录');
const file='summary.csv', contents='月份,收入\n四月,103\n', privateDraft='等我核对后再继续。';
const exporter='.cc-message .cc-project-export', inspector='.cc-message .cc-project-scene', input='#cc-message-input';
const folderAnswers=[null,occupied,destination], fileAnswers=[null,join(project,'notes.txt')];
const calls=[], checks=[], errors=[];
const digest=text=>createHash('sha256').update(text).digest('hex');
const {default:puppeteer}=await import(process.env.PUPPETEER_PATH?pathToFileURL(process.env.PUPPETEER_PATH).href:'puppeteer-core');
let app,browser,page;
try {
  await mkdir(output,{recursive:true});
  for(const dir of [project,occupied,destination]) await mkdir(dir);
  await writeFile(join(occupied,file),'此前已有');
  await writeFile(join(project,'notes.txt'),'手工核对');
  const pickFolder=async(_signal,purpose)=>{assert.equal(purpose,'export');assert(folderAnswers.length,'unexpected folder picker');return folderAnswers.shift();};
  const available={available:true};
  app=await createApplication({port:0,workspace:join(root,'default'),dataDir:join(root,'db'),
    staticDir:resolve(process.env.VALIDATION_STATIC_DIR || 'dist/web'),folderPicker:pickFolder,
    projectFilePicker:async()=>{assert(fileAnswers.length);return fileAnswers.shift();},
    collaborationRuntime:{projectWorkAvailability:()=>available,probe:async()=>[],
      invoke:async request=>{
        calls.push(request.invocationId);
        assert(request.projectWork);
        const session=randomUUID(),turn=randomUUID();
        request.onEvent({kind:'session',detail:{nativeSessionId:session,nativeTurnId:turn}});
        request.onEvent({kind:'accepted',detail:{nativeSessionId:session,nativeTurnId:turn,source:'scripted-ui-member'}});
        if(calls.length===3){
          await writeFile(join(project,'first.txt'),'已写入的部分');
          request.onEvent({kind:'tool',detail:{origin:'native',carrier:'codex-app-server',nativeSessionId:session,nativeTurnId:turn,
            name:'fileChange',state:'completed',path:'first.txt',callId:'first-write',sequence:1}});
          throw new RuntimeOutcomeUnknown();
        }
        await writeFile(join(project,file),contents);
        await executeTool(request,'project_export_request',{path:file},'export-'+calls.length);
        request.onEvent({kind:'process_exit',detail:{confirmed:true}});
        return {text:'已处理导出请求。',continuity:'unknown'};
      }}});
  const store=app.collaborationStore;
  const {conversation}=store.create({title:'月报导出',memberIds:['codex'],defaultMemberId:'codex',requestId:randomUUID()});
  const grant=store.workbench.previewWorkspace(conversation.id,{path:project,mode:'project-work'});
  store.workbench.applyPreview({previewId:grant.id,requestId:randomUUID()},conversation.id);
  const {url}=await app.start();
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless:true,args:['--disable-background-networking','--no-first-run']});
  page=await browser.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  page.setDefaultTimeout(20000);
  await page.setViewport({width:1360,height:900}); await page.goto(url,{waitUntil:'networkidle2'});
  async function send(text) {
    await page.click(input);await page.$eval(input,el=>el.select());await page.keyboard.press('Backspace');
    await page.type(input,text); await page.click('.cc-send-button');
  }
  const has=async(selector,text)=>page.waitForFunction((s,t)=>[...document.querySelectorAll(s)].at(-1)?.textContent.includes(t),{},selector,text);
  const waitCount=async(selector,n)=>page.waitForFunction((s,num)=>document.querySelectorAll(s).length===num,{},selector,n);
  const focus=async(selector)=>page.waitForFunction(s=>document.activeElement?.matches(s),{},selector);
  async function clickLast(selector) {const elements=await page.$$(selector);await elements.at(-1).click();}
  async function draft(){assert.equal(await page.$eval(input,el=>el.value),privateDraft);}
  async function assertNarrow(selector){
    const fits=await page.$eval(selector,card=>{card.scrollIntoView({block:'center'});return document.documentElement.scrollWidth<=innerWidth &&
      [...card.querySelectorAll('button')].filter(b=>b.getClientRects().length).every(b=>{const r=b.getBoundingClientRect();return r.x>=0 && r.right<=innerWidth+1 && r.height>=44;});});
    assert(fits,'controls must fit at 320px');
  }
  await send('@Codex 请生成月报文件，并导出到项目外。');
  await has(exporter,'待选择位置');
  await page.type(input,privateDraft);
  await page.click('.cc-workspace-toggle');
  await has('.cc-workspace-attention .cc-workspace-row','等待导出授权');
  await page.click('.cc-workspace-attention .cc-workspace-row');
  await page.waitForSelector('.cc-execution[open] .cc-project-export',{visible:true});
  assert.equal(await page.$eval('.cc-execution[open] .cc-project-export',el=>el.dataset.exportId),await page.$eval(exporter,el=>el.dataset.exportId));
  await page.click('.cc-workspace-close');await focus('.cc-workspace-toggle');await draft();
  checks.push('workspace attention opens the same request and closing it retains the composer draft');
  const pick=exporter+' [data-export-action=pick]',allow=exporter+' [data-export-action=allow]';
  await page.focus(pick);await page.keyboard.press('Enter');await has(exporter,'已取消选择');await focus(pick);await draft();
  await page.keyboard.press('Enter');await page.waitForSelector(exporter+' [role=alert]');await focus(pick);await draft();
  assert.equal(await readFile(join(occupied,file),'utf8'),'此前已有');
  await page.keyboard.press('Enter');await has(exporter,join(destination,file));await focus(allow);
  await assert.rejects(access(join(destination,file)),{code:'ENOENT'});
  checks.push('keyboard selection, cancellation and occupied destination retry preserve focus, draft and existing file; picking creates no output');
  await page.click(exporter+' summary');await has(exporter,digest(contents));await page.screenshot({path:join(output,'desktop.png')});
  await page.click(exporter+' summary');
  await page.setViewport({width:320,height:760});
  await page.waitForFunction(()=>document.querySelector('.cc-sidebar').getBoundingClientRect().right<=1);
  await assertNarrow(exporter);await page.screenshot({path:join(output,'mobile.png')});
  await page.setRequestInterception(true);
  let failOnce=true;
  const approvalIds=[];
  page.on('request',r=>{
    if(r.url().endsWith('/decide') && r.method()==='POST' && JSON.parse(r.postData()).decision==='allow'){
      approvalIds.push(JSON.parse(r.postData()).requestId);
      if(failOnce){failOnce=false;void r.respond({status:503,contentType:'application/json',body:JSON.stringify({error:'临时连接失败'})});return;}
    }
    void r.continue();
  });
  await clickLast(allow);await has(exporter+' [role=alert]','临时连接失败');await focus(allow);await draft();
  await clickLast(allow);await has(exporter,'已导出');await draft();assert.equal(await readFile(join(destination,file),'utf8'),contents);
  assert.equal(approvalIds.length,2);assert.equal(approvalIds[0],approvalIds[1]);assert.equal(calls.length,1);
  checks.push('320px approval displays the complete fixed target and hash, retries the same ticket and writes the intended bytes once');
  await page.reload({waitUntil:'networkidle2'});await has(exporter,'已导出');assert.equal(await page.$(allow),null);
  await send('@Codex 请再次生成月报文件，并导出项目外。');await waitCount(exporter,2);
  await clickLast(exporter+' [data-export-action=decline]');await has(exporter,'已拒绝');
  assert.equal(await readFile(join(destination,file),'utf8'),contents);assert.deepEqual(folderAnswers,[]);
  checks.push('refresh restores completed export; a different request can be declined before choosing a folder');
  await send('@Codex 请修改项目文件并运行测试。');await page.waitForSelector(inspector+' [data-inspect=check]');
  await page.type(input,privateDraft);await clickLast(inspector+' [data-inspect=check]');
  await has(inspector,'尚无确定结果');await has(inspector,'first.txt');await draft();
  const selectFile=inspector+' [data-inspect=pick]';
  await clickLast(selectFile);await has(inspector,'已取消选择');await focus(selectFile);
  await clickLast(selectFile);await has(inspector,'notes.txt');
  await clickLast(inspector+' [data-inspect=check]');await has(inspector,'notes.txt');await draft();
  await page.waitForFunction(s=>!document.querySelector(s).disabled,{},inspector+' [data-inspect=check]');
  await assertNarrow(inspector);await page.screenshot({path:join(output,'inspection.png')});
  assert.equal(calls.length,3);assert.deepEqual(fileAnswers,[]);assert.deepEqual(errors,[]);
  assert.equal(store.detail(conversation.id).invocations.at(-1).status,'interrupted');
  checks.push('interrupted execution shows uncertain outcome and on-disk file observations; cancelled/selected file and recheck preserve draft and start no new member');
  await writeFile(join(output,'result.json'),JSON.stringify({passed:true,checks,syntheticCalls:calls.length,realModelCalls:0,browserErrors:errors},null,2)+'\n');
  console.log(output,checks.length+' scenarios passed');
} catch(e) {
  console.error(e.message);process.exitCode=1;await page?.screenshot({path:join(output,'failed.png')}).catch(()=>{});
  const state=app?.collaborationStore.list()[0];
  const detail=state && app.collaborationStore.detail(state.id);
  await writeFile(join(output,'failure.json'),JSON.stringify({error:e.stack,checks,calls,browserErrors:errors,invocations:detail?.invocations.map(i=>({id:i.id,status:i.status,error:i.error})),exports:detail?.projectExports},null,2));
} finally {await browser?.close();await app?.close();await rm(root,{recursive:true,force:true});}
