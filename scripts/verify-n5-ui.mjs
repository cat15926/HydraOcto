/** Isolated synthetic runtime. No production database, credentials or model calls. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../dist/server/index.js';
const output = resolve(process.env.VALIDATION_OUTPUT_DIR || `.local-data/validation/n5-ui/${new Date().toISOString().replace(/[:.]/g, '-')}`);
const temp = await mkdtemp(join(tmpdir(), 'n5-ui-'));
const { default: puppeteer } = await import(pathToFileURL(process.env.PUPPETEER_PATH || '/Users/ruhonglin/lhz/clowder-ai-latest/packages/api/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js').href);
const checks = [], calls = [], errors = [];
const check = (label, ok) => { assert.ok(ok, label); checks.push(label); };
let app, browser;
const runtime = { probe: async () => [], invoke: async r => {
  calls.push(r); r.onEvent({ kind: 'accepted', detail: {} });
  if (r.member.id === 'codex') {
    const answer = await r.onToolCall('user_question', { questions: [{ id: 'format', question: '希望使用哪种格式？', options: ['Markdown', 'Text'] }] }, 'question');
    check('platform question returned exact answer', answer.answers?.format === 'Markdown');
    await r.onToolCall('artifact_propose', { name: 'design.md', content: '# N5 material\n<script>window.BAD=true</script>\nExact version for review.' }, 'proposal');
  } else {
    const list = await r.onToolCall('artifact_list', {}, 'list'), review = list.reviews.find(r => r.state === 'pending');
    await r.onToolCall('artifact_read', { versionId: review.versionId }, 'read');
    await r.onToolCall('review_submit', { reviewId: review.id, versionId: review.versionId, digest: review.digest, expectedRevision: review.revision, verdict: 'accept', comment: '已核对固定版本内容。' }, 'verdict');
  }
  r.onEvent({ kind: 'process_exit', detail: { confirmed: true } }); return { text: '合成验证完成。', continuity: 'fresh' };
} };
try {
  await mkdir(output, { recursive: true }); app = await createApplication({ port: 0, dataDir: temp, staticDir: resolve(process.env.VALIDATION_STATIC_DIR || 'dist/web'), collaborationRuntime: runtime }); const { url } = await app.start();
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-first-run', '--disable-background-networking'] });
  const page = await browser.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.setViewport({ width: 1512, height: 982 });
  const click = async (label, scope = 'body') => { await page.waitForFunction((label, scope) => [...document.querySelectorAll(scope + ' button')].some(b => b.textContent.trim() === label && !b.disabled), {}, label, scope); await page.evaluate((label, scope) => [...document.querySelectorAll(scope + ' button')].find(b => b.textContent.trim() === label).click(), label, scope); };
  await page.goto(url, { waitUntil: 'networkidle2' }); await page.waitForSelector('#cc-message-input');
  check('natural composer remains free of routing choices', !(await page.$('.cc-composer select')));
  await page.type('#cc-message-input', '@codex 提出一个产物'); await page.click('.cc-send-button'); await page.click('.cc-monitor-button');
  await click('回答问题'); await page.type('[name=answer-format]', 'Markdown'); await click('提交答案', '.cc-artifact-dialog');
  await page.waitForSelector('[data-artifact-id]'); await page.click('[data-artifact-id] > summary');
  await click('审查并决定'); await page.waitForFunction(() => document.querySelector('.cc-artifact-preview')?.textContent.includes('Exact version'));
  check('full exact text safely rendered', await page.evaluate(() => !window.BAD && document.querySelector('.cc-artifact-preview').textContent.includes('<script>')));
  const cid = app.collaborationStore.list()[0].id;
  check('proposal does not publish or write a job before consent', app.collaborationStore.artifacts.detail(cid).jobs.length === 0);
  await page.screenshot({ path: join(output, 'approval-desktop.png') }); await click('批准此版本写入');
  await page.waitForFunction(() => document.querySelector('.cc-artifact-panel')?.textContent.includes('已发布'));
  check('exact approval materializes one file', app.collaborationStore.artifacts.detail(cid).jobs[0].state === 'succeeded');
  await click('请求评审'); await page.select('[name=reviewerMemberId]', 'claude'); await click('提交', '.cc-artifact-dialog');
  await page.waitForFunction(() => document.querySelector('.cc-artifact-panel')?.textContent.includes('当前有效'));
  check('review visible with fixed version and current verdict', app.collaborationStore.artifacts.detail(cid).reviews[0].current === true);
  await page.screenshot({ path: join(output, 'review-desktop.png') });
  await click('提出新版本'); await page.type('[name=content]', 'Replacement material'); await click('提交', '.cc-artifact-dialog');
  await page.waitForFunction(() => document.querySelectorAll('.cc-artifact-version').length === 2); await click('审查并决定'); await click('批准此版本写入');
  await page.waitForFunction(() => document.querySelector('.cc-artifact-panel')?.textContent.includes('历史结论，当前无效'));
  check('old verdict visibly invalidated by replacement version', app.collaborationStore.artifacts.detail(cid).reviews[0].current === false);
  await page.reload({ waitUntil: 'networkidle2' }); await page.click('.cc-monitor-button'); await page.waitForSelector('[data-artifact-id]'); await page.click('[data-artifact-id] > summary');
  check('versions and review history survive reload', (await page.$eval('.cc-artifact-panel', e => e.textContent)).includes('历史结论，当前无效'));
  check('ordinary task completion remains separate', app.collaborationStore.tasks.list(cid).length === 0);
  await page.setViewport({ width: 390, height: 844 }); await click('提出产物');
  check('mobile modal fits viewport', await page.$eval('.cc-artifact-dialog', e => e.getBoundingClientRect().left >= 0 && e.getBoundingClientRect().right <= innerWidth));
  await page.screenshot({ path: join(output, 'artifact-mobile.png') }); await click('关闭', '.cc-artifact-dialog');
  check('mobile content does not overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  check('no browser runtime errors', errors.length === 0); check('only two requested synthetic invocations', calls.length === 2);
  await writeFile(join(output, 'result.json'), JSON.stringify({ passed: true, testedAt: new Date().toISOString(), checks, calls: calls.length, runtime: 'synthetic', errors }, null, 2)); console.log(JSON.stringify({ passed: true, checks: checks.length, output }));
} finally { await browser?.close(); await app?.close(); await rm(temp, { recursive: true, force: true }); }
