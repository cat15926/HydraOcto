import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { docsArchiveRoot } from '../../docs-paths.mjs';

const [upstream, preview, screenshot] = process.argv.slice(2);
const { default: puppeteer } = await import(pathToFileURL(join(resolve(upstream), 'packages/api/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js')).href);
const trace = JSON.parse(await readFile(resolve(process.env.CLOWDER_TRACE_PATH || join(docsArchiveRoot, 'research/clowder-simulation/trace.json')), 'utf8'));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--no-first-run', '--disable-background-networking'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewport({ width: 800, height: 1000 });
  await page.goto(pathToFileURL(resolve(preview)).href);
  let frame;
  for (const candidate of page.frames()) {
    if (await candidate.$('#clowder-source-trace')) { frame = candidate; break; }
  }
  assert(frame, 'trace iframe rendered');
  for (const [si, scenario] of trace.scenarios.entries()) {
    await frame.select('[data-role="scenario"]', String(si));
    for (const [ti, step] of scenario.steps.entries()) {
      await frame.select('[data-role="step"]', String(ti));
      const rendered = await frame.$eval('[data-role="raw"]', e => JSON.parse(e.textContent));
      assert.deepEqual(rendered, { input: step.input, result: step.result }, `${scenario.id} #${ti + 1} input/output`);
      assert.equal(await frame.$eval('[data-role="call"]', e => e.textContent), step.call);
      assert.ok(await frame.$$eval('[data-role="changes"] tr', rows => rows.length), 'diff table not empty');
    }
  }
  await frame.select('[data-role="scenario"]', '1');
  await frame.select('[data-role="step"]', '2');
  await frame.click('[data-role="next"]');
  assert.equal(await frame.$eval('[data-role="step"]', e => e.value), '3');
  await frame.click('[data-role="previous"]');
  assert.equal(await frame.$eval('[data-role="step"]', e => e.value), '2');
  await page.screenshot({ path: screenshot, fullPage: true });
  await page.setViewport({ width: 360, height: 800 });
  const overflow = await frame.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert.equal(overflow, false, 'narrow viewer has no horizontal overflow');
  assert.deepEqual(errors, [], 'no browser JS errors');
  console.log(`PASS: ${trace.totals.steps} steps, exact rendered input/output, navigation, narrow layout; ${screenshot}`);
} finally { await browser.close(); }
