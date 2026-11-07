import { openWorkspaceTool, closeWorkspace } from './ui-workspace.mjs';
/** Browser integration: isolated SQLite + synthetic runtime; no model calls. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../dist/server/index.js';
const root = resolve(import.meta.dirname, '..');
const output = resolve(process.env.VALIDATION_OUTPUT_DIR || `.local-data/validation/n3-ui/${new Date().toISOString().replace(/[:.]/g, '-')}`);
const temp = await mkdtemp(join(tmpdir(), 'n3-ui-'));
const { default: puppeteer } = await import(pathToFileURL(process.env.PUPPETEER_PATH || '/Users/ruhonglin/lhz/clowder-ai-latest/packages/api/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js').href);
const checks = [], calls = [], errors = [];
const check = (name, ok) => { assert.ok(ok, name); checks.push(name); };
const runtime = {
  async probe() { return [{ carrier: 'codex-app-server', installed: true, available: true, append: false, authentication: 'cli', verified: 'protocol_tested', version: 'N3 fixture' }]; },
  async sessionIdentity() { return { supported: true, fingerprint: 'ui-fixture-identity', version: 'N3 fixture', reason: 'UI fixture' }; },
  async invoke(r) {
    calls.push(r); const sid = r.nativeSessionId || crypto.randomUUID(), continuity = r.nativeSessionId ? 'resumed' : 'fresh';
    r.onEvent({ kind: 'session', detail: { nativeSessionId: sid, continuity, anchor: r.invocationId, previousAnchor: r.sessionPlan?.previousAnchor, historyVerified: true } });
    r.onEvent({ kind: 'accepted', detail: { nativeSessionId: sid, nativeTurnId: r.invocationId } });
    if (calls.length === 1) r.onEvent({ kind: 'usage', detail: { source: 'UI fixture', scope: 'invocation', inputTokens: 25, outputTokens: 5 } });
    r.onEvent({ kind: 'process_exit', detail: { confirmed: true, code: 0 } });
    return { nativeSessionId: sid, nativeTurnId: r.invocationId, text: '本轮合成请求已处理。', continuity };
  },
};
let app, browser;
try {
  await mkdir(output, { recursive: true });
  app = await createApplication({ port: 0, dataDir: temp, staticDir: resolve(process.env.VALIDATION_STATIC_DIR || join(root, 'dist/web')), collaborationRuntime: runtime });
  const { url } = await app.start();
  const boot = await (await fetch(`${url}/api/collaboration/bootstrap`)).json();
  const post = async (path, body) => {
    if (path === '/api/members') {
      body = { ...body, expectedRevision: app.collaborationStore.members().find(m => m.id === body.id)?.revision ?? 0, requestId: crypto.randomUUID() };
      if (body.model) { const { account, ticket } = app.collaborationStore.workbench.beginProbe(body.accountId); app.collaborationStore.workbench.finishProbe(account, ticket, { accountId: account.id, accountRevision: account.revision ?? 1, checkedAt: new Date().toISOString(), installed: true, configured: true, connection: 'reachable', identity: { state: 'unknown' }, models: [{ id: body.model, name: body.model, efforts: [] }], catalogSource: 'synthetic-ui-fixture', quota: { state: 'unknown' } }); }
    } const r = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': boot.csrfToken }, body: JSON.stringify(body) }); assert.ok(r.ok); return r.json(); };
  const member = { ...boot.members.find(m => m.id === 'codex'), model: 'fixture-model' }; await post('/api/members', member);
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-first-run', '--disable-background-networking'] });
  const page = await browser.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.setViewport({ width: 1512, height: 982 });
  await page.goto(url, { waitUntil: 'networkidle2' }); await page.waitForSelector('#cc-message-input');
  check('natural composer has no required routing controls', !(await page.$('.cc-composer select')));
  const send = async (text, count) => { await page.type('#cc-message-input', text); await page.click('.cc-send-button'); await page.waitForFunction(n => document.querySelectorAll('.cc-message-member .cc-status-succeeded').length === n, {}, count); };
  await send('@codex 首轮合成消息', 1); await send('继续处理', 2);
  check('second invocation carries exact saved native session', calls[1].nativeSessionId && calls[1].nativeSessionId !== undefined && calls[1].sessionPlan.mode === 'resume');
  await openWorkspaceTool(page, 'activity'); await page.waitForSelector('.cc-session-chain');
  check('single generation is ready for continued use', (await page.$eval('.cc-session-chain', el => el.textContent)).includes('第 1 代 · 可续接'));
  await page.click('.cc-execution > summary');
  const latest = await page.$eval('.cc-execution', el => el.textContent);
  check('proof-backed native resume shown in execution detail', latest.includes('已恢复原生会话') && latest.includes('请求续接'));
  check('missing native usage and cost remain unknown', latest.includes('未取得原生用量') && latest.includes('未知'));
  await page.screenshot({ path: join(output, 'resumed-desktop.png') });
  await post('/api/members', { ...member, model: 'different-fixture-model' });
  await send('修改模型后的消息', 3);
  check('incompatible model does not reuse prior session', calls[2].nativeSessionId === undefined && calls[2].sessionPlan.mode === 'replace');
  await page.waitForFunction(() => document.querySelector('.cc-session-chain')?.textContent.includes('第 2 代'));
  const chain = await page.$eval('.cc-session-chain', el => el.textContent);
  check('generation chain preserves sealed predecessor and replacement reason', chain.includes('第 1 代 · 已封存') && chain.includes('第 2 代 · 可续接') && chain.includes('模型变化'));
  await page.reload({ waitUntil: 'networkidle2' }); await openWorkspaceTool(page, 'activity'); await page.waitForSelector('.cc-session-chain');
  check('session chain survives browser reload', (await page.$$('.cc-session-chain details')).length === 2);
  await page.click('.cc-session-chain summary'); await page.click('.cc-execution > summary');
  await page.screenshot({ path: join(output, 'replaced-desktop.png') });
  await page.setViewport({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('.cc-sidebar').getBoundingClientRect().right <= 0);
  check('mobile session panel is not obscured by the closed sidebar', await page.$eval('.cc-sidebar', el => el.getBoundingClientRect().right <= 0));
  check('mobile layout does not overflow horizontally', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(output, 'mobile.png') });
  check('no browser runtime errors', errors.length === 0);
  check('exactly three synthetic invocations and no automatic callback', calls.length === 3);
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, testedAt: new Date().toISOString(), version: boot.version, checks, runtimeInvocations: calls.length, runtime: 'synthetic fixture', errors }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, checks: checks.length, output }));
} finally { await browser?.close(); await app?.close(); await rm(temp, { recursive: true, force: true }); }
