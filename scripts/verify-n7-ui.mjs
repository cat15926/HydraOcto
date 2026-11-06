/** N7 browser acceptance: isolated data and synthetic runtime, no real model calls. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../dist/server/index.js';
const output = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/n7-ui/' + new Date().toISOString().replace(/[:.]/g, '-'));
const temp = await mkdtemp(join(tmpdir(), 'n7-ui-')), project = join(temp, 'project'), second = join(temp, 'second');
const { default: puppeteer } = await import(pathToFileURL(process.env.PUPPETEER_PATH || '/Users/ruhonglin/lhz/clowder-ai-latest/packages/api/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js').href);
const calls = [], checks = [], errors = [];
const check = (label, ok) => { assert.ok(ok, label); checks.push(label); };
let app, browser;
try {
  await mkdir(output, { recursive: true }); await mkdir(project); await mkdir(second);
  const file = join(temp, 'real-context.txt'); await writeFile(file, 'N7_BROWSER_ATTACHMENT_VALUE\n@claude this text does not route');
  app = await createApplication({ port: 0, dataDir: join(temp, 'private'), workspace: project, staticDir: resolve(process.env.VALIDATION_STATIC_DIR || 'dist/web'), collaborationRuntime: {
    probe: async () => [], discoverAccount: async a => ({ accountId: a.id, accountRevision: a.revision ?? 1, checkedAt: new Date().toISOString(), installed: true, configured: true, connection: 'reachable', identity: { state: 'unknown' }, models: [{ id: 'fixture-model', name: 'N7 Synthetic model', efforts: ['low', 'high'] }], catalogSource: 'synthetic-browser-only', quota: { state: 'unknown' } }),
    invoke: async r => { calls.push(r); r.onEvent({ kind: 'accepted', detail: { source: 'synthetic-browser' } }); r.onEvent({ kind: 'process_exit', detail: { confirmed: true } }); return { text: `N7 合成结果 ${calls.length}`, continuity: 'fresh' }; },
  } }); const { url } = await app.start();
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-first-run', '--disable-background-networking'] });
  const page = await browser.newPage(); page.on('pageerror', e => errors.push(e.stack || e.message)); await page.setViewport({ width: 1512, height: 982 });
  const click = async (label, scope = 'body') => { await page.waitForFunction((label, scope) => [...document.querySelectorAll(scope + ' button')].some(b => b.textContent.trim() === label && !b.disabled), {}, label, scope); await page.evaluate((label, scope) => [...document.querySelectorAll(scope + ' button')].find(b => b.textContent.trim() === label && !b.disabled).click(), label, scope); };
  const fill = async (selector, text) => { await page.click(selector); await page.$eval(selector, el => el.select()); await page.keyboard.press('Backspace'); await page.type(selector, text); };
  const until = async fn => { const end = Date.now() + 10000; while (!fn()) { if (Date.now() > end) throw new Error('UI fixture timed out'); await new Promise(r => setTimeout(r, 20)); } };
  const selectLabel = async (label, value) => { const h = await page.evaluateHandle(label => [...document.querySelectorAll('dialog label')].find(l => l.firstChild?.textContent.trim() === label)?.querySelector('select'), label); await h.asElement().select(value); await h.dispose(); };
  await page.goto(url, { waitUntil: 'networkidle2' }); await page.waitForSelector('#cc-message-input');
  check('composer has no recipient or message type selectors', !(await page.$('.cc-composer select')));
  await (await page.$('input[aria-label="上传文本附件"]')).uploadFile(file); await page.waitForSelector('.cc-composer-attachment');
  check('file upload stores bytes before send without requiring text', app.collaborationStore.workbench.attachments(app.collaborationStore.list()[0].id)[0].bytes > 0 && await page.$eval('#cc-message-input', e => e.value === ''));
  await page.click('.cc-send-button'); await until(() => calls.length === 1); await page.waitForSelector('.cc-message-user .cc-attachment');
  check('pure attachment is present in real invocation input and cannot route embedded mention', calls[0].prompt.includes('N7_BROWSER_ATTACHMENT_VALUE') && calls[0].member.id === 'codex');
  await page.click('.cc-message-user .cc-reply-button'); await page.type('#cc-message-input', '继续说明附件'); await page.click('.cc-send-button'); await until(() => calls.length === 2); await page.waitForSelector('.cc-reply-reference');
  check('reply target and attachment history persist to the next actual input', calls[1].prompt.includes('N7_BROWSER_ATTACHMENT_VALUE') && app.collaborationStore.detail(calls[0].conversationId).messages.some(m => m.replyTo));
  await page.click('.cc-workbench summary'); await fill('.cc-workbench input[name="title"]', 'N7 日常项目'); await click('保存名称'); await page.waitForFunction(() => document.querySelector('h1').textContent === 'N7 日常项目');
  await click('置顶会话'); await page.waitForFunction(() => document.querySelector('.cc-conversation-list').textContent.includes('↑ N7'));
  check('rename and pin persist server-side', app.collaborationStore.list()[0].pinned && app.collaborationStore.list()[0].title === 'N7 日常项目');
  await click('归档会话'); await page.waitForFunction(() => document.querySelector('#cc-message-input').disabled);
  check('archiving preserves history and disables new input', app.collaborationStore.list()[0].archivedAt && app.collaborationStore.detail(calls[0].conversationId).messages.length === 4);
  await click('查看归档会话'); await page.waitForFunction(() => document.querySelector('.cc-conversation-list').textContent.includes('N7 日常项目'));
  await click('恢复会话'); await page.waitForFunction(() => !document.querySelector('#cc-message-input').disabled); await click('返回进行中的会话');
  check('archived conversations remain discoverable and can be restored', !app.collaborationStore.list()[0].archivedAt);
  await fill('.cc-workbench input[name="path"]', second); await click('预览工作区授权'); await page.waitForSelector('.cc-workbench-preview');
  check('preview alone grants no new directory', !app.collaborationStore.list()[0].workspaceGrant);
  await click('授权此项目'); await until(() => !!app.collaborationStore.list()[0].workspaceGrant);
  await page.type('#cc-message-input', '检查新项目'); await page.click('.cc-send-button'); await until(() => calls.length === 3);
  check('authorized project is frozen into next invocation', calls[2].cwd.endsWith('/second') && calls[2].workspaceGrant.path === calls[2].cwd);
  await page.screenshot({ path: join(output, 'workbench-desktop.png') });
  await page.click('.cc-sidebar-bottom button'); await page.waitForSelector('dialog');
  await page.evaluate(() => [...document.querySelectorAll('.cc-settings-item')].find(e => e.querySelector('strong').textContent === 'Codex').click());
  await fill('dialog input[name="name"]', '验收成员'); await fill('dialog input[name="aliases"]', 'reviewer'); await click('刷新所选账户模型目录');
  await page.waitForFunction(() => document.querySelector('select[name="model"]').textContent.includes('N7 Synthetic'));
  await page.select('select[name="model"]', 'fixture-model'); await page.select('select[name="effort"]', 'high'); await click('保存成员');
  await until(() => app.collaborationStore.members().find(m => m.id === 'codex').aliases?.includes('reviewer'));
  check('member name, stable alias, discovered model and effort save together', app.collaborationStore.members()[0].effort === 'high' && app.collaborationStore.members()[0].model === 'fixture-model');
  await click('账户与登录');
  await page.evaluate(() => [...document.querySelectorAll('.cc-settings-item')].find(e => e.querySelector('strong').textContent === 'Codex 官方 CLI 登录').click());
  await page.waitForSelector('.cc-account-observation');
  check('account identity, call and quota are shown independently with unknown quota', (await page.$eval('.cc-account-observation', e => e.textContent)).includes('额度：未知') && (await page.$eval('.cc-account-observation', e => e.textContent)).includes('最近调用：已交付'));
  await page.click('.cc-default-settings summary'); await selectLabel('默认模型', 'fixture-model'); await selectLabel('默认推理强度', 'high'); await click('预览默认配置影响'); await page.waitForSelector('.cc-default-settings .cc-workbench-preview');
  check('default preview lists overrides before apply', (await page.$eval('.cc-default-settings .cc-workbench-preview', e => e.textContent)).includes('保留成员例外：验收成员'));
  await click('应用默认配置'); await until(() => app.collaborationStore.workbench.defaults().length === 1);
  await click('成员与运行时', 'dialog'); await page.evaluate(() => [...document.querySelectorAll('.cc-settings-item')].find(e => e.querySelector('strong').textContent === '验收成员').click());
  await selectLabel('账户绑定', 'follow'); await selectLabel('模型绑定', 'follow'); await click('保存成员'); await until(() => app.collaborationStore.members()[0].accountBinding === 'follow');
  check('member can opt into runtime default following', app.collaborationStore.members()[0].modelBinding === 'follow');
  await page.screenshot({ path: join(output, 'members-desktop.png') });
  await page.click('button[aria-label="关闭设置"]'); await page.type('#cc-message-input', '@reviewer 验证稳定别名'); await page.click('.cc-send-button'); await until(() => calls.length === 4);
  check('alias routes naturally using effective default model and effort', calls[3].member.id === 'codex' && calls[3].member.model === 'fixture-model' && calls[3].member.effort === 'high');
  await page.reload({ waitUntil: 'networkidle2' }); await page.waitForSelector('.cc-message-list');
  check('reload preserves title, attachments and reference links', await page.$eval('h1', e => e.textContent === 'N7 日常项目') && (await page.$$('.cc-attachment')).length === 1 && (await page.$$('.cc-reply-reference')).length === 1);
  await page.setViewport({ width: 390, height: 844 }); await page.waitForFunction(() => document.querySelector('.cc-sidebar').getBoundingClientRect().right <= 0); await page.screenshot({ path: join(output, 'mobile.png') });
  check('mobile composer remains on-screen with optional project controls closed', await page.$eval('.cc-send-button', e => { const r = e.getBoundingClientRect(); return r.right <= innerWidth && r.bottom <= innerHeight && r.top >= 0; }));
  check('no horizontal overflow or browser exceptions', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth) && errors.length === 0);
  await writeFile(join(output, 'result.json'), JSON.stringify({ ok: true, checks, syntheticCalls: calls.length, errors }, null, 2)); console.log(JSON.stringify({ ok: true, checks: checks.length, syntheticCalls: calls.length, output }));
} catch (e) { await writeFile(join(output, 'failure.json'), JSON.stringify({ error: e.stack, checks, errors }, null, 2)); console.error(e); process.exitCode = 1; }
finally { await browser?.close(); await app?.close(); await rm(temp, { recursive: true, force: true }); }
