// Browser-only roster acceptance. Local synthetic members, temporary storage and zero provider calls.
import assert from 'node:assert/strict';
import { mkdir,mkdtemp,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createApplication } from '../server/index.ts';
import { MAX_ROOM_MEMBERS } from '../shared/room-limits.ts';

const base=resolve(process.env.VALIDATION_OUTPUT_DIR||tmpdir());
await mkdir(base,{recursive:true,mode:0o700});
const dir=await mkdtemp(join(base,'hydra-room-roster-ui-')),runs=[];
const browser=await puppeteer.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args:['--disable-background-networking','--no-first-run']});
const pick='button[aria-label="选择新会话成员与默认成员"]',input='#cc-message-input',form='.cc-conversation-settings';
async function exercise(width) {
  const root=join(dir,String(width));await mkdir(root);
  const app=await createApplication({dataDir:join(root,'db'),workspace:join(root,'project'),staticDir:resolve(process.env.VALIDATION_STATIC_DIR||'dist/web'),
    port:0,startWorker:false,collaborationRuntime:{probe:async()=>[],async invoke(req){
      req.onEvent({kind:'accepted',detail:{source:'UI fixture'}});req.onEvent({kind:'process_exit',detail:{confirmed:true}});return {text:'本地回执。',continuity:'unknown'};
    }}});
  const store=app.collaborationStore;
  for(let n=1;n<=14;n++)store.saveMember({id:'guest-'+n,name:'测试成员 '+n,carrier:'claude-cli',accountId:'claude-cli',enabled:true,instructions:'参与测试。'});
  const page=await browser.newPage(),errors=[];
  const check=(fn,...args)=>page.waitForFunction(fn,{timeout:12000},...args);
  const labels=(selector)=>page.$$eval(selector,nodes=>nodes.map(n=>n.textContent.trim()));
  try{
    const {url}=await app.start();assert.notEqual(new URL(url).port,'4310');
    page.on('pageerror',e=>errors.push(e.message));
    let failNext=false;
    await page.setRequestInterception(true);
    page.on('request',r=>{
      if(failNext && r.method()==='POST' && new URL(r.url()).pathname==='/api/conversations'){
        failNext=false;void r.respond({status:503,contentType:'application/json',body:JSON.stringify({error:'测试网络暂不可用'})});
      }else void r.continue();
    });
    await page.setViewport({width,height:800});
    await page.goto(url,{waitUntil:'domcontentloaded'});await page.waitForSelector(pick);
    await page.type(input,'保留草稿');
    const filename=join(root,'note.txt');await writeFile(filename,'临时测试资料');
    await (await page.$('input[aria-label="添加图片或文本附件"]')).uploadFile(filename);
    await page.waitForSelector('.cc-draft-file');assert.equal(store.list().length,0);
    assert.equal(await page.$('.cc-draft-image'),null,'Text should not render an image preview');
    await page.focus(pick);await page.keyboard.press('Enter');await page.waitForSelector(form);
    const checks=form+' input[type=checkbox]';
    assert.equal(await page.$$eval(checks,x=>x.filter(c=>c.checked).length),1);
    await page.keyboard.press('Escape');
    await check(s=>document.activeElement?.matches(s),pick);
    assert.equal(await page.$eval(input,t=>t.value),'保留草稿');
    await page.click(pick);
    const selected=await page.$$eval(checks,(items,limit)=>{
      for(const box of items)if(!box.checked && !box.disabled && items.filter(i=>i.checked).length<limit)box.click();
      return items.filter(i=>i.checked).map(i=>i.closest('label').textContent.trim());
    },MAX_ROOM_MEMBERS);
    assert.equal(selected.length,MAX_ROOM_MEMBERS);
    await check(s=>[...document.querySelectorAll(s)].filter(c=>!c.checked).every(c=>c.disabled),checks);
    const defaultId=await page.$eval(form+' select',s=>s.options[s.options.length-1].value);
    await page.select(form+' select',defaultId);
    await page.click(form+' button.cc-button-primary');await check(s=>!document.querySelector(s),form);
    assert.equal(await page.$eval(input,t=>t.value),'保留草稿');
    await page.click('.cc-mention-button');
    const choices=await labels('.cc-mention-menu button strong');assert.deepEqual(choices.toSorted(),selected.toSorted());
    await page.click(input);
    const privateButton='.cc-private-composer>button';
    await page.click(privateButton);
    const recipients=await page.$$('.cc-private-composer input[type=checkbox]');
    assert.equal(recipients.length,MAX_ROOM_MEMBERS);
    await recipients[0].click();
    assert.equal(store.list().length,0);
    failNext=true;await page.click('.cc-send-button');
    await check(()=>document.body.innerText.includes('测试网络暂不可用'));
    assert.equal(await page.$eval(input,t=>t.value),'保留草稿');
    assert.equal(store.list().length,0);
    await page.click('.cc-send-button');
    await check(s=>document.querySelector(s)?.value==='',input);
    const [room]=store.list();
    assert.equal(store.list().length,1);assert.equal(room.memberIds.length,MAX_ROOM_MEMBERS);assert.equal(room.defaultMemberId,defaultId);
    const details=store.detail(room.id),message=details.messages.find(m=>m.author==='user');
    assert.equal(message.content,'保留草稿');assert.equal(message.visibility?.memberIds.length,1);assert.equal(message.attachmentIds.length,1);
    assert(room.memberIds.includes(message.visibility.memberIds[0]));
    assert.deepEqual(room.memberIds.map(id=>store.members().find(m=>m.id===id).name).toSorted(),selected.toSorted());
    await page.click('button[aria-label="工作台"]');
    // Return to a new draft from the sidebar; the old roster doesn't become the next room's default.
    if(width<760)await page.click('button[aria-label="打开会话列表"]');
    const next=await check(()=>[...document.querySelectorAll('aside button')].find(b=>b.textContent.includes('新的协作')));
    await next.asElement().click();
    await check(s=>document.querySelector(s)?.textContent.includes('1'),pick);
    assert.equal(await page.$eval(input,t=>t.value),'');
    assert.equal(await page.$('.cc-draft-file'),null);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(errors,[]);
    runs.push({width,selection:room.memberIds.length,defaultId,userMessages:1,privateRecipients:1,textAttachments:1,cancel:true,retried:true,reset:true});
  }finally{await page.close();await app.close();}
}
let failure;
try{for(const width of [1280,390])await exercise(width);}
catch(e){failure=e;process.exitCode=1;}
finally{
  await browser.close();const result={passed:!failure,runs,...(failure&&{error:String(failure.stack).slice(0,1200)})};
  await writeFile(join(dir,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(result.passed?'passed':'failed',join(dir,'result.json'));
}
