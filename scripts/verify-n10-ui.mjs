import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../dist/server/index.js';
import { historyFixture } from './runtime/history-fixture.mjs';
const output = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/n10a/ui');
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'n10-ui-')),
  f = await historyFixture(temp);
process.env.CODEX_HOME = f.profile;
const app = await createApplication({
  port: 0,
  workspace: f.cwd,
  dataDir: join(temp, 'private'),
  staticDir: resolve(process.env.VALIDATION_STATIC_DIR || 'dist/web'),
  collaborationRuntime: f.runtime,
});
const { default: puppeteer } = await import(
  pathToFileURL(
    process.env.PUPPETEER_PATH ||
      '/Users/ruhonglin/lhz/clowder-ai-latest/packages/api/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js',
  ).href
);
let browser;
const checks = [],
  errors = [];
const check = (label, value) => {
  assert.ok(value, label);
  checks.push(label);
};
try {
  const old = app.collaborationStore.create({
    title: '原会话',
    memberIds: ['codex'],
    defaultMemberId: 'codex',
    requestId: crypto.randomUUID(),
  }).conversation;
  const { url } = await app.start();
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-first-run', '--disable-background-networking'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1410, height: 900 });
  await page.goto(url, { waitUntil: 'networkidle2' });
  await page.type('#cc-message-input', '保留草稿');
  await page.focus('.cc-import-entry');
  await page.keyboard.press('Enter');
  const list = 'dialog ul[aria-label="可导入的会话"] button',
    entry = '.cc-import-entry';
  await page.waitForSelector(list, { visible: true });
  check('only authorized session shown', await page.$$eval(list, (x) => x.length === 1));
  await page.keyboard.press('Escape');
  await page.waitForSelector('dialog', { hidden: true });
  await page.waitForFunction((sel) => document.activeElement === document.querySelector(sel), {}, entry);
  check(
    'cancel restores trigger focus and original draft',
    (await page.$eval(entry, (e) => e === document.activeElement)) &&
      (await page.$eval('#cc-message-input', (e) => e.value === '保留草稿')),
  );
  const intact = await readFile(f.file);
  await writeFile(f.file, '尚未完成的 JSONL');
  await page.click(entry);
  await page.waitForFunction(() => document.querySelector('dialog')?.innerText.includes('格式不受支持'));
  check('unreadable source provides a reason and no candidate title', (await page.$$(list)).length === 0);
  await writeFile(f.file, intact);
  await page.evaluate(() =>
    [...document.querySelectorAll('dialog button')].find((b) => b.textContent === '重新查找会话')?.click(),
  );
  await page.waitForSelector(list);
  await page.click(list);
  await page.waitForSelector('dialog ol li');
  check(
    'preview shows account, project and private audience',
    await page.$eval(
      '.cc-history-body',
      (e) => e.textContent.includes('仅你和') && e.textContent.includes('Codex 官方 CLI 登录'),
    ),
  );
  await page.click('button[aria-label="到第 4 条结束"]');
  check(
    'range selectable without typing offsets',
    await page.$eval('dialog footer .primary', (e) => e.textContent === '导入 4 条消息'),
  );
  await page.screenshot({ path: join(output, 'range-desktop.png') });
  await page.setViewport({ width: 390, height: 844 });
  check(
    'mobile dialog and primary action visible',
    await page.$eval('dialog footer .primary', (e) => {
      const r = e.getBoundingClientRect();
      return r.right <= innerWidth && r.bottom <= innerHeight && r.top >= 0;
    }),
  );
  await page.screenshot({ path: join(output, 'range-mobile.png') });
  const original = await readFile(f.file, 'utf8');
  const lastLine = original
    .trimEnd()
    .split('\n')
    .map((row) => JSON.parse(row))
    .findLast((r) => r.payload?.item?.type === 'AgentMessage');
  const append = {
    ...lastLine,
    payload: {
      ...lastLine.payload,
      item: {
        ...lastLine.payload.item,
        id: crypto.randomUUID(),
        content: [{ type: 'Text', text: '新写入的排除标记' }],
      },
    },
  };
  await appendFile(f.file, JSON.stringify(append) + '\n');
  await page.click('dialog footer .primary');
  await page.waitForSelector('dialog [role=alert]');
  check(
    'stale confirmation writes nothing and requires refreshing',
    app.collaborationStore.list().length === 1 && (await page.$eval('dialog footer .primary', (e) => e.disabled)),
  );
  await page.click('dialog [role=alert] button');
  await page.waitForFunction(() => document.querySelector('dialog ol')?.children.length === 7);
  check(
    'refresh preserves the exact four selected messages after an append',
    await page.$eval('dialog footer .primary', (e) => e.textContent === '导入 4 条消息' && !e.disabled),
  );
  await writeFile(f.file, original.replace('选中回复', '已修改的选中回复'));
  await page.click('dialog footer .primary');
  await page.waitForSelector('dialog [role=alert] button');
  await page.click('dialog [role=alert] button');
  await page.waitForFunction(() =>
    document.querySelector('dialog footer .primary')?.innerText.includes('0 条消息'),
  );
  check(
    'changed selection requires explicit reselection',
    await page.$eval('dialog footer .primary', (e) => e.disabled),
  );
  await page.click('button[aria-label="到第 4 条结束"]');
  await page.click('dialog footer .primary');
  await page.waitForFunction(() => document.querySelector('h1')?.textContent.includes('导入的 Codex'));
  check(
    'confirm opens new chat with just the selected lines',
    await page.$$eval(
      '.cc-message',
      (els) => els.length === 4 && els.every((e) => !e.textContent.includes('排除标记')),
    ),
  );
  check(
    'import triggers no model or delivery',
    f.calls.length === 0 && app.collaborationStore.invocations().length === 0,
  );
  await page.type('#cc-message-input', '请继续');
  await page.click('.cc-send-button');
  await page.waitForFunction(() => document.querySelector('.cc-message-list')?.textContent.includes('合成回复'));
  check(
    'first send gets selected private history in a new execution',
    f.calls.length === 1 &&
      f.calls[0].prompt.includes('选中回复') &&
      !f.calls[0].prompt.includes('排除标记') &&
      !f.calls[0].nativeSessionId,
  );
  check('original chat remains distinct', app.collaborationStore.detail(old.id).messages.length === 0);
  check('no browser errors', errors.length === 0);
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify({ passed: true, checks, errors, realCalls: 0 }, null, 2),
  );
  console.log('Passed', checks.length);
} finally {
  await browser?.close();
  await app.close();
  await rm(temp, { recursive: true, force: true });
}
