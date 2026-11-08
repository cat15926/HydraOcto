// Real project conversation and HTTP decisions, using a scripted member in a temporary project.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../server/index.ts';
import { executeTool } from '../server/collaboration/runtime-common.ts';
import { NativeFileApprovals } from '../server/collaboration/native-file-approval.ts';
import { closeWorkspace, openWorkspaceTool } from './ui-workspace.mjs';

const {default: puppeteer} = await import(process.env.PUPPETEER_PATH ? pathToFileURL(process.env.PUPPETEER_PATH).href : 'puppeteer-core');
const temp = await mkdtemp(join(await realpath(tmpdir()), 'project-permission-ui-'));
const project = join(temp, '月报');
const output = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/project-native-permissions/' + randomUUID());
const checks = [], errors = [], outcomes = [], retries = [];
const composer = '#cc-message-input', permissions = '.cc-message .cc-native-file-permission';
const draft = '第二条消息的草稿';
const existingMcp = process.env.COLLAB_MCP_READERS;
let app, browser, page, cid, current;
let count = 0;
const commandResult = Promise.withResolvers();
try {
  await mkdir(project); await mkdir(output, {recursive:true});
  process.env.COLLAB_MCP_READERS = JSON.stringify([{id:'guide',label:'项目手册',url:'http://127.0.0.1:12111/mcp',tool:'read',parameter:'term',readOnly:true}]);
  process.env.PERMISSION_UI_TEST_KEY = 'fixture';
  const available = {available:true};
  app = await createApplication({
    port:0, workspace:join(temp,'default'), dataDir:join(temp,'db'), staticDir:resolve(process.env.VALIDATION_STATIC_DIR || 'dist/web'),
    collaborationRuntime: {
      projectWorkAvailability:() => available, probe:async () => [],
      async runProjectReviewTest({argv,signal,verifyAuthorization}) {
        verifyAuthorization(); assert.equal(argv.at(-1).split('/').at(-1),'pwd');
        await commandResult.promise;
        signal.throwIfAborted(); verifyAuthorization();
        return {argv,output:'/work\n',exitCode:0,truncated:false,snapshotSha256:createHash('sha256').update('fixture snapshot').digest('hex'),treeExited:true};
      },
      async invoke(req) {
        assert(req.projectWork && req.workspaceGrant.nativeFileApprovals);
        const index = ++count;
        const thread = randomUUID(), turn = randomUUID(), item = randomUUID(), rid = randomUUID();
        req.onEvent({kind:'session',detail:{nativeSessionId:thread,nativeTurnId:turn}});
        req.onEvent({kind:'accepted',detail:{source:'scripted-permission-member',nativeSessionId:thread,nativeTurnId:turn}});
        const path = 'report-' + index + '.txt', contents = '月报第 ' + index + ' 版\n';
        const gate = new NativeFileApprovals(req);
        current = {rid, close:() => gate.closeRequest(rid)};
        let result;
        if (index === 7) {
          // A native tool completion with the same identifiers cannot confirm this managed command.
          req.onEvent({kind:'tool',detail:{origin:'native',nativeSessionId:thread,nativeTurnId:turn,callId:item,
            name:'commandExecution',state:'completed',exitCode:41}});
          const answer = await executeTool(req,'project_environment_check',{command:'pwd'},item);
          assert.equal(answer.exitCode,0);
          result = 'managed';
        } else if (index === 5) {
          await gate.unavailable(thread,turn,item,rid,'item/permissions/requestApproval','https://records.example.invalid');
          result = 'decline';
        } else if (index === 6) {
          const resultMessage = await req.onInteraction({kind:'approval',operation:'can_use_tool/Bash',
            providerRequestId:rid,nativeSessionId:thread,nativeTurnId:turn,nativeItemId:item,
            nativeCommand:{command:'pwd',cwd:'/mnt/project'},payload:{grantRevision:req.workspaceGrant.revision}});
          result = resultMessage.state === 'answered' ? 'accept' : resultMessage.state;
        } else {
          const exact = [{path:'/mnt/project/'+path,kind:{type:'add'},diff:contents}];
          gate.observe(thread,turn,item,{action:'create',path,preview:contents},exact);
          result = await gate.decide(thread,turn,item,rid,'codex',exact);
        }
        if (result === 'accept') {
          if (index !== 6) await writeFile(join(project,path),contents,{flag:'wx'});
          req.onEvent({kind:'tool',detail:{origin:'native',carrier:req.member.carrier,nativeSessionId:thread,nativeTurnId:turn,
            callId:item,name:index === 6 ? 'commandExecution' : 'fileChange',state:'completed',sequence:1}});
        }
        outcomes.push(result);
        req.onEvent({kind:'process_exit',detail:{confirmed:true}});
        return {text:'已处理本轮请求。',continuity:'unknown'};
      },
    },
  });
  const store = app.collaborationStore;
  const key = store.saveAccount({id:'test-api',name:'测试账户',provider:'codex',auth:'api',apiKeyEnv:'PERMISSION_UI_TEST_KEY',baseUrl:'https://example.invalid'});
  store.saveMember({...store.members().find(m => m.id === 'codex'),accountId:key.id,accountBinding:'override',model:'fixture'});
  const claude = store.saveAccount({id:'claude-api',name:'测试账户 Claude',provider:'claude',auth:'api',apiKeyEnv:'PERMISSION_UI_TEST_KEY',baseUrl:'https://example.invalid'});
  store.saveMember({...store.members().find(m => m.id === 'claude'),accountId:claude.id,accountBinding:'override',model:'fixture'});
  cid = store.create({title:'核对月报',memberIds:['codex','claude'],defaultMemberId:'codex',requestId:randomUUID()}).conversation.id;
  const initial = store.workbench.previewWorkspace(cid,{path:project,mode:'project-work',reviewMode:'project',mcpReaderId:'guide'});
  store.workbench.applyPreview({previewId:initial.id,requestId:randomUUID()},cid);
  const grant = () => store.workbench.conversation(cid).workspaceGrant;
  const {url} = await app.start();
  browser = await puppeteer.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking','--no-first-run']});
  page = await browser.newPage(); page.on('pageerror',e => errors.push(e.message)); page.setDefaultTimeout(12000);
  async function keyButton(selector, name) {
    const handle = await page.waitForFunction((sel, label) => [...document.querySelectorAll(sel+' button')].find(b => b.textContent.trim() === label && b.getClientRects().length && !b.disabled),{},selector,name);
    await handle.asElement().focus(); await page.keyboard.press('Enter'); await handle.dispose();
  }
  const waitText = (selector, text) => page.waitForFunction((sel, value) => document.querySelector(sel)?.textContent.includes(value),{},selector,text);
  const draftIntact = async () => assert.equal(await page.$eval(composer,el=>el.value),draft);
  await page.setViewport({width:1280,height:860}); await page.goto(url,{waitUntil:'networkidle2'});
  await page.type(composer,draft); await openWorkspaceTool(page,'project');
  async function configure(apply) {
    await keyButton('#cc-workspace','项目权限');
    const toggle = '.cc-project-preview input[data-project-native-approval]';
    await page.waitForSelector(toggle);
    await page.focus(toggle); await page.keyboard.press('Space');
    await page.waitForFunction(s => document.querySelector(s)?.checked && !document.querySelector(s).disabled && document.activeElement === document.querySelector(s),{},toggle);
    assert.equal(await page.$eval('.cc-project-reader select',el => el.value),'guide');
    await keyButton('.cc-project-preview',apply ? '确认项目工作授权' : '取消');
    await page.waitForSelector('.cc-project-preview',{hidden:true});
    assert.equal(grant().nativeFileApprovals === true,apply);
  }
  await configure(false); await configure(true);
  assert.equal(grant().reviewMode,'project'); assert.equal(grant().mcpReader.id,'guide');
  await closeWorkspace(page); await draftIntact();
  checks.push('Existing project permissions can be changed or cancelled with the keyboard while retaining the selected reader, review permission and draft.');
  // An updated member identity needs a renewed project grant. The existing review and reader settings travel with it.
  store.saveMember({...store.members().find(m => m.id === 'codex'),instructions:'在项目中协助核对月报。'});
  async function request(index) {
    if (index > 1) await page.waitForFunction(()=>!document.querySelector('.cc-live-summary'));
    await page.focus(composer); await page.$eval(composer,el=>el.select()); await page.keyboard.press('Backspace');
    await page.type(composer,(index === 6 ? '@Claude Code' : '@Codex')+' 请在项目中创建文件 report-'+index+'.txt'); await page.keyboard.press('Enter');
    if (index === 1) {
      await keyButton('.cc-project-intent','核对当前项目');
      const preview = '.cc-project-intent .cc-project-preview';
      await page.waitForSelector(preview,{visible:true});
      const preserved = await page.$eval(preview,el => [
        el.querySelector('[data-project-native-approval]').checked,
        [...el.querySelectorAll('label')].find(label=>label.textContent.includes('允许评审成员')).querySelector('input').checked,
        el.querySelector('.cc-project-reader select').value,
      ]);
      assert.deepEqual(preserved,[true,true,'guide']);
      await keyButton(preview,'确认并继续委托');
      await page.waitForSelector('.cc-project-intent',{hidden:true});
      assert.equal(grant().reviewMode,'project');
      checks.push('Renewing the current folder from a chat delegation preserves explicit review permission, approval mode, and reader.');
    }
    await page.waitForFunction((sel,n) => document.querySelectorAll(sel).length === n,{},permissions,index);
    const id = await page.$$eval(permissions,cards => cards.at(-1).dataset.permissionId);
    return permissions+'[data-permission-id="'+id+'"]';
  }
  const first = await request(1); await page.type(composer,draft);
  await page.click(first+' summary'); assert.match(await page.$eval(first+' pre',el=>el.textContent),/月报第 1 版/);
  await keyButton('.cc-live-summary','查看请求');
  assert.equal(await page.$eval(first,el=>el === document.activeElement),true);
  await page.$eval(first,el=>el.scrollIntoView({block:'center'})); await page.screenshot({path:join(output,'desktop.png')});
  await page.setViewport({width:320,height:760});
  await page.waitForFunction(()=>document.querySelector('.cc-sidebar').getBoundingClientRect().right<=1);
  await page.click(first+' summary');
  await page.$eval(first+' .cc-export-controls',controls=>controls.scrollIntoView({block:'center'}));
  assert.equal(await page.$eval(first,el => document.documentElement.scrollWidth <= innerWidth && [...el.querySelectorAll('button')].every(b=>b.getBoundingClientRect().height>=44)),true);
  await page.screenshot({path:join(output,'mobile.png')});
  await page.setRequestInterception(true);
  let fail = true;
  page.on('request',r => {
    if (r.url().endsWith('/answer') && r.method() === 'POST' && JSON.parse(r.postData()).decision === 'allow_once') {
      retries.push(JSON.parse(r.postData()).requestId);
      if (fail) {fail = false; void r.respond({status:503,contentType:'application/json',body:JSON.stringify({error:'临时断线，请重试。'})}); return;}
    }
    void r.continue();
  });
  await keyButton(first,'允许一次'); await waitText(first+' [role=alert]','临时断线');
  await page.waitForFunction(s => document.activeElement === document.querySelector(s+' button'),{},first); await draftIntact();
  await page.keyboard.press('Enter'); await waitText(first,'成员已完成操作');
  assert.equal(retries[0],retries[1]); assert.equal(await readFile(join(project,'report-1.txt'),'utf8'),'月报第 1 版\n'); await draftIntact();
  checks.push('Inline card shows full writing contents, 320px controls and the exact pending request. Retrying after a failed POST keeps the decision ID and draft.');
  const second = await request(2); await keyButton(second,'拒绝'); await waitText(second,'已拒绝');
  await page.waitForFunction(sel=>document.querySelector(sel)?.closest('article')?.querySelector('.cc-status')?.textContent === '本轮已结束',{},second);
  const third = await request(3); await keyButton(third,'取消并停止本轮'); await waitText(third,'已取消');
  for (const i of [2,3]) await assert.rejects(access(join(project,'report-'+i+'.txt')),{code:'ENOENT'});
  checks.push('Decline and stop are distinct decisions, each bound to one request.');
  const fourth = await request(4); const late = store.interactions.list(cid).find(i => i.providerRequestId === current.rid);
  current.close(); await waitText(fourth,'已取消');
  assert.equal(await page.$(fourth+' button'),null);
  const staleStatus = await page.evaluate(async ({token,item}) => (await fetch('/api/runtime-interactions/'+item.id+'/answer',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':token},body:JSON.stringify({decision:'allow_once',requestId:crypto.randomUUID(),expectedRevision:item.revision,payloadDigest:item.payloadDigest})})).status,{token:app.csrfToken,item:late});
  assert.equal(staleStatus,409);
  const fifth = await request(5); await waitText(fifth,'未获授权'); await waitText(fifth,'https://records.example.invalid');
  assert.equal(await page.$(fifth+' button'),null);
  checks.push('Closed requests have no active controls; a late approval is rejected. Unsupported network scope shows its target and an alternative.');
  const sixth = await request(6); await waitText(sixth,'pwd'); await waitText(sixth,'/mnt/project');
  await keyButton(sixth,'允许一次'); await waitText(sixth,'成员已完成操作');
  const seventh = await request(7); await waitText(seventh,'在项目副本运行命令'); await waitText(seventh,'/work');
  await keyButton(seventh,'允许一次'); await waitText(seventh,'等待项目副本返回命令结果');
  assert(!((await page.$eval(seventh,el=>el.textContent)).includes('退出码')));
  commandResult.resolve();
  await waitText(seventh,'已在项目副本完成'); await waitText(seventh,'退出码 0');
  checks.push('Managed command displays /work, awaits its own project runner receipt, then shows its exit code. A native event with identical identifiers cannot supply the result.');
  await page.reload({waitUntil:'networkidle2'}); await waitText(first,'已允许一次');
  assert.deepEqual(outcomes,['accept','decline','cancel','closed','decline','accept','managed']); assert.deepEqual(errors,[]);
  checks.push('Command and working directory can be inspected before approval. Refresh restores recorded decisions and results.');
  await writeFile(join(output,'result.json'),JSON.stringify({passed:true,checks,scriptedMemberInvocations:count,realModelCalls:0},null,2)+'\n');
  console.log('PASS',output,checks.length);
} catch(error) {
  console.error(error);
  await page?.screenshot({path:join(output,'failure.png')}).catch(()=>{});
  if (cid) console.error(app.collaborationStore.detail(cid).invocations.map(r=>[r.status,r.error]),checks,outcomes);
  process.exitCode = 1;
} finally {
  commandResult.resolve(); await browser?.close(); await app?.close(); await rm(temp,{recursive:true,force:true});
  if (existingMcp === undefined) delete process.env.COLLAB_MCP_READERS; else process.env.COLLAB_MCP_READERS=existingMcp;
}
