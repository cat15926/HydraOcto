import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Bootstrap, CreateRole, CreateTask, ToolName } from '../shared/contracts.js';
import { TOOL_NAMES } from '../shared/contracts.js';
import { AppError, ServiceLeaseLost, Store } from './store.js';
import { Commands, safeError, Worker } from './engine.js';
import { createProvider, type Provider } from './provider.js';
import { ToolGateway } from './tools.js';
import type { CollaborationRuntime } from '../shared/collaboration.js';
import { CollaborationStore } from './collaboration/store.js';
import { CollaborationEngine } from './collaboration/engine.js';
import { createCollaborationRuntime } from './collaboration/runtime.js';
import { collaborationHttp } from './collaboration/http.js';

export interface ApplicationOptions {
  port?: number; host?: '127.0.0.1'; dataDir?: string; workspace?: string; staticDir?: string;
  provider?: Provider; modelBaseUrl?: string; modelName?: string; modelApiKey?: string;
  approvalTtlMs?: number; providerTimeoutMs?: number; leaseMs?: number; startWorker?: boolean;
  collaborationRuntime?: CollaborationRuntime;
}
const TEXT_LIMIT = 20_000;
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'Expected a JSON object.'); return value as Record<string, unknown>; }
function textField(value: unknown, label: string, max = TEXT_LIMIT, optional = false): string { if (optional && value === undefined) return ''; if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(400, `${label} must contain 1–${max} characters.`); return value.trim(); }
function validateTask(body: unknown, apiConfigured: boolean): CreateTask {
  const value = object(body); const mode = value.mode;
  if (mode !== 'demo' && mode !== 'api') throw new AppError(400, 'mode must be demo or api.');
  if (mode === 'api' && !apiConfigured) throw new AppError(400, 'API mode requires MODEL_BASE_URL, MODEL_NAME, and MODEL_API_KEY to be configured.', 'model_not_configured');
  if (!Array.isArray(value.roleIds) || value.roleIds.length < 1 || value.roleIds.length > 10 || value.roleIds.some(id => typeof id !== 'string' || !id || id.length > 100)) throw new AppError(400, 'Select between 1 and 10 roles in execution order.');
  return { title: textField(value.title, 'title', 200), goal: textField(value.goal, 'goal'), acceptance: textField(value.acceptance, 'acceptance'), roleIds: value.roleIds as string[], mode, requestId: textField(value.requestId, 'requestId', 200) };
}
function validateRole(body: unknown): CreateRole {
  const value = object(body);
  if (!Array.isArray(value.tools) || value.tools.length > TOOL_NAMES.length || value.tools.some(tool => !TOOL_NAMES.includes(tool as ToolName)) || new Set(value.tools).size !== value.tools.length) throw new AppError(400, 'tools must be a unique list of supported tools.');
  return { name: textField(value.name, 'name', 80), description: textField(value.description, 'description', 1000), instructions: textField(value.instructions, 'instructions', 10_000), tools: value.tools as ToolName[] };
}
async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw new AppError(415, 'Mutations require application/json.', 'json_required');
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string); bytes += buffer.length; if (bytes > 400_000) throw new AppError(413, 'Request body exceeds 400 KB.'); chunks.push(buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw new AppError(400, 'Request body is not valid JSON.'); }
}
function json(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); }
const mimeTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };

export async function createApplication(options: ApplicationOptions = {}) {
  const port = options.port ?? Number(process.env.APP_PORT ?? '4310');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('APP_PORT must be a valid port number.');
  const host = options.host ?? '127.0.0.1';
  if (host !== '127.0.0.1') throw new Error('This application only supports 127.0.0.1.');
  const dataDir = resolve(options.dataDir ?? process.env.APP_DATA_DIR ?? '.local-data');
  const workspaceSetting = options.workspace ?? process.env.APP_WORKSPACE;
  const customWorkspace = Boolean(workspaceSetting?.trim());
  const workspace = resolve(customWorkspace ? workspaceSetting! : resolve(dataDir, 'workspace'));
  const staticDir = resolve(options.staticDir ?? 'dist/web');
  const modelBaseUrl = options.modelBaseUrl ?? process.env.MODEL_BASE_URL;
  const modelName = options.modelName ?? process.env.MODEL_NAME;
  const modelApiKey = options.modelApiKey ?? process.env.MODEL_API_KEY;
  const apiConfigured = Boolean(options.provider || (modelBaseUrl?.trim() && modelName?.trim() && modelApiKey?.trim()));
  const secrets = modelApiKey ? [modelApiKey] : [];
  const gateway = new ToolGateway({ workspace, artifactDir: resolve(dataDir, 'artifacts'), seedDemo: !customWorkspace });
  await gateway.init();
  const store = new Store(resolve(dataDir, 'platform.sqlite'), { ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}) });
  store.recover();
  const provider = options.provider ?? createProvider({ baseUrl: modelBaseUrl, model: modelName, apiKey: modelApiKey, timeoutMs: options.providerTimeoutMs });
  const worker = new Worker(store, gateway, provider, { approvalTtlMs: options.approvalTtlMs, providerTimeoutMs: options.providerTimeoutMs, secrets });
  const commands = new Commands(store, worker, gateway);
  const csrfToken = randomBytes(32).toString('hex');
  const collaborationStore = new CollaborationStore(store, { workspace });
  const collaborationRuntime = options.collaborationRuntime ?? createCollaborationRuntime();
  const collaborationEngine = new CollaborationEngine(collaborationStore, collaborationRuntime, { workspace });
  const collaborationRoutes = collaborationHttp({ store: collaborationStore, engine: collaborationEngine, runtime: collaborationRuntime, workspace, csrfToken, verifyCsrf, readJson, json });
  const streams = new Set<ServerResponse>();
  let closed = false; let listeningPort = port; let started = false; let leaseLost = false;
  function stopForLeaseLoss(): void {
    if (leaseLost) return;
    leaseLost = true; clearInterval(heartbeat);
    void Promise.allSettled([worker.stop(), collaborationEngine.stop()]);
    collaborationRoutes.close(); for (const stream of streams) stream.end();
  }
  const heartbeat = setInterval(() => {
    try { store.heartbeat(); }
    catch (error) {
      if (error instanceof ServiceLeaseLost) stopForLeaseLoss();
      else console.warn('数据库租约续期暂时失败，等待下次重试。');
    }
  }, Math.max(50, Math.floor(store.leaseMs / 3)));
  heartbeat.unref();
  function allowedOrigin(origin: string): boolean {
    try { const parsed = new URL(origin); return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname) && [listeningPort, 4311].includes(Number(parsed.port || 80)) && parsed.origin === origin; } catch { return false; }
  }
  function secureRequest(request: IncomingMessage, response: ServerResponse): void {
    let hostname: string;
    try { hostname = new URL(`http://${request.headers.host ?? ''}`).hostname; } catch { throw new AppError(403, 'Invalid Host header.'); }
    if (!['127.0.0.1', 'localhost'].includes(hostname)) throw new AppError(403, 'Only local requests are supported.');
    const origin = request.headers.origin;
    if (origin && !allowedOrigin(origin)) throw new AppError(403, 'Origin is not allowed.', 'origin_forbidden');
    if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
    response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
  }
  function verifyCsrf(request: IncomingMessage): void {
    const incoming = request.headers['x-csrf-token'];
    if (typeof incoming !== 'string' || Buffer.byteLength(incoming) !== Buffer.byteLength(csrfToken) || !timingSafeEqual(Buffer.from(incoming), Buffer.from(csrfToken))) throw new AppError(403, 'Missing or invalid CSRF token.', 'csrf_failed');
  }
  async function staticFile(pathname: string, response: ServerResponse): Promise<void> {
    const candidate = resolve(staticDir, `.${pathname}`);
    const relation = relative(staticDir, candidate);
    if (relation.startsWith('..') || isAbsolute(relation)) throw new AppError(404, 'Not found.');
    let target = candidate;
    try { const info = await stat(target); if (!info.isFile()) target = resolve(staticDir, 'index.html'); } catch { target = resolve(staticDir, 'index.html'); }
    try {
      const [root, actual] = await Promise.all([realpath(staticDir), realpath(target)]);
      const inside = relative(root, actual); if (inside.startsWith('..') || isAbsolute(inside)) throw new AppError(404, 'Not found.');
      const content = await readFile(actual); response.writeHead(200, { 'Content-Type': mimeTypes[extname(actual)] ?? 'application/octet-stream', 'Cache-Control': extname(actual) === '.html' ? 'no-cache' : 'public, max-age=3600' }); response.end(content);
    } catch (error) { if (error instanceof AppError) throw error; throw new AppError(404, 'Frontend build not found. Run npm run build first.', 'not_found'); }
  }
  const server = createServer((request, response) => {
    void (async () => {
      secureRequest(request, response);
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${listeningPort}`);
      const pathname = decodeURIComponent(url.pathname);
      if (request.method === 'OPTIONS') { response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token, Last-Event-ID' }); response.end(); return; }
      if (pathname === '/health' || pathname.startsWith('/api/')) { if (leaseLost) throw new ServiceLeaseLost(); store.assertLease(); }
      if (request.method === 'GET' && pathname === '/health') { json(response, 200, { status: 'ok', database: 'ok' }); return; }
      if (await collaborationRoutes.handle(request, response, url)) return;
      if (request.method === 'GET' && pathname === '/api/bootstrap') {
        const body: Bootstrap = { meta: { name: '协作工坊', version: '0.1.0', apiConfigured, ...(modelName ? { model: modelName } : {}), workspace, tools: [
          { name: 'workspace_list', description: '列出受限工作区中的文件。', requiresApproval: false }, { name: 'workspace_read', description: '读取工作区文本材料。', requiresApproval: false },
          { name: 'artifact_write', description: '经审批后保存任务产物。', requiresApproval: true }, { name: 'artifact_read', description: '读取本任务已有产物。', requiresApproval: false },
        ] }, roles: store.listRoles(), tasks: store.list(), eventCursor: store.cursor(), csrfToken };
        json(response, 200, body); return;
      }
      if (request.method === 'GET' && pathname === '/api/tasks') { json(response, 200, { tasks: store.list() }); return; }
      const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
      if (request.method === 'GET' && taskMatch) { json(response, 200, store.detail(taskMatch[1]!)); return; }
      if (request.method === 'GET' && pathname === '/api/events') {
        const rawCursor = request.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0';
        if (typeof rawCursor !== 'string' || !/^\d+$/.test(rawCursor) || !Number.isSafeInteger(Number(rawCursor))) throw new AppError(400, 'Invalid event cursor.');
        let cursor = Number(rawCursor);
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); response.flushHeaders();
        streams.add(response);
        const send = (events: ReturnType<Store['events']>) => { for (const event of events) { if (response.destroyed || response.writableEnded) return; if (event.id <= cursor) continue; if (response.writableLength > 2_000_000) { response.destroy(); return; } response.write(`id: ${event.id}\nevent: task-event\ndata: ${JSON.stringify(event)}\n\n`); cursor = event.id; } };
        let page = store.events(cursor); while (page.length && !response.destroyed) { send(page); if (page.length < 10_000) break; page = store.events(cursor); }
        if (response.destroyed) return;
        const unsubscribe = store.subscribe(send);
        const keepAlive = setInterval(() => response.write(': keepalive\n\n'), 15_000); keepAlive.unref();
        response.on('close', () => { clearInterval(keepAlive); unsubscribe(); streams.delete(response); }); return;
      }
      const artifactMatch = /^\/api\/artifacts\/([^/]+)$/.exec(pathname);
      if (request.method === 'GET' && artifactMatch) {
        const artifact = store.aggregates().flatMap(item => item.artifacts).find(item => item.id === artifactMatch[1]);
        if (!artifact) throw new AppError(404, 'Artifact not found.', 'not_found');
        const content = await gateway.readArtifact(artifact);
        response.writeHead(200, { 'Content-Type': artifact.mime, 'Content-Length': content.length, 'Content-Disposition': `attachment; filename="artifact.txt"; filename*=UTF-8''${encodeURIComponent(artifact.name)}`, 'Cache-Control': 'no-store' }); response.end(content); return;
      }
      if (request.method === 'POST' && pathname.startsWith('/api/')) {
        verifyCsrf(request); const body = await readJson(request); store.assertLease();
        if (pathname === '/api/tasks') { const result = store.create(validateTask(body, apiConfigured)); json(response, result.replayed ? 200 : 201, { task: result.task }); worker.kick(); return; }
        if (pathname === '/api/roles') { json(response, 201, { role: store.addRole(validateRole(body)) }); return; }
        const actionMatch = /^\/api\/tasks\/([^/]+)\/(cancel|retry|accept)$/.exec(pathname);
        if (actionMatch) { const taskId = actionMatch[1]!; const action = actionMatch[2]!; const task = action === 'cancel' ? commands.cancel(taskId) : action === 'retry' ? commands.retry(taskId) : commands.accept(taskId); json(response, 200, { task }); return; }
        const approvalMatch = /^\/api\/approvals\/([^/]+)\/decision$/.exec(pathname);
        if (approvalMatch) { const value = object(body).decision; const decision = value === 'approved' || value === 'approve' ? 'approved' : value === 'rejected' || value === 'reject' ? 'rejected' : undefined; if (!decision) throw new AppError(400, 'decision must be approved or rejected.'); json(response, 200, { approval: commands.decide(approvalMatch[1]!, decision) }); return; }
      }
      if (pathname.startsWith('/api/')) throw new AppError(404, 'API endpoint not found.', 'not_found');
      if (request.method === 'GET') { await staticFile(pathname, response); return; }
      throw new AppError(405, 'Method not allowed.');
    })().catch(error => {
      if (error instanceof ServiceLeaseLost) { stopForLeaseLoss(); error = new AppError(503, error.message, 'service_lease_lost'); }
      if (!response.headersSent) json(response, error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? safeError(error, secrets) : 'Internal server error.', code: error instanceof AppError ? error.code : 'internal_error' }); else response.destroy();
    });
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000;
  return {
    server, store, worker, commands, gateway, csrfToken, collaborationStore, collaborationEngine,
    async start() {
      if (closed) throw new Error('Application is closed.');
      if (!started) {
        try { await new Promise<void>((resolveStart, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolveStart(); }); }); }
        catch (error) { closed = true; clearInterval(heartbeat); await worker.stop(); await collaborationEngine.stop(); collaborationRoutes.close(); store.close(); throw error; }
        started = true; const address = server.address(); if (address && typeof address !== 'string') listeningPort = address.port; if (options.startWorker !== false) { worker.start(); collaborationEngine.start(); }
      }
      return { host, port: listeningPort, url: `http://${host}:${listeningPort}` };
    },
    async close() {
      if (closed) return; closed = true;
      await worker.stop(); await collaborationEngine.stop(); collaborationRoutes.close(); clearInterval(heartbeat);
      for (const stream of streams) stream.end();
      if (started) await new Promise<void>(resolveClose => { server.close(() => resolveClose()); server.closeAllConnections(); });
      store.close();
    },
  };
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  void createApplication().then(async app => {
    let address: Awaited<ReturnType<typeof app.start>>;
    try { address = await app.start(); } catch (error) { await app.close(); throw error; }
    console.log(`Agent platform listening at ${address.url}`);
    let exiting = false;
    const stop = () => { if (exiting) return; exiting = true; void app.close().then(() => { process.exitCode = 0; }); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  }).catch(error => { console.error(safeError(error, [process.env.MODEL_API_KEY ?? ''])); process.exitCode = 1; });
}
