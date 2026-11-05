/** Read-only capture of the real workbench acceptance conversation; never submits messages. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
const outputDir = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/cli-api-capture');
await mkdir(outputDir, { recursive: true });
const { default: puppeteer } = await import(pathToFileURL(process.env.PUPPETEER_PATH || '/Users/ruhonglin/lhz/clowder-ai-latest/packages/api/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js').href);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-first-run', '--disable-background-networking'] });
const errors = [];
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1512, height: 1100 });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:4310', { waitUntil: 'networkidle2' });
  await page.waitForSelector('.cc-conversation-list button');
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('.cc-conversation-list button')].find(b => b.textContent.includes('API 密钥 · 双 CLI 实机验收'));
    if (!button) throw new Error('Live acceptance conversation not found.'); button.click();
  });
  await page.waitForFunction(() => document.querySelector('.cc-message-list')?.textContent.includes('ORBIT-37'));
  await page.click('.cc-monitor-button');
  await new Promise(done => setTimeout(done, 400));
  await page.screenshot({ path: resolve(outputDir, 'cli-api-live-workbench.png'), fullPage: true });
  assert.equal(errors.length, 0);
  await writeFile(resolve(outputDir, 'cli-api-live-browser.json'), JSON.stringify({ date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()), source: 'real configured workbench; no injected runtime', conversation: 'API 密钥 · 双 CLI 实机验收', pageErrors: errors, screenshot: 'cli-api-live-workbench.png', readOnlyCapture: true }, null, 2) + '\n');
  console.log('Real workbench capture saved; no browser errors; no messages submitted.');
} finally { await browser.close(); }
