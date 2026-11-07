import { openWorkspaceTool, closeWorkspace } from './ui-workspace.mjs';
/** N9 browser acceptance: isolated data and synthetic runtime, no real model calls. */
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../dist/server/index.js';
const output=resolve(process.env.VALIDATION_OUTPUT_DIR||'.local-data/validation/n9-ui/'+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(output,{recursive:true});const temp=await mkdtemp(join(tmpdir(),'n9-ui-')),workspace=join(temp,'project');await mkdir(workspace);
const {default:puppeteer}=await import(pathToFileURL(process.env.PUPPETEER_PATH||'/Users/ruhonglin/lhz/clowder-ai-latest/packages/api/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js').href);
const calls=[],checks=[],errors=[];const check=(name,value)=>{assert.ok(value,name);checks.push(name);};let app,browser;
try{
 app=await createApplication({port:0,dataDir:join(temp,'private'),workspace,staticDir:resolve(process.env.VALIDATION_STATIC_DIR||'dist/web'),collaborationRuntime:{probe:async()=>[],invoke:async r=>{
  calls.push(r);r.onEvent({kind:'accepted',detail:{source:'synthetic-browser'}});
  const s=app.collaborationStore.visibility.primary(r.invocationId);
  if(s.actionRef){const a=(await r.onToolCall('action_list',{},'list')).actions.find(a=>a.executionId===r.invocationId),v={actionId:a.id,expectedRevision:a.revision,expectedGeneration:a.generation};
   if(a.generation===1&&a.title==='UI 条件委托')await r.onToolCall('action_wait',{...v,condition:{kind:'signal',name:'人工确认验收资料'},deadline:new Date(Date.now()+120000).toISOString()},'wait');
   else if(a.generation===1&&a.title==='UI 退回责任')await r.onToolCall('action_return',{...v,reason:'需要原负责人处理'},'return');
   else await r.onToolCall('action_candidate',{...v,summary:'N9_UI_CANDIDATE_MARKER'},'candidate');
  }
  r.onEvent({kind:'process_exit',detail:{confirmed:true}});return {text:'N9 合成结果',continuity:'fresh'};
 }}});const {url}=await app.start(),s=app.collaborationStore;
 const home=s.create({requestId:crypto.randomUUID(),title:'N9 主会话',memberIds:['codex','claude'],defaultMemberId:'codex'}).conversation,target=s.create({requestId:crypto.randomUUID(),title:'N9 执行会话',memberIds:['codex','claude'],defaultMemberId:'claude'}).conversation;
 browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--no-first-run','--disable-background-networking']});const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.stack||e.message));await page.setViewport({width:1512,height:982});
 const click=async(label,scope='body')=>{await page.waitForFunction((label,scope)=>[...document.querySelectorAll(scope+' button')].some(b=>b.textContent.trim()===label&&!b.disabled),{},label,scope);await page.evaluate((label,scope)=>[...document.querySelectorAll(scope+' button')].find(b=>b.textContent.trim()===label&&!b.disabled).click(),label,scope);};
 const until=async(fn)=>{const deadline=Date.now()+10000;while(!fn()){if(Date.now()>deadline)throw Error('N9 UI timeout');await new Promise(r=>setTimeout(r,20));}};
 const fill=async(selector,value)=>{await page.$eval(selector,(e,v)=>{e.value='';e.dispatchEvent(new Event('input',{bubbles:true}));},value);await page.type(selector,value);};
 await page.goto(url,{waitUntil:'networkidle2'});await page.waitForSelector('#cc-message-input');
 await page.evaluate(()=>[...document.querySelectorAll('.cc-conversation-list button')].find(b=>b.textContent.includes('N9 主会话')).click());await page.waitForFunction(()=>document.querySelector('h1').textContent==='N9 主会话');
 check('ordinary composer has no mandatory cross-conversation controls',!(await page.$('.cc-composer select')));await openWorkspaceTool(page, 'actions');await page.waitForSelector('.cc-action-panel');
 await click('批准跨会话授权','.cc-action-panel');await page.select('.cc-action-form select[name="home"]','codex');await page.select('.cc-action-form select:not([name])',target.id);await page.select('.cc-action-form select[name="member"]','claude');await click('批准两端授权','.cc-action-panel');await until(()=>s.cross.grants().length===1);
 const g=s.cross.grants()[0];check('grant stores exact endpoints and workspace identity',g.home.conversationId===home.id&&g.home.memberId==='codex'&&g.target.conversationId===target.id&&g.target.memberId==='claude'&&g.homeWorkspace&&g.targetWorkspace);check('approval alone does not invoke a model',calls.length===0);
 await click('跨会话发送','.cc-action-panel');await fill('.cc-action-form textarea[name="content"]','N9_CROSS_BROWSER_MARKER');await click('发送跨会话消息','.cc-action-panel');await until(()=>calls.length===1&&s.invocations().every(i=>i.status==='succeeded'));
 check('cross message reaches exact target with actual prompt',calls[0].conversationId===target.id&&calls[0].member.id==='claude'&&calls[0].prompt.includes('N9_CROSS_BROWSER_MARKER'));
 const transfer=s.cross.transfers()[0];check('cross transfer has actual consumption',s.detail(target.id).consumptions.some(c=>c.sourceId===transfer.sourceId));check('ordinary success does not create a callback',s.detail(home.id).sources.length===0);
 await click('新建专用责任','.cc-action-panel');await fill('.cc-action-form input[name="title"]','UI 条件委托');await fill('.cc-action-form textarea[name="content"]','明确等待后完成候选');await click('创建专用责任','.cc-action-panel');await until(()=>s.actions.list().some(a=>a.state==='waiting'&&!a.executionId));
 let a=s.actions.list()[0];await page.waitForSelector('[data-action-id="'+a.id+'"]');await page.$eval('[data-action-id="'+a.id+'"] summary',e=>e.click());
 check('Action waiting is distinct from model completion',a.state==='waiting'&&calls.length===2&&s.actions.waits()[0].state==='waiting');check('home owner and remote holder are shown separately',a.home.memberId==='codex'&&a.holder.memberId==='claude');
 await page.screenshot({path:join(output,'condition-waiting.png')});await click('人工确认条件满足','[data-action-id="'+a.id+'"]');await until(()=>s.actions.get(a.id).state==='candidate'&&!s.actions.get(a.id).executionId);
 check('one signal creates exactly one successor generation',calls.length===3&&s.actions.get(a.id).generation===2&&s.actions.waits()[0].wakeSourceId);check('condition history records human evidence rather than invented external fact',s.artifacts.rows('cc_condition_evidence')[0].authority==='human_signal');
 await page.waitForFunction(()=>document.querySelector('.cc-action-candidate')?.textContent.includes('N9_UI_CANDIDATE_MARKER'));check('candidate remains uncompleted before explicit verdict',s.actions.get(a.id).state==='candidate'&&s.artifacts.rows('cc_action_verdicts').length===0);await page.screenshot({path:join(output,'candidate-desktop.png')});await click('接受候选并完成','[data-action-id="'+a.id+'"]');await until(()=>s.actions.get(a.id).state==='completed');check('acceptance persists one exact candidate verdict',s.artifacts.rows('cc_action_verdicts').length===1);
 await click('新建专用责任','.cc-action-panel');await fill('.cc-action-form input[name="title"]','UI 退回责任');await fill('.cc-action-form textarea[name="content"]','退回原负责人确认');await click('创建专用责任','.cc-action-panel');await until(()=>s.actions.list().some(a=>a.title==='UI 退回责任'&&a.generation===2&&a.state==='candidate'&&!a.executionId));
 const returned=s.actions.list().find(a=>a.title==='UI 退回责任');check('structured return changes holder after release and reaches home',returned.holder.memberId==='codex'&&returned.holder.conversationId===home.id&&calls.length===5);check('return delivery has actual source and consumption',s.detail(home.id).consumptions.some(c=>c.sourceId===returned.currentSourceId));
 await page.$eval('.cc-cross-grants summary',e=>e.click());await click('撤销授权','.cc-cross-grants');await until(()=>s.cross.grant(g.id).state==='revoked');check('revoked grant blocks outstanding responsibility',s.actions.get(returned.id).state==='blocked');check('revocation causes no additional model call',calls.length===5);
 await page.reload({waitUntil:'networkidle2'});await openWorkspaceTool(page, 'actions');await page.waitForSelector('.cc-action-panel');check('reload preserves grant, candidate and condition history',s.cross.grant(g.id).state==='revoked'&&s.actions.waits()[0].state==='fired');
 await page.setViewport({width:390,height:844});await page.waitForFunction(()=>document.querySelector('.cc-sidebar').getBoundingClientRect().right<=0);await page.screenshot({path:join(output,'mobile.png')});check('mobile page does not overflow horizontally',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await closeWorkspace(page);check('mobile composer remains reachable',await page.$eval('.cc-send-button',e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.right<=innerWidth;}));check('no browser exception',errors.length===0);
 await writeFile(join(output,'result.json'),JSON.stringify({ok:true,checks,syntheticCalls:calls.length,errors},null,2));console.log(JSON.stringify({ok:true,checks:checks.length,syntheticCalls:calls.length,output}));
}catch(e){await writeFile(join(output,'failure.json'),JSON.stringify({error:e.stack,checks,errors},null,2));console.error(e);process.exitCode=1;}
finally{await browser?.close();await app?.close();await rm(temp,{recursive:true,force:true});}
