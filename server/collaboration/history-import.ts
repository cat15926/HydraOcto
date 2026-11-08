import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import type { CollaborationRuntime, HistoryPreview, NativeSessionIdentity } from '../../shared/collaboration.js';
import { verifyWorkspace } from './workbench.js';
import { AppError } from '../store.js';
import type { CollaborationStore } from './store.js';
import {
  checksum,
  indexedCodex,
  parseHistory,
  projectIdentity,
  receipts,
  uuid,
  type NativeCarrier,
} from './history-files.js';

interface Bounds {
  memberId: string;
  projectId: string;
  accountId?: string;
}
interface Candidate {
  session: string;
  path: string;
  revision?: string;
  anchors?: string[];
}
const stale = () => new AppError(409, '来源、账户或项目已经变化，请刷新列表后重新选择。');
function required(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > 180) throw new AppError(400, '请选择有效的来源。');
  return value;
}
export class HistoryImport {
  private projects = new Map<string, { path: string; until: number }>();
  private pending = new Map<string, { bounds: Bounds; session: string; stamp: string; until: number }>();
  readonly directory: string;
  constructor(
    private store: CollaborationStore,
    private runtime: CollaborationRuntime,
    dir: string,
  ) {
    this.directory = join(dir, 'history-receipts');
  }
  options() {
    const projects = new Map<string, { id: string; path: string }>();
    const paths = [this.store.options.workspace];
    for (const c of this.store.list()) {
      if (c.deletedAt || c.archivedAt || !c.workspaceGrant) continue;
      try {
        verifyWorkspace(c.workspaceGrant);
        paths.push(c.workspaceGrant.path);
      } catch {
        /* stale grant */
      }
    }
    for (const path of paths) {
      if (path)
        try {
          const p = projectIdentity(path);
          projects.set(p.id, p);
        } catch {
          /* unavailable project */
        }
    }
    for (const [id, p] of this.projects) {
      if (p.until <= Date.now()) {
        this.projects.delete(id);
        continue;
      }
      try {
        if (projectIdentity(p.path).id === id) projects.set(id, { id, path: p.path });
      } catch {
        /* no longer available */
      }
    }
    const members = this.store
      .members()
      .filter((m) => m.enabled && !m.deletedAt)
      .flatMap((m) => {
        try {
          return [this.store.workbench.resolveMember(m)];
        } catch {
          return [];
        }
      })
      .filter((m) => ['codex-app-server', 'claude-cli'].includes(m.carrier))
      .map((m) => {
        const a = this.store.accounts().find((a) => a.id === m.accountId && !a.deletedAt);
        return { id: m.id, name: m.name, carrier: m.carrier, account: a?.name, accountId: a?.id };
      })
      .filter((m) => m.accountId);
    const accounts = this.store
      .accounts()
      .filter((a) => !a.deletedAt && ['codex', 'claude'].includes(a.provider))
      .map((a) => ({ id: a.id, name: a.name, provider: a.provider }));
    return { projects: [...projects.values()], members, accounts, terminalRoot: process.cwd() };
  }
  addProject(path: string) {
    this.store.workbench.checkImportDirectory(path);
    const p = projectIdentity(path);
    if (this.projects.size >= 100) this.projects.delete(this.projects.keys().next().value!);
    this.projects.set(p.id, { path: p.path, until: Date.now() + 30 * 60_000 });
    return p;
  }
  private async scope(bounds: Bounds) {
    const selected = this.options().projects.find((p) => p.id === bounds.projectId);
    const raw = this.store.members().find((m) => m.id === bounds.memberId && m.enabled && !m.deletedAt);
    if (!selected || !raw) throw stale();
    const member = this.store.workbench.resolveMember(raw),
      account = this.store.accounts().find((a) => a.id === (bounds.accountId ?? member.accountId) && !a.deletedAt);
    if (
      !account ||
      !['codex-app-server', 'claude-cli'].includes(member.carrier) ||
      account.provider !== (member.carrier === 'claude-cli' ? 'claude' : 'codex')
    )
      throw stale();
    const carrier = member.carrier as NativeCarrier;
    const identity = await (this.runtime.historyIdentity ?? this.runtime.sessionIdentity)?.({
      member,
      account,
      cwd: selected.path,
    });
    if (!identity?.supported || !identity.fingerprint)
      throw new AppError(409, '无法核验此成员的 CLI 账户。请在「成员与运行时」检查账户绑定与登录后重试。');
    const assertCurrent = () => {
      const current = this.store.members().find((m) => m.id === raw.id && m.enabled && !m.deletedAt);
      if (
        !current ||
        JSON.stringify(this.store.workbench.resolveMember(current)) !== JSON.stringify(member) ||
        JSON.stringify(this.store.accounts().find((a) => a.id === account.id)) !== JSON.stringify(account) ||
        !this.options().projects.some((p) => p.id === selected.id)
      )
        throw stale();
    };
    assertCurrent();
    const stamp = checksum(
      JSON.stringify([member, account, identity.fingerprint, identity.historyOwner, selected.id]),
    );
    return {
      member,
      account,
      carrier,
      identity: identity as NativeSessionIdentity & { fingerprint: string },
      project: selected,
      stamp,
      assertCurrent,
    };
  }
  private sources(s: Awaited<ReturnType<HistoryImport['scope']>>) {
    const candidates = new Map<string, Candidate>();
    for (const c of s.carrier === 'codex-app-server' ? indexedCodex(s.project.path, s.identity.historyOwner) : [])
      candidates.set(c.session, c);
    for (const r of receipts(this.directory, s.account.id, s.identity.fingerprint, s.project.id, s.carrier))
      candidates.set(r.session, r);
    return candidates;
  }
  private read(s: Awaited<ReturnType<HistoryImport['scope']>>, candidate: Candidate) {
    const data = parseHistory(s.carrier, candidate.path, candidate.session, s.project.path);
    let lines = data.lines;
    if (candidate.revision) {
      if (data.revision !== candidate.revision || !candidate.anchors) throw stale();
      const allowed = new Set(candidate.anchors);
      lines = lines.filter((l) => allowed.has(l.anchor));
      if (lines.length !== allowed.size) throw stale();
    }
    if (!lines.length || lines.length > 1200 || lines.reduce((n, l) => n + l.text.length, 0) > 1_000_000)
      throw new AppError(422, '此记录为空或超过单次预览上限。');
    return {
      lines,
      stamp: checksum(JSON.stringify([s.stamp, candidate.session, data.revision, lines.map((l) => l.anchor)])),
    };
  }
  private bounds(body: Record<string, unknown>): Bounds {
    return {
      memberId: required(body.memberId),
      projectId: required(body.projectId),
      accountId: body.accountId === undefined ? undefined : required(body.accountId),
    };
  }
  async list(body: Record<string, unknown>) {
    const s = await this.scope(this.bounds(body)),
      result = [];
    const offset = body.offset ?? 0;
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000)
      throw new AppError(400, '无效的列表位置。');
    const candidates = [...this.sources(s).values()];
    let unavailable = 0;
    const reasons = new Set<string>();
    for (const c of candidates.slice(offset, offset + 8)) {
      await new Promise<void>((r) => setImmediate(r));
      try {
        const { lines } = this.read(s, c);
        result.push({
          id: c.session,
          title: lines.find((l) => l.role === 'user')?.text.slice(0, 76) || '本机 CLI 会话',
          time: lines.at(-1)!.time,
          count: lines.length,
        });
      } catch (error) {
        reasons.add(error instanceof AppError ? error.message : '来源不可读取或已被移动。');
        unavailable++;
      }
    }
    s.assertCurrent();
    return {
      choices: result.sort((a, b) => b.time.localeCompare(a.time)),
      unavailable,
      reasons: [...reasons],
      next: offset + 8 < candidates.length ? offset + 8 : null,
    };
  }
  async preview(body: Record<string, unknown>): Promise<HistoryPreview> {
    const bounds = this.bounds(body),
      s = await this.scope(bounds),
      session = required(body.session);
    const c = this.sources(s).get(session);
    if (!c) throw stale();
    const { lines, stamp } = this.read(s, c),
      token = randomUUID();
    for (const [key, p] of this.pending) if (p.until <= Date.now()) this.pending.delete(key);
    if (this.pending.size >= 200) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(token, { bounds, session, stamp, until: Date.now() + 300_000 });
    return {
      token,
      lines,
      project: s.project.path,
      account: s.account.name,
      member: s.member.name,
      title: basename(s.project.path),
    };
  }
  async confirm(body: Record<string, unknown>) {
    const token = required(body.token),
      first = body.first,
      last = body.last;
    if (
      !uuid.test(token) ||
      typeof first !== 'number' ||
      typeof last !== 'number' ||
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(last) ||
      first < 0 ||
      last < first
    )
      throw new AppError(400, '请选择要导入的消息范围。');
    const replay = this.store.importReplay(token, first, last);
    if (replay) return replay;
    const p = this.pending.get(token);
    if (!p || p.until <= Date.now()) throw stale();
    const s = await this.scope(p.bounds),
      c = this.sources(s).get(p.session);
    if (!c) throw stale();
    const { lines, stamp } = this.read(s, c);
    if (p.stamp !== stamp || p.until <= Date.now()) throw stale();
    if (last >= lines.length || last - first >= 200) throw new AppError(400, '每次可选择 1 至 200 条消息。');
    const selected = lines.slice(first, last + 1);
    if (selected.reduce((n, l) => n + l.text.length, 0) > 100_000)
      throw new AppError(422, '所选内容过长，请缩小范围。');
    s.assertCurrent();
    return this.store.importSelected(token, first, last, s.member.id, selected, {
      carrier: s.carrier,
      accountId: s.account.id,
      identity: s.identity.fingerprint,
      project: s.project.path,
      projectIdentity: s.project.id,
      sessionId: c.session,
    });
  }
}
