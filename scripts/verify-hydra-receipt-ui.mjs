// Browser acceptance against a temporary database, two temporary loopback ports and a synthetic in-process runtime.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import puppeteer from 'puppeteer-core';
import {createApplication} from '../server/index.ts';

const dir=await mkdtemp(join(tmpdir(),'hydra-receipt-ui-'));
const input='#cc-message-input',card='.cc-obligation',draft='保存这条草稿';
const bundled=resolve(process.env.VALIDATION_STATIC_DIR || 'dist/web');
const browser=await puppeteer.launch({headless:true,executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking','--no-first-run']});
const runs=[];
async function exercise(width){
  const base=join(dir,String(width)); await mkdir(base); await mkdir(join(base,'work'));
  let store;
  const runtime={probe:async()=>[],async invoke(req){
    req.onEvent({kind:'accepted',detail:{fixture:true}});
    const src=store.visibility.primary(req.invocationId);
    if(src.kind==='user' && src.content==='请持续跟进资料校对') {
      await req.onToolCall('obligation_open',{goal:'校对资料并回报'},'open-fixture');
    }
    // A bounded reminder that still omits its receipt exercises the real blocked/retry transition.
    req.onEvent({kind:'process_exit',detail:{confirmed:true}});
    return {text:src.content==='现在几点'?'普通答复完成':'已经查看资料。',continuity:'unknown'};
  }};
  const app=await createApplication({port:0,workspace:join(base,'work'),dataDir:join(base,'db'),staticDir:bundled,collaborationRuntime:runtime});
  store=app.collaborationStore;
  const c=store.create({title:'资料校对',memberIds:['claude','codex'],defaultMemberId:'claude',requestId:randomUUID()}).conversation;
  const {url}=await app.start(),page=await browser.newPage();
  assert.notEqual(new URL(url).port,'4310');
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const wait=(fn,...args)=>page.waitForFunction(fn,{timeout:15000},...args);
  async function button(label){
    const h=await wait((selector,t)=>[...document.querySelectorAll(selector+' button')].find(b=>b.textContent.trim()===t && !b.disabled && b.getClientRects().length),card,label);
    try {await h.asElement().click();} finally {await h.dispose();}
  }
  async function send(content){
    await page.type(input,content); await page.click('.cc-send-button');
    await wait(sel=>document.querySelector(sel)?.value==='',input);
  }
  const support={width,url,passed:false};
  try{
    await page.setViewport({width,height:width>480?850:844});
    await page.goto(url,{waitUntil:'networkidle2'});
    await page.waitForSelector(input,{visible:true});
    await send('现在几点');
    await wait(()=>document.body.innerText.includes('普通答复完成'));
    assert.equal(await page.$(card),null);
    await send('请持续跟进资料校对');
    await wait(sel=>document.querySelector(sel+' summary')?.textContent.includes('需要处理'),card);
    await page.type(input,draft);
    await page.focus(card+' summary');
    await page.keyboard.press('Enter');
    await wait(sel=>document.querySelector(sel)?.open,card);
    await wait(sel=>document.querySelector(sel)?.innerText.includes('校对资料并回报'),card);
    await page.screenshot({path:join(base,'blocked.png')});
    await button('取消跟进…');await button('返回');
    await wait(sel=>document.activeElement===document.querySelector(sel+' summary'),card);
    assert.equal(store.obligations.list(c.id)[0].state,'blocked');
    await button('改派负责人…');
    await wait(sel=>document.activeElement===document.querySelector(sel+' select'),card);
    await page.keyboard.press('Escape');
    await wait(sel=>document.activeElement===document.querySelector(sel+' summary'),card);
    const note='请对照今天补充的会议记录。';
    await button('补充材料并复核…'); await page.type(card+' textarea',note);
    await page.evaluate(()=>{
      const original=window.fetch.bind(window);
      window.retryBodies=[];
      window.fetch=async(resource,options={})=>{
        const path=new URL(resource,location.href).pathname;
        if(path.endsWith('/retry') && options.method==='POST'){
          window.retryBodies.push(JSON.parse(options.body));
          if(window.retryBodies.length===1) {
            const committed=await original(resource,options);
            if(!committed.ok) return committed;
            return Response.json({error:'回执丢失，请重试'},{status:503});
          }
        }
        return original(resource,options);
      };
    });
    await button('提交材料并复核');
    await wait(sel=>document.querySelector(sel+' [role=alert]')?.textContent.includes('回执丢失'),card);
    assert.equal(await page.$eval(input,e=>e.value),draft);
    assert.equal(await page.$eval(card+' textarea',e=>e.value),note);
    await wait(()=>document.activeElement?.textContent==='重试上次操作');
    await page.keyboard.press('Enter');
    await wait(sel=>document.activeElement===document.querySelector(sel+' summary'),card);
    const bodies=await page.evaluate(()=>window.retryBodies);
    assert.equal(bodies.length,2);assert.deepEqual(bodies[0],bodies[1]);
    assert.equal(store.detail(c.id).sources.filter(s=>s.content.includes(note)).length,1);
    await wait(sel=>document.querySelector(sel+' summary')?.textContent.includes('需要处理'),card);
    await button('改派负责人…');
    const target=await page.$eval(card+' select',e=>e.options[1].value);
    await page.select(card+' select',target);
    await page.type(card+' textarea','请接手并核验材料'); await button('确认改派');
    await wait(sel=>document.querySelector(sel+' summary')?.textContent.includes('Codex 负责') &&
      document.querySelector(sel+' summary')?.textContent.includes('需要处理'),card);
    assert.equal(store.tasks.handoffs(c.id).filter(h=>h.state==='applied').length,1);
    await button('取消跟进…');
    await page.type(card+' form input, '+card+' form textarea','任务已结束');
    await button('确认取消');
    await wait(sel=>document.querySelector(sel+' summary')?.textContent.includes('已取消'),card);
    await wait(sel=>document.activeElement===document.querySelector(sel+' summary'),card);
    assert.equal(store.obligations.list(c.id)[0].state,'cancelled');
    assert.equal(await page.$eval(input,e=>e.value),draft);
    const geometry=await page.$eval(card,e=>{
      const r=e.getBoundingClientRect();return {width:r.width,left:r.left,right:r.right,viewport:innerWidth,body:document.documentElement.scrollWidth};
    });
    assert(geometry.left>=-1 && geometry.right<=width+1 && geometry.width>0 && geometry.body<=width+1,JSON.stringify(geometry));
    assert.deepEqual(errors,[]);
    await page.screenshot({path:join(base,'cancelled.png')});
    Object.assign(support,{passed:true,geometry,focus:'summary',lostCommittedReceiptReplayed:true,handoffAppliedOnce:true,draftPreserved:true,ordinaryCards:0,finalState:'cancelled'});
  }finally{
    runs.push(support);
    if(!support.passed) await page.screenshot({path:join(base,'failure.png')}).catch(()=>{});
    await page.close();await app.close();
  }
}
try{for(const width of [1390,390])await exercise(width);}
finally{
  await browser.close();
  const files=['web/ObligationReceipt.tsx','web/CollaborationApp.tsx','server/collaboration/obligations.ts','server/collaboration/http.ts','scripts/verify-hydra-receipt-ui.mjs'];
  const sha=createHash('sha256');
  for(const file of files)sha.update(file+'\0').update(await readFile(file));
  const result={dir,runs,testedUiSourceDigest:sha.digest('hex')};
  await writeFile(join(dir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
