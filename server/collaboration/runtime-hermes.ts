import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { RuntimeCapability, RuntimeRequest, RuntimeResult } from '../../shared/collaboration.js';
import { cliApiSettings, cliEnv, executeTool, JsonProcess, RuntimeOutcomeUnknown, runtimeTools } from './runtime-common.js';

const exec = promisify(execFile);
const hostPath = [ '../../scripts/runtime/hermes-host.py', '../../../scripts/runtime/hermes-host.py' ]
  .map(p => fileURLToPath(new URL(p, import.meta.url))).find(existsSync)!;
export const hermesPython = () => process.env.COLLAB_HERMES_PYTHON || join(homedir(), '.hermes/hermes-agent/venv/bin/python');

function isolatedEnv(directory: string) {
  const env = cliEnv();
  for (const name of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) delete env[name];
  return { ...env, HOME: directory, HERMES_HOME: directory, HERMES_SKIP_CHMOD: '1', NO_COLOR: '1' };
}

export async function probeHermes(python: string): Promise<RuntimeCapability> {
  const capability: RuntimeCapability = { carrier: 'hermes-agent', authentication: 'api', installed: false,
    available: false, append: false, verified: 'unverified' };
  const dir = await mkdtemp(join(tmpdir(), 'collab-hermes-check-'));
  try {
    const { stdout } = await exec(python, ['-I', hostPath, '--probe'], { env: isolatedEnv(dir), cwd: dir, timeout: 12000, maxBuffer: 64000 });
    const status = JSON.parse(stdout);
    return { ...capability, installed: true, available: status.supported === true, version: status.version,
      reason: status.supported ? '已就绪。成员可选用 OpenAI 兼容 API 账户或 Codex 的 API 密钥账户。' : '当前适配 Hermes Agent 0.18.2，请检查安装版本。' };
  } catch {
    return { ...capability, reason: '未能启动 Hermes。请安装 Hermes Agent 0.18.2，或设置 COLLAB_HERMES_PYTHON 指向其 Python。' };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function invokeHermes(request: RuntimeRequest, python: string): Promise<RuntimeResult> {
  const api = cliApiSettings(request);
  const dir = await mkdtemp(join(tmpdir(), 'collab-hermes-run-'));
  const session = randomUUID();
  let proc: JsonProcess | undefined, active = false, accepted = false;
  const accept = (evidence: string) => {
    if (accepted) return;
    request.onEvent({ kind: 'accepted', detail: { nativeSessionId: session, evidence } });
    accepted = true;
  };
  const abort = () => { void proc?.stop().catch(() => {}); };
  try {
    request.signal.throwIfAborted();
    proc = new JsonProcess(python, ['-I', hostPath], { cwd: dir, env: isolatedEnv(dir),
      onExit: (code, signal) => { if (proc?.pid) request.onEvent({ kind: 'process_exit', detail: { confirmed: true, code, signal, transport: 'stdio' } }); } });
    const child = proc;
    if (child.pid) request.onEvent({ kind: 'prepared', detail: { processStarted: true, pid: child.pid } });
    request.signal.addEventListener('abort', abort, { once: true });
    const allowed = runtimeTools(request);
    const calls = new Set<string>();
    child.onMessage = frame => {
      if (!active || request.signal.aborted || frame.method !== 'tool' || frame.params?.session !== session ||
          typeof frame.id !== 'string' || !frame.id || calls.has(frame.id)) { abort(); return; }
      calls.add(frame.id);
      accept('Hermes 模型工具调用');
      void (async () => {
        let output: unknown;
        try { output = await executeTool(request, frame.params.name, frame.params.arguments, frame.id); }
        catch { output = { error: '当前执行未获准完成此工具操作。' }; }
        if (active && !request.signal.aborted) child.send({ id: frame.id, result: output });
      })().catch(abort);
    };
    const ready = await child.call('configure', { session, model: api.model, endpoint: api.baseUrl, key: api.key, tools: allowed })
      .catch(() => { throw new Error('Hermes 启动失败，请检查 0.18.2 安装和 COLLAB_HERMES_PYTHON。'); });
    if (ready.session !== session || ready.model !== api.model || ready.version !== '0.18.2') throw new Error('Hermes 版本、会话或模型不匹配，请检查成员设置。');
    request.signal.throwIfAborted();
    request.onEvent({ kind: 'session', detail: { nativeSessionId: session, continuity: 'fresh', model: api.model, authentication: 'api', evidence: 'Hermes AIAgent 初始化' } });
    active = true;
    request.onEvent({ kind: 'exposed', detail: { nativeSessionId: session, evidence: '向 Hermes 发送本轮输入' } });
    const result = await child.call('prompt', { session, text: request.prompt }).catch(() => { throw new RuntimeOutcomeUnknown(); });
    request.signal.throwIfAborted();
    if (result.session !== session) throw new RuntimeOutcomeUnknown();
    if (result.invalidToolId === true) throw new Error('Hermes 返回了无效或重复的工具调用编号，本轮执行已停止。');
    if (result.ok !== true && result.rejected === true) {
      throw new Error('Hermes 未完成本轮，请检查 API 地址、模型与账户权限。');
    }
    if (!result.ok || typeof result.text !== 'string' || !result.text.trim()) throw new RuntimeOutcomeUnknown();
    accept('Hermes 返回模型完成结果');
    request.onEvent({ kind: 'text', detail: { text: result.text } });
    request.onEvent({ kind: 'diagnostic', detail: { protocol: 'hermes-agent', observation: 'native_terminal', nativeSessionId: session, status: 'succeeded', content: result.text, evidence: 'Hermes run_conversation completed' } });
    request.onEvent({ kind: 'usage', detail: { source: 'Hermes Agent', scope: 'invocation', inputTokens: result.input, outputTokens: result.output } });
    return { text: result.text, nativeSessionId: session, continuity: 'fresh' };
  } finally {
    active = false;
    request.signal.removeEventListener('abort', abort);
    await proc?.stop();
    await rm(dir, { recursive: true, force: true });
  }
}
