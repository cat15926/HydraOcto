import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { RuntimeEvent } from '../../shared/collaboration.js';
import type { Json } from './runtime-common.js';

type Operation = { name: string; path?: string; paths?: string[]; pathsTruncated?: true; commandLabel?: string; commandDigest?: string };
type State = 'started' | 'completed' | 'failed' | 'unknown';

function identity(value: unknown): value is string {
  return typeof value === 'string' && /^[\w.:-]{1,200}$/.test(value);
}

function projectPath(root: string, path: unknown): string | undefined {
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path)) return;
  const local = relative(root, resolve(root, path));
  if (local && local !== '..' && !local.startsWith('..' + sep) && !isAbsolute(local)) return local;
}

function commandSummary(command: unknown): Pick<Operation, 'commandDigest' | 'commandLabel'> {
  if (typeof command !== 'string') return {};
  // Arbitrary shell arguments and output may contain document contents or credentials.
  // Codex may report a shell wrapper. Only store known command names, never arbitrary paths or arguments.
  const body = command.trim().replace(/^\/(?:usr\/)?bin\/(?:ba|z|da)?sh\s+-[lc]+\s+['"]?/, '')
    .replace(/^cd\s+[^;&|\n]{1,512}\s*&&\s*/, '');
  const label = /^(npm (?:run )?test|pnpm test|yarn test|node --test|pytest|git (?:diff|status)|python3? -m (?:pytest|unittest)|python3?)(?=\s|['"]?$)/.exec(body);
  return { commandLabel: label?.[1] ?? 'Shell', commandDigest: createHash('sha256').update(command).digest('hex') };
}

/** One instance per live invocation. Provider tool IDs are only meaningful inside their session/turn. */
export class NativeToolEvidence {
  private calls = new Map<string, { operation: Operation; done: boolean }>();
  private truncated = false;
  constructor(private cwd: string, private emit: (event: RuntimeEvent) => void) {}

  private record(session: string, turn: string | undefined, id: unknown, state: State, operation?: Operation, extra?: { exitCode: number }) {
    if (!identity(id)) return;
    const key = JSON.stringify([session, turn, id]);
    const previous = this.calls.get(key);
    if (!operation && !previous || previous?.done || state === 'started' && previous) return;
    if (!previous && this.calls.size >= 512) {
      if (!this.truncated) this.emit({ kind: 'diagnostic', detail: { observation: 'native_tool_limit', nativeSessionId: session, truncated: true, limit: 512 } });
      this.truncated = true;
      return;
    }
    // A file-change start may lack the resulting paths; enrich it from the matched terminal item.
    let op = operation ?? previous!.operation;
    if (previous && operation && operation.name !== 'fileChange') op = { ...previous.operation, ...operation };
    this.calls.set(key, { operation: op, done: state !== 'started' });
    this.emit({ kind: 'tool', detail: { origin: 'native', nativeSessionId: session, ...(turn ? { nativeTurnId: turn } : {}), callId: id, state, ...op, ...extra } });
  }

  codex(session: string, turn: string, item: Json, notification: 'started' | 'completed') {
    if (!identity(session) || !identity(turn) || !item || !['commandExecution', 'fileChange'].includes(item.type)) return;
    const operation: Operation = item.type === 'commandExecution'
      ? { name: 'commandExecution', ...commandSummary(item.command) } : { name: 'fileChange' };
    if (item.type === 'fileChange' && Array.isArray(item.changes)) {
      const paths = new Set<string>();
      for (const change of item.changes) {
        const path = projectPath(this.cwd, change?.path);
        if (path) paths.add(path);
        if (paths.size > 32) break;
      }
      if (paths.size === 1) operation.path = [...paths][0];
      if (paths.size > 1) operation.paths = [...paths].slice(0,32);
      if (paths.size > 32) operation.pathsTruncated = true;
    }
    const exitCode = Number.isSafeInteger(item.exitCode) ? item.exitCode as number : undefined;
    const done = item.status === 'failed' || item.status === 'declined' || exitCode !== undefined && exitCode !== 0
      ? 'failed' : item.status === 'completed' ? 'completed' : 'unknown';
    this.record(session, turn, item.id, notification === 'started' ? 'started' : done, operation, exitCode !== undefined ? { exitCode } : undefined);
  }

  claude(session: string, frame: Json, turn?: string) {
    if (!identity(session) || (turn !== undefined && !identity(turn)) || frame.session_id !== session || frame.parent_tool_use_id || !Array.isArray(frame.message?.content)) return;
    for (const block of frame.message.content) {
      if (!block || typeof block !== 'object') continue;
      if (frame.type === 'assistant' && block.type === 'tool_use' && ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'].includes(block.name)) {
        const path = projectPath(this.cwd, block.input?.file_path ?? block.input?.path);
        this.record(session, turn, block.id, 'started', { name: block.name, ...(path ? { path } : {}), ...(block.name === 'Bash' ? commandSummary(block.input?.command) : {}) });
      }
      if (frame.type === 'user' && block.type === 'tool_result') {
        this.record(session, turn, block.tool_use_id, block.is_error === true ? 'failed' : 'completed');
      }
    }
  }
}
