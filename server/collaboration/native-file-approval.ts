import { digest } from './continuity.js';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NativeCommandApproval, NativeFileChange, RuntimeRequest } from '../../shared/collaboration.js';
import { discoverableProjectPath, projectFileDigest } from './project-file-read.js';
import { validNativeCommand } from './native-command-approval.js';
import { verifyWorkspace } from './workbench.js';
import type { Json } from './runtime-common.js';

const guestRoot = '/mnt/project/';
const validId = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 160 && !/[\s\x00-\x1f\x7f]/.test(s);
function projectPath(value: unknown) {
  if (typeof value !== 'string') return;
  if (!value.startsWith(guestRoot)) return;
  const path = value.slice(guestRoot.length);
  if (discoverableProjectPath(path) && !/[\u202a-\u202e\u2066-\u2069]/u.test(path)) return path;
}
function preview(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) <= 8000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

export function codexFileChange(item: Json): NativeFileChange | undefined {
  if (item.type !== 'fileChange' || !Array.isArray(item.changes) || item.changes.length !== 1) return;
  const c = item.changes[0], path = projectPath(c?.path), action = c?.kind?.type;
  if (!path || !['add','update'].includes(action) || Object.keys(c.kind).some(k => k !== 'type' && k !== 'move_path') || c.kind.move_path != null || !preview(c.diff)) return;
  return { path, action: action === 'add' ? 'create' : 'patch', preview: c.diff };
}
export function claudeFileChange(input: Json): NativeFileChange | undefined {
  if (!input || Object.keys(input).length !== 2 || typeof input.file_path !== 'string' || !input.file_path.startsWith(guestRoot) || !preview(input.content)) return;
  const path = projectPath(input.file_path);
  if (path) return { path, action:'write', preview:input.content };
}

// The OS project mount remains the execution boundary. Check the named target again immediately
// before returning a one-operation decision, including its parent identity for file creation.
async function fileVersion(request: RuntimeRequest, change: NativeFileChange) {
  const grant = request.workspaceGrant!;
  verifyWorkspace(grant);
  const full = join(grant.path,change.path), parent = dirname(full);
  if (realpathSync(parent) !== parent) throw new Error();
  const folder = lstatSync(parent);
  if (!folder.isDirectory() || folder.dev !== grant.device) throw new Error();
  const stat = lstatSync(full,{throwIfNoEntry:false});
  const prefix = [folder.dev,folder.ino];
  if (!stat && change.action !== 'patch') return JSON.stringify([...prefix,null]);
  if (!stat?.isFile() || stat.nlink !== 1 || stat.dev !== grant.device || change.action === 'create') throw new Error();
  const version = await projectFileDigest(grant,change.path,request.signal);
  return JSON.stringify([...prefix,stat.ino,version.sha256]);
}

type Review = {fileChange:NativeFileChange; nativeCommand?:never} | {nativeCommand:NativeCommandApproval; fileChange?:never};
async function targetVersion(request: RuntimeRequest, review: Review) {
  if (review.fileChange) return fileVersion(request,review.fileChange);
  const grant = request.workspaceGrant!;
  verifyWorkspace(grant);
  return JSON.stringify([grant.device,grant.inode,grant.revision]);
}

export type NativeDecision = 'accept' | 'decline' | 'cancel' | 'closed';
export class NativeFileApprovals {
  private closed = false;
  private items = new Map<string, { review: Review; fingerprint: string }>();
  private used = new Set<string>();
  private requestIds = new Set<string>();
  private pending = new Map<string, string>();
  constructor(private readonly request: RuntimeRequest) {}
  private key(thread:string,turn:string,item:string) { return JSON.stringify([thread,turn,item]); }
  observe(thread:string,turn:string,item:string,change:NativeFileChange | undefined,exact:unknown) {
    if (change) this.remember(thread,turn,item,{fileChange:change},exact);
  }
  observeCommand(thread:string,turn:string,item:string,command:NativeCommandApproval | undefined,exact:unknown) {
    if (command) this.remember(thread,turn,item,{nativeCommand:command},exact);
  }
  private remember(thread:string,turn:string,item:string,review:Review,exact:unknown) {
    if (this.closed || ![thread,turn,item].every(validId) || this.items.size >= 128) return;
    const key = this.key(thread,turn,item);
    if (this.used.has(key)) return;
    if (this.items.has(key)) { this.closeItem(thread,turn,item); return; }
    this.items.set(key,{review,fingerprint:digest(exact)});
  }
  hasItem(thread:string,turn:string,item:string) { return this.items.has(this.key(thread,turn,item)); }
  async unavailable(thread:string,turn:string,item:string,id:string,operation:string,target?:string) {
    if (!this.request.onInteraction || ![thread,turn,item,id].every(validId) || this.request.signal.aborted || this.requestIds.has(id) || this.requestIds.size >= 256) return;
    this.requestIds.add(id);
    await this.reportUnavailable(thread,turn,item,id,operation,target);
  }
  private async reportUnavailable(thread:string,turn:string,item:string,id:string,operation:string,target?:string,fileUnavailable=false) {
    try { await this.request.onInteraction?.({kind:'approval',operation,providerRequestId:id,nativeSessionId:thread,nativeTurnId:turn,nativeItemId:item,
      payload:{...(target && target.length <= 512 ? {target} : {}), ...(fileUnavailable ? {reasonCode:'file_unavailable'} : {})}}); }
    catch { /* A closed source cannot receive another permission notice. */ }
  }
  closeItem(thread:string,turn:string,item:string) {
    const key=this.key(thread,turn,item);
    this.items.delete(key);
    if (this.used.size < 256) this.used.add(key);
    for (const [id,pending] of this.pending) if (pending === key) this.closeRequest(id);
  }
  closeRequest(id:string) {
    if (!this.pending.delete(id)) return;
    this.request.onInteractionResolved?.(id);
  }
  close() { this.closed = true; this.items.clear(); for (const id of this.pending.keys()) this.closeRequest(id); }
  async decide(thread:string,turn:string,item:string,id:string,transport:'codex'|'claude',exact?:unknown,kind:'file'|'command'='file'): Promise<NativeDecision> {
    const r=this.request, grant=r.workspaceGrant, key=this.key(thread,turn,item), record=this.items.get(key);
    if (this.pending.has(id)) { this.closeRequest(id); return 'decline'; }
    if (this.closed || !record || !validId(id) || this.used.has(key) || this.requestIds.has(id) || this.used.size >= 256 ||
        !r.projectWork || r.projectReview || r.visibility?.kind === 'private' || !r.onInteraction || r.signal.aborted ||
        !grant?.nativeFileApprovals || grant.mode !== 'project-work' || grant.path !== r.cwd || grant.conversationId !== r.conversationId ||
        !grant.memberIds?.includes(r.member.id) || (transport === 'claude' && digest(exact) !== record.fingerprint)) return 'decline';
    const review = record.review;
    if (kind === 'command' ? !review.nativeCommand : !review.fileChange) return 'decline';
    if (review.nativeCommand && !validNativeCommand(review.nativeCommand,transport)) return 'decline';
    const operation = review.nativeCommand
      ? 'can_use_tool/Bash'
      : transport === 'codex' ? 'item/fileChange/requestApproval' : 'can_use_tool/Write';
    this.requestIds.add(id);
    this.used.add(key);
    this.pending.set(id,key);
    let allowedByUser = false, delivered = false;
    try {
      let version: string;
      try { version = await targetVersion(r,review); }
      catch {
        if (review.fileChange && !r.signal.aborted && this.pending.get(id) === key) {
          await this.reportUnavailable(thread,turn,item,id,operation,review.fileChange.path,true);
        }
        return 'decline';
      }
      if (r.signal.aborted || this.pending.get(id) !== key) return 'closed';
      const response = await r.onInteraction({
        kind:'approval', operation,
        providerRequestId:id, nativeSessionId:thread, nativeTurnId:turn, nativeItemId:item, ...review,
        payload:{grantRevision:grant.revision,requestDigest:record.fingerprint,fileVersion:digest(version)},
      });
      allowedByUser = response.state === 'answered';
      if (r.signal.aborted || this.pending.get(id) !== key) return 'closed';
      if (response.state === 'cancelled' && response.cancelledByUser) return 'cancel';
      if (response.state !== 'answered' || await targetVersion(r,review) !== version ||
          r.signal.aborted || this.pending.get(id) !== key || !r.checkNativePermission?.(id,thread,turn,item)) return 'decline';
      delivered = true;
      return 'accept';
    } catch { return 'decline'; }
    finally {
      if (allowedByUser && !delivered) r.onNativePermissionLost?.(id);
      this.pending.delete(id); this.items.delete(key);
    }
  }
}
