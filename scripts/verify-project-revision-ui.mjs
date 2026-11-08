// Browser acceptance of project check revisions using isolated state, synthetic agents and synthetic test receipts.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../server/index.ts';
import { executeTool } from '../server/collaboration/runtime-common.ts';

const output = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/native-project-p8/ui/' + new Date().toISOString().replace(/[:.]/g, '-'));
const temp = await mkdtemp(join(tmpdir(), 'p7-ui-'));
const root = join(temp, '订单');
const sha = text => createHash('sha256').update(text).digest('hex');
const lock = JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'ui-only' } } });
const original = sha('before'), revised = sha('after');
const prompt = '@Codex 修复订单计算，运行测试、类型检查和构建后请 Claude Code 评审，有问题就继续改。';
const draft = '这段草稿留到下一轮';
const calls = [], decisions = [], checks = [], errors = [];
let scenario = 'roundtrip', cache = false, authors = 0;
let app, page, browser, cid;
const preparing = Promise.withResolvers(), testing = Promise.withResolvers();
const card = '.cc-message .cc-npm-download';
const checksArea = '.cc-message .cc-revision-evidence';
const composer = '#cc-message-input';
const available = { available: true, reason: 'UI fixture' };
const { default: puppeteer } = await import(process.env.PUPPETEER_PATH ? pathToFileURL(process.env.PUPPETEER_PATH).href : 'puppeteer-core');

try {
  await mkdir(output, { recursive: true });
  await mkdir(root);
  await writeFile(join(root, 'package-lock.json'), lock);
  await writeFile(join(root, 'order.js'), 'before');
  app = await createApplication({
    port: 0, dataDir: join(temp, 'db'), workspace: join(temp, 'workspace'),
    staticDir: resolve(process.env.VALIDATION_STATIC_DIR || 'dist/web'),
    collaborationRuntime: {
      projectWorkAvailability: () => available,
      probe: async () => ['claude-cli', 'codex-app-server'].map(carrier => ({carrier,installed:true,available:true,append:false,authentication:'cli',verified:'unverified',nativeProject:{api:available,cli:available}})),
      async runProjectReviewTest({ argv, signal, verifyAuthorization, npm, authorInvocationId }) {
        verifyAuthorization();
        assert.ok(npm);
        npm.onPhase('preparing');
        if (scenario === 'roundtrip' && authors === 1 && authorInvocationId) await preparing.promise;
        if (!cache) {
          await npm.authorizeDownload({ lockSha256: sha(lock), packages: ['example-test-kit@1.0.0'] });
          cache = true;
        }
        npm.onPhase('testing');
        if (scenario === 'roundtrip' && authors === 1 && authorInvocationId) await testing.promise;
        signal.throwIfAborted();
        const data = await readFile(join(root, 'order.js'), 'utf8');
        return { argv, snapshotSha256: sha(data), treeExited: true, output: 'synthetic test', truncated: false, exitCode: argv[2] === 'typecheck' && data === 'before' ? 1 : 0 };
      },
      async invoke(req) {
        calls.push(req.member.id);
        req.onEvent({kind:'accepted',detail:{source:'ui-fixture'}});
        try {
          if (req.projectWork) {
            authors++;
            if (scenario === 'roundtrip' && authors === 2) await writeFile(join(root,'order.js'),'after');
            await executeTool(req, 'project_npm_test', {}, 'author-test');
            if (authors === 2 && scenario === 'roundtrip') {
              for (const script of ['typecheck', 'build']) await executeTool(req, 'project_npm_test', {script}, 'author-' + script);
            }
            if (scenario === 'roundtrip' && authors === 1) {
              await executeTool(req, 'collaboration_request', {targets:['claude'], content:'请读取订单计算并独立测试。', projectReview:{paths:['order.js']}}, 'send-review');
            }
          } else {
            assert.ok(req.projectReview);
            await executeTool(req, 'project_review_read', {path:'order.js'}, 'review-read');
            await executeTool(req, 'project_review_test', {argv:['npm','test']}, 'independent-test');
            for (const script of ['typecheck','build']) {
              await executeTool(req, 'project_review_test', {argv:['npm','run',script]}, 'independent-' + script);
            }
          }
          return {text:'本轮已完成。',continuity:'unknown'};
        } finally { req.onEvent({kind:'process_exit',detail:{confirmed:true}}); }
      },
    },
  });
  const store = app.collaborationStore;
  const {conversation} = store.create({title:'依赖与修订',memberIds:['codex','claude'],defaultMemberId:'codex',requestId:randomUUID()});
  cid = conversation.id;
  const preview = store.workbench.previewWorkspace(conversation.id,{mode:'project-work',path:root,reviewMode:'project'});
  store.workbench.applyPreview({previewId:preview.id,requestId:randomUUID()},conversation.id);
  const { url } = await app.start();
  browser = await puppeteer.launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true,args:['--disable-background-networking','--no-first-run']});
  page = await browser.newPage();
  page.setDefaultTimeout(18000);
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', req => {if (/\/runtime-interactions\/[^/]+\/answer$/.test(req.url())) decisions.push(JSON.parse(req.postData()));});
  await page.setViewport({width:320,height:740});
  await page.goto(url,{waitUntil:'networkidle2'});
  async function send(content) {
    await page.waitForSelector(composer,{visible:true});
    await page.$eval(composer, field => field.focus());
    await page.keyboard.type(content);
    await page.click('.cc-send-button');
    await page.waitForFunction(sel => !document.querySelector(sel)?.value, {}, composer);
  }
  const latest = sel => [...document.querySelectorAll('.cc-message .cc-npm-download')].at(-1)?.querySelector(sel);
  async function press(action) {
    const target = await page.waitForFunction(latest, {}, action);
    await target.asElement().focus();
    await page.keyboard.press('Enter');
    await target.dispose();
  }
  const after = (fn, ...args) => page.waitForFunction(fn, {}, ...args);
  await send(prompt);
  await page.waitForFunction(() => document.querySelector('.cc-message .cc-project-test-list')?.innerText.includes('正在准备测试依赖'));
  preparing.resolve();
  await page.waitForSelector(card + ' [data-allow]',{visible:true});
  await page.click('.cc-live-summary button');
  assert.ok(await page.$eval(card,e=>e===document.activeElement));
  await page.type(composer, draft);
  await page.focus(card + ' summary');
  await page.keyboard.press('Enter');
  const text = await page.$eval(card, e => e.innerText);
  for (const phrase of ['订单','Codex','example-test-kit@1.0.0','https://registry.npmjs.org',sha(lock)]) assert.ok(text.includes(phrase), text);
  const geometry = await page.$eval(card, e => ({ viewport: innerWidth, width: document.documentElement.scrollWidth, buttons:[...e.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return [r.left,r.right,r.height];}) }));
  assert.equal(geometry.width,geometry.viewport);
  assert.ok(geometry.buttons.every(([left,right,height])=>left>=0 && right<=320 && right>left && height>=44));
  checks.push('320px card exposes member, project, registry, package and lock scope via keyboard');
  // A failed transport before acceptance must preserve the exact request on a retry.
  await page.evaluate(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = (...args) => {
      if (String(args[0]).includes('/runtime-interactions/') && args[1]?.method === 'POST') {
        window.fetch = fetch;
        return Promise.resolve(Response.json({error:'授权请求暂时失败'},{status:503}));
      }
      return fetch(...args);
    };
  });
  await press('[data-allow]');
  await after(sel => document.querySelector(sel+' [role="alert"]')?.textContent.includes('授权请求暂时失败'), card);
  await after(sel => document.activeElement === document.querySelector(sel+' [data-allow]'), card);
  assert.equal(await page.$eval(composer,e=>e.value),draft);
  await press('[data-allow]');
  await after(() => document.querySelector('.cc-message .cc-project-test-list')?.innerText.includes('正在运行测试'));
  testing.resolve();
  checks.push('live stages show dependency preparation, focus the exact pending request and then show test execution');
  await after(sel => [...document.querySelectorAll(sel)].some(e=>e.innerText.includes('复验通过')), checksArea);
  const final = await page.$$eval(checksArea, els=>els.at(-1).innerText);
  for (const part of ['npm test','npm run typecheck','npm run build','初评','复验','退出码 1','退出码 0',original.slice(0,12),revised.slice(0,12)]) assert.ok(final.includes(part), final);
  assert.equal(await page.$eval(composer,e=>e.value),draft);
  assert.deepEqual(calls,['codex','claude','codex','claude']);
  checks.push('retry after 503, one repair, fresh independent retest and version-specific receipts preserve composer draft');
  await page.screenshot({path:join(output,'retest-mobile.png')});
  await page.reload({waitUntil:'networkidle2'});
  await after(sel => [...document.querySelectorAll(sel)].some(e=>e.innerText.includes('复验通过')), checksArea);
  assert.deepEqual(calls,['codex','claude','codex','claude']);
  checks.push('refresh preserves the verdict without repeating the four executions');

  scenario='decline'; cache=false;
  await send('@Codex 修改订单文件并运行 npm test。');
  await press('[data-decline]');
  await after(sel => [...document.querySelectorAll(sel)].at(-1)?.innerText.includes('已拒绝下载'),card);
  await after(() => !document.querySelector('.cc-message .cc-native-project-activity button.cc-reply-button'));
  assert.equal(decisions.at(-1).decline,true);
  checks.push('decline from the active run records a refusal and does not start another execution');

  scenario='stop'; cache=false;
  await send('@Codex 修改订单文件并重新运行 npm test。');
  const pending = await after(sel => {
    const section = [...document.querySelectorAll(sel)].at(-1);
    return section?.querySelector('[data-allow]') && section.closest('.cc-native-project-activity')?.querySelector('button.cc-reply-button');
  },card);
  await pending.asElement().focus(); await page.keyboard.press('Enter'); await pending.dispose();
  await after(sel => [...document.querySelectorAll(sel)].at(-1)?.innerText.includes('下载请求已取消'),card);
  assert.equal(decisions.length,2);
  assert.equal(calls.length,6);
  checks.push('stopping the exact author run while waiting for permission closes its pending decision');
  assert.deepEqual(errors,[]);
  await writeFile(join(output,'result.json'),JSON.stringify({ok:true,checks,geometry,calls,realModels:0},null,2));
  console.log(JSON.stringify({ok:true,output,checks}));
} catch(e) {
  await page?.screenshot({path:join(output,'failure.png')}).catch(()=>{});
  let d; try { if (cid) d=app?.collaborationStore.detail(cid); } catch { /* service failed to start */ }
  const evidence=d && {invocations:d.invocations.map(i=>[i.memberId,i.status,i.error]),events:d.evidence.filter(e=>e.kind==='tool').map(e=>e.detail),interactions:d.interactions};
  await writeFile(join(output,'failure.json'),JSON.stringify({error:e.stack,evidence,calls,checks,errors},null,2));
  console.error(e); process.exitCode=1;
} finally { preparing.resolve(); testing.resolve(); await browser?.close(); await app?.close(); await rm(temp,{recursive:true,force:true}); }
