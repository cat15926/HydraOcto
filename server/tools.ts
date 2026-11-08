import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, fsyncSync } from 'node:fs';
import { lstat, open, opendir, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { protectProjectLogin } from './collaboration/workbench.js';
import type { Artifact, ToolCall } from '../shared/contracts.js';

const TEXT_LIMIT = 64 * 1024;
const WRITE_LIMIT = 256 * 1024;
const RECORD_LIMIT = 2 * 1024 * 1024;
const LIST_LIMIT = 200;
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const within = (root: string, path: string): boolean => path === root || path.startsWith(root + sep);
const isCode = (error: unknown, code: string): boolean => error instanceof Error && 'code' in error && error.code === code;

function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || value === null || seen.has(value)) throw new Error('操作参数必须是无循环的 JSON 数据');
  seen.add(value);
  try {
    if (Array.isArray(value)) return '[' + value.map(item => canonical(item, seen)).join(',') + ']';
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('操作参数必须是普通对象');
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key], seen)).join(',') + '}';
  } finally { seen.delete(value); }
}

export function operationDigest(call: Pick<ToolCall, 'id' | 'taskId' | 'runId' | 'stepId' | 'name' | 'args'>): string {
  return hash(canonical({ id: call.id, taskId: call.taskId, runId: call.runId, stepId: call.stepId, name: call.name, args: call.args }));
}

function objectArgs(args: Record<string, unknown>, allowed: string[], required: string[]): void {
  if (!args || typeof args !== 'object' || Array.isArray(args) || (Object.getPrototypeOf(args) !== Object.prototype && Object.getPrototypeOf(args) !== null)) throw new Error('工具参数必须是普通对象');
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('工具参数包含未知字段');
  if (required.some(key => !Object.hasOwn(args, key))) throw new Error('工具参数缺少必需字段');
}

function text(value: unknown, label: string, maxBytes: number, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || Buffer.byteLength(value) > maxBytes) throw new Error(`${label}格式或长度无效`);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) throw new Error(`${label}包含二进制或控制字符`);
}

function decode(buffer: Buffer): string {
  let result: string;
  try { result = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error('文件不是有效的 UTF-8 文本'); }
  text(result, '文件', WRITE_LIMIT, true);
  return result;
}

interface StoredArtifact { operation: string; artifact: Artifact; content: string }

export class ToolGateway {
  private workspace: string;
  private artifactDir: string;
  private ready = false;
  private seedDemo: boolean;

  constructor(config: { workspace: string; artifactDir: string; seedDemo?: boolean }) {
    this.seedDemo = config.seedDemo ?? false;
    this.workspace = resolve(config.workspace);
    this.artifactDir = resolve(config.artifactDir);
  }

  async init(): Promise<void> {
    mkdirSync(this.workspace, { recursive: true, mode: 0o700 });
    mkdirSync(this.artifactDir, { recursive: true, mode: 0o700 });
    this.workspace = realpathSync(this.workspace);
    this.artifactDir = realpathSync(this.artifactDir);
    if (within(this.artifactDir, this.workspace) || within(this.workspace, this.artifactDir)) throw new Error('工作区与专用产物区不得重叠');
    this.ready = true;
    if (!this.seedDemo) return;
    try {
      await writeFile(join(this.workspace, 'welcome.txt'), '欢迎使用本地多 Agent 工作区。\n这是固定演示流程的示例材料。演示模式只验证读取、审批、交付和验收流程，不理解任意任务。\n', { flag: 'wx', mode: 0o600 });
    } catch (error) { if (!isCode(error, 'EEXIST')) throw error; }
  }

  validate(name: string, args: Record<string, unknown>): void {
    if (name === 'workspace_list' || name === 'workspace_read') {
      objectArgs(args, ['path'], ['path']);
      text(args.path, '工作区路径', 1024);
      if (isAbsolute(args.path) || args.path.includes('\\') || args.path.split('/').includes('..')) throw new Error('工作区路径必须是范围内的相对路径');
      return;
    }
    if (name === 'artifact_read') {
      objectArgs(args, ['artifactId'], ['artifactId']);
      text(args.artifactId, '产物 ID', 200);
      if (!/^[a-zA-Z0-9_-]+$/u.test(args.artifactId)) throw new Error('产物 ID 无效');
      return;
    }
    if (name === 'artifact_write') {
      objectArgs(args, ['name', 'content', 'mime'], ['name', 'content']);
      text(args.name, '产物名称', 180);
      if (args.name !== basename(args.name) || /[\\/]/u.test(args.name) || args.name === '.' || args.name === '..') throw new Error('产物名称只能是文件名');
      text(args.content, '产物内容', WRITE_LIMIT, true);
      if (Object.hasOwn(args, 'mime')) {
        text(args.mime, 'MIME 类型', 100);
        if (!/^(text\/[a-z0-9][a-z0-9.+-]*|application\/(json|xml))$/u.test(args.mime)) throw new Error('只允许文本产物的 MIME 类型');
      }
      return;
    }
    throw new Error('未知工具');
  }

  private assertRoots(): void {
    if (!this.ready) throw new Error('工具网关尚未初始化');
    for (const root of [this.workspace, this.artifactDir]) {
      const stat = lstatSync(root);
      if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(root) !== root) throw new Error('工具根目录已变化');
    }
  }

  private async workspacePath(path: string): Promise<string> {
    this.assertRoots();
    protectProjectLogin(this.workspace,'read-only');
    const target = resolve(this.workspace, path);
    if (!within(this.workspace, target) || within(this.artifactDir, target)) throw new Error('工作区路径越界或指向专用产物区');
    let cursor = this.workspace;
    for (const component of relative(this.workspace, target).split(sep).filter(Boolean)) {
      cursor = join(cursor, component);
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error('工作区不允许读取软链接');
    }
    const actual = await realpath(target);
    if (!within(this.workspace, actual) || within(this.artifactDir, actual)) throw new Error('工作区真实路径越界');
    protectProjectLogin(actual,'read-only');
    return actual;
  }

  private async readBounded(path: string, limit: number): Promise<Buffer> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('只允许读取普通文件');
      if (stat.size > limit) throw new Error('文件超过读取大小限制');
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length <= limit) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > limit) throw new Error('文件超过读取大小限制');
      return buffer.subarray(0, length);
    } finally { await handle.close(); }
  }

  async executeRead(name: 'workspace_list' | 'workspace_read' | 'artifact_read', args: Record<string, unknown>, context: { taskId: string; artifacts: Artifact[] }): Promise<string> {
    this.validate(name, args);
    if (name === 'artifact_read') {
      const artifact = context.artifacts.find(item => item.id === args.artifactId && item.taskId === context.taskId);
      if (!artifact) throw new Error('产物不存在或不属于当前任务');
      if (artifact.bytes > TEXT_LIMIT) throw new Error('产物超过文本读取大小限制');
      return decode(await this.readArtifact(artifact));
    }
    const target = await this.workspacePath(args.path as string);
    if (name === 'workspace_read') return decode(await this.readBounded(target, TEXT_LIMIT));
    if (name !== 'workspace_list') throw new Error('此接口仅允许读取工具');
    const directory = await opendir(target);
    const entries: { name: string; type: 'file' | 'directory' }[] = [];
    let truncated = false;
    try {
      while (true) {
        const entry = await directory.read();
        if (!entry) break;
        if (entry.isSymbolicLink() || within(this.artifactDir, join(target, entry.name)) || (!entry.isFile() && !entry.isDirectory())) continue;
        if (entries.length === LIST_LIMIT) { truncated = true; break; }
        entries.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' });
      }
    } finally { await directory.close(); }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return JSON.stringify({ path: args.path, entries, truncated });
  }

  private artifactPath(toolCallId: string): string {
    text(toolCallId, '工具调用 ID', 200);
    return join(this.artifactDir, hash(toolCallId) + '.json');
  }

  private parseStored(buffer: Buffer): StoredArtifact {
    if (buffer.length > RECORD_LIMIT) throw new Error('产物存储记录过大');
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
    catch { throw new Error('产物存储记录无效'); }
    if (!value || typeof value !== 'object') throw new Error('产物存储记录无效');
    const record = value as StoredArtifact;
    if (typeof record.operation !== 'string' || typeof record.content !== 'string' || !record.artifact || typeof record.artifact !== 'object') throw new Error('产物存储记录无效');
    text(record.content, '产物内容', WRITE_LIMIT, true);
    const bytes = Buffer.from(record.content);
    if (record.artifact.bytes !== bytes.length || record.artifact.sha256 !== hash(bytes)) throw new Error('产物内容摘要不匹配');
    return record;
  }

  // Synchronous by design: the engine can recheck approval and commit without yielding to cancellation.
  writeArtifact(call: ToolCall): Artifact {
    this.assertRoots();
    if (call.name !== 'artifact_write' || !['approved', 'succeeded'].includes(call.status)) throw new Error('产物写入需要有效批准');
    this.validate(call.name, call.args);
    for (const identity of [call.id, call.taskId, call.runId, call.stepId]) text(identity, '操作身份', 200);
    const operation = operationDigest(call);
    const content = call.args.content as string;
    const bytes = Buffer.from(content);
    const id = 'artifact-' + hash(call.id);
    const artifact: Artifact = { id, taskId: call.taskId, runId: call.runId, toolCallId: call.id, name: call.args.name as string, mime: call.args.mime as string | undefined ?? 'text/markdown', bytes: bytes.length, sha256: hash(bytes), createdAt: new Date().toISOString(), url: '/api/artifacts/' + id };
    const target = this.artifactPath(call.id);
    const temporary = join(this.artifactDir, '.' + hash(call.id) + '.' + randomUUID() + '.tmp');
    let temporaryCreated = false;
    try {
      const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      temporaryCreated = true;
      try { writeFileSync(fd, JSON.stringify({ operation, artifact, content } satisfies StoredArtifact)); fsyncSync(fd); }
      finally { closeSync(fd); }
      try { linkSync(temporary, target); }
      catch (error) {
        if (!isCode(error, 'EEXIST')) throw error;
        const stat = lstatSync(target);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > RECORD_LIMIT) throw new Error('产物目标不是有效文件');
        const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        let existing: StoredArtifact;
        try { existing = this.parseStored(readFileSync(fd)); } finally { closeSync(fd); }
        if (existing.operation !== operation || existing.content !== content) throw new Error('工具调用身份已用于不同的写入内容');
        return existing.artifact;
      }
      return artifact;
    } finally { if (temporaryCreated) unlinkSync(temporary); }
  }

  async readArtifact(artifact: Artifact): Promise<Buffer> {
    this.assertRoots();
    const target = this.artifactPath(artifact.toolCallId);
    const record = this.parseStored(await this.readBounded(target, RECORD_LIMIT));
    if (canonical(record.artifact) !== canonical(artifact)) throw new Error('产物身份或内容元数据不匹配');
    return Buffer.from(record.content);
  }
}
