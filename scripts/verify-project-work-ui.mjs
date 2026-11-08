/** Browser interaction checks with an isolated application, an injected folder picker and a synthetic runtime. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../server/index.ts';
import { openWorkspaceTool, closeWorkspace } from './ui-workspace.mjs';

const output = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/project-work-ui/' + new Date().toISOString().replace(/[:.]/g, '-'));
const temp = await mkdtemp(join(tmpdir(), 'project-work-ui-'));
const project = join(temp, '账单'), observed = [], checks = [], errors = [];
const { default: puppeteer } = await import(process.env.PUPPETEER_PATH ? pathToFileURL(process.env.PUPPETEER_PATH).href : 'puppeteer-core');
let app, browser, pickerCount = 0, codexAvailable = true, codexLoggedIn = false, loginChecks = 0;
const supported = { available: true, reason: '浏览器夹具' }, unsupported = { available: false, reason: '此测试组合仅提供只读能力。' };
try {
  await mkdir(output, { recursive: true }); await mkdir(project);
  app = await createApplication({
    port: 0, workspace: join(temp, 'default'), dataDir: join(temp, 'private'), staticDir: resolve(process.env.VALIDATION_STATIC_DIR || 'dist/web'),
    folderPicker: async () => {
      pickerCount++;
      if (pickerCount === 1) throw new Error('fixture: retry picker');
      return pickerCount === 2 ? null : project;
    },
    collaborationRuntime: {
      projectWorkAvailability: member => member.id === 'codex' && codexAvailable ? supported : unsupported,
      probe: async () => ['codex-app-server', 'claude-cli'].map(carrier => ({ carrier, installed: true, available: carrier !== 'codex-app-server' || codexLoggedIn, append: false, authentication: 'cli', verified: 'unverified',
        ...(carrier === 'codex-app-server' && !codexLoggedIn ? { loginRequired: true } : {}),
        nativeProject: { api: unsupported, cli: carrier === 'codex-app-server' && codexAvailable ? supported : unsupported } })),
      discoverAccount: async account => {
        if (++loginChecks === 1) throw new Error('fixture: retry account check');
        codexLoggedIn = true;
        return { accountId: account.id, accountRevision: account.revision ?? 1, checkedAt: new Date().toISOString(), installed: true, configured: true, connection: 'reachable',
          identity: { state: 'authenticated' }, models: [], catalogSource: 'fixture', quota: { state: 'unknown' } };
      },
      invoke: async req => {
        observed.push(req); req.onEvent({ kind: 'accepted', detail: { source: 'synthetic-ui' } });
        if (req.projectWork) {
          const emitTool = data => req.onEvent({ kind: 'tool', detail: { origin: 'native', nativeSessionId: 'sample-session', nativeTurnId: 'first', callId: 'sample-item', ...data } });
          emitTool({ name: 'commandExecution', state: 'started', commandLabel: 'npm test' });
          emitTool({ name: 'commandExecution', state: 'completed', exitCode: 0 });
          emitTool({ name: 'fileChange', nativeTurnId: 'second', state: 'completed', paths: ['report.js','report.css'] });
          emitTool({ name: 'Read', nativeSessionId: 'another-session', state: 'started', path: 'report.test.js' });
        }
        req.onEvent({ kind: 'process_exit', detail: { confirmed: true } });
        return { text: '合成执行 ' + observed.length, continuity: 'fresh' };
      }
    }
  });
  const { url } = await app.start();
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--disable-background-networking', '--no-first-run'] });
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.setDefaultTimeout(12000); await page.setViewport({ width: 1390, height: 850 });
  const wait = (fn, ...args) => page.waitForFunction(fn, {}, ...args);
  const see = (selector) => page.waitForSelector(selector, { visible: true });
  const gone = selector => page.waitForSelector(selector, { hidden: true });
  async function click(label, scope = 'body') {
    const handle = await wait((text, parent) => [...document.querySelectorAll(parent + ' button')].find(b => b.textContent.trim() === text && !b.disabled && b.getClientRects().length), label, scope);
    await handle.asElement().click(); await handle.dispose();
  }
  async function send(body) {
    await wait(() => !document.querySelector('#cc-message-input').disabled);
    await page.type('#cc-message-input', body); await page.click('.cc-send-button');
    await wait(() => document.querySelector('#cc-message-input').value === '' && !document.querySelector('#cc-message-input').disabled);
  }
  const intent = '.cc-project-intent', input = '#cc-message-input', card = '.cc-project-preview';
  const store = app.collaborationStore;
  const detail = () => store.detail(store.list()[0].id);
  await page.goto(url, {waitUntil:'networkidle2'}); await see(input);
  const task = '@Codex 修复项目里的月报导出，并跑测试';
  await send(task); await see(intent);
  assert.equal(await page.$eval(intent + ' blockquote', e => e.textContent), task);
  assert.equal(observed.length, 0); assert.equal(detail().sources.length, 0); checks.push('first request is visible beside its authorization, with no dispatch');
  await page.reload({waitUntil:'networkidle2'}); await see(intent);
  await click('选择文件夹…', intent); await see(intent + ' [role=alert]');
  await wait(sel => document.activeElement.matches(sel) && !document.activeElement.disabled, intent + ' .cc-project-actions button:first-child');
  await page.keyboard.press('Enter'); await wait(sel => document.querySelector(sel)?.textContent.includes('已取消选择'), intent + ' [role=status]');
  assert.equal(observed.length,0); assert.equal(pickerCount,2); checks.push('refresh, picker error, keyboard retry and cancel retain the original pending request');
  await page.keyboard.press('Enter'); await see(card);
  await wait(selector => document.activeElement === document.querySelector(selector),card);
  assert.ok(await page.$eval(card, e => e.textContent.includes('codex login') && e.querySelector('.cc-project-primary').disabled));
  await page.type(input,'登录时保留草稿');
  await click('重新检查',card); await see(intent + ' [role=alert]');
  assert.equal(observed.length,0);
  await click('重新检查',card);
  await wait(selector => document.querySelector(selector)?.textContent.includes('Codex 在项目虚拟机中运行原生命令。'),card);
  assert.equal(await page.$eval(input,e=>e.value),'登录时保留草稿');
  assert.equal(pickerCount,3); assert.equal(observed.length,0);
  await wait(sel => document.activeElement === document.querySelector(sel), card + ' button');
  await page.$eval(input,e=>e.select()); await page.keyboard.press('Backspace');
  checks.push('official login guidance, failed check, retry and keyboard focus retain the original folder, request and composer');
  assert.equal(await page.$eval(card + ' code',e=>e.textContent),await realpath(project));
  await click('取消', card); await gone(card); assert.equal(detail().conversation.workspaceGrant,undefined);
  await click('选择文件夹…', intent); await see(card); await page.type(input,'草稿保留');
  await page.screenshot({path:join(output,'desktop.png')});
  await click('确认并继续委托',card); await gone(intent); await see('.cc-native-project-activity summary');
  assert.equal(observed.length,1); assert.equal(detail().sources.length,1); assert.equal(await page.$eval(input,e=>e.value),'草稿保留');
  assert.equal(observed[0].cwd,await realpath(project)); await page.click('.cc-native-project-activity summary');
  const summaryLabel = await page.$eval('.cc-native-project-activity summary', el => el.textContent);
  assert.match(summaryLabel,/3 项操作/);
  const activity = await page.$$eval('.cc-native-project-activity details[open] li', els => els.map(el => el.textContent));
  assert.deepEqual(activity, ['运行命令 · 已完成npm test退出码 0','修改文件 · 已完成report.jsreport.css','读取文件 · 结果待核查report.test.js']);
  checks.push('grant starts original request once, preserves draft and shows native fixture receipt in chat');
  await page.$eval(input,e=>e.select()); await page.keyboard.press('Backspace');
  await openWorkspaceTool(page,'project'); await click('收回工作授权…'); await click('确认收回工作授权');
  await wait(()=>document.querySelector('#cc-workspace .cc-project-current')?.textContent.endsWith('只读')); await closeWorkspace(page);
  assert.equal(detail().conversation.workspaceGrant.mode,'read-only'); checks.push('explicit revoke returns project to read-only');
  await page.setViewport({width:320,height:700,isMobile:true,hasTouch:true});
  await send('@Claude Code 修改账本文件'); await see(intent); const count = pickerCount;
  await click('核对当前项目',intent); await see(card); assert.equal(pickerCount,count);
  assert.ok(await page.$eval(card, e => e.textContent.includes('此测试组合仅提供只读能力') && e.querySelector('button').disabled));
  await page.screenshot({path:join(output,'mobile.png')});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
  await click('按只读咨询发送',intent); await gone(intent);
  await wait(()=>[...document.querySelectorAll('.cc-prose')].some(e=>e.textContent==='合成执行 2'));
  assert.equal(observed.length,2); assert.ok(!observed[1].projectWork); checks.push('320px old grant reuses same folder, denied combination identifies reason and can deliver read-only');
  await send('@Claude Code 修改项目数据'); await see(intent); await click('放弃委托',intent); await gone(intent);
  assert.equal(observed.length,2); assert.equal(detail().projectIntents.length,0);
  checks.push('abandon leaves zero new deliveries');
  codexAvailable = false;
  await openWorkspaceTool(page,'project'); await click('允许在此项目工作…'); await see(card);
  assert.ok(await page.$eval(card,e=>e.textContent.includes('当前成员仅可读取文件。工作授权可以单独保存')));
  await click('确认项目工作授权'); await wait(()=>document.querySelector('#cc-workspace .cc-project-current')?.textContent.includes('已授权项目工作'));
  assert.equal(observed.length,2); checks.push('workbench can save grant independently without dispatching a request');
  const initialRevision = detail().conversation.workspaceGrant.revision;
  const permission = card + ' input[type="checkbox"]';
  async function expandReviewPermission() {
    await click('项目权限');
    await see(permission); await page.focus(permission); await page.keyboard.press('Space');
    await wait(sel=>{const el=document.querySelector(sel);return el?.checked && !el.disabled;},permission);
  }
  await expandReviewPermission(); await click('取消', card); await gone(card);
  assert.equal(detail().conversation.workspaceGrant.revision,initialRevision);
  assert.equal(detail().conversation.workspaceGrant.reviewMode,undefined);
  await expandReviewPermission(); await click('确认项目工作授权',card); await gone(card);
  assert.equal(detail().conversation.workspaceGrant.reviewMode,'project');
  assert.equal(observed.length,2);
  checks.push('320px keyboard selection previews, cancels and explicitly saves independent review on the existing folder');
  await closeWorkspace(page);
  const originalId = detail().conversation.id;
  const originalRow = '.cc-thread-row[data-thread-id="' + originalId + '"] .cc-thread-main';
  await page.type(input,'切换后继续写');
  async function openSidebar() {
    await page.click('button[aria-label="打开会话列表"]');
    await wait(() => Math.abs(document.querySelector('.cc-sidebar.cc-open')?.getBoundingClientRect().left ?? -1000) < 1);
  }
  await openSidebar(); await page.click('.cc-new-button');
  assert.equal(await page.$eval(input,e=>e.value),'');
  await wait(() => document.querySelector('.cc-sidebar').getBoundingClientRect().right < 1);
  await openSidebar(); await see(originalRow); await page.click(originalRow);
  await wait(()=>document.querySelector('#cc-message-input').value === '切换后继续写');
  checks.push('changing conversation and returning on mobile preserves the composer draft');
  assert.deepEqual(errors,[]); checks.push('no browser exceptions');
  await writeFile(join(output,'result.json'),JSON.stringify({ok:true,checks,syntheticInvocations:observed.length,realInvocations:0,errors},null,2));
  console.log(JSON.stringify({ok:true,checks:checks.length,syntheticInvocations:observed.length,realInvocations:0,output}));
} catch (e) {
  await writeFile(join(output,'failure.json'),JSON.stringify({error:e.stack,checks,errors},null,2)); console.error(e); process.exitCode=1;
} finally {
  await browser?.close(); await app?.close(); await rm(temp,{recursive:true,force:true});
}
