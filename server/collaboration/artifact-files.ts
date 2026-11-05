import { constants, closeSync, fstatSync, fsyncSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, parse, relative, resolve, sep } from 'node:path';
import type { ArtifactVersion, ManagedJob } from '../../shared/collaboration.js';

export const contentDigest = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
export interface ArtifactReceipt { jobId: string; versionId: string; operationDigest: string; fence: string; digest: string; content: string }
/** Platform-owned immutable objects. A display name never participates in a filesystem path. */
export class ArtifactFiles {
  private identity?: { dev: number; ino: number };
  readonly root: string;
  constructor(root: string, private readonly workspace = '') {
    let path = resolve(root);
    // macOS system aliases are fixed mappings, not arbitrary user-controlled realpath resolution.
    if (process.platform === 'darwin') for (const prefix of ['/tmp', '/var']) if (path === prefix || path.startsWith(prefix + '/')) path = '/private' + path;
    this.root = path;
  }
  private noLinks(path: string) {
    let part = parse(path).root;
    for (const component of path.slice(part.length).split(sep).filter(Boolean)) {
      part = resolve(part, component);
      try { if (lstatSync(part).isSymbolicLink()) throw new Error('Artifact path ancestors cannot be symbolic links.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    }
  }
  validate(): void { this.directory(); }
  private directory(): string {
    const path = resolve(this.root);
    this.noLinks(path);
    const overlaps = (a: string, b: string) => { const r = relative(a, b); return !r || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r)); };
    if (this.workspace) {
      const workspace = realpathSync(this.workspace);
      if (overlaps(path, workspace) || overlaps(workspace, path)) throw new Error('工作区与受管产物目录不得重叠。');
    }
    mkdirSync(path, { recursive: true, mode: 0o700 });
    this.noLinks(path);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) throw new Error('Artifact directory must be a real private directory.');
    if (this.identity && (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino)) throw new Error('Artifact directory identity changed.');
    this.identity ??= { dev: stat.dev, ino: stat.ino };
    return realpathSync(path);
  }
  private path(job: ManagedJob): string {
    if (!/^[a-f0-9-]{36}$/.test(job.id)) throw new Error('Invalid managed job identity.');
    return resolve(this.directory(), `${job.id}.json`);
  }
  write(job: ManagedJob, version: ArtifactVersion, content: string): void {
    const dest = this.path(job), temp = `${dest}.${randomUUID()}.tmp`;
    const receipt: ArtifactReceipt = { jobId: job.id, versionId: version.id, operationDigest: job.operationDigest, fence: job.fence, digest: version.digest, content };
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd); } finally { closeSync(fd); }
    try { this.directory(); linkSync(temp, dest); const dir = openSync(this.directory(), constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(dir); } finally { closeSync(dir); } }
    finally { unlinkSync(temp); }
  }
  inspect(job: ManagedJob, version: ArtifactVersion): ArtifactReceipt | undefined {
    try {
      const fd = openSync(this.path(job), constants.O_RDONLY | constants.O_NOFOLLOW);
      let value: ArtifactReceipt;
      try { const s = fstatSync(fd); if (!s.isFile() || s.size > 240_000 || s.nlink !== 1) return; value = JSON.parse(readFileSync(fd, 'utf8')) as ArtifactReceipt; } finally { closeSync(fd); }
      if (value.jobId !== job.id || value.versionId !== version.id || value.operationDigest !== job.operationDigest || value.fence !== job.fence || value.digest !== version.digest || typeof value.content !== 'string' || contentDigest(value.content) !== version.digest || Buffer.byteLength(value.content) !== version.bytes) return;
      return value;
    } catch { return; }
  }
}
