/** Exercise the member editor through a browser using a disposable account and model catalogue. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../dist/server/index.js';

const output = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/n10b/ui');
const root = await mkdtemp(join(tmpdir(), 'hermes-member-ui-'));
const runtime = {
  probe: async () => [{ carrier: 'hermes-agent', authentication: 'api', installed: true, available: true, version: '0.18.2', verified: 'unverified', append: false }],
  discoverAccount: async account => ({ accountId: account.id, accountRevision: account.revision, checkedAt: new Date().toISOString(),
    installed: true, configured: true, connection: 'reachable', identity: { state: 'unknown' }, models: [{ id: 'fixture-chat', name: 'Fixture Chat', efforts: [] }],
    catalogSource: 'fixture', quota: { state: 'unknown' } }),
  invoke: async () => { throw new Error('Unexpected model invocation'); },
};
const app = await createApplication({ dataDir: join(root, 'private'), port: 0, workspace: join(root, 'workspace'), collaborationRuntime: runtime,
  staticDir: resolve(process.env.VALIDATION_STATIC_DIR || 'dist/web') });
let browser;
try {
  await mkdir(output, { recursive: true });
  process.env.N10B_UI_TEST_KEY = 'test-only';
  app.collaborationStore.saveAccount({ id: 'fixture-api', provider: 'openai', auth: 'api', name: '测试 API', apiKeyEnv: 'N10B_UI_TEST_KEY' });
  const { url } = await app.start();
  const { default: puppeteer } = await import(pathToFileURL(process.env.PUPPETEER_PATH ||
    '/Users/ruhonglin/lhz/clowder-ai-latest/packages/api/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js').href);
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--no-first-run', '--disable-background-networking'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.setViewport({ width: 1380, height: 900 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cc-sidebar-bottom button:enabled');
  await page.click('.cc-sidebar-bottom button');
  const form = '.cc-settings-form';
  await page.type(form + ' input[name=name]', 'Hermes 同伴');
  await page.select(form + ' select', 'hermes-agent');
  await page.waitForSelector(form + ' select[name=model] option[value="fixture-chat"]');
  assert.deepEqual(await page.$$eval(form + ' [name=accountId] option:not(:disabled)', os => os.map(o => o.value)), ['fixture-api']);
  assert.equal(await page.$(form + ' [name=effort]'), null);
  await page.select(form + ' [name=model]', 'fixture-chat');
  await page.screenshot({ path: join(output, 'member-desktop.png') });
  await page.setViewport({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(output, 'member-mobile.png') });
  await page.click(form + ' .cc-button-primary');
  await page.waitForFunction(() => document.querySelector('.cc-settings-list')?.textContent.includes('Hermes 同伴'));
  const saved = app.collaborationStore.members().find(m => m.name === 'Hermes 同伴');
  assert.equal(saved?.carrier, 'hermes-agent');
  assert.equal(saved.accountId, 'fixture-api');
  assert.equal(saved.model, 'fixture-chat');
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, memberSaved: true, compatibleAccountsOnly: true,
    automaticModelCatalogue: true, mobileWidth: 390, realModelCalls: 0 }, null, 2));
} finally {
  await browser?.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
