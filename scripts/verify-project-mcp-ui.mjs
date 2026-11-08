// Browser verification of the project settings and author tool over a real loopback MCP transport.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../server/index.ts';
import { executeTool } from '../server/collaboration/runtime-common.ts';
import { openWorkspaceTool, closeWorkspace } from './ui-workspace.mjs';

const { default: puppeteer } = await import(process.env.PUPPETEER_PATH ? pathToFileURL(process.env.PUPPETEER_PATH).href : 'puppeteer-core');
const output = resolve(process.env.VALIDATION_OUTPUT_DIR || '.local-data/validation/project-mcp-ui/' + new Date().toISOString().replace(/[:.]/g, '-'));
const temp = await mkdtemp(join(await realpath(tmpdir()), 'project-mcp-ui-'));
const project = join(temp, '手册'), token = randomUUID();
const methods = [], checks = [], errors = [];
const server = createServer(async (req, res) => {
  if (req.method === 'DELETE') {
    methods.push('DELETE');
    res.writeHead(204).end(); return;
  }
  let raw = '';
  for await (const part of req) raw += part;
  const msg = JSON.parse(raw);
  methods.push(msg.method);
  if (msg.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
  let result;
  if (msg.method === 'initialize') {
    result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'test-handbook', version: '1' } };
  } else {
    assert.deepEqual(msg.params, { name: 'search_docs', arguments: { term: '季度' } });
    result = { content: [{ type: 'text', text: '季度资料 ' + token }] };
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'local-handbook' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
});
const originalConfig = process.env.COLLAB_MCP_READERS;
let app, browser, page, syntheticCalls = 0;
try {
  await mkdir(output, { recursive: true });
  await mkdir(project);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  process.env.COLLAB_MCP_READERS = JSON.stringify([{ id: 'handbook', label: '团队手册', url: origin + '/mcp', tool: 'search_docs', parameter: 'term', readOnly: true }]);
  const available = { available: true };
  app = await createApplication({
    port: 0, workspace: join(temp, 'workspace'), dataDir: join(temp, 'db'), staticDir: resolve(process.env.VALIDATION_STATIC_DIR || 'dist/web'),
    collaborationRuntime: {
      projectWorkAvailability: () => available,
      probe: async () => [{ carrier: 'codex-app-server', installed: true, available: true, append: false, authentication: 'cli', verified: 'unverified', nativeProject: { cli: available } }],
      invoke: async req => {
        syntheticCalls++;
        req.onEvent({ kind: 'accepted', detail: { source: 'synthetic-user-flow' } });
        const result = await executeTool(req, 'project_mcp_search', { query: '季度' }, 'ui-read');
        req.onEvent({ kind: 'process_exit', detail: {confirmed:true} });
        return { text: result.text, continuity: 'unknown' };
      }
    }
  });
  const store = app.collaborationStore;
  const cid = store.create({ title: '查阅手册', memberIds: ['codex'], defaultMemberId: 'codex', requestId: randomUUID() }).conversation.id;
  const folder = store.workbench.previewWorkspace(cid, { path: project, mode: 'project-work' });
  store.workbench.applyPreview({ previewId: folder.id, requestId: randomUUID() }, cid);
  const { url } = await app.start();
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--disable-background-networking', '--no-first-run'] });
  page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(12000);
  const input = '#cc-message-input', reader = '.cc-project-reader select';
  const draft = '我的草稿';
  const savedReader = () => store.workbench.conversation(cid).workspaceGrant?.mcpReader;
  async function click(label) {
    const reference = await page.waitForFunction(text => [...document.querySelectorAll('#cc-workspace button')].find(b => b.textContent.trim() === text && !b.disabled && b.getClientRects().length), {}, label);
    await reference.asElement().focus(); await page.keyboard.press('Enter'); await reference.dispose();
  }
  const focusIs = selector => page.waitForFunction(s => document.activeElement === document.querySelector(s), {}, selector);
  const selectionIs = value => page.waitForFunction((s, v) => { const el = document.querySelector(s); return el && el.value === v && !el.disabled; }, {}, reader, value);
  await page.setViewport({width:1360,height:840});
  await page.goto(url, {waitUntil:'networkidle2'});
  await page.type(input, draft);
  await openWorkspaceTool(page, 'project');
  const edit = '项目权限';
  await click(edit); await selectionIs('');
  await page.setRequestInterception(true);
  let injectFailure = true;
  page.on('request', req => {
    if (injectFailure && req.url().endsWith('/workspace-preview') && req.method() === 'POST' && JSON.parse(req.postData()).mcpReaderId === 'handbook') {
      injectFailure = false;
      void req.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '暂时无法预览' }) });
    } else { void req.continue(); }
  });
  await page.select(reader, 'handbook');
  await page.waitForSelector('#cc-workspace [role=alert]',{ visible:true });
  await focusIs(reader); await selectionIs('');
  await page.select(reader,'handbook'); await selectionIs('handbook'); await focusIs(reader);
  await page.keyboard.press('Tab'); await focusIs('.cc-project-preview .cc-project-primary');
  await page.$eval(reader,el=>el.scrollIntoView({block:'center'}));
  assert.equal(savedReader(), undefined); assert.deepEqual(methods,[]);
  assert.ok(await page.$eval('.cc-project-reader', (el, origin) => el.textContent.includes(origin) && el.textContent.includes('search_docs'), origin));
  await page.screenshot({path:join(output,'preview.png')});
  await click('取消');
  await page.waitForSelector(reader, { hidden:true });
  assert.equal(savedReader(), undefined);
  checks.push('temporary preview failure returns focus to the selector; retry and keyboard navigation reach confirmation; explicit target and tool are shown before consent; cancellation made no call');
  await page.setViewport({width:320,height:760});
  await openWorkspaceTool(page, 'project');
  await click(edit); await selectionIs(''); await page.select(reader,'handbook'); await selectionIs('handbook');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
  const size = await page.$eval(reader, el=>{ const r = el.getBoundingClientRect(); return [r.left,r.right,innerWidth]; });
  assert.ok(size[0] >= 0 && size[1] <= size[2]);
  await page.$eval(reader,el=>el.scrollIntoView({block:'center'}));
  await page.screenshot({path:join(output,'narrow.png')});
  await click('确认项目工作授权'); await page.waitForSelector(reader,{hidden:true});
  assert.equal(savedReader()?.id,'handbook');
  await closeWorkspace(page);
  assert.equal(await page.$eval(input,el=>el.value),draft);
  checks.push('320px source control remains visible; confirming grants only that source and preserves the composer draft');
  await page.$eval(input, el=>el.select()); await page.keyboard.press('Backspace');
  await page.type(input,'@Codex 请修改项目中的手册并查询季度资料'); await page.click('.cc-send-button');
  await page.waitForFunction(value=>[...document.querySelectorAll('.cc-prose')].some(el=>el.textContent.includes(value)),{},token);
  assert.equal(syntheticCalls,1);
  assert.deepEqual(methods,['initialize','notifications/initialized','tools/call','DELETE']);
  checks.push('chat author obtains the unique value generated by the loopback MCP service and shows it in the reply');
  await openWorkspaceTool(page,'project'); await click(edit); await selectionIs('handbook');
  await page.select(reader,''); await selectionIs(''); await click('确认项目工作授权');
  await page.waitForSelector(reader,{hidden:true});
  assert.equal(savedReader(),undefined);
  assert.equal(store.workbench.conversation(cid).workspaceGrant.mode,'project-work');
  assert.deepEqual(errors,[]);
  checks.push('disconnecting the source preserves project authorization and causes no further MCP calls');
  await writeFile(join(output,'result.json'),JSON.stringify({passed:true,checks,methods,uniqueValue:token,syntheticCalls,realModelCalls:0,dedicatedExternalService:false,errors},null,2)+'\n');
  console.log('Passed '+checks.length+' UI scenarios, evidence '+output);
} catch (error) {
  await writeFile(join(output,'failure.json'),JSON.stringify({error:error.stack,methods,checks,errors,body:await page?.evaluate(()=>document.body.innerText)},null,2));
  await page?.screenshot({path:join(output,'failed.png')}).catch(()=>{});
  throw error;
} finally {
  if (originalConfig === undefined) delete process.env.COLLAB_MCP_READERS;
  else process.env.COLLAB_MCP_READERS = originalConfig;
  await browser?.close(); await app?.close();
  if (server.listening) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
  await rm(temp,{recursive:true,force:true});
}
