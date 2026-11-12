// UI and ledger acceptance only: deterministic runtime, real HTTP, SQLite and Chromium. No native model claims.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import puppeteer from 'puppeteer-core';
import {createApplication} from '../server/index.ts';
import {boothAdapter} from '../tests/fixtures/booth-operation-adapter.ts';

const base=resolve(process.env.VALIDATION_OUTPUT_DIR || tmpdir());
await mkdir(base,{recursive:true,mode:0o700});
const run=await mkdtemp(join(base,'external-ui-'));
const results=[];
const browser=await puppeteer.launch({headless:true,executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args:['--disable-background-networking','--no-first-run']});
async function examine(width) {
  const dir=join(run,String(width));
  await mkdir(join(dir,'project'),{recursive:true});
  let id='', store,available=false;
  const ledger=join(dir,'booth.sqlite'), booth=boothAdapter(ledger,a=>a.conversationId===id && a.memberId==='claude',true,()=>!available);
  const sql=new DatabaseSync(ledger,{readOnly:true}), count=()=>sql.prepare('SELECT COUNT(*) AS n FROM reservation_calls').get().n;
  const app=await createApplication({port:0,workspace:join(dir,'project'),dataDir:join(dir,'platform'),staticDir:resolve(process.env.VALIDATION_STATIC_DIR||'dist/web'),
    externalOperations:booth.adapter,collaborationRuntime:{probe:async()=>[],async invoke(req){
      req.onEvent({kind:'accepted',detail:{fixture:'ui'}});
      const source=store.visibility.primary(req.invocationId);
      const call=(name,args)=>req.onToolCall(name,args,randomUUID());
      let text='已登记，等待授权。';
      if(source.kind==='user') {
        const {obligation}=await call('obligation_open',{goal:'预约 A12 展位并取得回执'});
        await call('obligation_external_request',{obligationId:obligation.id,targetId:booth.target.id});
      } else {
        const root=store.obligations.list(id)[0], op=root.externalOperation, args={obligationId:root.id};
        if(op.stage==='approved') await call('obligation_external_execute',args);
        else if(op.stage==='unknown') await call('obligation_external_lookup',{...args,operationId:op.id});
        const current=store.obligations.list(id)[0].externalOperation;
        text='目前还无法核实原操作的结果。';
        if(current.stage==='recorded') {
          text='已预约，回执：'+current.receipt;
          await call('obligation_deliver',{...args,summary:text});
        }
      }
      req.onEvent({kind:'process_exit',detail:{confirmed:true}});return {text,continuity:'unknown'};
    }}});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const wait=(fn,...args)=>page.waitForFunction(fn,{timeout:20000},...args);
  const press=async text=>{
    const h=await wait(t=>[...document.querySelectorAll('.cc-obligation button')].find(el=>el.textContent.trim()===t && !el.disabled && el.getClientRects().length),text);
    try{await h.asElement().focus();await page.keyboard.press('Enter');}finally{await h.dispose();}
  };
  try {
    store=app.collaborationStore;
    id=store.create({requestId:randomUUID(),title:'展位预约',memberIds:['claude'],defaultMemberId:'claude'}).conversation.id;
    const {url}=await app.start();assert.notEqual(new URL(url).port,'4310');
    await page.setViewport({width,height:850});await page.goto(url,{waitUntil:'networkidle2'});
    const input='#cc-message-input',summary='.cc-obligation summary';
    await page.waitForSelector(input,{visible:true});await page.type(input,'请预约秋展 A12 展位');await page.click('.cc-send-button');
    await wait(()=>document.querySelector('.cc-obligation summary')?.textContent.includes('等你授权'));
    await page.type(input,'尚未发出的草稿');await page.focus(summary);await page.keyboard.press('Enter');
    await press('取消跟进…');await press('返回');
    await wait(()=>document.activeElement===document.querySelector('.cc-obligation summary'));
    assert.equal(count(),0);
    await page.evaluate(()=>{
      const real=window.fetch.bind(window);window.approvalBodies=[];
      window.fetch=async(input,init)=>{
        const authorization=String(input).endsWith('/approve-external') && init?.method==='POST';
        if(authorization)window.approvalBodies.push(JSON.parse(init.body));
        const response=await real(input,init);
        if(authorization && response.ok && window.approvalBodies.length===1)return Response.json({error:'授权回执未抵达'},{status:503});
        return response;
      };
    });
    await press('授权此次操作');await wait(()=>document.activeElement?.textContent==='重试上次操作');
    await page.keyboard.press('Enter');
    await wait(()=>document.querySelector('.cc-obligation summary')?.textContent.includes('外部结果待核查'));
    const bodies=await page.evaluate(()=>window.approvalBodies);
    assert.equal(bodies.length,2);assert.deepEqual(bodies[0],bodies[1]);assert.equal(count(),1);
    assert.equal(await page.$eval(input,e=>e.value),'尚未发出的草稿');
    const target=store.obligations.list(id)[0].externalOperation;
    assert.equal(target.stage,'unknown');assert(target.id && target.target.id===booth.target.id);
    await page.screenshot({path:join(dir,'unknown.png')});
    available=true;await press('查询原操作');
    await wait(()=>document.querySelector('.cc-obligation summary')?.textContent.includes('已交付'));
    await wait(()=>document.activeElement===document.querySelector('.cc-obligation summary'));
    assert.equal(await page.$eval(input,e=>e.value),'尚未发出的草稿');
    const final=store.obligations.list(id)[0].externalOperation;
    assert.equal(final.id,target.id);assert.equal(count(),1);assert(final.receipt);
    assert.equal(sql.prepare('SELECT reservation_id FROM reservations WHERE operation_id=?').get(final.id).reservation_id,final.receipt);
    assert(await page.$eval('.cc-obligation',el=>document.documentElement.scrollWidth<=innerWidth+1 && el.getBoundingClientRect().right<=innerWidth+1));
    assert.deepEqual(errors,[]);results.push({width,writes:1,receipt:final.receipt,requestReused:true,draftPreserved:true,focusRestored:true});
  }finally{await page.close();await app.close();sql.close();booth.close();}
}
try{for(const width of [1390,390])await examine(width);}
finally{await browser.close();const report=join(run,'result.json');await writeFile(report,JSON.stringify({passed:results.length===2,kind:'browser-fixture',results},null,2));console.log(report);}
