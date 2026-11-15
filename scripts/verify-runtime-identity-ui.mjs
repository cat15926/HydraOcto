/** Identity and cancel checks use an isolated app and synthetic CLI events, no paid inference. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
import puppeteer from 'puppeteer-core';import {createApplication} from '../server/index.ts';
const out=resolve(process.env.VALIDATION_OUTPUT_DIR||'.local-data/validation/runtime-identity-ui/'+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(out,{recursive:true});
let browser,app;const checks=[],errors=[];
try{
 browser=await puppeteer.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
 for(const width of [1390,390]){
  const root=await mkdtemp(join(tmpdir(),'runtime-identity-'));let calls=0;
  process.env.HYDRA_TEST_MODEL_KEY='synthetic-only';
  app=await createApplication({port:0,dataDir:join(root,'db'),workspace:join(root,'workspace'),staticDir:resolve('dist/web'),collaborationRuntime:{probe:async()=>[],invoke:async req=>{
   const n=++calls;req.onEvent({kind:'session',detail:{nativeSessionId:'fixture-'+n,model:'glm-runtime-confirmed',authentication:'api',evidence:'system.init'}});req.onEvent({kind:'accepted',detail:{evidence:'synthetic'}});
   if(n===2)await new Promise((_,reject)=>{req.signal.addEventListener('abort',()=>reject(req.signal.reason),{once:true});});
   req.onEvent({kind:'process_exit',detail:{confirmed:true}});return{text:'身份显示验收',continuity:'fresh'};
  }}});
  const store=app.collaborationStore;store.saveAccount({id:'fixture-api',name:'智谱API测试',provider:'claude',auth:'api',apiKeyEnv:'HYDRA_TEST_MODEL_KEY',baseUrl:'https://example.com'});
  store.saveMember({...store.members().find(m=>m.id==='claude'),id:'claude',name:'Claude Code',carrier:'claude-cli',accountId:'fixture-api',accountBinding:'override',modelBinding:'override',model:'configured-glm',enabled:true,instructions:'fixture'});
  store.create({title:'身份验证',memberIds:['claude'],defaultMemberId:'claude',requestId:'fixture'});
  const {url}=await app.start(),page=await browser.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width,height:900});await page.goto(url,{waitUntil:'networkidle2'});await page.type('#cc-message-input','请回答');await page.click('.cc-send-button');
  const trigger = '.cc-record-trigger';
  const identity = '.cc-record-dialog .cc-runtime-identity';
  await page.waitForFunction(s => document.querySelector(s)?.textContent === '执行记录', {}, trigger);
  assert.equal(await page.$('.cc-message-list .cc-runtime-identity'), null);
  await page.click(trigger);
  const original = await page.$eval(identity, e => e.textContent);
  for (const value of ['执行完成','Claude Code CLI','glm-runtime-confirmed','API 密钥']) assert(original.includes(value));
  await page.click(identity+' summary');
  await page.screenshot({path:join(out,'record-'+width+'.png')});
  await page.keyboard.press('Escape');
  assert(await page.$eval(trigger,e=>document.activeElement===e));
  store.saveMember({...store.members().find(m=>m.id==='claude'),model:'changed-after-run'});
  await page.reload({waitUntil:'networkidle2'});
  await page.waitForSelector(trigger);await page.click(trigger);
  assert.equal(await page.$eval(identity,e=>e.textContent),original);
  await page.click('button[aria-label="关闭执行记录"]');
  await page.type('#cc-message-input','等待停止');await page.click('.cc-send-button');
  await page.waitForFunction(s=>[...document.querySelectorAll(s)].some(e=>e.textContent==='执行中'),{},trigger);
  const h=await page.waitForFunction(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='停止本次执行'&&!b.disabled));
  await h.asElement().focus();await page.keyboard.press('Enter');
  const stopped=await page.waitForFunction(s=>[...document.querySelectorAll(s)].find(e=>/已停止|执行中断/.test(e.textContent)),{},trigger);
  await stopped.asElement().click();
  assert.match(await page.$eval(identity,e=>e.textContent),/已停止|执行中断/);
  await page.keyboard.press('Escape');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:join(out,'identity-'+width+'.png'),fullPage:true});checks.push({width,runtime:true,confirmedModel:true,apiAuth:true,status:true,frozenIdentityAfterEdit:true,cancelByKeyboard:true,noOverflow:true});await page.close();await app.close();app=undefined;
 }
 assert.deepEqual(errors,[]);await writeFile(join(out,'result.json'),JSON.stringify({passed:true,checks,errors,realModelCalls:0},null,2));console.log(JSON.stringify({passed:true,checks,out}));
}catch(e){await writeFile(join(out,'failure.json'),JSON.stringify({error:e.stack,checks,errors},null,2));console.error(e);process.exitCode=1;}finally{await browser?.close();await app?.close();delete process.env.HYDRA_TEST_MODEL_KEY;}
