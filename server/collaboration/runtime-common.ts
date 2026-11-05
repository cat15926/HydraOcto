import { ARTIFACT_TOOL_SPECS } from './artifact-tools.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { RuntimeRequest } from '../../shared/collaboration.js';

export type Json = Record<string, any>;
export class RuntimeProtocolError extends Error {
  readonly missingSession: boolean;
  constructor(error: Json) {
    super(`Runtime protocol rejected request (${error.code ?? 'unknown'}).`);
    // Used only by thread/resume, before turn/start; transport failures never qualify.
    this.missingSession = error.code === -32600 && /(?:thread|session|rollout).*(?:not found|does not exist)|no (?:thread|session|rollout).*found/i.test(String(error.message ?? ''));
  }
}
export const TOOL_SPECS = [
  { name: 'collaboration_request', description: 'Request work from other conversation members. Use their stable member IDs. Ordinary completion does not automatically wake the caller.', inputSchema: { type: 'object', properties: { targets: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 }, content: { type: 'string', minLength: 1, maxLength: 20000 } }, required: ['targets', 'content'], additionalProperties: false } },
  { name: 'workspace_list', description: 'List files in the platform workspace; paths are relative to the workspace.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false } },
  { name: 'workspace_read', description: 'Read a text file within the platform workspace, up to 128 KB.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
];
const versionFields = { taskId: { type: 'string' }, expectedRevision: { type: 'integer' }, expectedOwnerRevision: { type: 'integer' } };
export const TASK_TOOL_SPECS = [
  { name: 'task_list', description: 'Read current ordinary tasks in this conversation, including exact revision, ownerRevision and execution bindings. Reading does not grant ownership.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'task_create', description: 'Create an OPTIONAL ordinary task when the user needs explicit tracking. ownerMemberId may be your own member ID or omitted (unassigned). Ordinary chat needs no task.', inputSchema: { type: 'object', properties: { title: { type: 'string', maxLength: 200 }, description: { type: 'string', maxLength: 20000 }, ownerMemberId: { type: 'string' } }, required: ['title', 'description'], additionalProperties: false } },
  { name: 'task_update', description: 'Update a task using its latest revisions from task_list. doing can claim unassigned work. done requires the exact current owner execution; finishing a reply alone never completes a task. blocked requires a reason.', inputSchema: { type: 'object', properties: { ...versionFields, status: { type: 'string', enum: ['todo', 'doing', 'blocked', 'done'] }, reason: { type: 'string', maxLength: 2000 } }, required: ['taskId', 'expectedRevision', 'expectedOwnerRevision', 'status'], additionalProperties: false } },
  { name: 'task_handoff', description: 'Formally transfer an owned ordinary task to another member in THIS conversation. Requires the exact owner execution and current revisions. A waiting receipt means finish this invocation; the platform changes owner ONLY after real execution release. Do not also send collaboration_request for the same work.', inputSchema: { type: 'object', properties: { ...versionFields, targetMemberId: { type: 'string' }, reason: { type: 'string', maxLength: 2000 } }, required: ['taskId', 'expectedRevision', 'expectedOwnerRevision', 'targetMemberId', 'reason'], additionalProperties: false } },
];
export function runtimeTools(request: Pick<RuntimeRequest, 'toolPolicyVersion'>) { return request.toolPolicyVersion === 'managed-artifacts-v1' ? [...TOOL_SPECS, ...TASK_TOOL_SPECS, ...ARTIFACT_TOOL_SPECS] : request.toolPolicyVersion === 'readonly-tasks-v1' ? [...TOOL_SPECS, ...TASK_TOOL_SPECS] : TOOL_SPECS; }
export function cliEnv(): NodeJS.ProcessEnv {
  // Accounts can reference arbitrary variable names (DS_KEY, MY_TOKEN, etc.). A deny-list
  // cannot isolate them. Native hosts inherit only OS, path, locale and network settings.
  const allowed = new Set(['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'COLORTERM', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir', 'PATHEXT', 'COMSPEC', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key) || /^LC_[A-Z_]+$/.test(key)) env[key] = value;
  return env;
}
/** Validate the selected account before a native host is created; secrets never enter argv. */
export function cliApiSettings(request: RuntimeRequest): { key: string; baseUrl: string; model: string } {
  const envName = request.account.apiKeyEnv;
  if (!envName || !/^[A-Z][A-Z0-9_]{0,99}$/.test(envName) || !process.env[envName]?.trim()) throw new Error('CLI API account credential environment variable is not configured.');
  if (!request.member.model?.trim()) throw new Error('CLI API accounts require an explicit model.');
  const defaultBase = request.member.carrier === 'codex-app-server' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com';
  let endpoint: URL;
  try { endpoint = new URL(request.account.baseUrl ?? defaultBase); } catch { throw new Error('CLI API endpoint is invalid.'); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)))) throw new Error('CLI API endpoint must use HTTPS, or HTTP on localhost.');
  return { key: process.env[envName]!, baseUrl: endpoint.href.replace(/\/+$/, ''), model: request.member.model.trim() };
}
export async function executeTool(request: RuntimeRequest, name: string, args: Json, callId: string): Promise<unknown> {
  request.signal.throwIfAborted();
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
  if (!runtimeTools(request).some(tool => tool.name === name)) throw new Error('Tool is outside this invocation frozen policy.');
  request.onEvent({ kind: 'tool', detail: { name, callId, state: 'started' } });
  let result: unknown;
  if (name === 'collaboration_request' || name.startsWith('task_') || name.startsWith('artifact_') || name.startsWith('review_') || name === 'user_question') result = await request.onToolCall(name, args, callId);
  else if (name === 'workspace_read' || name === 'workspace_list') {
    if (args.path !== undefined && typeof args.path !== 'string') throw new Error('path must be a relative string.');
    const path = args.path ?? '.';
    if (isAbsolute(path)) throw new Error('Only workspace-relative paths are allowed.');
    const root = await realpath(request.cwd), actual = await realpath(resolve(root, path));
    const rel = relative(root, actual);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel) || rel.split('/').some((part: string) => part.startsWith('.'))) throw new Error('Path is outside the allowed visible workspace.');
    if (name === 'workspace_list') result = (await readdir(actual, { withFileTypes: true })).filter(x => !x.name.startsWith('.')).slice(0, 200).map(x => ({ name: x.name, directory: x.isDirectory() }));
    else {
      const info = await stat(actual);
      if (!info.isFile() || info.size > 131072) throw new Error('Only text files of up to 128 KB can be read.');
      const data = await readFile(actual);
      if (data.includes(0)) throw new Error('Binary files are not supported.');
      result = data.toString('utf8');
    }
  } else throw new Error(`Unsupported tool: ${name}`);
  request.onEvent({ kind: 'tool', detail: { name, callId, state: 'completed' } });
  return result;
}

/** Bounded NDJSON transport. A process spawn is never an input-acceptance receipt. */
export class JsonProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  private waiters = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private buffer = '';
  private bytes = 0;
  private ended = false;
  private fatal?: Error;
  private onClose = () => {};
  onMessage: (message: Json) => void = () => {};
  onFailure: (error: Error, reason: 'protocol' | 'closed') => void = () => {};
  constructor(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; onExit?: (code: number | null, signal: NodeJS.Signals | null) => void } = {}) {
    this.child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: 'pipe', detached: process.platform !== 'win32' });
    this.closed = new Promise(resolveClose => { this.onClose = resolveClose; });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (data: string) => {
      this.bytes += Buffer.byteLength(data);
      if (this.bytes > 16_000_000 || this.buffer.length + data.length > 2_000_000) { this.fail(new Error('Runtime output limit exceeded.')); return; }
      this.buffer += data;
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line) as Json;
          if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Expected a JSON object.');
          const waiter = typeof message.id === 'number' && !message.method ? this.waiters.get(message.id) : undefined;
          if (waiter) { this.waiters.delete(message.id); message.error ? waiter.reject(new RuntimeProtocolError(message.error)) : waiter.resolve(message.result ?? {}); }
          else this.onMessage(message);
        } catch { this.fail(new Error('Invalid runtime JSON stream.')); }
      }
    });
    // Drain diagnostics without persisting arbitrary CLI stderr (it may contain credentials).
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.fail(new Error('Runtime input pipe closed.')));
    this.child.on('error', error => this.fail(new Error(`Runtime process could not start (${(error as NodeJS.ErrnoException).code ?? 'unknown'}).`)));
    this.child.on('close', (code, signal) => {
      this.ended = true;
      try { options.onExit?.(code, signal); }
      catch (error) { this.fail(error instanceof Error ? error : new Error('Exit evidence persistence failed.')); }
      finally { try { this.fail(new Error(`Runtime process exited (${code ?? signal ?? 'unknown'}).`), 'closed'); } finally { this.onClose(); } }
    });
  }
  private fail(error: Error, reason: 'protocol' | 'closed' = 'protocol') { if (!this.fatal) this.fatal = error; for (const waiter of this.waiters.values()) waiter.reject(error); this.waiters.clear(); this.onFailure(error, reason); if (reason === 'protocol') this.kill('SIGTERM'); }
  send(value: unknown) { if (this.ended || this.fatal) throw this.fatal ?? new Error('Runtime closed.'); this.child.stdin.write(`${JSON.stringify(value)}\n`); }
  call(method: string, params: Json): Promise<Json> {
    if (this.fatal) return Promise.reject(this.fatal);
    const id = this.nextId++;
    return new Promise((resolveCall, reject) => { this.waiters.set(id, { resolve: resolveCall, reject }); try { this.send({ id, method, params }); } catch (error) { this.waiters.delete(id); reject(error); } });
  }
  kill(signal: NodeJS.Signals) { if (this.ended) return; try { if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal); else this.child.kill(signal); } catch { /* Await actual close, never synthesize teardown. */ } }
  async stop(): Promise<void> {
    if (this.ended) return;
    this.kill('SIGTERM');
    const force = setTimeout(() => this.kill('SIGKILL'), 1000); force.unref();
    let limit: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { limit = setTimeout(() => reject(new Error('Runtime teardown remains unconfirmed.')), 3000); limit.unref(); });
    try { await Promise.race([this.closed, timeout]); } finally { clearTimeout(force); clearTimeout(limit); }
  }
}
