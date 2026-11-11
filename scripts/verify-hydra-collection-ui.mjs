// Exercises the compiled workbench and normal HTTP/engine entry points with an isolated runtime.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import puppeteer from 'puppeteer-core';
import {createApplication} from '../server/index.ts';

const dir = await mkdtemp(join(tmpdir(), 'hydra-collection-ui-'));
const browser = await puppeteer.launch({executablePath:process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking']});
const results = [];
async function exercise(width) {
  const runDir = join(dir, String(width));
  const workspace = join(runDir, 'workspace');
  await mkdir(workspace,{recursive:true});
  let store, root;
  let release;
  const hold = new Promise(done => {release = done;});
  const runtime = {probe:async()=>[], async invoke(request) {
    request.onEvent({kind:'accepted',detail:{fixture:true}});
    let text;
    const source = store.visibility.primary(request.invocationId);
    if (source.kind === 'multi_mention') {
      if (request.member.id === 'editor') await hold;
      text = request.member.id === 'editor' ? '校对者的意见' : '技术成员的意见';
    } else if (source.kind === 'user' && source.content === '请收集两位同伴的意见') {
      const opened = await request.onToolCall('obligation_open',{goal:'收集并交付意见'},'open');
      root = opened.obligation.id;
      await request.onToolCall('multi_mention',{targets:['codex','editor'],question:'请分别核对展签的文字',obligationId:root,timeoutMs:90000},'ask');
      text = '已发给同伴。';
    } else if (source.kind === 'user' && source.content === '过一会提醒我核稿') {
      const opened = await request.onToolCall('obligation_open',{goal:'提醒核稿'},'open-timer');
      await request.onToolCall('obligation_wait',{obligationId:opened.obligation.id,kind:'timer',condition:'提醒核稿',deadline:new Date(Date.now()+300000).toISOString()},'wait-timer');
      text = '到时提醒。';
    } else {
      text = '已汇集两位同伴的意见。';
      await request.onToolCall('obligation_deliver',{obligationId:root,summary:text},'deliver');
    }
    request.onEvent({kind:'process_exit',detail:{confirmed:true}});
    return {text,continuity:'unknown'};
  }};
  const app = await createApplication({port:0,dataDir:join(runDir,'db'),workspace,staticDir:resolve(process.env.VALIDATION_STATIC_DIR ?? 'dist/web'),collaborationRuntime:runtime});
  const page = await browser.newPage();
  try {
    store = app.collaborationStore;
    store.saveMember({...store.members()[0],id:'editor',name:'校对者'});
    store.create({title:'展签核验',memberIds:['claude','editor','codex'],defaultMemberId:'claude',requestId:randomUUID()});
    const {url} = await app.start(); assert.notEqual(new URL(url).port,'4310');
    const errors = []; page.on('pageerror',err=>errors.push(err.message));
    await page.setViewport({width,height:850}); await page.goto(url,{waitUntil:'networkidle2'});
    const input = '#cc-message-input';
    const card = '.cc-obligation'; const group = '.cc-obligation-group';
    await page.waitForSelector(input,{visible:true});
    const send = async msg => {await page.type(input,msg); await page.click('.cc-send-button');};
    const wait = (fn,...args) => page.waitForFunction(fn,{timeout:20000},...args);
    await send('请收集两位同伴的意见');
    await wait(s=>document.querySelector(s)?.textContent.includes('1/2'),card+' > summary');
    await page.focus(card+' > summary'); await page.keyboard.press('Enter');
    await wait(s=>document.querySelector(s)?.innerText.includes('等待校对者的答复'),group);
    assert.match(await page.$eval(group,el=>el.innerText),/技术成员的意见/);
    await page.type(input,'保留这条草稿');
    await page.screenshot({path:join(runDir,'waiting.png')});
    release();
    await wait(s=>document.querySelector(s)?.textContent.includes('已交付'),card+' > summary');
    if (!await page.$eval(group,el=>el.open)) {await page.focus(group+' > summary');await page.keyboard.press('Enter');}
    await wait(s=>document.querySelector(s)?.innerText.includes('校对者的意见'),group);
    assert.match(await page.$eval(group,el=>el.innerText),/已收齐 · 2\/2/);
    assert.equal(await page.$eval(input,el=>el.value),'保留这条草稿');
    await page.screenshot({path:join(runDir,'delivered.png')});
    await page.focus(input); await page.keyboard.press('Home');
    await page.$eval(input,el=>el.select()); await page.keyboard.press('Backspace');
    await send('过一会提醒我核稿');
    await wait(s=>[...document.querySelectorAll(s)].some(el=>el.textContent.includes('等待约定时间')),card+' > summary');
    const timer=await page.evaluateHandle(s=>[...document.querySelectorAll(s)].find(el=>el.querySelector('summary')?.textContent.includes('等待约定时间')),card);
    await (await timer.asElement().$('summary')).click();
    const timerText=await timer.evaluate(el=>el.innerText);
    assert.match(timerText,/提醒核稿/); assert.doesNotMatch(timerText,/补充实际结果/);
    const pageWidth=await page.evaluate(()=>document.documentElement.scrollWidth); assert(pageWidth<=width);
    assert.deepEqual(errors,[]);
    results.push({width,pageWidth,partial:'1/2',complete:'2/2',keyboard:true,draftPreserved:true,timer:true});
  } finally {release(); await page.close(); await app.close();}
}
try {for(const width of [1390,390]) await exercise(width);}
finally {await browser.close();await writeFile(join(dir,'result.json'),JSON.stringify({dir,results},null,2));console.log(JSON.stringify({dir,results}));}
