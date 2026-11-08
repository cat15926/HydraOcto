// Isolated browser scenario. The runtime captures its typed inputs, without calling a model.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../server/index.ts';

const { default: puppeteer } = await import(process.env.PUPPETEER_PATH ? pathToFileURL(process.env.PUPPETEER_PATH).href : 'puppeteer-core');
const temp = await mkdtemp(join(tmpdir(), 'chat-images-'));
const output = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/chat-images/' + randomUUID());
const calls = [], errors = [];
let app, browser;
try {
  await mkdir(output, { recursive:true });
  app = await createApplication({
    port:0, dataDir:join(temp,'db'), workspace:join(temp,'project'), staticDir:resolve(process.env.VALIDATION_STATIC_DIR || 'dist/web'),
    collaborationRuntime:{
      probe:async () => [{carrier:'codex-app-server', installed:true, available:true, append:false, authentication:'cli', verified:'unverified'}],
      invoke:async req => {
        calls.push({prompt:req.prompt, images:req.images});
        req.onEvent({kind:'accepted', detail:{source:'ui-fixture'}});
        req.onEvent({kind:'process_exit', detail:{confirmed:true}});
        return {text:'已收到截图。', continuity:'unknown'};
      },
    },
  });
  const { url } = await app.start();
  browser = await puppeteer.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking','--no-first-run']});
  const page = await browser.newPage();
  page.on('pageerror', err => errors.push(err.message));
  await page.setViewport({width:320,height:740});
  await page.goto(url, {waitUntil:'networkidle2'});
  await page.waitForSelector('#cc-message-input');
  const image = await page.evaluate(() => {
    const canvas=document.createElement('canvas'); canvas.width=200; canvas.height=65;
    const context=canvas.getContext('2d');
    context.fillStyle='white'; context.fillRect(0,0,200,65);
    context.fillStyle='black'; context.font='24px sans-serif'; context.fillText('收据示例',8,37);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const bytes = Buffer.from(image,'base64');
  const filename = join(temp,'receipt.png'); await writeFile(filename,bytes);
  const paste = async () => page.evaluate(encoded => {
    const file=new File([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],'截图.png',{type:'image/png'});
    const clipboardData=new DataTransfer(); clipboardData.items.add(file);
    document.querySelector('#cc-message-input').dispatchEvent(new ClipboardEvent('paste',{clipboardData,bubbles:true,cancelable:true}));
  },image);
  await paste(); await page.waitForFunction(()=>document.querySelector('.cc-draft-image img')?.naturalWidth>0);
  await page.click('.cc-draft-image'); await page.waitForSelector('.cc-picture-dialog[open]');
  await page.keyboard.press('Escape'); await page.waitForFunction(()=>!document.querySelector('dialog[open]'));
  await page.click('button[aria-label^="移除附件"]'); await page.waitForFunction(()=>document.activeElement?.id==='cc-message-input');
  assert.equal(app.collaborationStore.list().length,0);
  assert.equal(await page.$('.cc-draft-file'),null);
  const fileInput=await page.$('input[aria-label="添加图片或文本附件"]');
  await fileInput.uploadFile(filename); await page.waitForSelector('.cc-draft-image img');
  await page.type('#cc-message-input','核对图片');
  // Simulate a lost message response after the server accepted it. The same upload and send IDs must survive retry.
  await page.evaluate(()=>{
    const original=window.fetch;
    window.fetch=async (...args)=>{
      const response=await original(...args);
      if(String(args[0]).endsWith('/messages') && args[1]?.method==='POST' && response.ok){
        window.fetch=original;
        throw new TypeError('模拟发送回执丢失');
      }
      return response;
    };
  });
  await page.click('.cc-send-button');
  await page.waitForFunction(()=>document.querySelector('.cc-error-banner')?.textContent.includes('回执丢失'));
  assert.equal(await page.$eval('#cc-message-input',e=>e.value),'核对图片');
  assert.ok(await page.$('.cc-draft-file'));
  async function openSidebar() {
    await page.waitForFunction(()=>document.querySelector('.cc-sidebar').getBoundingClientRect().right<1);
    await page.click('button[aria-label="打开会话列表"]');
    await page.waitForFunction(()=>Math.abs(document.querySelector('.cc-sidebar.cc-open')?.getBoundingClientRect().left ?? 999)<1);
  }
  await openSidebar(); await page.click('.cc-new-button');
  assert.equal(await page.$eval('#cc-message-input',e=>e.value),'');
  await openSidebar(); await page.click('.cc-thread-main[title="核对图片"]');
  await page.waitForFunction(()=>document.querySelector('.cc-draft-image img')?.naturalWidth===200);
  await page.click('.cc-send-button');
  await page.waitForFunction(()=>!document.querySelector('.cc-draft-file') && document.querySelector('.cc-sent-image img')?.naturalWidth===200);
  await page.reload({waitUntil:'networkidle2'});
  await page.waitForFunction(()=>document.querySelector('.cc-sent-image img')?.naturalWidth===200 && [...document.querySelectorAll('.cc-prose')].some(n=>n.textContent.includes('已收到截图')));
  await page.click('.cc-sent-image'); await page.waitForSelector('.cc-picture-dialog[open] img');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:join(output,'image-mobile.png')});
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('.cc-sent-image',el=>el===document.activeElement),true);
  assert.equal(calls.length,1); assert.equal(calls[0].images?.length,1);
  assert.equal(calls[0].images[0].base64,image);
  assert.equal(calls[0].images[0].digest,createHash('sha256').update(bytes).digest('hex'));
  assert(!calls[0].prompt.includes(image));
  const conversation=app.collaborationStore.list()[0];
  assert.equal(app.collaborationStore.workbench.attachments(conversation.id).length,1);
  assert.equal(app.collaborationStore.detail(conversation.id).messages.filter(m=>m.author==='user').length,1);
  const wrongType=join(temp,'animated.gif'); await writeFile(wrongType,'GIF89a');
  await (await page.$('input[type=file]')).uploadFile(wrongType);
  await page.waitForFunction(()=>document.querySelector('.cc-error-banner')?.textContent.includes('图片支持'));
  assert.equal(await page.$('.cc-draft-file'),null);
  assert.deepEqual(errors,[]);
  const report={passed:true,width:320,checks:['paste','cancel before upload','file selection','switch away and return to draft','retry after lost receipt','one typed image','reload and keyboard focus','unsupported type'],modelCalls:0};
  await writeFile(join(output,'result.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report));
} finally { await browser?.close(); await app?.close(); await rm(temp,{recursive:true,force:true}); }
