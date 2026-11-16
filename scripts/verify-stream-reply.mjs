import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import puppeteer from 'puppeteer-core';
import {createApplication} from '../server/index.ts';
const dir=await mkdtemp(join(tmpdir(),'stream-reply-'));
let release;
const gate=new Promise(r=>{release=r});
const app=await createApplication({port:0,dataDir:join(dir,'db'),workspace:join(dir,'work'),staticDir:resolve(process.env.VALIDATION_STATIC_DIR || 'dist/web'),
  collaborationRuntime:{probe:async()=>[],invoke:async req=>{
    const emit=(kind,detail)=>req.onEvent({kind,detail});
    emit('accepted',{evidence:'fixture'});emit('diagnostic',{notification:'item/started',itemType:'reasoning'});
    emit('tool',{callId:'read1',name:'Read',state:'started',path:'orders.ts'});emit('text',{text:'第一段'});
    await gate;
    emit('tool',{callId:'read1',name:'Read',state:'completed'});emit('text',{text:'，第二段。'});
    emit('process_exit',{confirmed:true});return {text:'第一段，第二段。',continuity:'fresh'};
  }}});
const b=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
  const {url}=await app.start();const p=await b.newPage();await p.goto(url);
  await p.waitForSelector('#cc-message-input');await p.type('#cc-message-input','检查订单');await p.click('.cc-send-button');
  await p.waitForFunction(()=>document.querySelector('.cc-message-member .cc-prose')?.textContent==='第一段');
  const summary='.cc-reply-process > summary';await p.click(summary);
  assert.equal(await p.$eval('.cc-reply-process',el=>el.open),false);
  release();await p.waitForFunction(()=>document.querySelector('.cc-message-member .cc-prose')?.textContent==='第一段，第二段。');
  await p.waitForSelector('[data-record-run]');await p.reload();await p.waitForSelector(summary);
  assert.equal(await p.$eval('.cc-reply-process',el=>el.open),false);await p.click(summary);
  assert.match(await p.$eval('.cc-reply-process',el=>el.textContent),/1 次工具调用/);
  assert.match(await p.$eval('.cc-reply-process',el=>el.textContent),/已完成/);
  console.log('Browser verified partial before finish, final replacement, tool grouping, folding and refresh.');
} finally {release();await b.close();await app.close()}
