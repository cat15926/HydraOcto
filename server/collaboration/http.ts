import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Carrier, CollaborationAccount, CollaborationBootstrap, CollaborationRuntime, Member, OrdinaryTaskStatus, UpdateOrdinaryTask } from '../../shared/collaboration.js';
import { AppError } from '../store.js';
import type { CollaborationStore } from './store.js';
import type { CollaborationEngine } from './engine.js';

const carriers: Carrier[] = ['codex-app-server', 'claude-cli', 'openai-api', 'anthropic-api'];
const providers = ['codex', 'claude', 'openai', 'anthropic'] as const;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, '需要 JSON 对象。');
  return value as Record<string, unknown>;
}
function field(value: unknown, label: string, max = 200, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max) throw new AppError(400, `${label} 需要 ${allowEmpty ? 0 : 1}–${max} 个字符。`);
  return value.trim();
}
function id(value: unknown): string {
  const result = field(value, 'ID', 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(result)) throw new AppError(400, 'ID 仅允许字母、数字、下划线和连字符。');
  return result;
}
function revision(value: unknown, label: string, minimum = 0): number { if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new AppError(400, `${label} 需要有效版本号。`, 'invalid_revision'); return value as number; }
function memberIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 10) throw new AppError(400, '请选择 1–10 名成员。');
  const ids = value.map(id);
  if (new Set(ids).size !== ids.length) throw new AppError(400, '成员不能重复。');
  return ids;
}
function accountInput(body: unknown): CollaborationAccount {
  const b = object(body);
  if (!providers.includes(b.provider as typeof providers[number]) || !['cli', 'api'].includes(String(b.auth))) throw new AppError(400, '账户类型无效。');
  const provider = b.provider as CollaborationAccount['provider'];
  const auth = b.auth as CollaborationAccount['auth'];
  if (auth === 'cli' && !['codex', 'claude'].includes(provider)) throw new AppError(400, '仅 Codex 和 Claude Code 运行时支持官方 CLI 登录。');
  const result: CollaborationAccount = { id: id(b.id), name: field(b.name, '账户名称', 80), provider, auth };
  if (Object.keys(b).some(key => /^(apiKey|secret|token|password)$/i.test(key))) throw new AppError(400, '请配置环境变量引用；接口不接收明文密钥。');
  if (auth === 'api') {
    result.apiKeyEnv = field(b.apiKeyEnv, '密钥环境变量', 100);
    if (!/^[A-Z][A-Z0-9_]*$/.test(result.apiKeyEnv)) throw new AppError(400, '环境变量名需要大写字母、数字或下划线。');
    if (['codex', 'claude'].includes(provider) && (typeof b.baseUrl !== 'string' || !b.baseUrl.trim())) throw new AppError(400, 'CLI 的 API 认证需要明确填写服务地址。');
    if (b.baseUrl !== undefined && b.baseUrl !== '') {
      result.baseUrl = field(b.baseUrl, 'API 地址', 2000);
      let url: URL; try { url = new URL(result.baseUrl); } catch { throw new AppError(400, 'API 地址无效。'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new AppError(400, 'API 地址须为不包含凭据、查询参数或片段的 HTTP(S) 地址。');
      if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new AppError(400, '远程 API 必须使用 HTTPS。');
    }
  }
  return result;
}
function memberInput(body: unknown): Member {
  const b = object(body);
  if (!carriers.includes(b.carrier as Carrier) || typeof b.enabled !== 'boolean') throw new AppError(400, '成员运行时或启用状态无效。');
  return { id: id(b.id), name: field(b.name, '成员名称', 80), instructions: field(b.instructions, '成员说明', 10_000, true), carrier: b.carrier as Carrier, accountId: id(b.accountId), enabled: b.enabled,
    ...(b.aliases !== undefined ? { aliases: Array.isArray(b.aliases) ? b.aliases.map(a => field(a, '别名', 40)) : (() => { throw new AppError(400, '别名需要数组。'); })() } : {}),
    ...(b.accountBinding !== undefined ? { accountBinding: b.accountBinding as Member['accountBinding'] } : {}), ...(b.modelBinding !== undefined ? { modelBinding: b.modelBinding as Member['modelBinding'] } : {}), ...(b.effort ? { effort: field(b.effort, '推理强度', 30) } : {}),
    ...(b.model !== undefined && b.model !== '' ? { model: field(b.model, '模型', 200) } : {}) };
}
interface HttpDependencies {
  store: CollaborationStore; engine: CollaborationEngine; runtime: CollaborationRuntime;
  workspace: string; csrfToken: string;
  verifyCsrf(request: IncomingMessage): void;
  readJson(request: IncomingMessage): Promise<unknown>;
  json(response: ServerResponse, status: number, body: unknown): void;
}

export function collaborationHttp(deps: HttpDependencies) {
  const streams = new Map<ServerResponse, ReturnType<typeof setInterval>>();
  let probeCache: { at: number; promise: ReturnType<CollaborationRuntime['probe']> } | undefined;
  const probe = () => {
    if (!probeCache || Date.now() - probeCache.at > 15_000) probeCache = { at: Date.now(), promise: deps.runtime.probe().catch(() => carriers.map(carrier => ({ carrier, installed: false, available: false, append: false as const, authentication: carrier.endsWith('-api') ? 'api' as const : 'cli' as const, verified: 'unverified' as const, reason: '运行时检查暂不可用；请稍后刷新。' }))) };
    return probeCache.promise;
  };
  const publicAccount = (account: CollaborationAccount, runtimes: Awaited<ReturnType<CollaborationRuntime['probe']>> = []) => ({ ...account,
    configured: account.auth === 'api' ? Boolean(account.apiKeyEnv && process.env[account.apiKeyEnv]?.trim()) : true,
  });
  return {
    close() { for (const [stream, timer] of streams) { clearInterval(timer); stream.end(); } streams.clear(); },
    async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
      const path = decodeURIComponent(url.pathname);
      if (!/^\/api\/(collaboration(?:\/|$)|conversations(?:\/|$)|members(?:\/|$)|accounts(?:\/|$)|invocations(?:\/|$)|deliveries(?:\/|$)|ordinary-tasks(?:\/|$)|managed-artifacts(?:\/|$)|artifact-approvals(?:\/|$)|managed-jobs(?:\/|$)|runtime-interactions(?:\/|$)|sources(?:\/|$)|mention-groups(?:\/|$)|input-handoffs(?:\/|$))/.test(path)) return false;
      const { store, engine, json } = deps;
      if (request.method === 'GET' && path === '/api/collaboration/bootstrap') {
        const runtimes = await probe();
        const body: CollaborationBootstrap = { version: '0.8.0-n7', workspace: deps.workspace, csrfToken: deps.csrfToken, members: store.members(), defaults: store.workbench.defaults(), accountObservations: store.workbench.observations(), configurationRevision: store.configurationRevision(), accounts: store.accounts().filter(a => !a.deletedAt).map(a => publicAccount(a, runtimes)), conversations: store.list(), runtimes, eventCursor: store.cursor() };
        json(response, 200, body); return true;
      }
      if (request.method === 'GET' && path === '/api/collaboration/runtimes') { json(response, 200, { runtimes: await probe() }); return true; }
      if (request.method === 'GET' && path === '/api/conversations') { json(response, 200, { conversations: store.list() }); return true; }
      const conversation = /^\/api\/conversations\/([^/]+)$/.exec(path);
      if (request.method === 'GET' && conversation) { json(response, 200, store.detail(conversation[1]!)); return true; }
      const inputSnapshot = /^\/api\/invocations\/([^/]+)\/input$/.exec(path);
      if (request.method === 'GET' && inputSnapshot) { json(response, 200, store.input(inputSnapshot[1]!) ?? { manifest: null, prompt: null, reason: '历史执行未捕获实际输入；不事后重建。' }); return true; }
      if (request.method === 'GET' && path === '/api/collaboration/events') {
        const raw = request.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0';
        if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new AppError(400, '事件游标无效。');
        let cursor = Number(raw); let ticks = 0;
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.flushHeaders();
        const send = () => {
          if (response.destroyed || response.writableEnded) return;
          try {
            if (response.writableLength > 2_000_000) { response.destroy(); return; }
            for (const event of store.events(cursor, undefined, 1000)) {
              if (response.writableLength > 2_000_000) { response.destroy(); return; }
              response.write(`id: ${event.id}\nevent: collaboration-event\ndata: ${JSON.stringify(event)}\n\n`); cursor = event.id;
            }
            if (++ticks % 50 === 0) response.write(': keepalive\n\n');
          } catch { response.destroy(); }
        };
        send(); const timer = setInterval(send, 300); timer.unref(); streams.set(response, timer);
        response.on('close', () => { clearInterval(timer); streams.delete(response); }); return true;
      }
      const artifactContent = /^\/api\/managed-artifacts\/versions\/([^/]+)(\/download)?$/.exec(path);
      if (request.method === 'GET' && artifactContent) {
        const result = store.artifacts.content(artifactContent[1]!);
        if (artifactContent[2]) {
          if (result.version.state !== 'published') throw new AppError(409, '此版本尚未发布。');
          response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `attachment; filename="artifact.txt"; filename*=UTF-8''${encodeURIComponent(result.artifact.name)}`, 'Cache-Control': 'no-store' }); response.end(result.content);
        } else json(response, 200, result);
        return true;
      }
      const attachment = /^\/api\/conversations\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
      if (request.method === 'GET' && attachment) { const result = store.workbench.attachmentContent(attachment[2]!); if (result.attachment.conversationId !== attachment[1]) throw new AppError(404, '附件不属于此会话。'); json(response, 200, result); return true; }
      if (request.method === 'GET' && path === '/api/collaboration/event-page') { const after = Number(url.searchParams.get('after') ?? '0'); if (!Number.isSafeInteger(after) || after < 0) throw new AppError(400, '事件游标无效。'); const events = store.events(after, undefined, 1000); json(response, 200, { events, nextCursor: events.at(-1)?.id ?? after, hasMore: !!events.length && events.at(-1)!.id < store.cursor() }); return true; }
      if (request.method === 'POST') {
        deps.verifyCsrf(request); const body = object(await deps.readJson(request));
        const workbenchCommand = /^\/api\/conversations\/([^/]+)\/(organize|attachments|workspace-preview|workspace-apply)$/.exec(path);
        if (workbenchCommand) {
          const cid = workbenchCommand[1]!, action = workbenchCommand[2];
          const result = action === 'organize' ? store.workbench.organize(cid, body) : action === 'attachments' ? store.workbench.upload(cid, body) : action === 'workspace-preview' ? store.workbench.previewWorkspace(cid, body) : store.workbench.applyPreview(body, cid);
          json(response, action === 'attachments' ? 201 : 200, result); return true;
        }
        if (path === '/api/collaboration/default-preview') { json(response, 200, store.workbench.previewDefault(body)); return true; }
        if (path === '/api/collaboration/default-apply') { json(response, 200, store.workbench.applyPreview(body)); return true; }
        const deletion = /^\/api\/(members|accounts)\/([^/]+)\/delete$/.exec(path);
        if (deletion) { json(response, 200, store.workbench.remove(deletion[1] as 'members' | 'accounts', deletion[2]!, body)); engine.kick(); return true; }
        const accountProbe = /^\/api\/accounts\/([^/]+)\/probe$/.exec(path);
        if (accountProbe) {
          if (Object.keys(body).length) throw new AppError(400, '探测身份和证据由服务端取得。');
          if (!deps.runtime.discoverAccount) throw new AppError(503, '当前运行时不支持账户探测。');
          const { account, ticket } = store.workbench.beginProbe(accountProbe[1]!);
          const result = await deps.runtime.discoverAccount(account);
          json(response, 200, store.workbench.finishProbe(account, ticket, result)); probeCache = undefined; return true;
        }
        const queueCommand = /^\/api\/conversations\/([^/]+)\/(queue-order|cancel-all|mention-groups)$/.exec(path);
        const sourceCommand = /^\/api\/sources\/([^/]+)\/(withdraw|priority)$/.exec(path);
        const groupCancel = /^\/api\/mention-groups\/([^/]+)\/cancel$/.exec(path);
        const appendInspect = /^\/api\/input-handoffs\/([^/]+)\/inspect$/.exec(path);
        if (queueCommand || sourceCommand || groupCancel || appendInspect) {
          const action = queueCommand?.[2] ?? sourceCommand?.[2] ?? (groupCancel ? 'group-cancel' : 'append-inspect');
          const keys: Record<string, string[]> = { 'queue-order': ['sourceIds', 'expectedRevision'], 'cancel-all': [], 'mention-groups': ['targets', 'question', 'context', 'timeoutMs'], withdraw: ['expectedRevision'], priority: ['expectedRevision', 'priority'], 'group-cancel': ['expectedRevision'], 'append-inspect': ['expectedRevision'] };
          if (Object.keys(body).some(k => k !== 'requestId' && !keys[action!]!.includes(k))) throw new AppError(400, '身份和证据由服务端绑定；请求包含未知字段。');
          const requestId = field(body.requestId, '请求标识', 200);
          let result: unknown;
          if (queueCommand?.[2] === 'queue-order') result = store.cooperation.reorder(queueCommand[1]!, body);
          else if (queueCommand?.[2] === 'cancel-all') { const out = store.cooperation.cancelAll(queueCommand[1]!, requestId); out.invocationIds.forEach(id => engine.cancel(id)); result = out; }
          else if (queueCommand) result = store.cooperation.createGroup(queueCommand[1]!, body);
          else if (sourceCommand) result = sourceCommand[2] === 'withdraw' ? store.cooperation.withdraw(sourceCommand[1]!, body) : store.cooperation.priority(sourceCommand[1]!, body);
          else if (groupCancel) { const out = store.cooperation.cancelGroup(groupCancel[1]!, body); out.invocationIds.forEach(id => engine.cancel(id)); result = out; }
          else result = await engine.inspectAppend(appendInspect![1]!, revision(body.expectedRevision, '追加', 1));
          engine.kick(); json(response, 200, result); return true;
        }
        const proposeArtifact = /^\/api\/conversations\/([^/]+)\/managed-artifacts$/.exec(path);
        const reviewArtifact = /^\/api\/conversations\/([^/]+)\/artifact-reviews$/.exec(path);
        const approveArtifact = /^\/api\/artifact-approvals\/([^/]+)\/decide$/.exec(path);
        const reconcileJob = /^\/api\/managed-jobs\/([^/]+)\/reconcile$/.exec(path);
        const answerInteraction = /^\/api\/runtime-interactions\/([^/]+)\/answer$/.exec(path);
        if (proposeArtifact || reviewArtifact || approveArtifact || reconcileJob || answerInteraction) {
          if (['actor', 'origin', 'invocationId', 'fence', 'observation', 'conversationId'].some(k => k in body)) throw new AppError(400, '准确身份与核查证据由服务端绑定。');
          const result = proposeArtifact ? store.artifacts.propose(proposeArtifact[1]!, body)
            : reviewArtifact ? store.artifacts.requestReview(reviewArtifact[1]!, body)
            : approveArtifact ? store.artifacts.decide(approveArtifact[1]!, body)
            : answerInteraction ? store.interactions.answer(answerInteraction[1]!, body)
            : store.artifacts.reconcileJob(reconcileJob![1]!);
          engine.kick(); json(response, 200, result); return true;
        }
        const createTask = /^\/api\/conversations\/([^/]+)\/ordinary-tasks$/.exec(path);
        const taskCommand = /^\/api\/ordinary-tasks\/([^/]+)\/(update|handoff|cancel-handoff)$/.exec(path);
        if (createTask || taskCommand) {
          if (['actor', 'invocationId', 'executionRef', 'fence'].some(key => key in body)) throw new AppError(400, '任务身份由服务端绑定。');
          const requestId = field(body.requestId, '请求标识', 200);
          if (createTask) {
            const result = store.tasks.create(createTask[1]!, { requestId, title: field(body.title, '标题', 200), description: field(body.description ?? '', '描述', 20000, true), ownerMemberId: body.ownerMemberId == null || body.ownerMemberId === '' ? null : id(body.ownerMemberId) });
            engine.kick(); json(response, result.replayed ? 200 : 201, result); return true;
          }
          const version = { requestId, expectedRevision: revision(body.expectedRevision, '任务', 1), expectedOwnerRevision: revision(body.expectedOwnerRevision, '负责人') };
          const taskId = taskCommand![1]!;
          if (taskCommand![2] === 'handoff') {
            if (body.stopCurrent !== undefined && typeof body.stopCurrent !== 'boolean') throw new AppError(400, '停止选项必须为布尔值。');
            const result = store.tasks.handoff(taskId, { ...version, targetMemberId: id(body.targetMemberId), reason: field(body.reason, '交接说明', 2000), stopCurrent: body.stopCurrent === true });
            if (result.handoff.state === 'waiting' && result.handoff.stopRequested && result.handoff.executionRef) engine.cancel(result.handoff.executionRef.invocationId);
            engine.kick(); json(response, 200, result); return true;
          }
          const result = taskCommand![2] === 'cancel-handoff' ? store.tasks.cancelHandoff(taskId, version) : store.tasks.update(taskId, { ...version, status: body.status as OrdinaryTaskStatus | undefined, reason: field(body.reason ?? '', '原因', 2000, true), disposition: body.disposition as UpdateOrdinaryTask['disposition'] });
          engine.kick(); json(response, 200, result); return true;
        }
        if (path === '/api/conversations') {
          const result = store.create({ title: field(body.title, '会话名称', 200), memberIds: memberIds(body.memberIds), defaultMemberId: id(body.defaultMemberId), requestId: field(body.requestId, '请求标识', 200) });
          json(response, result.replayed ? 200 : 201, result); return true;
        }
        const send = /^\/api\/conversations\/([^/]+)\/messages$/.exec(path);
        if (send) {
          if (body.deliveryMode !== undefined && !['next_turn', 'continue_current'].includes(String(body.deliveryMode))) throw new AppError(400, '输入投递模式无效。');
          if (body.resolveWhenIdle !== undefined && typeof body.resolveWhenIdle !== 'boolean') throw new AppError(400, '空闲解析必须为布尔值。');
          const result = store.send(send[1]!, { content: field(body.content ?? '', '消息', 20_000, true), ...(body.attachmentIds !== undefined ? { attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds.map(id) : (() => { throw new AppError(400, '附件列表无效。'); })() } : {}), ...(body.replyTo ? { replyTo: id(body.replyTo) } : {}), requestId: field(body.requestId, '请求标识', 200), ...(body.deliveryMode ? { deliveryMode: body.deliveryMode as 'next_turn' | 'continue_current' } : {}), ...(body.resolveWhenIdle ? { resolveWhenIdle: true } : {}) });
          engine.kick(); json(response, result.replayed ? 200 : 201, result); return true;
        }
        const preview = /^\/api\/conversations\/([^/]+)\/route-preview$/.exec(path);
        if (preview) { json(response, 200, { routing: store.previewRoute(preview[1]!, field(body.content, '消息', 20_000)) }); return true; }
        const reconcile = /^\/api\/invocations\/([^/]+)\/reconcile$/.exec(path);
        if (reconcile) {
          json(response, 200, await engine.reconcile(reconcile[1]!, { requestId: field(body.requestId, '请求标识', 200), expectedInvocationRevision: revision(body.expectedInvocationRevision, '执行', 1), expectedCancelRevision: revision(body.expectedCancelRevision, '取消'), expectedInputRevision: revision(body.expectedInputRevision, '输入', 1) })); return true;
        }
        const recheck = /^\/api\/deliveries\/([^/]+)\/recheck$/.exec(path);
        if (recheck) {
          const result = store.recheckDelivery(recheck[1]!, { requestId: field(body.requestId, '请求标识', 200), expectedDeliveryRevision: revision(body.expectedDeliveryRevision, '投递', 1), expectedSourceRevision: revision(body.expectedSourceRevision, '来源', 1) }); engine.kick(); json(response, 200, result); return true;
        }
        const settings = /^\/api\/conversations\/([^/]+)\/settings$/.exec(path);
        if (settings) {
          if (body.routingMode !== undefined && !['normal', 'concierge'].includes(String(body.routingMode))) throw new AppError(400, '路由模式无效。');
          json(response, 200, { conversation: store.updateConversation(settings[1]!, { memberIds: memberIds(body.memberIds), defaultMemberId: id(body.defaultMemberId), ...(body.preferredMemberIds !== undefined ? { preferredMemberIds: Array.isArray(body.preferredMemberIds) && !body.preferredMemberIds.length ? [] : memberIds(body.preferredMemberIds) } : {}), ...(body.routingMode !== undefined ? { routingMode: body.routingMode as 'normal' | 'concierge' } : {}) }) }); return true;
        }
        if (path === '/api/members') { const member = store.workbench.saveMember(memberInput(body), body.expectedRevision, body.requestId).result; engine.kick(); json(response, 200, { member }); return true; }
        if (path === '/api/accounts') { const account = store.workbench.saveAccount(accountInput(body), body.expectedRevision, body.requestId).result; probeCache = undefined; json(response, 200, { account: publicAccount(account, await probe()) }); return true; }
        const cancel = /^\/api\/invocations\/([^/]+)\/cancel$/.exec(path);
        if (cancel) { engine.cancel(cancel[1]!); json(response, 200, { ok: true }); return true; }
      }
      throw new AppError(404, '持续协作接口不存在。', 'not_found');
    },
  };
}
