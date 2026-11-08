// Exercise a real browser with an isolated conversation and controlled route response timings.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../dist/server/index.js';

const { default: puppeteer } = await import(process.env.PUPPETEER_PATH ? pathToFileURL(process.env.PUPPETEER_PATH).href : 'puppeteer-core');
const temp = await mkdtemp(join(tmpdir(), 'composer-layout-'));
let app, browser;
try {
  app = await createApplication({
    port: 0, dataDir: join(temp, 'data'), workspace: join(temp, 'workspace'),
    staticDir: resolve(process.env.VALIDATION_STATIC_DIR || 'dist/web'),
    collaborationRuntime: { probe: async () => [], invoke: async () => { throw new Error('Unexpected model invocation'); } },
  });
  app.collaborationStore.create({ title: '输入框验证', memberIds: ['codex','claude'], defaultMemberId: 'claude', requestId: randomUUID() });
  const { url } = await app.start();
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-first-run', '--disable-background-networking'], headless: true,
  });
  for (const width of [1280, 320]) {
    const page = await browser.newPage();
    const input = '#cc-message-input', hint = '.cc-route-preview';
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewport({ width, height: 800 });
    await page.setRequestInterception(true);
    page.on('request', async request => {
      if (request.url().endsWith('/route-preview')) {
        const { content } = JSON.parse(request.postData());
        if (content === 'slow') {
          await delay(450);
        }
        if (content === 'failure') {
          await request.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '预览暂时不可用，请稍后再试。'.repeat(20) }) });
          return;
        }
      }
      await request.continue().catch(() => {}); // Superseded previews can already have been aborted.
    });
    await page.goto(url, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => document.querySelector('.cc-conversation-title')?.textContent.includes('输入框验证') || document.querySelector('h1')?.textContent.includes('输入框验证'));
    await page.focus(input);
    // Sample each painted frame, including the debounce window and the in-flight request.
    await page.evaluate(() => {
      window.composerFrames = [];
      function sample() {
        window.composerFrames.push(['.cc-composer', '#cc-message-input', '.cc-send-button'].flatMap(selector => {
          const { top, height } = document.querySelector(selector).getBoundingClientRect();
          return [top, height];
        }));
        window.composerFrameId = requestAnimationFrame(sample);
      }
      sample();
    });
    const replace = async value => {
      await page.$eval(input, el => el.select());
      await page.keyboard.press('Backspace');
      if (value) await page.type(input, value);
    };
    const waitHint = text => page.waitForFunction((sel, value) => document.querySelector(sel)?.textContent.includes(value), {}, hint, text);
    await replace('slow');
    await waitHint('预计交给 Claude');
    await replace('@codex');
    await waitHint('预计交给 Codex');
    await replace('failure');
    await waitHint('预览暂时不可用');
    if (width === 320) {
      const scrollable = await page.$eval(hint, el => el.scrollHeight > el.clientHeight);
      assert(scrollable, 'long notice should be readable in the reserved space');
      await page.focus(hint);
      await page.keyboard.press('End');
      await page.waitForFunction(sel => document.querySelector(sel).scrollTop > 0, {}, hint);
      await page.focus(input);
    }
    await replace('');
    await page.waitForFunction(sel => !document.querySelector(sel)?.textContent.includes('预览暂时不可用'), {}, hint);
    await replace('@claude');
    await waitHint('预计交给 Claude');
    const result = await page.evaluate(() => {
      cancelAnimationFrame(window.composerFrameId);
      const delta = Math.max(...window.composerFrames.flatMap(frame => frame.map((value, i) => Math.abs(value - window.composerFrames[0][i]))));
      return { delta, focus: document.activeElement.id, draft: document.querySelector('#cc-message-input').value,
        overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, ...result }));
    assert.deepEqual(result, { delta: 0, focus: 'cc-message-input', draft: '@claude', overflow: false });
    await page.close();
  }
} finally {
  await browser?.close();
  await app?.close();
  await rm(temp, { recursive: true, force: true });
}
