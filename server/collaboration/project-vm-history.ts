import { createHash } from 'node:crypto';
import type { RuntimeRequest } from '../../shared/collaboration.js';
import type { claudeTranscript } from './runtime-session.js';

export const projectHistoryProtocol = 'project-session-history-v1';
type TranscriptRows = NonNullable<Awaited<ReturnType<typeof claudeTranscript>>>;

export interface ProjectHistory {
  restored: boolean;
  restoredRolloutPath?: string;
  beforeClaudeRows?: TranscriptRows;
  finish(nativeSessionId: string, anchor?: string): Promise<TranscriptRows | undefined>;
}

type Command = (args: string[]) => Promise<string>;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export async function beginProjectHistory(request: RuntimeRequest, carrier: 'codex' | 'claude', command: Command) {
  const { sessionPlan: plan, workspaceGrant: grant } = request;
  if (plan?.imageTurnOnly || !request.projectContinuity || !plan?.fingerprint || !plan.identity?.supported || !grant) return;
  const run = request.invocationId;
  if (!uuid.test(run)) throw new Error('项目执行身份无法绑定历史。');

  const scope = createHash('sha256').update(JSON.stringify([
    projectHistoryProtocol, request.conversationId, request.member.id, request.account.id, carrier,
    grant.path, grant.device, grant.inode, grant.revision, plan.fingerprint,
  ])).digest('hex');
  const manage = async (action: string, previous = '-', session = '-', anchor = '-') =>
    JSON.parse(await command(['--history', action, scope, run, carrier, previous, session, anchor]));
  const resume = plan.mode === 'resume' && uuid.test(plan.previousInvocationId ?? '') &&
    uuid.test(plan.nativeSessionId ?? '') && uuid.test(plan.previousAnchor ?? '');
  const before = resume
    ? await manage('begin', plan.previousInvocationId, plan.nativeSessionId, plan.previousAnchor)
    : await manage('begin');
  if (typeof before.restored !== 'boolean' || (before.restored && !resume)) {
    throw new Error('虚拟机未确认原生历史的准备结果。');
  }
  const history: ProjectHistory = {
    restored: before.restored,
    async finish(session, anchor) {
      if (!anchor || !uuid.test(session) || !uuid.test(anchor) || request.signal.aborted) return;
      try {
        const result = await manage('finish', '-', session, anchor);
        if (!request.signal.aborted && result.saved === true && Array.isArray(result.rows)) return result.rows;
      } catch {
        // The CLI may have delivered a valid turn while the guest could not persist its history.
        request.signal.throwIfAborted();
      }
    },
  };
  if (before.restored) {
    if (carrier === 'codex') {
      const rollout = before.name;
      if (typeof rollout !== 'string' || !/^\d{4}\/\d{2}\/\d{2}\/rollout-[0-9T:-]{19}-[a-f0-9-]{36}\.jsonl$/.test(rollout) ||
          !rollout.endsWith('-' + plan.nativeSessionId + '.jsonl')) {
        throw new Error('虚拟机返回的 Codex 历史位置与上次执行不一致。');
      }
      history.restoredRolloutPath = '/tmp/home/.codex/sessions/' + rollout;
    } else {
      if (!Array.isArray(before.rows)) throw new Error('虚拟机缺少 Claude Code 历史记录。');
      history.beforeClaudeRows = before.rows;
    }
  }
  return { history, key: { scope, run }, discard: () => manage('discard') };
}
