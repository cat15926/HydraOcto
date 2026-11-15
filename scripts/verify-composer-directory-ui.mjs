/** Directory placement, grants and composer preservation in an isolated app. No real models. */
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import puppeteer from 'puppeteer-core';
import {openWorkspaceTool} from './ui-workspace.mjs';
import {createApplication} from '../server/index.ts';
const out=resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/composer-directory/'+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(out,{recursive:true});
const checks=[],errors=[];let app,browser;
try {
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking']});
  for(const width of [1390,390]) {
    const dir=await realpath(await mkdtemp(join(tmpdir(),'composer-directory-'))),project=join(dir,'订单项目'),other=join(dir,'另一项目');
    await mkdir(project);await mkdir(other);await writeFile(join(dir,'note.txt'),'附件保留');
    let picks=0;const calls=[],ok={available:true,reason:'synthetic fixture'};
    app=await createApplication({port:0,workspace:join(dir,'default'),dataDir:join(dir,'db'),staticDir:resolve(process.env.VALIDATION_STATIC_DIR || 'dist/web'),
      folderPicker:async()=>{picks++;if(picks===1)throw Error('fixture picker failure');if(picks===2)return null;return project;},
      collaborationRuntime:{projectWorkAvailability:()=>ok,probe:async()=>['codex-app-server','claude-cli'].map(carrier=>({carrier,installed:true,available:true,append:false,authentication:'cli',verified:'unverified',nativeProject:{api:ok,cli:ok}})),
        invoke:async req=>{calls.push({cwd:req.cwd,projectWork:req.projectWork,member:req.member.id});req.onEvent({kind:'accepted',detail:{source:'synthetic'}});req.onEvent({kind:'process_exit',detail:{confirmed:true}});return{text:'目录验收合成答复',continuity:'fresh'};}}});
    const store=app.collaborationStore;
    const previous=store.create({requestId:'recent',title:'已有目录',memberIds:['codex'],defaultMemberId:'codex'}).conversation;
    const preview=store.workbench.previewWorkspace(previous.id,{path:other,mode:'read-only',expectedRevision:previous.revision??1});
    store.workbench.applyPreview({previewId:preview.id,requestId:'recent-grant'},previous.id);
    const {url}=await app.start(),page=await browser.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
    await page.setViewport({width,height:900});
    await page.evaluateOnNewDocument(()=>{const original=window.fetch;let lost=true;window.fetch=async(...args)=>{const response=await original(...args);if(lost&&String(args[0]).endsWith('/api/conversations')&&args[1]?.method==='POST'){lost=false;throw Error('fixture lost creation response');}return response;};});
    await page.goto(url,{waitUntil:'networkidle2'});await page.waitForSelector('#cc-message-input');
    const wait=(fn,...args)=>page.waitForFunction(fn,{},...args);
    async function click(text,scope='body'){const h=await wait((t,s)=>[...document.querySelectorAll(s+' button')].find(b=>b.textContent.trim()===t&&!b.disabled&&b.getClientRects().length),text,scope);await h.asElement().click();await h.dispose();}
    const folder='button[aria-label="设置会话工作目录"]';
    if(width===390){await page.click('.cc-mobile-menu');await wait(()=>document.querySelector('.cc-new-button').getBoundingClientRect().left>=0);}
    await page.click('.cc-new-button');await wait(()=>document.querySelector('h1')?.textContent==='新的协作');
    assert.equal(await page.$('.cc-topbar [aria-label="设置会话工作目录"]'),null);
    await page.type('#cc-message-input','@Codex 请核对订单编号排序');
    const file=await page.$('input[aria-label="添加图片或文本附件"]');await file.uploadFile(join(dir,'note.txt'));await page.waitForSelector('.cc-draft-file');
    const scope='.cc-audience-trigger';
    assert.equal(await page.$eval(scope,b=>b.textContent),'会话内公开');
    const aligned=()=>page.evaluate(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect(),a=rect('.cc-directory-trigger'),b=rect('.cc-audience-trigger'),c=rect('.cc-composer-members');return Math.abs(a.y+a.height/2-b.y-b.height/2)<2 && b.x>=a.right && c.x>=b.right && c.right<=innerWidth;});
    assert(await aligned());await page.click(scope);await page.click('.cc-audience-menu input');await page.keyboard.press('Escape');
    assert(await page.$eval(scope,b=>document.activeElement===b && b.textContent==='会话内公开'));
    await page.click(scope);await page.click('.cc-audience-menu input');await page.click('.cc-audience-apply');assert(await aligned());assert.match(await page.$eval(scope,b=>b.textContent),/私聊/);
    await page.screenshot({path:join(out,'private-'+width+'.png')});await page.click(scope);await click('会话内公开','.cc-audience-menu');
    assert.equal(await page.$eval('#cc-message-input',e=>e.value),'@Codex 请核对订单编号排序');assert(await page.$('.cc-draft-file'));
    await page.click(folder);await page.waitForSelector('[role=menu][aria-label="选择工作目录"]');
    await page.keyboard.press('Escape');assert.equal(await page.$eval(folder,e=>document.activeElement===e),true);
    await page.click(folder);await click('选择其他文件夹…','.cc-directory-menu');
    await wait(()=>document.body.innerText.includes('fixture lost creation response'));
    await wait(()=>document.activeElement?.getAttribute('aria-label')==='设置会话工作目录');
    assert.equal(store.list().length,2);assert.equal(calls.length,0);
    await page.keyboard.press('Enter');await click('选择其他文件夹…','.cc-directory-menu');
    await page.waitForSelector('dialog .cc-project-picker [role=alert]');assert.equal(store.list().length,2);
    await click('选择文件夹…','dialog');await wait(()=>document.querySelector('dialog [role=status]')?.textContent.includes('已取消选择'));
    await click('选择文件夹…','dialog');await page.waitForSelector('dialog .cc-project-preview');
    const room=store.list().find(c=>c.id!==previous.id);assert(!room.workspaceGrant);assert.equal(store.detail(room.id).messages.length,0);assert.equal(calls.length,0);
    await click('确认项目工作授权','dialog');await page.waitForSelector('dialog',{hidden:true});
    await wait(()=>document.querySelector('.cc-directory-trigger')?.textContent.includes('订单项目'));
    assert.equal(store.detail(room.id).conversation.workspaceGrant.path,project);
    assert.equal(await page.$eval('#cc-message-input',e=>e.value),'@Codex 请核对订单编号排序');assert(await page.$('.cc-draft-file'));
    await wait(()=>document.activeElement?.getAttribute('aria-label')==='设置会话工作目录');
    await page.click(folder);await click('另一项目'+other,'.cc-directory-menu');await page.waitForSelector('dialog .cc-project-preview');
    assert.equal(store.detail(room.id).conversation.workspaceGrant.path,project);
    await page.keyboard.press('Escape');await page.waitForSelector('dialog',{hidden:true});
    assert.equal(store.detail(room.id).conversation.workspaceGrant.path,project);
    await page.click(folder);await page.screenshot({path:join(out,'directory-'+width+'.png'),fullPage:true});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.keyboard.press('Escape');
    // A recent directory still needs its own confirmation; cancellation never changes the grant.
    await page.click(folder);await click('另一项目'+other,'.cc-directory-menu');await page.waitForSelector('dialog .cc-project-preview');
    await click('确认项目工作授权','dialog');await page.waitForSelector('dialog',{hidden:true});
    assert.equal(store.detail(room.id).conversation.workspaceGrant.path,other);
    await page.click('.cc-send-button');await wait(()=>document.querySelector('#cc-message-input')?.value==='');await wait(()=>document.querySelector('.cc-message-member .cc-prose')?.textContent.includes('目录验收合成答复'));
    assert.equal(calls.length,1);assert.equal(calls[0].cwd,other);
    await page.click(folder);await click('使用默认工作区','.cc-directory-menu');await page.waitForSelector('dialog .cc-project-preview');await click('确认只读授权','dialog');await page.waitForSelector('dialog',{hidden:true});
    assert.equal(store.detail(room.id).conversation.workspaceGrant.mode,'read-only');
    await openWorkspaceTool(page,'project');
    await page.waitForSelector('#cc-workspace .cc-project-picker');
    assert.equal(await page.$('#cc-workspace .cc-project-actions button:first-child')!==null,true);
    assert(!(await page.$eval('#cc-workspace .cc-project-picker',e=>e.textContent)).includes('更换文件夹…'));
    await click('允许在此项目工作…','#cc-workspace');await page.waitForSelector('#cc-workspace .cc-project-preview');
    await click('取消','#cc-workspace .cc-project-preview');await wait(()=>document.activeElement?.textContent==='允许在此项目工作…');
    await page.keyboard.press('Enter');await page.waitForSelector('#cc-workspace .cc-project-preview');await click('确认项目工作授权','#cc-workspace');
    await wait(()=>document.querySelector('#cc-workspace .cc-project-current')?.textContent.includes('已授权项目工作'));
    await click('收回工作授权…','#cc-workspace');await page.waitForSelector('#cc-workspace .cc-project-preview');await click('取消','#cc-workspace .cc-project-preview');
    await wait(()=>document.activeElement?.textContent==='收回工作授权…');
    assert.equal(store.detail(room.id).conversation.workspaceGrant.mode,'project-work');
    checks.push({width,headerDeduplicated:true,recentPreview:true,creationRetryIdempotent:true,pickerErrorAndCancel:true,draftAndAttachmentRetained:true,escapeFocus:true,firstMessageCwd:true,defaultWorkspaceConfirmed:true,workbenchDeduplicated:true,permissionCancelFocus:true,noOverflow:true});
    await page.close();await app.close();app=undefined;
  }
  assert.deepEqual(errors,[]);await writeFile(join(out,'result.json'),JSON.stringify({passed:true,checks,errors,realModelCalls:0},null,2));console.log(JSON.stringify({passed:true,checks,out}));
} catch(e){await writeFile(join(out,'failure.json'),JSON.stringify({error:e.stack,checks,errors},null,2));console.error(e);process.exitCode=1;}finally{await browser?.close();await app?.close();}
