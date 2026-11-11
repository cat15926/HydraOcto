// Uses the compiled workbench with a private temporary SQLite database. No model calls.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import puppeteer from 'puppeteer-core';
import {createApplication} from '../server/index.ts';

const dir=await mkdtemp(join(tmpdir(),'hydra-personal-ui-'));
const work=join(dir,'work');await mkdir(work);
const app=await createApplication({workspace:work,dataDir:join(dir,'db'),port:0,staticDir:resolve(process.env.VALIDATION_STATIC_DIR||'dist/web'),collaborationRuntime:{probe:async()=>[],invoke:async request=>{assert.equal(request.memberContextMode,'writing');request.onEvent({kind:'accepted',detail:{fixture:true}});request.onEvent({kind:'process_exit',detail:{confirmed:true}});return {text:'合成公开回复。',continuity:'fresh'};}}});
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking']});

const {url}=await app.start();assert.notEqual(new URL(url).port,'4310');
const runs=[];
try{
 for(const width of [1390,390]){
  const room=app.collaborationStore.create({requestId:randomUUID(),title:'会话资料 '+width,memberIds:['claude','codex'],defaultMemberId:'claude'}).conversation;
  const page=await browser.newPage();let watched;
  page.setDefaultTimeout(8000);
  const step=label=>console.log(width,label);
  const tryButton=async(sel,name)=>{
    step(name);const handle=await page.waitForFunction((sel,name)=>[...document.querySelectorAll(sel)].find(el=>el.getClientRects().length && !el.disabled && el.textContent.trim()===name),{timeout:6000},sel,name);
    try {await handle.asElement().click();}finally{await handle.dispose();}
  };
  const wait=(f,...args)=>page.waitForFunction(f,{timeout:6000},...args);
  async function clickVisible(selector){
    await page.waitForSelector(selector,{visible:true});
    await page.$eval(selector,el=>el.scrollIntoView({block:'nearest',behavior:'instant'}));
    await wait(s=>{
      const item=document.querySelector(s);if(!item)return false;
      const r=item.getBoundingClientRect();
      return item.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
    },selector);
    await page.locator(selector).click();
  }
  const panel='.cc-member-materials:not([hidden])';
  const txt=panel+' textarea';const marker='受限原件-'+randomUUID();
  const scope='[aria-label="成员视角预览"]';
  try{
    step('open workbench');await page.setViewport({width,height:844});await page.goto(url);
    const row='.cc-thread-main[title="'+room.title+'"]';
    if(width<480) {
      await page.locator('[aria-label="打开会话列表"]').click();
      await page.waitForSelector('.cc-sidebar.cc-open '+row,{visible:true});
    }
    step('select room');
    await clickVisible(row);
    await wait(title=>document.querySelector('.cc-conversation-title-row h1')?.textContent===title,room.title);
    if(width<480){
      await wait(()=>!document.querySelector('.cc-sidebar.cc-open'));
      await page.$eval('.cc-sidebar',async el=>{await Promise.allSettled(el.getAnimations().map(a=>a.finished));});
    }
    step('workspace tools');
    await page.waitForSelector('.cc-workspace-toggle',{visible:true});
    if(await page.$eval('.cc-workspace-toggle',e=>e.getAttribute('aria-expanded')!=='true'))await clickVisible('.cc-workspace-toggle');
    await page.waitForSelector('#cc-workspace .cc-workspace-add',{visible:true});
    if(await page.$eval('.cc-workspace-add',e=>e.getAttribute('aria-expanded')!=='true'))await clickVisible('.cc-workspace-add');
    await clickVisible('[data-workspace-tool="knowledge"]');
    await tryButton('[role=tab]','可见范围');
    await page.select(scope,'claude');await tryButton(panel+' button','提供资料');
    await wait(s=>document.activeElement===document.querySelector(s),txt);
    await page.type(txt,marker);await page.select(scope,'codex');
    await wait(s=>!document.querySelector(s),txt);await page.select(scope,'claude');
    await wait((s,v)=>document.querySelector(s)?.value===v,txt,marker);
    await page.select(panel+' form select','choice');
    const inputs=await page.$$(panel+' form textarea');assert.equal(inputs.length,2);
    await inputs[1].type('需要复核\n允许继续');
    const submit=panel+' form button';
    await page.evaluate(()=>{
      const original=window.fetch.bind(window);window.hydraIssueRequests=[];
      window.fetch=(url,options)=>{
        if(String(url).endsWith('/factors/issue')){
          window.hydraIssueRequests.push(JSON.parse(options.body).requestId);
          if(window.hydraIssueRequests.length===1)return Promise.resolve(Response.json({error:'服务暂不可用'},{status:503}));
        }
        return original(url,options);
      };
    });
    await tryButton(submit,'保存资料');await wait(s=>document.querySelector(s+' [role=alert]')?.innerText.includes('服务暂不可用'),panel);
    await tryButton(submit,'保存资料');await wait((s,v)=>document.querySelector(s+' article p')?.textContent===v,panel,marker);
    assert.equal(await page.evaluate(()=>new Set(window.hydraIssueRequests).size),1);
    await tryButton(panel+' button','提供资料');await tryButton(submit,'取消');
    await wait(s=>document.activeElement?.textContent==='提供资料'&&!document.querySelector(s),txt);
    const paths=[];watched=await browser.newPage();
    watched.on('request',r=>{const p=new URL(r.url()).pathname;if(p.startsWith('/api/'))paths.push(r.method()+' '+p);});
    const href=await page.$eval('[href*="observe="]',a=>a.href);
    await watched.setViewport({width,height:844});await watched.goto(href);await watched.waitForFunction(()=>document.body.innerText.includes('暂无公开消息'));
    assert(!await watched.evaluate(v=>document.body.innerText.includes(v),marker));
    assert(paths.length>0 && paths.every(p=>p==='GET /api/conversations/'+room.id+'/observer'));
    await page.bringToFront();await tryButton(panel+' button','撤回资料');await tryButton(panel+' button','保留资料');
    assert(await page.$(panel+' article'));
    await tryButton(panel+' button','撤回资料');await tryButton(panel+' button','确认撤回');await wait(s=>!document.querySelector(s+' article'),panel);
    // A selected/explicitly licensed expression enables the invitation.
    await tryButton(panel+' button','提供资料');
    const plain=await page.$$(panel+' form textarea');await plain[0].type(marker);await plain[1].type('允许继续。');
    await tryButton(submit,'保存资料');await tryButton(panel+' button','请此成员公开发言');await tryButton(panel+' button','取消邀请');
    await wait(()=>document.activeElement?.textContent==='请此成员公开发言');
    assert.equal(app.collaborationStore.invocations(room.id).length,0);
    // Drop the response after the server accepted it. A retry must reuse the ID.
    await page.evaluate(()=>{
      const original=window.fetch.bind(window);window.hydraInvitationIds=[];
      window.fetch=async(url,options)=>{
        if(String(url).endsWith('/messages')&&options?.method==='POST'){
          const body=JSON.parse(options.body);window.hydraInvitationIds.push(body.requestId);
          const response=await original(url,options);
          if(response.ok&&window.hydraInvitationIds.length===1)return Response.json({error:'邀请回执未送达'},{status:503});
          return response;
        }
        return original(url,options);
      };
    });
    await tryButton(panel+' button','请此成员公开发言');
    await tryButton(panel+' button','发送邀请');await wait(s=>document.querySelector(s+' [role=alert]')?.textContent.includes('邀请回执未送达'),panel);
    await tryButton(panel+' button','发送邀请');await wait(s=>document.querySelector(s+' .cc-material-invitation [role=status]')?.textContent.includes('已邀请'),panel);
    assert.deepEqual(await page.evaluate(()=>[window.hydraInvitationIds.length,new Set(window.hydraInvitationIds).size]),[2,1]);
    assert.equal(app.collaborationStore.invocations(room.id).length,1);
    assert.equal(await watched.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    runs.push({width,linkedReadOnly:true,draftRetained:true,retryIdReused:true,revoke:true,statementInviteRetriedOnce:true});
  }catch(error){await page.screenshot({path:join(dir,width+'-failed.png')}).catch(()=>{});console.error(width,dir,error);throw error;}finally{await page.close();await watched?.close();}
 }
 await writeFile(join(dir,'result.json'),JSON.stringify(runs,null,2));console.log(join(dir,'result.json'));
}finally{await browser.close();await app.close();}
