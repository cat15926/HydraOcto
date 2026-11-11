// Normal workbench + real HTTP, SQLite and projection; capture the actual input at the fixture carrier.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createApplication } from '../server/index.ts';

const dir = await mkdtemp(join(tmpdir(), 'hydra-excerpt-ui-'));
const workspace = join(dir, 'work');
await mkdir(workspace);
const inputs = [];
const app = await createApplication({ workspace, dataDir: join(dir, 'db'), port: 0,
  staticDir: resolve(process.env.VALIDATION_STATIC_DIR || 'dist/web'),
  collaborationRuntime: { probe: async () => [], invoke: async request => {
    inputs.push({ room: request.conversationId, member: request.member.id, prompt: request.prompt });
    request.onEvent({ kind: 'accepted', detail: { fixture: true } });
    request.onEvent({ kind: 'process_exit', detail: { confirmed: true, code: 0 } });
    return { text: '收到。', continuity: 'fresh' };
  }},
});
let browser;
try {
  const { url } = await app.start();
  const { csrfToken } = await (await fetch(url + '/api/collaboration/bootstrap')).json();
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--disable-background-networking'] });
  for (const width of [1360, 390]) {
    const createRoom = title => app.collaborationStore.create({ requestId: randomUUID(), title, memberIds: ['codex', 'claude'], defaultMemberId: 'claude' }).conversation;
    const target = createRoom('接收资料 ' + width);
    const source = createRoom('发出资料 ' + width);
    const approved = 'SHARE-' + width, remainder = '仅来源房间保留-' + randomUUID();
    const original = approved + '。' + remainder;
    const sent = await fetch(url + '/api/conversations/' + source.id + '/messages', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ requestId: randomUUID(), content: original }) });
    assert.ok(sent.ok, await sent.text());

    const page = await browser.newPage();
    page.setDefaultTimeout(9000);
    try {
      await page.setViewport({ width, height: 844 });
      await page.evaluateOnNewDocument(() => {
        const originalFetch = window.fetch.bind(window);
        window.shareAttempts = [];
        window.fetch = async (resource, init) => {
          if (String(resource).endsWith('/share-excerpts') && init?.method === 'POST') {
            const response = await originalFetch(resource, init);
            window.shareAttempts.push({ body: JSON.parse(init.body), status: response.status });
            if (response.ok && window.shareAttempts.length === 1) throw Error('回执连接中断');
            return response;
          }
          return originalFetch(resource, init);
        };
      });
      await page.goto(url);
      const row = '.cc-thread-main[title="' + source.title + '"]';
      if (width < 480) {
        await page.locator('[aria-label="打开会话列表"]').click();
        await page.waitForSelector('.cc-sidebar.cc-open ' + row, { visible: true });
      }
      await page.locator(row).click();
      await page.waitForFunction(title => document.querySelector('.cc-conversation-title-row h1')?.textContent === title, {}, source.title);
      if (width < 480) {
        await page.waitForFunction(() => !document.querySelector('.cc-sidebar.cc-open'));
        await page.$eval('.cc-sidebar', async el => { await Promise.allSettled(el.getAnimations().map(a => a.finished)); });
      }
      const summary = '.cc-message-actions details > summary';
      await page.waitForSelector(summary, { visible: true });
      await page.locator(summary).click();
      const buttonWith = async (selector, text) => {
        const handle = await page.waitForFunction((sel, label) => [...document.querySelectorAll(sel)].find(el =>
          el.getClientRects().length && !el.disabled && el.textContent.trim() === label), {}, selector, text);
        try {
          const button = handle.asElement();
          await button.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
          await page.waitForFunction(el => {
            const rect = el.getBoundingClientRect();
            return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
          }, { timeout: 3500 }, button);
          await button.click();
        } finally { await handle.dispose(); }
      };
      const open = () => buttonWith('.cc-message-actions button', '分享选段到其他会话');
      const modal = 'dialog.cc-excerpt-dialog[open]';
      async function choose() {
        await open();
        await page.waitForSelector(modal + ' textarea', { visible: true });
        assert.equal(await page.$eval(modal + ' textarea', element => element.value), original);
        await page.focus(modal + ' textarea');
        await page.keyboard.press('Home');
        await page.keyboard.down('Shift');
        for (const char of approved) await page.keyboard.press('ArrowRight');
        await page.keyboard.up('Shift');
        await page.waitForFunction((sel, expected) => document.querySelector(sel + ' blockquote')?.textContent === expected, {}, modal, approved);
        const selects = await page.$$(modal + ' select');
        await selects[0].select(target.id);
        await selects[1].select('codex');
        assert.ok(await page.$eval(modal, dialog => dialog.scrollWidth <= dialog.clientWidth && dialog.getBoundingClientRect().right <= innerWidth));
      }
      await choose();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('dialog.cc-excerpt-dialog[open]') &&
        document.activeElement.textContent === '分享选段到其他会话');
      assert.equal(inputs.filter(row => row.room === target.id).length, 0);
      assert.equal(await page.evaluate(() => window.shareAttempts.length), 0);
      await choose();
      await buttonWith(modal + ' button', '确认并发送选段');
      await page.waitForSelector(modal + ' [role="alert"]', { visible: true });
      assert.equal(await page.$eval(modal + ' blockquote', el => el.textContent), approved);
      await buttonWith(modal + ' button', '确认并发送选段');
      await page.waitForFunction(title => [...document.querySelectorAll('[role=status]')].some(el =>
        el.textContent.includes('已投递') && el.textContent.includes(title) && el.textContent.includes('Codex')), {}, target.title);
      const attempts = await page.evaluate(() => window.shareAttempts);
      assert.deepEqual(attempts.map(item => item.status), [200, 200]);
      assert.deepEqual(attempts[1].body, attempts[0].body);
      const { messageId, start, end } = attempts[0].body.refs[0];
      assert.equal(original.slice(start, end), approved);
      const targetPath = '/api/conversations/' + target.id;
      const detail = await (await fetch(url + targetPath)).json();
      assert.equal(detail.crossTransfers.length, 1);
      assert.equal(detail.crossGrants.length, 1);
      const calls = inputs.filter(row => row.room === target.id);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].member, 'codex');
      assert.ok(calls[0].prompt.includes(approved));
      for (const restricted of [remainder, messageId, source.id]) assert.ok(!calls[0].prompt.includes(restricted), '载荷泄露来源材料或标识');
      for (const endpoint of [targetPath + '/observer', targetPath + '?viewer=claude']) {
        const response = await fetch(url + endpoint);
        assert.equal(response.status, 200);
        const projection = await response.text();
        for (const restricted of [approved, remainder, messageId, source.id]) assert.ok(!projection.includes(restricted));
      }
      console.log(JSON.stringify({ width, receiver: calls[0].member, transfers: detail.crossTransfers.length, attempts: attempts.length, mode: 'fixture', passed: true }));
    } catch (error) {
      console.error(await page.evaluate(() => ({width: innerWidth, active: document.activeElement?.outerHTML.slice(0,200),
        buttons: [...document.querySelectorAll('.cc-knowledge-choices button')].filter(e => e.textContent === '分享选段到其他会话').map(e => {
          const r = e.getBoundingClientRect();return { x:r.x,y:r.y,w:r.width,h:r.height, top:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,180) };
        })})));
      throw error;
    } finally { await page.close(); }
  }
} finally {
  await browser?.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
