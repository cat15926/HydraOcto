// Optional terminal entry point for native formats that omit the originating login.
// Bind the exact visible messages observed in a live CLI turn, never attest a supplied transcript.
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { CollaborationAccount, CollaborationRuntime, Member } from '../../shared/collaboration.js';
import {
  checksum,
  historyRoot,
  parseHistory,
  projectIdentity,
  uuid,
  type NativeCarrier,
  type SourceReceipt,
} from './history-files.js';

export class HistoryRecording {
  private session?: string;
  private previousAnchor?: string;
  private attested = new Map<string, string>();
  private stamp?: string;
  constructor(
    private runtime: CollaborationRuntime,
    private member: Member,
    private account: CollaborationAccount,
    private cwd: string,
    private directory: string,
  ) {}
  async turn(prompt: string) {
    if (!prompt.trim() || prompt.length > 20000) throw new Error('请输入 1 至 20000 字的消息。');
    const project = projectIdentity(this.cwd),
      carrier = this.member.carrier as NativeCarrier;
    if (!['codex-app-server', 'claude-cli'].includes(carrier)) throw new Error('请选择 CLI 成员。');
    const context = { member: this.member, account: this.account, cwd: project.path };
    const before = await this.runtime.sessionIdentity?.(context);
    if (!before?.supported || !before.fingerprint || (this.stamp && this.stamp !== before.fingerprint))
      throw new Error('不能核验当前 CLI 身份。');
    let anchor: string | undefined,
      exited = false;
    const result = await this.runtime.invoke({
      ...context,
      invocationId: randomUUID(),
      conversationId: randomUUID(),
      prompt,
      signal: AbortSignal.timeout(240_000),
      nativeSessionId: this.session,
      sessionPlan: {
        mode: this.session ? 'resume' : 'fresh',
        previousAnchor: this.previousAnchor,
        reason: '用户主动开启的终端记录',
      },
      onEvent: (e) => {
        if (e.kind === 'session' && e.detail.historyVerified === true && typeof e.detail.anchor === 'string')
          anchor = e.detail.anchor;
        if (e.kind === 'process_exit' && e.detail.confirmed === true) exited = true;
      },
      onToolCall: async () => {
        throw new Error('终端历史记录不执行平台命令。');
      },
    });
    const after = await this.runtime.sessionIdentity?.(context);
    const session = result.nativeSessionId;
    if (
      !exited ||
      !anchor ||
      before.fingerprint !== after?.fingerprint ||
      !session ||
      !uuid.test(session) ||
      (this.session && session !== this.session)
    )
      throw new Error('未取得同一账户、会话锚点或退出证据，未登记此轮。');
    const root = historyRoot(carrier);
    let path: string;
    if (carrier === 'claude-cli')
      path = join(root, project.path.replace(/[^a-zA-Z0-9]/g, '-'), session + '.jsonl');
    else {
      const db = new DatabaseSync(join(root, '..', 'state_5.sqlite'), { readOnly: true });
      try {
        const row = db.prepare('SELECT rollout_path FROM threads WHERE id=? AND cwd=?').get(session, project.path);
        if (typeof row?.rollout_path !== 'string') throw new Error('CLI 未保存此会话的来源索引。');
        path = row.rollout_path;
      } finally {
        db.close();
      }
    }
    const data = parseHistory(carrier, path, session, project.path);
    const previous = data.lines.filter((line) => this.attested.has(line.anchor));
    const anchors = [...this.attested.keys()];
    if (
      previous.length !== this.attested.size ||
      previous.some(
        (line, i) =>
          line.anchor !== anchors[i] || this.attested.get(line.anchor) !== checksum(JSON.stringify(line)),
      )
    ) {
      throw new Error('此前登记的消息已经变化，未登记此轮。');
    }
    const last = data.lines.at(-1);
    const user = data.lines.findLast((line) => line.role === 'user');
    if (
      !user ||
      !last ||
      last.role !== 'assistant' ||
      last.text.trim() !== result.text.trim() ||
      user.text !== prompt ||
      this.attested.has(user.anchor) ||
      this.attested.has(last.anchor) ||
      (carrier === 'claude-cli' && last.anchor !== anchor)
    )
      throw new Error('原生历史与本轮输入或回复不一致，未登记此轮。');
    const attested = new Map(this.attested);
    for (const line of [user, last]) attested.set(line.anchor, checksum(JSON.stringify(line)));
    const receipt: SourceReceipt = {
      version: 1,
      accountId: this.account.id,
      identity: before.fingerprint,
      carrier,
      projectId: project.id,
      session,
      path,
      revision: data.revision,
      anchors: [...attested.keys()],
    };
    const folder = join(
      this.directory,
      checksum(JSON.stringify([this.account.id, before.fingerprint, project.id])),
    );
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const tmp = join(folder, randomUUID() + '.tmp');
    await writeFile(tmp, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
    await rename(tmp, join(folder, session + '.json'));
    this.session = session;
    this.previousAnchor = anchor;
    this.attested = attested;
    this.stamp = before.fingerprint;
    return { text: result.text, session };
  }
}
