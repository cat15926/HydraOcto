import {
  constants,
  openSync,
  closeSync,
  readSync,
  fstatSync,
  realpathSync,
  statSync,
  lstatSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../store.js';
import type { HistoryLine, ImportedOrigin } from '../../shared/collaboration.js';

export type NativeCarrier = ImportedOrigin['carrier'];
export const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const checksum = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function projectIdentity(path: string) {
  const canonical = realpathSync(path),
    st = statSync(canonical);
  if (!st.isDirectory()) throw new AppError(409, '项目目录已经变化，请重新选择。');
  return { path: canonical, id: checksum(JSON.stringify([canonical, st.dev, st.ino])) };
}
export function historyRoot(carrier: NativeCarrier) {
  return carrier === 'codex-app-server'
    ? resolve(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')
    : resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}
export function boundedFile(root: string, path: string, max: number) {
  const actualRoot = realpathSync(root),
    actual = realpathSync(path),
    suffix = relative(actualRoot, actual);
  const inside = (r: string) => !!r && r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r);
  const relativeNames = [relative(root, path), relative(actualRoot, path)].filter(inside);
  if (!inside(suffix) || !relativeNames.includes(suffix)) throw new AppError(403, '来源目录已变化。');
  const fd = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (st.size > max) throw new AppError(422, '来源文件超过读取大小上限。');
    if (!st.isFile() || st.uid !== process.getuid?.()) throw new AppError(422, '来源文件的归属或类型无法核验。');
    const bytes = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) break;
      offset += n;
    }
    const end = fstatSync(fd),
      linked = statSync(actual);
    if (
      offset !== bytes.length ||
      end.size !== st.size ||
      end.mtimeMs !== st.mtimeMs ||
      linked.ino !== st.ino ||
      linked.dev !== st.dev ||
      realpathSync(path) !== actual
    )
      throw new AppError(409, '来源正在变化，请刷新后重试。');
    return { bytes, revision: checksum(JSON.stringify([st.dev, st.ino, checksum(bytes)])) };
  } finally {
    closeSync(fd);
  }
}

type Row = Record<string, any>;
function plain(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (
    !Array.isArray(content) ||
    !content.length ||
    !content.every((x) => x?.type === 'text' && typeof x.text === 'string')
  )
    return;
  return content.map((x) => x.text).join('\n');
}
export function parseHistory(carrier: NativeCarrier, path: string, session: string, project: string) {
  if (!uuid.test(session)) throw new AppError(422, '来源缺少可核验的会话标识。');
  const { bytes, revision } = boundedFile(historyRoot(carrier), path, 16_000_000);
  let records: Row[];
  try {
    records = bytes
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((s) => JSON.parse(s));
  } catch {
    throw new AppError(422, '此记录尚未写完或格式不受支持。');
  }
  const lines: HistoryLine[] = [];
  function add(role: HistoryLine['role'], text: unknown, anchor: string, time: unknown) {
    if (
      typeof anchor !== 'string' ||
      !anchor ||
      typeof text !== 'string' ||
      !text.trim() ||
      typeof time !== 'string' ||
      !Number.isFinite(Date.parse(time))
    )
      return;
    lines.push({ role, text, anchor, time });
  }
  if (carrier === 'codex-app-server') {
    const metas = records.filter((r) => r.type === 'session_meta');
    if (metas.length !== 1 || metas[0]?.payload?.id !== session || metas[0]?.payload?.cwd !== project)
      throw new AppError(409, '会话或项目身份不一致。');
    const source = metas[0]?.payload?.source;
    if (source === 'subagent' || (typeof source === 'object' && source?.subagent))
      throw new AppError(422, '此记录属于内部子任务。');
    if (records.some((r) => r.type === 'turn_context' && r.payload?.cwd && r.payload.cwd !== project))
      throw new AppError(422, '记录横跨多个项目，无法确认导入范围。');
    // Native user/agent events contain visible messages. Raw response items also contain injected instructions.
    const typed = records.some(
      (r) =>
        r.type === 'event_msg' && r.payload?.type === 'item_completed' && r.payload.item?.type === 'UserMessage',
    );
    for (const [i, r] of records.entries()) {
      if (r.type !== 'event_msg') continue;
      const p = r.payload;
      if (typed) {
        if (p?.type !== 'item_completed' || p.thread_id !== session) continue;
        const item = p.item;
        if (item?.type === 'UserMessage') add('user', plain(item.content), item.id, r.timestamp);
        if (
          item?.type === 'AgentMessage' &&
          (!item.phase || item.phase === 'final_answer') &&
          Array.isArray(item.content) &&
          item.content.every((x: Row) => x?.type === 'Text' && typeof x.text === 'string')
        )
          add('assistant', item.content.map((x: Row) => x.text).join('\n'), item.id, r.timestamp);
        continue;
      }
      if (p?.type === 'user_message') add('user', p.message, 'event-' + i, r.timestamp);
      if (p?.type === 'agent_message' && (!p.phase || p.phase === 'final_answer'))
        add('assistant', p.message, 'event-' + i, r.timestamp);
    }
  } else {
    const eligible = records.filter((r) => ['user', 'assistant'].includes(r.type) && !r.isSidechain);
    if (eligible.some((r) => r.sessionId !== session || r.cwd !== project || !uuid.test(r.uuid)))
      throw new AppError(409, '会话或项目身份不一致。');
    const graph = new Map<string, Row>();
    for (const r of records.filter((r) => !r.isSidechain && typeof r.uuid === 'string')) {
      if (graph.has(r.uuid)) throw new AppError(422, '记录存在重复历史节点。');
      graph.set(r.uuid, r);
    }
    const last = eligible.at(-1);
    let node = last;
    const chain = new Set<string>();
    while (node) {
      if (chain.has(node.uuid)) throw new AppError(422, '记录链无效。');
      chain.add(node.uuid);
      if (!node.parentUuid) break;
      node = graph.get(node.parentUuid);
      if (!node) throw new AppError(422, '历史链不完整。');
    }
    for (const r of eligible.filter((r) => chain.has(r.uuid))) {
      if (
        r.isMeta ||
        r.isVisibleInTranscriptOnly ||
        r.toolUseResult ||
        r.isCompactSummary ||
        r.message?.role !== r.type
      )
        continue;
      add(r.type, plain(r.message.content), r.uuid, r.timestamp);
    }
  }
  if (new Set(lines.map((l) => l.anchor)).size !== lines.length) throw new AppError(422, '历史消息锚点重复。');
  return { lines, revision };
}

// The native thread index is a separate source of account and project attribution.
export function indexedCodex(
  project: string,
  owner: { account: string; user: string } | undefined,
  session?: string,
) {
  if (!owner) return [];
  const dir = resolve(historyRoot('codex-app-server'), '..'),
    path = join(dir, 'state_5.sqlite');
  if (!existsSync(path) || realpathSync(path) !== join(realpathSync(dir), 'state_5.sqlite')) return [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const rows = db
      .prepare(
        'SELECT id,rollout_path FROM threads WHERE creator_account_id=? AND creator_user_id=? AND cwd=? AND (? IS NULL OR id=?) ORDER BY updated_at DESC LIMIT 100',
      )
      .all(owner.account, owner.user, project, session ?? null, session ?? null);
    return rows.flatMap((r) =>
      typeof r.id === 'string' && uuid.test(r.id) && typeof r.rollout_path === 'string'
        ? [{ session: r.id, path: r.rollout_path }]
        : [],
    );
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
export interface SourceReceipt {
  version: 1;
  accountId: string;
  identity: string;
  carrier: NativeCarrier;
  projectId: string;
  session: string;
  path: string;
  revision: string;
  anchors: string[];
}
export function receipts(
  dir: string,
  accountId: string,
  identity: string,
  projectId: string,
  carrier: NativeCarrier,
): SourceReceipt[] {
  const folder = join(dir, checksum(JSON.stringify([accountId, identity, projectId])));
  if (!existsSync(folder)) return [];
  for (const part of [dir, folder]) {
    const st = lstatSync(part);
    if (!st.isDirectory() || st.uid !== process.getuid?.()) throw new AppError(403, '来源登记目录不可用。');
  }
  const names = readdirSync(folder).filter((f) => uuid.test(f.slice(0, -5)) && f.endsWith('.json'));
  if (names.length > 500) throw new AppError(422, '这个项目的来源记录过多，请分项目整理。');
  const rows: SourceReceipt[] = [];
  for (const file of names) {
    const r = JSON.parse(boundedFile(dir, join(folder, file), 256_000).bytes.toString('utf8')) as SourceReceipt;
    if (
      r.version === 1 &&
      r.carrier === carrier &&
      r.accountId === accountId &&
      r.identity === identity &&
      r.projectId === projectId &&
      file === r.session + '.json' &&
      Array.isArray(r.anchors)
    )
      rows.push(r);
  }
  return rows;
}
