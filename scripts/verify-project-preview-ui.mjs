// Exercise the actual preview listener, browser sandbox and workbench, with a temporary project and database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../server/index.ts';
import { openWorkspaceTool } from './ui-workspace.mjs';

const {default:puppeteer}=await import(process.env.PUPPETEER_PATH ? pathToFileURL(process.env.PUPPETEER_PATH).href : 'puppeteer-core');
const temp=await mkdtemp(join(await realpath(tmpdir()),'preview-ui-'));
const output=resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/project-preview/'+randomUUID());
const project=join(temp,'收据'), marker=randomUUID();
const checks=[];
let app,browser;
try {
  await mkdir(output,{recursive:true}); await mkdir(join(project,'dist/assets'),{recursive:true});
  app=await createApplication({port:0,dataDir:join(temp,'db'),workspace:join(temp,'default'),startWorker:false,
    staticDir:resolve(process.env.VALIDATION_STATIC_DIR || 'dist/web'),collaborationRuntime:{probe:async()=>[],invoke:async()=>{throw Error('unexpected model');}}});
  const store=app.collaborationStore;
  const cid=store.create({title:'项目预览',memberIds:['codex'],defaultMemberId:'codex',requestId:randomUUID()}).conversation.id;
  const selection=store.workbench.previewWorkspace(cid,{path:project,mode:'read-only'});
  store.workbench.applyPreview({previewId:selection.id,requestId:randomUUID()},cid);
  const {url}=await app.start();
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-first-run','--disable-background-networking']});
  const page=await browser.newPage(); page.setDefaultTimeout(14000);
  await page.setViewport({width:1100,height:800});
  await page.goto(url); await openWorkspaceTool(page,'preview');
  const panel='#cc-workspace .cc-site-preview';
  async function click(label) {
    const handle=await page.waitForFunction((s,t)=>[...document.querySelectorAll(s+' button')].find(n=>n.textContent===t&&!n.disabled),{},panel,label);
    await handle.asElement().focus(); await page.keyboard.press('Enter'); await handle.dispose();
  }
  await click('启动预览');
  await page.waitForFunction(s=>document.querySelector(s).innerText.includes('没有找到可预览的 index.html'),{},panel);
  checks.push('missing index reports an actionable error');
  await writeFile(join(project,'dist/index.html'),'<!doctype html><html lang="zh"><meta charset="UTF-8"><style>body{font:18px system-ui;color:#304138;padding:1rem}</style><h1>收据</h1><button id="check">核对编号</button><output></output><script type="module" src="/assets/index.js"></script></html>');
  await writeFile(join(project,'dist/assets/index.js'),'document.querySelector("#check").onclick=()=>document.querySelector("output").textContent='+JSON.stringify(marker));
  await click('重新启动预览');
  const inner=await page.waitForFrame(f=>f.url().includes('.localhost:') && new URL(f.url()).pathname==='/');
  await inner.waitForFunction(()=>typeof document.querySelector('#check')?.onclick==='function');
  await page.screenshot({path:join(output,'before.png')});
  await inner.click('#check'); assert.equal(await inner.$eval('output',n=>n.textContent),marker);
  await page.screenshot({path:join(output,'after.png')});
  assert.equal(await inner.evaluate(()=>{try {return !!window.top.document;}catch {return false;}}),false);
  const first=await page.$eval(panel+' iframe',n=>n.src);
  assert.notEqual(new URL(first).origin,new URL(url).origin);
  checks.push('actual project HTML loads its absolute module asset and responds to a browser click in an isolated origin');
  await click('收起预览'); await click('打开预览');
  await page.reload(); await openWorkspaceTool(page,'preview'); await page.waitForSelector(panel+' iframe');
  assert.equal(await page.$eval(panel+' iframe',n=>n.src),first);
  checks.push('reopening and refreshing use the same listener');
  await page.setViewport({width:320,height:780});
  if(!(await page.$(panel+' ol'))) await click('查看日志');
  await page.waitForFunction(s=>document.querySelector(s+' ol')?.textContent.includes('200 · /assets/index.js'),{},panel);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await click('停止预览'); await page.waitForFunction(s=>document.querySelector(s+' [role="status"]').textContent==='已停止',{},panel);
  assert.equal(await page.$(panel+' iframe'),null);
  await assert.rejects(fetch('http://127.0.0.1:'+new URL(first).port,{signal:AbortSignal.timeout(1000)}));
  checks.push('320px logs show real asset requests, keyboard stop closes actual listener');
  await click('重新启动预览'); await page.waitForSelector(panel+' iframe');
  assert.notEqual(await page.$eval(panel+' iframe',n=>n.src),first);
  await writeFile(join(output,'result.json'),JSON.stringify({passed:true,marker,checks,realModelCalls:0},null,2));
  console.log('PASS',output,checks.length);
} finally { await browser?.close(); await app?.close(); await rm(temp,{recursive:true,force:true}); }
