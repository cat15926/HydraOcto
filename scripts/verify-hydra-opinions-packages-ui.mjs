// Node 24 --import tsx. Exercises the compiled workbench, HTTP and SQLite with synthetic members.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import puppeteer from 'puppeteer-core';
import {createApplication} from '../server/index.ts';

const output=await mkdtemp(join(process.env.VALIDATION_OUTPUT_DIR || tmpdir(),'hydra-06-07-ui-'));
const browser=await puppeteer.launch({headless:true,executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--disable-background-networking']});
const results=[];
const ask='请征询两位同伴的意见，资料 A 已获得展览许可。', change='请根据活动地点准备路线图和嘉宾简介。';
const input='#cc-message-input';
function gate(){let open;const waiting=new Promise(resolve=>{open=resolve;});return {open,waiting};}
async function exercise(width) {
  const base=join(output,String(width)),workspace=join(base,'work');
  await mkdir(workspace,{recursive:true});
  const holdDecision=gate(), holdRevision=gate(), toolErrors=[];
  let store,root,round,bundle,room;
  const runtime={probe:async()=>[],async invoke(request){
    request.onEvent({kind:'accepted',detail:{fixture:true}});
    const source=store.visibility.primary(request.invocationId);
    let text='已完成本轮工作。';
    let n=0;
    const tool=(name,args)=>request.onToolCall(name,args,'fixture-'+ ++n);
    try{
      if(source.kind==='user' && source.content===ask) {
        root=(await tool('obligation_open',{goal:'结合许可及评审意见给出建议'})).obligation;
        round=await tool('opinion_open',{obligationId:root.id,question:'这件展品是否可以展出？',minimum:2,targets:['codex','editor'],deadline:new Date(Date.now()+120000).toISOString(),lockMode:'early'});
      } else if(source.kind==='user' && source.content===change) {
        root=(await tool('obligation_open',{goal:'交付活动说明资料包'})).obligation;
        bundle=await tool('package_open',{obligationId:root.id,title:'活动说明资料包',materials:[{key:'venue',name:'活动地点',content:'南馆'}],parts:[
          {key:'map',label:'路线图',dependsOn:['venue']},{key:'guest',label:'嘉宾简介',dependsOn:[]}]});
        for(const key of ['map','guest']){
          const read=(await tool('package_list',{packageId:bundle.id})).packages[0];
          const posted=await tool('package_submit',{packageId:bundle.id,key,content:key==='map'?'路线通往南馆。':'嘉宾是馆藏专家。',basis:key==='map'?[{key:'venue',versionId:read.materials[0].versionId}]:[],expectedPartVersionId:null});
          const part=posted.parts.find(p=>p.key===key);
          await tool('package_list',{packageId:bundle.id});
          bundle=await tool('package_review',{packageId:bundle.id,key,versionId:part.versionId,verdict:'accept',note:'已核对本文。'});
        }
        const oldGuest=bundle.parts.find(p=>p.key==='guest');
        await holdRevision.waiting;
        const actual=(await tool('package_list',{packageId:bundle.id})).packages[0];
        if(actual.materials[0].number===2) {
          const map=actual.parts.find(part=>part.key==='map');
          const updated=await tool('package_submit',{packageId:bundle.id,key:'map',content:'路线通往北馆。',basis:[{key:'venue',versionId:actual.materials[0].versionId}],expectedPartVersionId:map.versionId});
          await tool('package_list',{packageId:bundle.id});
          const signed=await tool('package_review',{packageId:bundle.id,key:'map',versionId:updated.parts.find(part=>part.key==='map').versionId,verdict:'accept',note:'新地址已经核实。'});
          const guest=signed.parts.find(p=>p.key==='guest');
          assert.equal(guest.versionId,oldGuest.versionId);assert.equal(guest.evidenceId,oldGuest.evidenceId);
          bundle=await tool('package_publish',{packageId:bundle.id,expectedRevision:signed.revision});
          text='嘉宾简介沿用已核实资料，路线改为北馆。';
          await tool('obligation_deliver',{obligationId:root.id,summary:text});
        }
      } else if(round && request.member.id!=='claude'){
        const objection=request.member.id==='editor';
        await tool('opinion_submit',{roundId:round.id,text:objection?'请核对展览许可。':'展品说明清楚。',objection});
      } else if(round && !bundle && request.member.id==='claude') {
        const current=await tool('opinion_read',{roundId:round.id});
        const locked=await tool('opinion_lock',{roundId:round.id,expectedRevision:current.revision});
        await holdDecision.waiting;
        const evidence=store.detail(room.id).messages.find(m=>m.author==='user' && m.content===ask);
        await tool('opinion_resolve',{roundId:round.id,opinionId:locked.objectionIds[0],evidenceMessageId:evidence.id,finding:'已核对本次展览的许可范围。'});
        text='许可核查完毕，可以展出。';
        await tool('obligation_deliver',{obligationId:root.id,summary:text});
      }
    }catch(error){toolErrors.push(String(error.message));throw error;}
    request.onEvent({kind:'process_exit',detail:{confirmed:true}});return {text,continuity:'unknown'};
  }};
  const app=await createApplication({port:0,dataDir:join(base,'db'),workspace,staticDir:resolve(process.env.VALIDATION_STATIC_DIR || 'dist/web'),collaborationRuntime:runtime});
  const page=await browser.newPage(), errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  try{
    store=app.collaborationStore;
    store.saveMember({...store.members()[0],id:'editor',name:'校对者'});
    room=store.create({title:'复核展品',memberIds:['claude','editor','codex'],defaultMemberId:'claude',requestId:randomUUID()}).conversation;
    const {url}=await app.start();assert.notEqual(new URL(url).port,'4310');
    await page.setViewport({width,height:850});await page.goto(url,{waitUntil:'networkidle2'});
    const wait=(fn,...args)=>page.waitForFunction(fn,{timeout:20000},...args);
    const key=async(selector,k='Enter')=>{await page.focus(selector);await page.keyboard.press(k);};
    async function showCard(marker) {
      await wait(sel=>document.querySelector(sel),marker);
      const selector='.cc-obligation:has('+marker+') > summary';
      if(!(await page.$eval(marker,e=>e.closest('.cc-obligation').open)))await key(selector);
      await key(marker+' > summary');
    }
    await page.waitForSelector(input,{visible:true});
    await page.type(input,ask);await page.click('.cc-send-button');
    const opinions='.cc-obligation [data-opinion-round]', pkg='.cc-obligation [data-version-package]';
    await showCard('[data-opinion-round]');
    await wait(s=>document.querySelector(s)?.innerText.includes('有署名异议待核查'),opinions);
    const reviewText=await page.$eval(opinions,e=>e.innerText);
    for(const term of ['至少需 2 人','展品说明清楚','请核对展览许可','第 1 版','已纳入决定依据'])assert(reviewText.includes(term),term);
    holdDecision.open();
    await wait(s=>document.querySelector(s)?.innerText.includes('已核对本次展览的许可范围'),opinions);
    await wait(s=>document.querySelector(s)?.closest('.cc-obligation')?.querySelector(':scope > summary').innerText.includes('已交付'),opinions);
    await key(opinions+' button');await wait(()=>document.activeElement?.classList.contains('cc-message') && document.activeElement.innerText.includes('资料 A 已获得展览许可'));
    await page.screenshot({path:join(base,'review.png')});
    await page.type(input,change);await page.click('.cc-send-button');await showCard('[data-version-package]');
    await wait(s=>document.querySelector(s)?.innerText.includes('已验收 2/2 项'),pkg);
    const edit=pkg+' button[aria-label="修改活动地点"]',dialog=pkg+' dialog[open]', submit=dialog+' [type=submit]';
    await page.type(input,'保留这条草稿');
    await key(edit);await wait(s=>document.querySelector(s)?.open,dialog);
    await page.focus(dialog+' textarea');await page.keyboard.press('Escape');
    await wait(s=>document.activeElement===document.querySelector(s),edit);
    assert.equal(await page.$eval(input,e=>e.value),'保留这条草稿');
    await key(edit);await page.$eval(dialog+' textarea',e=>e.select());await page.keyboard.type('北馆');
    await page.evaluate(()=>{
      const fetchOriginal=window.fetch.bind(window);window.changeRequests=[];
      window.fetch=async(url,options)=>{
        const res=await fetchOriginal(url,options);
        if(typeof url==='string' && url.includes('/version-packages/') && url.endsWith('/change') && options?.method==='POST') {
          window.changeRequests.push(JSON.parse(options.body));
          if(window.changeRequests.length===1 && res.ok)throw new Error('保存回执丢失');
        } return res;
      };
    });
    await key(submit);
    await wait(s=>document.querySelector(s)?.innerText.includes('保存回执丢失'),dialog);
    await wait(s=>document.activeElement===document.querySelector(s),submit);
    assert.equal(await page.$eval(dialog+' textarea',e=>e.value),'北馆');
    await page.keyboard.press('Enter');
    await wait(s=>document.activeElement===document.querySelector(s),edit);
    const requests=await page.evaluate(()=>window.changeRequests);
    assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);
    await wait(s=>document.querySelector(s)?.innerText.includes('活动地点 · v2'),pkg);
    const partText=await page.$$eval(pkg+' > ul:last-of-type > li',es=>es.map(e=>e.innerText));
    assert.match(partText[0],/路线图.*需要重验/s);assert.match(partText[0],/活动地点 v1（当前 v2）/);
    assert.match(partText[1],/嘉宾简介.*已验收.*独立交付/s);
    await key(pkg+' > ul:last-of-type > li:first-child details > summary');
    await wait(s=>document.querySelector(s)?.innerText.includes('验收通过'),pkg);
    assert.equal(await page.$eval(input,e=>e.value),'保留这条草稿');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:join(base,'changed.png')});
    holdRevision.open();await wait(s=>document.querySelector(s)?.innerText.includes('已发布 · 已验收 2/2 项'),pkg);
    await wait(s=>document.querySelector(s)?.closest('.cc-obligation')?.querySelector(':scope > summary').innerText.includes('已交付'),pkg);
    assert.deepEqual(errors,[]);assert.deepEqual(toolErrors,[]);
    results.push({width,approvedOpinions:2,duplicateMaterialRequests:requests.length,originalDecisionKept:true,focusReturned:true,draftKept:true});
  } catch(error){throw Error(error.message+'; fixture errors: '+JSON.stringify(toolErrors),{cause:error});}
  finally{holdDecision.open();holdRevision.open();await page.close();await app.close();}
}
try{for(const width of [1390,390])await exercise(width);}
finally{await browser.close();await writeFile(join(output,'result.json'),JSON.stringify({output,results},null,2));console.log(JSON.stringify({output,results}));}
