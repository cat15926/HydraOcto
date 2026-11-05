import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Browser-level checks of the offline review prototype, not production runtime tests.
// Pass an installed puppeteer-core ESM entry; no runtime dependency is added to the app.
const modulePath = process.argv[2];
if (!modulePath) throw new Error('Usage: node scripts/check-collaboration-prototype.mjs /absolute/path/to/puppeteer-core.js');
const { default: puppeteer } = await import(pathToFileURL(resolve(modulePath)).href);
const output = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/prototype-v4');
await mkdir(output, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.PROTOTYPE_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-first-run', '--disable-background-networking'],
});
const results = { kind: 'offline-prototype-browser-validation', checkedAt: new Date().toISOString(), checks: [], scenarios: [] };
const check = (name, value) => { assert.ok(value, name); results.checks.push(name); };
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(pathToFileURL(resolve('prototypes/continuous-collaboration/history/v4/prototype.html')).href);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('collab-review-prototype-v4')));
  const body = () => page.$eval('body', e => e.innerText);
  const action = async (name) => { await page.click(`[data-action="${name}"]`); };
  const scenario = async (id) => { await page.select('#scenario', id); await action('reset'); };
  const next = () => action('next');
  const capture = async (filename) => {
    await page.waitForFunction(() => !document.querySelector('.toast'), { timeout: 8000 });
    await page.screenshot({ path: join(output, filename), fullPage: true });
  };
  const typeMessage = async text => {
    await page.$eval('#message-input', input => { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.type('#message-input', text);
  };
  const send = async text => {
    await typeMessage(text);
    await page.click('#composer button[type="submit"]');
  };
  const lastUser = async () => (await state()).messages.filter(m => m.sender === 'user').at(-1);
  const options = await page.$$eval('#scenario option', nodes => nodes.map(n => n.value));
  assert.deepEqual(options, ['assist', 'parallel', 'consume', 'pause', 'handoff', 'fairness', 'context', 'recovery']);
  results.checks.push('Eight selectable scenarios');

  for (const id of options) {
    await scenario(id);
    const snapshots = [];
    for (let i = 0; i < 20; i++) {
      if (await page.$eval('[data-action="next"]', b => b.disabled)) break;
      await next();
      const current = await state();
      snapshots.push({ step: current.step, owner: current.owner, ownerRevision: current.ownerRevision, paused: current.paused, returns: current.returns, active: Object.values(current.states).filter(s => ['执行中', '等待退出', '核对中'].includes(s)).length });
    }
    const done = await state();
    check(`${id}: reaches last step`, await page.$eval('[data-action="next"]', b => b.disabled));
    check(`${id}: step progression`, snapshots.every((s, i) => s.step === i + 1));
    results.scenarios.push({ id, steps: done.step, final: snapshots.at(-1) });
    if (id === 'assist') check('Assistance retains original task owner', done.owner === 'lin');
    if (id === 'parallel') check('Parallel group has one logical return after late result', done.group.closed && done.group.wakeCount === 1);
    if (id === 'consume') {
      const first = done.messages.find(m => m.kind === 'supplement').deliveries[0];
      const second = done.messages.find(m => m.kind === 'stale').deliveries[0];
      check('Supplement ownership remains on exact first run', first.consumed && first.invocation === 'xu-run-1');
      check('Confirmed unaccepted supplement reaches next run', second.consumed && second.invocation === 'xu-run-2');
    }
    if (id === 'handoff') {
      check('Owner changes only after release step', snapshots.slice(0, 4).every(s => s.owner === 'lin'));
      check('Formal handoff changes owner and revision', done.owner === 'xu' && done.ownerRevision === 2);
      check('Late result cannot revert task ownership', snapshots.at(-1).owner === snapshots.at(-2).owner);
      await capture('handoff.png');
    }
    if (id === 'fairness') {
      assert.deepEqual(done.claims, ['A0', 'U1', 'U2', 'A1', 'U3', 'U4', 'A2']);
      check('Fair scheduling follows 2 user then 1 automatic, while unrelated member proceeds', done.claims[0] === 'A0');
      check('Scheduler never exceeds two occupied execution slots', snapshots.every(s => s.active <= 2));
      await capture('fairness.png');
    }
    if (id === 'context') {
      check('Session rebuilt without losing request', done.sessions.xu.includes('session-2') && done.messages[0].body.includes('v3'));
      check('New version remains deferred from frozen review', done.contextItems.find(x => x.version === 'v4')?.decision === '延后');
      check('Unauthorized trigger is never inserted', done.contextItems.find(x => x.decision === '权限过滤')?.representation === '未提供');
      check('Run snapshot records rebuilt native session', done.runConfigs.xu.session.includes('session-2'));
      check('Context review keeps formal request and returns its versioned result once', done.requests.some(r => r.id === 'R-701' && r.status === '已完成' && r.wakeCount === 1) && done.returns === 1);
      await capture('context.png');
    }
    if (id === 'recovery') {
      check('Existing result recovery has no new tool attempt', done.recovery.attempt === 1 && done.returns === 1);
      await capture('recovery.png');
    }
    await action('previous');
    check(`${id}: previous restores earlier step`, (await state()).step === done.step - 1);
    await next();
    check(`${id}: replay does not duplicate ownership or returns`, (await state()).owner === done.owner && (await state()).returns === done.returns);
  }

  await scenario('handoff'); await next(); await next(); await next();
  const beforeBlocked = await state();
  await send('@林 等待退出时不能启动替代执行');
  check('Free input cannot bypass pending process exit', (await state()).invocations.lin === beforeBlocked.invocations.lin && !(await lastUser()).deliveries[0].invocation);
  check('Blocked ordinary reply cannot dispatch', await page.$eval('[data-action="dispatch-reply"]', b => b.disabled));

  await scenario('assist');
  for (let i = 0; i < 4; i++) await next();
  await send('@序 自定义讨论不能与预设复核共用一次执行');
  const manualId = (await lastUser()).id;
  check('Custom message waits while scripted scenario is active', (await lastUser()).deliveries[0].status.startsWith('已排队'));
  await next();
  const mixed = await state();
  check('Scripted dependency gets its own run, custom input remains unassigned', mixed.requests.find(r => r.id === 'R-102').invocation && !mixed.messages.find(m => m.id === manualId).deliveries[0].invocation);
  await next();
  await page.click(`[data-action="select-message"][data-id="${manualId}"]`);
  await page.click(`[data-action="dispatch-reply"][data-id="${manualId}"]`);
  check('Custom work can dispatch after scripted demonstration', (await state()).messages.find(m => m.id === manualId).deliveries[0].invocation);

  await scenario('parallel'); await next(); await next(); await next();
  await send('@林 新增讨论在演示结束后处理');
  await next(); await next(); await next();
  check('Custom reply cannot strand or falsely claim group return', (await state()).group.wakeCount === 1 && (await state()).returns === 1);

  await scenario('recovery'); await next(); await next();
  const unknown = await state();
  await send('@序 结果未知时不能抢占同一执行槽');
  check('Free input cannot bypass unknown operation occupancy', (await state()).invocations.xu === unknown.invocations.xu && !(await lastUser()).deliveries[0].invocation);
  await next(); await action('resume');
  check('Resume cannot bypass unresolved operation', (await state()).paused);
  await page.select('#recovery-choice', 'absent');
  await next();
  check('Confirmed nonexecution remains paused until user continues', (await state()).paused && (await state()).recovery.attempt === 1);
  await page.reload();
  check('Refresh preserves reconciliation and pause', (await state()).paused && (await state()).recovery.retryAllowed);
  await next(); await next();
  check('Only confirmed nonexecution permits second attempt', (await state()).recovery.attempt === 2);

  await scenario('consume');
  await page.click('[data-view="members"]');
  await page.select('#bind-xu', 'one');
  await page.click('[data-view="accounts"]');
  await page.select('[data-default="codex"]', 'two');
  await action('apply-accounts');
  check('Default account change preserves explicitly bound member', (await state()).defaults.codex === 'two' && (await state()).bindings.xu === 'one');
  await page.click('[data-view="members"]');
  await page.select('#bind-xu', 'follow');
  check('Active run account snapshot survives configuration change', (await state()).runConfigs.xu.account === 'one');
  await page.click('[data-view="conversation"]');
  for (let i = 0; i < 5; i++) await next();
  check('Next execution resolves changed default account', (await state()).runConfigs.xu.account === 'two');

  await scenario('pause'); await next(); await next();
  check('Pause persisted before refresh', (await state()).paused);
  await page.reload();
  check('Refresh cannot unpause task', (await state()).paused);
  await next();
  check('Delayed result while paused does not wake caller', (await state()).paused && (await state()).returns === 0);

  await scenario('parallel'); await next(); await next(); await next();
  await page.click('[data-action="fail-request"][data-id="R-202"]');
  check('Failed parallel branch is absorbed into single group return', (await state()).group.closed && (await state()).group.wakeCount === 1);
  await next(); await next();
  check('Late parallel result cannot create second return after failure', (await state()).group.wakeCount === 1);

  await scenario('assist'); await next(); await next();
  const notified = await state();
  check('Agent notification remains non-waking without a user message-type selector', notified.messages.some(m => m.kind === 'notify' && m.deliveries[0]?.member === 'zhi') && notified.invocations.zhi === 0);
  await send('@全部 <img src=x onerror="window.prototypeInjected=1"> 请看这条消息');
  check('Optional all mention creates three ordinary deliveries', (await lastUser()).kind === 'reply' && (await lastUser()).deliveries.length === 3);
  check('User message is escaped', await page.evaluate(() => !window.prototypeInjected && document.querySelectorAll('.bubble img').length === 0));
  check('Literal user text remains visible', (await body()).includes('<img src=x'));

  // Product input: no protocol choices before sending; preview and dispatch agree.
  await scenario('fairness');
  check('Composer has no recipient or message-type selector', await page.$$eval('#composer select', nodes => nodes.length === 0));
  check('Composer uses a normal send action', (await page.$eval('#composer button[type="submit"]', b => b.textContent.trim())) === '发送');
  await typeMessage('请继续处理我的要求');
  check('Plain message previews current task owner instead of fixed Lin', (await page.$eval('#route-preview', e => e.textContent)).includes('序'));
  const ordinaryBefore = await state();
  await page.click('#composer button[type="submit"]');
  check('Plain input creates an ordinary reply to automatically resolved recipient', (await lastUser()).kind === 'reply' && (await lastUser()).deliveries.length === 1 && (await lastUser()).deliveries[0].member === 'xu');
  check('Plain input does not manufacture a formal request or change ownership', (await state()).requests.length === ordinaryBefore.requests.length && (await state()).owner === ordinaryBefore.owner);
  check('Busy recipient remains selected and queued', (await lastUser()).deliveries[0].status.startsWith('已排队') && (await state()).invocations.xu === ordinaryBefore.invocations.xu);

  await send('@知 @zhi 请补充资料');
  check('Chinese and English aliases resolve to one recipient', (await lastUser()).deliveries.length === 1 && (await lastUser()).deliveries[0].member === 'zhi');
  await page.reload();
  await page.click('[data-action="select-member"][data-member="lin"]');
  await send('再核对一下刚才的资料');
  check('Last explicit recipient persists across reload and graph selection', (await lastUser()).deliveries.length === 1 && (await lastUser()).deliveries[0].member === 'zhi');
  await send('@序 @zhi 请分别发表意见');
  assert.deepEqual((await lastUser()).deliveries.map(d => d.member).sort(), ['xu', 'zhi']);
  check('Multiple explicit mentions resolve independently without changing task owner', (await state()).owner === 'xu');

  await scenario('context');
  await send('邮箱 user@xu.example，命令 `@林`，代码：\n```text\n@序\n```');
  check('Email and code mentions do not redirect a plain message', (await lastUser()).deliveries.length === 1 && (await lastUser()).deliveries[0].member === 'zhi');
  const beforeInvalid = (await state()).messages.length;
  await send('@不存在 请回复');
  check('Unknown explicit target cannot silently fall back', (await state()).messages.length === beforeInvalid);
  check('Rejected mention preserves the draft', (await page.$eval('#message-input', e => e.value)) === '@不存在 请回复');
  await send('@xunknown 不应当匹配序');
  check('Unknown alias is not partially matched', (await state()).messages.length === beforeInvalid);
  await send('@constructor 不应当匹配对象属性');
  check('Object prototype names are rejected as unknown mentions', (await state()).messages.length === beforeInvalid);
  await typeMessage('@序 请核对');
  check('Correcting an invalid mention restores recipient preview', (await page.$eval('#route-preview', e => e.textContent)).includes('序'));
  await page.focus('#message-input');
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  check('Keyboard shortcut uses the same explicit routing', (await lastUser()).deliveries[0].member === 'xu');

  await scenario('assist');
  await typeMessage('完成。@序 请核对');
  check('Chinese sentence punctuation recognizes an explicit mention', await page.$eval('#route-preview', el => el.dataset.source === 'explicit' && el.dataset.recipients === 'xu'));
  await page.click('#composer button[type="submit"]');
  check('Punctuation mention preview matches actual dispatch', (await lastUser()).deliveries[0].member === 'xu');
  await scenario('assist');
  await send('「@知」请核对');
  check('Chinese quotation marks delimit an exact member mention', (await lastUser()).deliveries[0].member === 'zhi');
  await page.evaluate(() => {
    const key = 'collab-review-prototype-v4', saved = JSON.parse(localStorage.getItem(key));
    delete saved.recentExplicitTargets; delete saved.defaultRecipient; delete saved.lastSuccessfulResponder;
    localStorage.setItem(key, JSON.stringify(saved));
  });
  await page.reload();
  await send('旧原型存档仍可以直接发消息');
  check('Existing v4 state without new routing fields remains usable', (await lastUser()).deliveries[0].member === 'lin');

  await scenario('handoff');
  for (let i = 0; i < 5; i++) await next();
  await send('继续后续实现');
  check('Automatic routing follows formal handoff when user has no explicit override', (await lastUser()).deliveries[0].member === 'xu' && (await state()).ownerRevision === 2);

  await scenario('pause'); await next(); await next();
  const pausedBefore = await state();
  await send('@知 暂停期间补充一条信息');
  check('Ordinary user input preserves pause and creates no execution', (await state()).paused && (await state()).invocations.zhi === pausedBefore.invocations.zhi && !(await lastUser()).deliveries[0].invocation);

  await scenario('fairness');
  for (let i = 0; i < 8; i++) await next();
  await send('请继续解释方案');
  check('Ordinary sending after preset completion starts the resolved member without extra choices', (await lastUser()).deliveries[0].member === 'xu' && (await lastUser()).deliveries[0].invocation && (await state()).states.xu === '执行中');
  await page.$eval('#composer', el => el.scrollIntoView({ block: 'center' }));
  await capture('composer.png');

  await scenario('context'); await next(); await next();
  await page.setViewport({ width: 390, height: 844 });
  check('Narrow viewport has no page overflow', await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  await capture('narrow.png');
  await page.setViewport({ width: 1440, height: 1000 });
  await scenario('handoff');
  for (let i = 0; i < 5; i++) await next();
  await page.waitForFunction(() => !document.querySelector('.toast'), { timeout: 8000 });
  await page.screenshot({ path: resolve('prototypes/continuous-collaboration/history/v4/preview.jpg'), type: 'jpeg', quality: 88 });
  check('No browser JavaScript errors', errors.length === 0);
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(`PASS: ${results.scenarios.length} scenarios; ${results.checks.length} checks; screenshots and results in ${output}`);
} finally {
  await browser.close();
}
