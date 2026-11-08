/** Uses the real application, an isolated project, and deterministic member callbacks. No model credentials or VM needed. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../server/index.ts';
import { executeTool } from '../server/collaboration/runtime-common.ts';

const output = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/native-project-p6/ui/'+new Date().toISOString().replace(/[:.]/g,'-'));
const temp = await mkdtemp(join(tmpdir(),'project-review-ui-'));
const project = join(temp,'账本');
const input = '#cc-message-input';
const card = '.cc-project-review-evidence';
const filename = 'ledger-summary.csv';
const untouched = 'details.txt';
const discovered = 'coverage.md';
const delegation = '@Codex 修改月报文件，跑通原测试后请 Claude Code 评审。';
const draft = '等我确认后再修改';
const digest = text => createHash('sha256').update(text).digest('hex');
const calls = [], checks = [], errors = [];
const { default: puppeteer } = await import(process.env.PUPPETEER_PATH ? pathToFileURL(process.env.PUPPETEER_PATH).href : 'puppeteer-core');
let app, browser, page;
let skipReviewRead = false;
try {
  await mkdir(output,{recursive:true});
  await mkdir(project);
  const available = {available:true,reason:'浏览器验证夹具'};
  app = await createApplication({
    port:0, workspace:join(temp,'default'), dataDir:join(temp,'private'), staticDir:resolve(process.env.VALIDATION_STATIC_DIR || 'dist/web'),
    collaborationRuntime:{
      projectWorkAvailability:()=>available,
      runProjectReviewTest:async({argv,verifyAuthorization})=>{
        verifyAuthorization();
        if (argv[0]==='interrupted') throw new Error('Synthetic interrupted review test');
        return {argv,exitCode:argv[0]==='false'?1:0,output:'synthetic result',truncated:false,snapshotSha256:digest('synthetic snapshot'),treeExited:true};
      },
      probe:async()=>['claude-cli','codex-app-server'].map(carrier=>({carrier,installed:true,available:true,append:false,authentication:'cli',verified:'unverified',nativeProject:{api:available,cli:available}})),
      invoke:async req=>{
        calls.push(req.member.id);
        req.onEvent({kind:'accepted',detail:{source:'ui-fixture'}});
        if(req.projectWork) {
          assert.equal(req.account.id,'codex-cli');
          assert.equal(req.account.auth,'cli');
          await writeFile(join(project,filename),'original');
          await executeTool(req,'collaboration_request',{targets:['claude'],content:'请独立核对月报字段。',projectReview:{paths:[filename,untouched]}},'writer-review');
        } else if(req.projectReview) {
          assert.equal(req.account.id,'glm-review-ui');
          assert.equal(req.account.auth,'api');
          assert.equal(req.member.model,'glm-5.3');
          if (req.projectReview.mode==='project' && !req.projectReview.rereadOf) {
            const page = await executeTool(req,'project_review_list',{},'browse');
            assert.ok(page.entries.some(entry=>entry.name===discovered));
            await executeTool(req,'project_review_read',{path:discovered},'read-extra');
            for (const cmd of ['false','true']) await executeTool(req,'project_review_test',{argv:[cmd]},'test-'+cmd);
            await assert.rejects(executeTool(req,'project_review_test',{argv:['interrupted']},'test-incomplete'));
          }
          if (!skipReviewRead) await executeTool(req,'project_review_read',{path:filename},'read-summary');
          if (!req.projectReview.rereadOf) await writeFile(join(project,filename),'edited while the member reviewed');
        } else throw new Error('Unexpected fixture invocation');
        req.onEvent({kind:'process_exit',detail:{confirmed:true}});
        return {text:req.projectWork ? '已生成月报并请同伴核对。' : '已核对月报字段。',continuity:'unknown'};
      },
    },
  });
  const store = app.collaborationStore;
  store.saveAccount({id:'glm-review-ui',provider:'claude',auth:'api',name:'合成智谱账户',baseUrl:'https://open.bigmodel.cn/api/anthropic',apiKeyEnv:'P5_SYNTHETIC_UI_KEY'});
  const reviewer = store.members().find(m => m.id === 'claude');
  store.saveMember({...reviewer,accountBinding:'override',accountId:'glm-review-ui',modelBinding:'override',model:'glm-5.3'});
  const {conversation} = store.create({title:'月报评审',memberIds:['codex','claude'],defaultMemberId:'codex',requestId:randomUUID()});
  const preview = store.workbench.previewWorkspace(conversation.id,{mode:'project-work',path:project});
  store.workbench.applyPreview({previewId:preview.id,requestId:randomUUID()},conversation.id);
  const {url} = await app.start();
  browser = await puppeteer.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking','--no-first-run']});
  page = await browser.newPage();
  page.on('pageerror',e=>errors.push(e.message));
  page.setDefaultTimeout(12000);
  await page.setViewport({width:1390,height:850});
  await page.goto(url,{waitUntil:'networkidle2'});
  const wait = (fn,...args)=>page.waitForFunction(fn,{},...args);
  async function hasText(selector,value) {
    await wait((sel,t)=>document.querySelector(sel)?.textContent.includes(t),selector,value);
  }
  async function button(text,cardIndex=0) {
    const match = await wait((sel,t,index)=>{
      const section = Array.from(document.querySelectorAll(sel)).at(index);
      return section && Array.from(section.querySelectorAll('button')).find(b=>b.textContent.trim()===t && !b.disabled && b.getClientRects().length);
    },card,text,cardIndex);
    await match.asElement().click();
    await match.dispose();
  }
  async function assertDraft() {assert.equal(await page.$eval(input,e=>e.value),draft);}
  await page.waitForSelector(input);
  const messagePath = '/api/conversations/'+conversation.id+'/messages';
  const sent = [];
  page.on('request', req => {
    if (new URL(req.url()).pathname === messagePath && req.method() === 'POST') sent.push(JSON.parse(req.postData()));
  });
  // Lose the first acknowledgement after the real server has accepted the message.
  await page.evaluate(path => {
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const result = await fetch(...args);
      if (new URL(result.url).pathname === path && args[1]?.method === 'POST' && result.ok) {
        window.fetch = fetch;
        return Response.json({error:'发送回执暂未收到'},{status:503});
      }
      return result;
    };
  },messagePath);
  await page.type(input,delegation);
  await page.click('.cc-send-button');
  await wait(() => document.body.innerText.includes('发送回执暂未收到'));
  assert.equal(await page.$eval(input,e=>e.value),delegation);
  await page.click('.cc-send-button');
  await wait(sel => document.querySelector(sel).value === '',input);
  assert.equal(sent.length,2);
  assert.deepEqual(sent[1],sent[0]);
  await hasText(card+' summary','已读取 1/2');
  await hasText(card+' summary','文件已变化');
  const firstReview = store.detail(conversation.id);
  const [writer,reader] = firstReview.invocations;
  const [original,a2a] = firstReview.sources;
  assert.equal(firstReview.sources.length,2);
  assert.deepEqual(original.requestedTargets,['codex']);
  assert.equal(a2a.parentInvocationId,writer.id);
  assert.deepEqual(a2a.requestedTargets,['claude']);
  assert.equal(reader.memberId,'claude');
  assert.equal(firstReview.messages.filter(m=>m.author==='user').length,1);
  const origin = firstReview.messages.find(m=>m.sourceId===a2a.id && m.memberId==='codex');
  assert.ok(origin);
  checks.push('a lost send acknowledgement retries the same request and yields one Codex assignment and one Claude review');
  await writeFile(join(project,filename),'original');
  await page.type(input,draft);
  await page.focus(card+' summary');
  await page.keyboard.press('Enter');
  await hasText(card+'[open] li','与读取时一致');
  assert.equal(await page.$eval(card+' li small',e=>e.title),digest('original'));
  await hasText(card,'还没有读取回执');
  await hasText(card,'给出原结论前，文件已经发生变化。');
  const requestLink = card+' a.cc-reply-reference';
  assert.equal(await page.$eval(requestLink,a=>a.textContent),'查看 Codex 的评审请求');
  assert.equal(await page.$eval(requestLink,a=>a.hash),'#message-'+origin.id);
  await page.focus(requestLink);
  await page.keyboard.press('Enter');
  await wait(id=>document.activeElement.id==='message-'+id,origin.id);
  await assertDraft();
  assert.deepEqual(calls,['codex','claude']);
  await page.screenshot({path:join(output,'desktop.png')});
  checks.push('desktop keyboard opens review, shows one actual digest and one unread path, and focuses the exact author request');

  await writeFile(join(project,filename),'edited in the editor');
  await button('核对当前文件');
  await hasText(card+' li','读取后有改动');
  await assertDraft();
  assert.deepEqual(calls,['codex','claude']);
  checks.push('current file check detects an external edit, with no model call or draft change');
  await page.setViewport({width:320,height:720});
  await wait(()=>document.querySelector('.cc-sidebar').getBoundingClientRect().right<=1);
  await hasText(card+'[open] li','读取后有改动');
  await assertDraft();
  const geometry = await page.$eval(card,el=>{
    el.scrollIntoView({block:'center'});
    const controls = [...el.querySelectorAll('button')].filter(b=>!b.disabled);
    return {pageWidth:document.documentElement.scrollWidth,viewport:innerWidth,controls:controls.map(b=>{const r=b.getBoundingClientRect();return [r.left,r.right];})};
  });
  assert.ok(geometry.pageWidth<=geometry.viewport,JSON.stringify(geometry));
  for(const [left,right] of geometry.controls) assert.ok(right>left && left>=0 && right<=geometry.viewport,JSON.stringify(geometry));
  await page.screenshot({path:join(output,'mobile.png')});
  checks.push('320px reread and check actions fit without horizontal page scrolling');

  await page.setRequestInterception(true);
  let failOnce=true;
  page.on('request',req=>{
    if(failOnce && req.method()==='POST' && req.url().endsWith('/reread')) {
      failOnce=false;
      void req.respond({status:503,contentType:'application/json',body:JSON.stringify({error:'测试：请求暂时失败'})});
    } else void req.continue();
  });
  await button('请成员重新读取并评审');
  await page.waitForSelector(card+' [role=alert]',{visible:true});
  await assertDraft();
  assert.deepEqual(calls,['codex','claude']);
  await button('请成员重新读取并评审');
  await wait(sel=>document.querySelectorAll(sel).length===2,card);
  const reviewRuns = store.detail(conversation.id).invocations.filter(i=>i.memberId==='claude');
  assert.equal(reviewRuns.length,2);
  const latest = store.detail(conversation.id).sources.at(-1);
  assert.equal(latest.kind,'user');
  assert.equal(latest.projectReview.rereadOf,reviewRuns[0].id);
  assert.deepEqual(calls,['codex','claude','claude']);
  await assertDraft();
  checks.push('failed reread retains draft and retries once through the real service under the original reviewer');

  // Reload after verifying draft preservation through the operations. A hard reload starts a new composer session.
  await page.reload({waitUntil:'networkidle2'});
  await wait(sel=>document.querySelectorAll(sel).length===2,card);
  await hasText(card+' summary','已请求重新评审');
  await hasText(card+' summary','文件已变化');
  await page.focus(card+' summary'); await page.keyboard.press('Enter');
  await wait(sel=>[...document.querySelector(sel).querySelectorAll('button')].some(b=>b.textContent.trim()==='已请求重新评审' && b.disabled),card);
  assert.equal(store.detail(conversation.id).sources.length,3);
  checks.push('refresh restores the original stale-at-reply warning and suppresses duplicate reread');
  await page.$$eval(card+' summary',els=>els.at(-1).click());
  await wait((sel,sha)=>[...document.querySelectorAll(sel)].at(-1).querySelector('li small')?.title===sha && [...document.querySelectorAll(sel)].at(-1).querySelector('li')?.textContent.includes('与读取时一致'),card,digest('edited in the editor'));
  assert.deepEqual(calls,['codex','claude','claude']);
  checks.push('after reload, latest review displays the new file digest and no further execution');
  const latestReview = await page.$$(card);
  assert.equal(await latestReview.at(-1).$eval('a.cc-reply-reference',a=>a.hash),'#message-'+origin.id);
  // A new reviewer response claims success without reading. Earlier runs' receipts must stay with those runs.
  skipReviewRead = true;
  await button('请成员重新读取并评审',-1);
  await wait(sel=>document.querySelectorAll(sel).length===3 &&
    [...document.querySelectorAll(sel)].at(-1).closest('article').querySelector('.cc-prose')?.textContent==='已核对月报字段。',card);
  const withoutReads = (await page.$$(card)).at(-1);
  assert.match(await withoutReads.$eval('summary',e=>e.textContent),/已读取 0\/2/);
  await withoutReads.$eval('summary',e=>e.click());
  assert.deepEqual(await withoutReads.$$eval('li span',els=>els.map(el=>el.textContent)),['还没有读取回执','还没有读取回执']);
  assert.equal((await withoutReads.$$('li small')).length,0);
  assert.deepEqual(calls,['codex','claude','claude','claude']);
  assert.deepEqual(errors,[]);
  checks.push('a completed review with no tool reads shows zero files read and no file digests despite its success text');
  assert.equal((await page.$$(card+' [aria-label="独立测试"]')).length,0);
  const expanded=store.workbench.previewWorkspace(conversation.id,{mode:'project-work',useCurrent:true,reviewMode:'project'});
  store.workbench.applyPreview({previewId:expanded.id,requestId:randomUUID()},conversation.id);
  await writeFile(join(project,discovered),'new evidence');
  skipReviewRead=false;
  await page.type(input,delegation);
  await page.click('.cc-send-button');
  await wait(sel=>document.querySelectorAll(sel).length===4 &&
    [...document.querySelectorAll(sel)].at(-1).closest('article').querySelector('.cc-prose')?.textContent==='已核对月报字段。',card);
  const expandedCard=(await page.$$(card)).at(-1);
  await expandedCard.$eval('summary',e=>e.focus()); await page.keyboard.press('Enter');
  await wait(sel=>[...document.querySelectorAll(sel)].at(-1).textContent.includes('失败 · 退出码 1'),card);
  assert.match(await expandedCard.$eval('summary',e=>e.textContent),/已读取 2\/3/);
  const additional=await expandedCard.$$eval('li',els=>els.find(el=>el.querySelector('code')?.textContent==='coverage.md')?.querySelector('small')?.title);
  assert.equal(additional,digest('new evidence'));
  const testRows=(sel)=>[...document.querySelectorAll(sel)].at(-1).querySelector('[aria-label="独立测试"]').innerText;
  const expandedText=await page.evaluate(testRows,card);
  for(const label of ['失败 · 退出码 1','通过 · 退出码 0','未取得完整结果']) assert.ok(expandedText.includes(label),expandedText);
  assert.equal((await page.$$(card+' [aria-label="独立测试"]')).length,1);
  await page.screenshot({path:join(output,'expanded-mobile.png')});
  checks.push('opt-in review adds a discovered file with the correct digest and distinguishes exit 0, exit 1 and interrupted tests at 320px; old review cards retain their file-only scope');
  await page.reload({waitUntil:'networkidle2'});
  await wait(sel=>document.querySelectorAll(sel).length===4,card);
  const restored=(await page.$$(card)).at(-1);
  await restored.$eval('summary',e=>e.click());
  const persisted=await page.evaluate(testRows,card);
  assert.equal(persisted,expandedText);
  assert.deepEqual(calls,['codex','claude','claude','claude','codex','claude']);
  checks.push('refresh preserves completed and interrupted test receipts without rerunning either member');
  await button('请成员重新读取并评审',-1);
  await wait(sel=>document.querySelectorAll(sel).length===5 &&
    [...document.querySelectorAll(sel)].at(-1).closest('article').querySelector('.cc-prose')?.textContent==='已核对月报字段。',card);
  await page.$$eval(card+' summary',els=>els.at(-1).click());
  assert.match(await page.evaluate(testRows,card),/暂无测试执行回执/);
  assert.deepEqual(calls,['codex','claude','claude','claude','codex','claude','claude']);
  assert.deepEqual(errors,[]);
  checks.push('reread which never tests displays no test receipt and does not inherit a prior failure or success');
  await writeFile(join(output,'result.json'),JSON.stringify({ok:true,checks,calls,syntheticInvocations:calls.length,realInvocations:0,geometry,errors},null,2));
  console.log(JSON.stringify({ok:true,output,checks:checks.length,syntheticInvocations:calls.length,realInvocations:0}));
} catch(e) {
  await page?.screenshot({path:join(output,'failed.png')}).catch(()=>{});
  await writeFile(join(output,'failure.json'),JSON.stringify({error:e.stack,checks,calls,errors},null,2));
  console.error(e); process.exitCode=1;
} finally {
  await browser?.close(); await app?.close(); await rm(temp,{recursive:true,force:true});
}
