// Compiled UI, temporary HTTP server and database. The runtime is a deterministic fixture.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createApplication } from '../server/index.ts';

const dir = await mkdtemp(join(tmpdir(), 'hydra-observer-ui-'));
const workspace = join(dir, 'work');
await mkdir(workspace);
const app = await createApplication({ workspace, dataDir: join(dir, 'db'), port: 0,
  staticDir: resolve(process.env.VALIDATION_STATIC_DIR || 'dist/web'),
  collaborationRuntime: {
    probe: async () => [],
    invoke: async request => {
      request.onEvent({ kind: 'accepted', detail: { fixture: true } });
      const { obligation } = await request.onToolCall('obligation_open', { goal: '核对材料并交付' }, 'open');
      const text = '核对通过，公开结果如下。';
      await request.onToolCall('obligation_deliver', { obligationId: obligation.id, summary: text }, 'deliver');
      request.onEvent({ kind: 'process_exit', detail: { code: 0, confirmed: true } });
      return { text, continuity: 'fresh' };
    },
  },
});
let browser;
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--disable-background-networking'] });
  const { url } = await app.start();
  const { csrfToken } = await (await fetch(url + '/api/collaboration/bootstrap')).json();
  async function post(path, input) {
    const response = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ requestId: randomUUID(), ...input }) });
    assert.ok(response.ok, await response.text());
  }

  for (const width of [1280, 320]) {
    const title = '公开旁观验收 ' + width;
    const room = app.collaborationStore.create({ requestId: randomUUID(), title, memberIds: ['claude', 'codex'], defaultMemberId: 'claude' }).conversation;
    const path = '/api/conversations/' + room.id;
    const page = await browser.newPage();
    await page.setViewport({ width, height: 700 });
    page.setDefaultTimeout(10000);
    const requests = [];
    let offline = false;
    await page.setRequestInterception(true);
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith('/api/')) {
        requests.push(request.method() + ' ' + pathname);
        if (offline) return void request.respond({ status: 503, body: '{}' });
      }
      void request.continue();
    });
    await page.goto(url + '/?observe=' + room.id);
    await page.waitForFunction(() => document.body.innerText.includes('暂无公开消息'));
    await post(path + '/factors/issue', { memberId: 'codex', content: '私密标记' });
    await post(path + '/messages', { content: '@Claude 帮我核对材料并汇报。' });
    await page.waitForSelector('.cc-observer-result');
    assert.equal(await page.$$eval('.cc-observer-progress li', items => items.length), 1);
    assert.ok(!await page.evaluate(() => document.body.innerText.includes('私密标记') || document.body.innerText.includes('codex')));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), '查看交付');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.matches('.cc-observer ol li') && document.activeElement.textContent.includes('核对通过'));
    offline = true;
    await page.waitForSelector('.cc-observer button');
    assert.equal(await page.$$eval('.cc-observer ol li', items => items.length), 0);
    assert.ok(!await page.evaluate(title => document.body.innerText.includes(title), title));
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), '重新读取');
    offline = false;
    await page.keyboard.press('Enter');
    await page.waitForSelector('.cc-observer-result');
    assert.ok(await page.evaluate(() => document.activeElement?.tagName === 'H1'));
    // Let automatic polling discover the revocation; the reader performs no action.
    await post(path + '/visibility-organize', { expectedRevision: 1, action: 'delete' });
    await page.waitForFunction(() => document.body.innerText.includes('此房间当前无法旁观。'));
    assert.ok(!await page.evaluate(() => document.body.innerText.includes('核对通过')));
    assert.ok(requests.length >= 4 && requests.every(request => request === 'GET ' + path + '/observer'));
    console.log(JSON.stringify({ width, room: room.id, requests: requests.length, mode: 'fixture', passed: true }));
    await page.close();
  }
} finally {
  await browser?.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
