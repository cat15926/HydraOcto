import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createApplication } from '../server/index.ts';

const dir = await mkdtemp(join(tmpdir(),'chat-markdown-'));
const output = resolve(process.env.VALIDATION_OUTPUT_DIR || join(dir,'results'));
await mkdir(output,{recursive:true});
const body = ['### 项目权限','','- **读取文件**：使用 `Read`。','- 修改文件','','> 授权范围','','```bash','git diff '+ 'a'.repeat(220),'```','','<b>原始标签</b>','','[待查资料](https://example.org/unchecked)'].join('\n');
const app = await createApplication({port:0,dataDir:join(dir,'db'),workspace:join(dir,'project'),staticDir:resolve('dist/web'),
  collaborationRuntime:{probe:async()=>[],invoke:async req=>{
    req.onEvent({kind:'accepted',detail:{evidence:'fixture'}});
    req.onEvent({kind:'process_exit',detail:{confirmed:true}});
    return {text:body,continuity:'fresh'};
  }}});
const browser = await puppeteer.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try {
  const {url}=await app.start();
  const page=await browser.newPage();
  await page.goto(url);
  await page.waitForSelector('#cc-message-input');
  await page.type('#cc-message-input','**检查权限**');await page.click('.cc-send-button');
  const reply='.cc-message-member';
  for(const width of [1390,390]){
    await page.setViewport({width,height:900});
    await page.waitForSelector(reply+' .cc-agent-markdown h3');
    const aligned=await page.evaluate(()=>{
      const pos=s=>document.querySelector(s).getBoundingClientRect();
      const user=pos('.cc-message-user .cc-avatar'),agent=pos('.cc-message-member .cc-avatar');
      return user.left>=pos('.cc-message-user .cc-prose').right && agent.right<=pos('.cc-message-member .cc-prose').left &&
        document.documentElement.scrollWidth===innerWidth;
    });
    assert(aligned);assert.equal(await page.$eval('.cc-message-user .cc-prose',e=>e.textContent),'**检查权限**');
    const md=reply+' .cc-agent-markdown';
    assert.equal(await page.$$eval(md+' li',els=>els.length),2);
    assert.equal(await page.$eval(md+' strong',e=>e.textContent),'读取文件');
    assert(await page.$(md+' blockquote'));assert(await page.$(md+' pre>code'));
    assert.equal(await page.$(md+' a'),null);assert.equal(await page.$(md+' b'),null);
    await page.screenshot({path:join(output,'chat-'+width+'.png')});
    const summary=reply+' .cc-message-actions summary';
    async function toggle(label){
      await page.click(summary);
      const h=await page.waitForFunction(t=>[...document.querySelectorAll('.cc-message-member details[open] button')].find(b=>b.textContent===t),{},label);
      await h.asElement().focus();await page.keyboard.press('Enter');
      await page.waitForFunction(s=>document.activeElement===document.querySelector(s),{},summary);
    }
    await toggle('查看 Markdown 原文');assert.equal(await page.$eval(reply+' .cc-markdown-source',e=>e.textContent),body);
    await toggle('返回排版视图');
    await page.reload({waitUntil:'domcontentloaded'});
  }
  await writeFile(join(output,'result.json'),JSON.stringify({passed:true,widths:[1390,390],realModelCalls:0}));
} finally {await browser.close();await app.close();}
