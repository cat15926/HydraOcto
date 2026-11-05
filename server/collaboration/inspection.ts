import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { CollaborationRuntime, RuntimeEvent, RuntimeInspection, RuntimeInspectionRequest, RuntimeRequest } from '../../shared/collaboration.js';

interface Observation {
  identity: string;
  workspace: string;
  finished: boolean;
  conflicted: boolean;
  hostStarted: boolean;
  exposed: boolean;
  acceptance: RuntimeInspection['acceptance'];
  teardown: RuntimeInspection['teardown'];
  nativeSessionId?: string;
  nativeTurnId?: string;
  processExitCode?: number | null;
  result?: RuntimeInspection['result'];
  resultTooLarge?: boolean;
  evidence: RuntimeEvent[];
}

// Hash only frozen configuration metadata, never credentials or the prompt. The
// same invocation ID in a different conversation/account is not the same work.
function identity(input: RuntimeInspectionRequest): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',') + '}';
    return JSON.stringify(value) ?? 'null';
  };
  return createHash('sha256').update(canonical({ invocationId: input.invocationId, conversationId: input.conversationId, member: input.member, account: input.account })).digest('hex');
}

const detailFields = new Set(['nativeSessionId', 'nativeTurnId', 'nativeMessageId', 'clientUserMessageId', 'providerResponseId', 'resultId', 'requestedSessionId', 'continuity', 'resumeRequested', 'processStarted', 'transport', 'scope', 'confirmed', 'evidence', 'reason', 'code', 'signal', 'status', 'round', 'observation', 'protocol', 'content']);
const observedKinds = new Set<RuntimeEvent['kind']>(['prepared', 'exposed', 'accepted', 'not_accepted', 'session', 'process_exit', 'transport_settled']);

/** Same-process evidence inspection, not a vendor history search or process probe.
 * State cannot survive a service restart; absent observations are unsupported.
 * Durable observations already committed by the Store remain a separate source.
 */
export function withRuntimeInspection(base: CollaborationRuntime, options: { maxCompleted?: number; maxEvidence?: number } = {}): CollaborationRuntime {
  const records = new Map<string, Observation>();
  const completedLimit = Math.max(0, options.maxCompleted ?? 256);
  const evidenceLimit = Math.max(8, options.maxEvidence ?? 64);
  const prune = () => {
    let remaining = [...records.values()].filter(record => record.finished).length;
    for (const [key, record] of records) {
      if (remaining <= completedLimit) break;
      if (record.finished) { records.delete(key); remaining--; }
    }
  };
  return {
    probe: () => base.probe(),
    ...(base.sessionIdentity ? { sessionIdentity: base.sessionIdentity.bind(base) } : {}),
    async invoke(input: RuntimeRequest) {
      // In-process retries must never silently create a second provider call.
      if (records.has(input.invocationId)) throw new Error('Invocation identity has already been observed; inspect its existing execution.');
      const record: Observation = { identity: identity(input), workspace: resolve(input.cwd), finished: false, conflicted: false, hostStarted: false, exposed: false, acceptance: 'unknown', teardown: 'unknown', evidence: [] };
      records.set(input.invocationId, record);
      const selectedSecret = input.account.apiKeyEnv ? process.env[input.account.apiKeyEnv] : undefined;
      const redact = (text: string) => selectedSecret ? text.split(selectedSecret).join('[redacted]') : text;
      const bind = (key: 'nativeSessionId' | 'nativeTurnId', value: unknown) => {
        if (typeof value !== 'string' || !value) return;
        if (record[key] && record[key] !== value) record.conflicted = true;
        else record[key] = value;
      };
      const cli = !input.member.carrier.endsWith('-api');
      const capture = (event: RuntimeEvent) => {
        const terminal = event.kind === 'diagnostic' && event.detail.observation === 'native_terminal' && event.detail.protocol === input.member.carrier;
        if (!observedKinds.has(event.kind) && !terminal) return;
        const detail: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(event.detail)) {
          if (!detailFields.has(key)) continue;
          if (typeof value === 'string') {
            const safe = redact(value);
            if (key === 'content' && safe.length > 100_000) { record.resultTooLarge = true; continue; }
            detail[key] = key === 'content' ? safe : safe.slice(0, 4000);
          }
          else if (value === null || typeof value === 'boolean' || typeof value === 'number') detail[key] = value;
        }
        // The result is retained once, not repeated in every evidence record.
        const safe: RuntimeEvent = { kind: event.kind, detail: { ...detail } };
        delete safe.detail.content;
        record.evidence.push(safe);
        if (record.evidence.length > evidenceLimit) record.evidence.shift();
        bind('nativeSessionId', detail.nativeSessionId);
        bind('nativeTurnId', detail.nativeTurnId);
        if (event.kind === 'prepared' && detail.processStarted === true) record.hostStarted = true;
        if (event.kind === 'exposed') { record.exposed = true; record.teardown = 'unknown'; }
        if (event.kind === 'accepted') record.acceptance = 'accepted';
        if (event.kind === 'not_accepted' && record.acceptance !== 'accepted') record.acceptance = 'not_accepted';
        if (cli && event.kind === 'process_exit' && detail.confirmed === true) {
          record.teardown = 'confirmed';
          record.processExitCode = typeof detail.code === 'number' ? detail.code : null;
        }
        if (event.kind === 'transport_settled' && detail.confirmed === true && (
          (!cli && detail.scope === 'request') || (detail.scope === 'preflight' && !record.hostStarted && !record.exposed)
        )) record.teardown = 'confirmed';
        // Only adapters emit this after validating an actual native terminal
        // receipt. Arbitrary diagnostic text, CLI close and thrown errors do not.
        if (terminal && typeof detail.content === 'string' && (detail.status === 'succeeded' || detail.status === 'failed') && record.nativeSessionId && (!cli || input.member.carrier === 'claude-cli' || record.nativeTurnId)) {
          record.result = { status: detail.status, content: detail.content };
          if (detail.status === 'succeeded') record.acceptance = 'accepted';
        }
      };
      try {
        const result = await base.invoke({ ...input, onEvent: event => { capture(event); input.onEvent(event); } });
        bind('nativeSessionId', result.nativeSessionId); bind('nativeTurnId', result.nativeTurnId);
        const content = redact(result.text);
        record.resultTooLarge = content.length > 100_000;
        record.result = record.resultTooLarge ? undefined : { status: 'succeeded', content };
        return result;
      } finally {
        // A rejected promise may be a persistence callback failure, cancellation,
        // socket loss or adapter failure. It is not proof of a failed model turn.
        record.finished = true;
        prune();
      }
    },
    async inspect(input: RuntimeInspectionRequest): Promise<RuntimeInspection> {
      const answer: RuntimeInspection = { invocationId: input.invocationId, carrier: input.member.carrier, state: 'unsupported', acceptance: 'unknown', teardown: 'unknown', reason: '本服务进程没有该执行的受信观察记录；当前承载不支持重启后的原生执行核查，不会重新发送。', observedAt: new Date().toISOString(), evidence: [] };
      const record = records.get(input.invocationId);
      if (!record) return answer;
      if (record.conflicted || record.identity !== identity(input) || (input.workspaceScope && resolve(input.workspaceScope) !== record.workspace) || (input.nativeSessionId && input.nativeSessionId !== record.nativeSessionId) || (input.nativeTurnId && input.nativeTurnId !== record.nativeTurnId)) {
        return { ...answer, state: 'unknown', reason: '核查身份与本进程观察记录不匹配；不能将其他会话、账户或原生执行的结果关联到此调用。' };
      }
      // Claude's adapter requires both a successful result and a clean process
      // close. A contradictory nonzero exit must not be upgraded by inspection.
      const result = input.member.carrier === 'claude-cli' && record.result?.status === 'succeeded' && record.processExitCode !== 0 ? undefined : record.result;
      return structuredClone({ ...answer,
        ...(record.nativeSessionId ? { nativeSessionId: record.nativeSessionId } : {}),
        ...(record.nativeTurnId ? { nativeTurnId: record.nativeTurnId } : {}),
        state: record.finished ? record.teardown === 'confirmed' ? 'settled' : 'unknown' : 'running',
        acceptance: record.acceptance, teardown: record.teardown,
        ...(result ? { result } : {}), evidence: record.evidence,
        reason: !record.finished ? '本进程仍在观察该调用；本地调用运行中不等于供应商已接受。' : record.teardown !== 'confirmed' ? '调用已结束，但缺少准确的退出或请求终态证据；保留未知，不自动重发。' : result ? '已取得准确执行结果及退出/请求终态证据。' : record.resultTooLarge ? '执行结果超出本进程核查缓存上限；不能用截断正文恢复为完整成功。' : '已证明执行退出或请求结束，但没有可核验的执行结果。',
      });
    },
  };
}
