/** N0–N2 UI integration against temporary SQLite and an injected runtime; no real models or credentials. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../dist/server/index.js';

const root = resolve(import.meta.dirname, '..');
const output = resolve(process.env.UI_OUTPUT_DIR || process.env.VALIDATION_OUTPUT_DIR || join(root, '.local-data/validation/n0-n2-ui'));
const dataDir = await mkdtemp(join(tmpdir(), 'n0-n2-ui-'));
const { default: puppeteer } = await import(pathToFileURL(process.env.PUPPETEER_PATH || '/Users/ruhonglin/lhz/clowder-ai-latest/packages/api/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js').href);
const calls = [];
let nextBehavior = 'success';
const runtime = {
  async probe() { return ['codex-app-server', 'claude-cli'].map(carrier => ({ carrier, installed: true, available: true, append: false, authentication: 'cli', verified: 'protocol_tested', version: 'UI fixture' })); },
  async invoke(request) {
    calls.push(request);
    const behavior = nextBehavior; nextBehavior = 'success';
    request.onEvent({ kind: 'session', detail: { nativeSessionId: `fixture-session-${request.invocationId}`, continuity: 'fresh' } });
    request.onEvent({ kind: 'accepted', detail: { nativeTurnId: `fixture-turn-${request.invocationId}` } });
    if (behavior === 'unknown') throw new Error('受控断线，原执行退出尚未确认。');
    if (behavior === 'held') await request.onToolCall('collaboration_request', { targets: ['claude'], content: '请核对这条合成材料。' }, 'fixture-held-request');
    request.onEvent({ kind: 'process_exit', detail: { code: 0, confirmed: true, fixture: true } });
    return { text: `${request.member.name}：已处理本次合成验收输入。`, continuity: 'fresh' };
  },
  async inspect(request) { return { invocationId: request.invocationId, carrier: request.member.carrier, nativeSessionId: request.nativeSessionId, nativeTurnId: request.nativeTurnId, state: 'unsupported', acceptance: 'unknown', teardown: 'unknown', reason: '测试承载不支持跨连接核查，不能推断原执行结果。', observedAt: new Date().toISOString(), evidence: [] }; },
};
const checks = [];
const check = (name, pass) => { assert.ok(pass, name); checks.push(name); };
let app, browser, page;
let url, boot;
const post = async (path, body) => {
  const response = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': boot.csrfToken }, body: JSON.stringify(body) });
  const result = await response.json(); assert.ok(response.ok, `${path}: ${response.status} ${result.error || ''}`); return result;
};
const read = async path => (await fetch(url + path)).json();
const errors = [];
try {
  await mkdir(output, { recursive: true });
  app = await createApplication({ dataDir, port: 0, staticDir: join(root, 'dist/web'), collaborationRuntime: runtime });
  ({ url } = await app.start()); boot = await read('/api/collaboration/bootstrap');
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-first-run', '--disable-background-networking'] });
  page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 1512, height: 982 }); await page.goto(url, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#cc-message-input');
  check('composer needs no recipient or message type selector', !(await page.$('.cc-composer select')));
  await page.type('#cc-message-input', '@claude 请分析这条合成输入。'); await page.click('.cc-send-button');
  await page.waitForFunction(() => document.querySelectorAll('.cc-message-member .cc-status-succeeded').length === 1);
  check('explicit first message reaches Claude', calls.length === 1 && calls[0].member.id === 'claude');
  await page.type('#cc-message-input', '继续说明其中的边界。');
  await page.waitForFunction(() => document.querySelector('.cc-route-preview')?.textContent.includes('预计交给 Claude'));
  check('natural follow-up shows read-only server route preview', await page.$('.cc-route-preview'));
  await page.click('.cc-send-button');
  await page.waitForFunction(() => document.querySelectorAll('.cc-message-member .cc-status-succeeded').length === 2);
  check('natural follow-up stays with Claude despite default Codex', calls.length === 2 && calls[1].member.id === 'claude');
  await page.click('.cc-monitor-button'); await page.waitForSelector('.cc-monitor.cc-open');
  await page.click('.cc-execution > summary'); await page.waitForSelector('.cc-contract-audit');
  check('execution contract and manifest are displayed', await page.$('.cc-input-audit[data-manifest-id]'));
  check('manifest alone is not labelled provider acceptance', (await page.$eval('.cc-input-audit', el => el.textContent)).includes('不代表承载已经接受'));
  await page.click('.cc-input-audit > .cc-text-button'); await page.waitForSelector('.cc-input-payload');
  check('explicit payload inspection reads frozen submitted input', (await page.$eval('.cc-input-payload', el => el.textContent)).includes('继续说明其中的边界'));
  const firstConversation = (await read('/api/collaboration/bootstrap')).conversations[0].id;
  const d = await read('/api/conversations/' + firstConversation);
  check('runtime prompt matches immutable input endpoint', (await read('/api/invocations/' + d.invocations.at(-1).id + '/input')).prompt === calls[1].prompt);
  nextBehavior = 'unknown';
  await page.type('#cc-message-input', '@codex 核查断线状态的测试。'); await page.click('.cc-send-button');
  await page.waitForSelector('.cc-uncertain .cc-reconcile-button');
  const retryIds = []; let abortOnce = true;
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url().endsWith('/reconcile')) {
      retryIds.push(JSON.parse(request.postData()).requestId);
      if (abortOnce) { abortOnce = false; void request.abort('failed'); return; }
    }
    void request.continue();
  });
  await page.click('.cc-uncertain .cc-reconcile-button');
  await page.waitForSelector('.cc-error-banner');
  check('network error preserves user-visible recoverable failure', await page.$('.cc-uncertain'));
  await page.waitForFunction(() => !document.querySelector('.cc-uncertain .cc-reconcile-button')?.disabled);
  await page.click('.cc-uncertain .cc-reconcile-button');
  await page.waitForFunction(() => document.querySelector('.cc-result-banner')?.textContent.includes('仍待核查'));
  check('network retry preserves exact recovery command identity', retryIds.length === 2 && retryIds[0] === retryIds[1]);
  check('unsupported inspection remains unknown and does not resend', calls.length === 3 && !!(await page.$('.cc-uncertain')));
  await page.screenshot({ path: join(output, 'desktop.png') });
  const pending = await post('/api/conversations/' + firstConversation + '/messages', { content: '@codex 尚未执行的后续工作，只作为他人的公开背景。', requestId: crypto.randomUUID() });
  await post('/api/conversations/' + firstConversation + '/messages', { content: '@claude 核对公开背景，保留其他成员的待办责任。', requestId: crypto.randomUUID() });
  await page.waitForFunction(() => document.querySelectorAll('.cc-message-member .cc-status-succeeded').length === 3);
  const responsibilityDetail = await read('/api/conversations/' + firstConversation);
  const latestRun = responsibilityDetail.invocations.at(-1);
  await page.click(`.cc-execution[data-invocation-id="${latestRun.id}"] > summary`);
  const responsibilitySelector = `.cc-source-responsibility[data-source-id="${pending.source.id}"]`;
  await page.waitForSelector(responsibilitySelector);
  const responsibilityText = await page.$eval(responsibilitySelector, el => el.textContent);
  check('visible pending background preserves original delivery responsibility', responsibilityText.includes('仅作背景') && responsibilityText.includes('当前执行不新增消费关系') && responsibilityText.includes('codex · 等待投递') && responsibilityText.includes('仍由此原投递负责'));
  check('response background is distinguished from missing historical delivery evidence', (await page.$eval(`.cc-execution[data-invocation-id="${latestRun.id}"] .cc-input-audit`, el => el.textContent)).includes('此背景不关联来源投递'));
  check('visible background creates no extra consumption or provider invocation', calls.length === 4 && !responsibilityDetail.consumptions.some(c => c.sourceId === pending.source.id) && responsibilityDetail.deliveries.find(delivery => delivery.sourceId === pending.source.id)?.status === 'pending');
  await page.$eval(responsibilitySelector, el => el.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: join(output, 'responsibility.png') });
  await page.setViewport({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('.cc-sidebar')?.getBoundingClientRect().right <= 1);
  await page.$eval(responsibilitySelector, el => el.scrollIntoView({ block: 'center' }));
  check('mobile responsibility detail has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(output, 'mobile-responsibility.png') });
  await page.setViewport({ width: 1512, height: 982 });
  const claude = boot.members.find(member => member.id === 'claude');
  const created = await post('/api/conversations', { title: '投递重验验收', memberIds: ['codex', 'claude'], defaultMemberId: 'codex', requestId: crypto.randomUUID() });
  await post('/api/members', { ...claude, enabled: false });
  nextBehavior = 'held';
  await post('/api/conversations/' + created.conversation.id + '/messages', { content: '创建一个需要重验的协作投递。', requestId: crypto.randomUUID() });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.cc-monitor-button'); await page.click('.cc-monitor-button');
  await page.waitForSelector('.cc-recheck-button'); await page.click('.cc-recheck-button');
  await page.waitForFunction(() => document.querySelector('.cc-result-banner')?.textContent.includes('仍暂缓投递'));
  check('disabled target remains held after explicit recheck', await page.$('.cc-recheck-button'));
  await post('/api/members', { ...claude, enabled: true });
  await page.click('.cc-recheck-button');
  await page.waitForFunction(() => document.querySelector('.cc-result-banner')?.textContent.includes('投递条件已满足'));
  await page.waitForFunction(() => document.querySelectorAll('.cc-message-member .cc-status-succeeded').length === 2);
  check('recheck returns original delivery to scheduling, with no duplicate invocation', calls.length === 6 && calls.at(-1).member.id === 'claude');
  const heldDetail = await read('/api/conversations/' + created.conversation.id);
  check('recheck decision and exact caller persist and show in execution detail', heldDetail.holdRechecks.length === 2 && heldDetail.inputManifests.some(m => m.caller?.memberId === 'codex'));
  await page.click('[aria-label="收起协作动态"]'); await page.setViewport({ width: 390, height: 844 });
  await page.type('#cc-message-input', '继续讨论。');
  await page.waitForFunction(() => document.querySelector('.cc-route-preview')?.textContent.includes('预计交给'));
  check('mobile has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check('mobile send button remains visible', await page.$eval('.cc-send-button', el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }));
  await page.screenshot({ path: join(output, 'mobile.png') });
  check('no uncaught browser application errors', errors.length === 0);
  await writeFile(join(output, 'report.json'), JSON.stringify({ passed: true, fixtureOnly: true, checks, runtimeInvocations: calls.length, browserErrors: errors }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, checks: checks.length, runtimeInvocations: calls.length, output }));
} catch (error) {
  await writeFile(join(output, 'report.json'), JSON.stringify({ passed: false, fixtureOnly: true, checks, error: error.message, browserErrors: errors }, null, 2) + '\n');
  throw error;
} finally { await browser?.close(); await app?.close(); await rm(dataDir, { recursive: true, force: true }); }
