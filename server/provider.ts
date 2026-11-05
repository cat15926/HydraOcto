import { createHash } from 'node:crypto';
import type { Artifact, ModelMessage, Step, Task, ToolName } from '../shared/contracts.js';

export interface ProviderContext { task: Task; step: Step; previousOutputs: string[]; artifacts: Artifact[] }
export interface ProviderResponse { content: string | null; toolCalls?: { id: string; name: string; arguments: string }[] }
export type Provider = (context: ProviderContext, signal: AbortSignal) => Promise<ProviderResponse>;

const schemas: Record<ToolName, { description: string; parameters: Record<string, unknown> }> = {
  workspace_list: { description: '列出受限工作区内目录的文件，最多 200 项。', parameters: { type: 'object', properties: { path: { type: 'string', description: '工作区内相对目录，例如 .' } }, required: ['path'], additionalProperties: false } },
  workspace_read: { description: '读取工作区内最多 64 KiB 的 UTF-8 文本。', parameters: { type: 'object', properties: { path: { type: 'string', description: '工作区内相对文件路径' } }, required: ['path'], additionalProperties: false } },
  artifact_write: { description: '请求将文本保存为本任务产物，最多 256 KiB；必须等待用户批准，调用成功后才算交付。', parameters: { type: 'object', properties: { name: { type: 'string', description: '不包含目录的文件名' }, content: { type: 'string' }, mime: { type: 'string', description: '文本 MIME 类型，默认 text/markdown' } }, required: ['name', 'content'], additionalProperties: false } },
  artifact_read: { description: '读取当前任务产物的文本内容，最多 64 KiB。', parameters: { type: 'object', properties: { artifactId: { type: 'string' } }, required: ['artifactId'], additionalProperties: false } },
};

function demo(context: ProviderContext): ProviderResponse {
  const { task, step, previousOutputs } = context;
  const allowed = new Set(step.role.tools);
  const calls = step.messages.flatMap(message => message.role === 'assistant' ? message.tool_calls ?? [] : []);
  const resultIds = new Set(step.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id));
  if (calls.some(call => !resultIds.has(call.id))) throw new Error('固定演示流程正在等待工具结果');
  const has = (name: ToolName): boolean => calls.some(call => call.function.name === name);
  const propose = (name: ToolName, args: Record<string, unknown>): ProviderResponse => ({ content: '固定演示流程：申请执行 ' + name + '。', toolCalls: [{ id: 'demo-' + createHash('sha256').update(step.id + ':' + name + ':' + JSON.stringify(args)).digest('hex').slice(0, 24), name, arguments: JSON.stringify(args) }] });
  const source = step.messages.filter(message => message.role === 'tool' && calls.some(call => call.id === message.tool_call_id && call.function.name === 'workspace_read')).map(message => message.content ?? '').join('\n').slice(0, 8000);
  const outputs = previousOutputs.map(value => value.slice(0, 4000)).join('\n\n').slice(0, 16000);

  if (allowed.has('artifact_read') && !allowed.has('artifact_write')) {
    const artifacts = context.artifacts.filter(artifact => artifact.taskId === task.id && artifact.runId === step.runId);
    for (const artifact of artifacts) {
      const alreadyRead = calls.some(call => {
        if (call.function.name !== 'artifact_read') return false;
        try { return (JSON.parse(call.function.arguments) as { artifactId?: unknown }).artifactId === artifact.id; } catch { return false; }
      });
      if (!alreadyRead) return propose('artifact_read', { artifactId: artifact.id });
    }
    return { content: `固定演示流程：${step.role.name}已完成复核阶段。${artifacts.length ? `已实际读取本次执行的 ${artifacts.length} 份产物。` : '本次执行没有可读取的产物，无法检查交付内容。'}\n这仅验证工具与交付流程，不代表目标或验收条件已被满足；请由用户验收。${outputs ? '\n\n之前角色的交付：\n' + outputs : ''}` };
  }
  if (allowed.has('workspace_list') && !has('workspace_list')) return propose('workspace_list', { path: '.' });
  if (allowed.has('workspace_read') && !has('workspace_read')) {
    const listingCall = calls.find(call => call.function.name === 'workspace_list');
    const listingResult = step.messages.find(message => message.role === 'tool' && message.tool_call_id === listingCall?.id);
    if (listingResult?.content) {
      try {
        const listing = JSON.parse(listingResult.content) as { entries?: { name: string; type: string }[] };
        const files = (listing.entries ?? []).filter(entry => entry.type === 'file' && /\.(txt|md|json|csv|ya?ml|ts|js|html|css)$/iu.test(entry.name));
        const selected = files.find(entry => entry.name === 'welcome.txt') ?? files[0];
        if (selected) return propose('workspace_read', { path: selected.name });
      } catch { /* No readable sample was returned; the demo may proceed without material. */ }
    }
  }
  if (allowed.has('artifact_write') && !has('artifact_write')) {
    return propose('artifact_write', { name: `demo-report-${step.position + 1}.md`, mime: 'text/markdown', content: `# 固定演示流程报告\n\n本报告由确定性的演示执行器生成，仅验证本地读取、人工审批和交付流程，不宣称理解或完成任意任务。\n\n## 任务目标\n${task.goal.slice(0, 8000)}\n\n## 验收条件\n${task.acceptance.slice(0, 8000)}\n\n## 执行角色\n${step.role.name}\n\n## 已读取的示例材料\n${source || '此角色未读取工作区材料。'}\n\n## 之前角色交付\n${outputs || '无。'}\n\n请检查此产物后决定是否验收。\n` });
  }
  return { content: `固定演示流程：${step.role.name}阶段完成。${has('artifact_write') ? '已收到经过批准的产物写入结果。' : has('workspace_read') ? '已读取工作区文本样本并记录协作上下文。' : '已记录任务目标及此角色可用的工具范围。'}\n目标：${task.goal.slice(0, 1000)}\n演示流程不判断任务是否真正达标，最终结果需要用户验收。` };
}

function responseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型返回了无效的响应结构');
  return value as Record<string, unknown>;
}

function parseResponse(value: unknown): ProviderResponse {
  const body = responseObject(value);
  if (!Array.isArray(body.choices) || body.choices.length === 0) throw new Error('模型响应缺少 choices');
  const choice = responseObject(body.choices[0]);
  const message = responseObject(choice.message);
  if (message.content !== null && message.content !== undefined && typeof message.content !== 'string') throw new Error('模型响应 content 格式无效');
  const response: ProviderResponse = { content: typeof message.content === 'string' ? message.content : null };
  if (message.tool_calls !== undefined && message.tool_calls !== null) {
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 16) throw new Error('模型工具调用数量或格式无效');
    const ids = new Set<string>();
    response.toolCalls = message.tool_calls.map((value: unknown) => {
      const call = responseObject(value);
      const fn = responseObject(call.function);
      if (call.type !== 'function' || typeof call.id !== 'string' || !call.id || call.id.length > 200 || typeof fn.name !== 'string' || !fn.name || typeof fn.arguments !== 'string' || Buffer.byteLength(fn.arguments) > 512 * 1024 || ids.has(call.id)) throw new Error('模型工具调用格式无效或 ID 重复');
      ids.add(call.id);
      return { id: call.id, name: fn.name, arguments: fn.arguments };
    });
  }
  if (!response.content?.trim() && !response.toolCalls?.length) throw new Error('模型返回了空响应');
  return response;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('模型响应没有内容');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('模型响应超过大小限制'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('模型响应不是有效 JSON'); }
}

export function createProvider(config: { baseUrl?: string; model?: string; apiKey?: string; timeoutMs?: number }): Provider {
  return async (context, signal) => {
    if (signal.aborted) throw new DOMException('模型请求已取消', 'AbortError');
    if (context.task.mode === 'demo') return demo(context);
    if (!config.model?.trim()) throw new Error('真实模型模式尚未配置模型名称');
    const base = new URL(config.baseUrl ?? 'https://api.openai.com/v1');
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('模型服务地址必须是无凭据的 HTTP 或 HTTPS 基础地址');
    base.pathname = base.pathname.replace(/\/+$/u, '') + '/chat/completions';
    const timeoutMs = config.timeoutMs ?? 60000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) throw new Error('模型超时时间必须为 1 到 300000 毫秒');
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const allowedTools = [...new Set(context.step.role.tools)];
    const request: { model: string; messages: ModelMessage[]; tools?: unknown[]; tool_choice?: string } = { model: config.model, messages: context.step.messages };
    if (allowedTools.length) {
      request.tools = allowedTools.map(name => ({ type: 'function', function: { name, ...schemas[name] } }));
      request.tool_choice = 'auto';
    }
    try {
      const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {}) }, body: JSON.stringify(request), signal: combined, redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`模型服务请求失败（HTTP ${response.status}）`); }
      const result = parseResponse(await readJson(response));
      if (combined.aborted) throw new DOMException('模型请求已终止', 'AbortError');
      return result;
    } catch (error) {
      if (signal.aborted) throw new DOMException('模型请求已取消', 'AbortError');
      if (timeout.aborted) throw new Error('模型请求超时');
      if (error instanceof Error && (error.message.startsWith('模型') || error.message.startsWith('真实模型'))) throw error;
      throw new Error('无法连接模型服务，请检查服务地址、网络和配置');
    }
  };
}
