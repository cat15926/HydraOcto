import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { WorkspaceGrant } from '../../shared/collaboration.js';
import { AppError } from '../store.js';
import { verifyWorkspace } from './workbench.js';

const exec = promisify(execFile);
export function safeProjectPath(value:unknown): value is string {
  return typeof value==='string' && value.length>0 && value.length<=512 &&
    Buffer.from(value).toString('utf8') === value && !/[\\:\x00-\x1f\x7f]/.test(value) && value.split('/').every(component=>component && !component.startsWith('.'));
}

export function discoverableProjectPath(path:unknown): path is string {
  return safeProjectPath(path) && path.split('/').every(part => !['node_modules','__pycache__'].includes(part.toLowerCase()));
}

// Reopen the named directory after enumeration so a concurrent move cannot publish
// entries from a directory which no longer belongs to this grant.
const listScript = `import json,os,stat,sys
root,dev,ino,path,after=sys.argv[1:]
flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
base=os.open(root,flags)
def identity(s): return (s.st_dev,s.st_ino)
if identity(os.fstat(base))!=(int(dev),int(ino)): raise SystemExit(2)
def opened():
 fd=os.dup(base)
 try:
  for part in path.split('/') if path else ():
   child=os.open(part,flags,dir_fd=fd)
   os.close(fd)
   fd=child
   if os.fstat(fd).st_dev!=int(dev): raise ValueError('mount')
  return fd
 except BaseException:
  os.close(fd)
  raise
fd=opened()
before=os.fstat(fd)
entries=[]
with os.scandir(fd) as scan:
 for index,entry in enumerate(scan):
  if index>=20000: raise SystemExit(3)
  name=entry.name
  if name<=after or name.startswith('.') or name.lower() in ('node_modules','__pycache__'): continue
  if any(ord(c)<32 or ord(c)==127 or c in ('\\\\',':') for c in name): continue
  try: relative=(path+'/'+name if path else name).encode('utf-16-le')
  except UnicodeError: continue
  if len(relative)>1024: continue
  info=entry.stat(follow_symlinks=False)
  if info.st_dev!=int(dev): continue
  if stat.S_ISDIR(info.st_mode): kind='directory'
  elif stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_size<=131072: kind='file'
  else: continue
  entries.append((name,kind))
again=os.fstat(opened())
if identity(before)!=identity(again) or before.st_mtime_ns!=again.st_mtime_ns: raise SystemExit(2)
entries.sort()
page=entries[:64]
print(json.dumps(dict(path=path,entries=[dict(name=n,kind=k) for n,k in page],**(dict(nextAfter=page[-1][0]) if len(entries)>64 else {}))))`;

export async function listProjectDirectory(grant:WorkspaceGrant,path:string,after:string,signal:AbortSignal) {
  if ((path && !discoverableProjectPath(path)) || (after && (!safeProjectPath(after) || after.includes('/')))) {
    throw new AppError(400,'请选择项目内的普通目录。');
  }
  try {
    const {stdout}=await exec('/usr/bin/python3',['-I','-c',listScript,grant.path,String(grant.device),String(grant.inode),path,after],
      {cwd:'/',env:{PATH:'/usr/bin:/bin'},timeout:10000,maxBuffer:256*1024,signal});
    verifyWorkspace(grant);
    return JSON.parse(stdout) as {path:string;entries:{name:string;kind:'file'|'directory'}[];nextAfter?:string};
  } catch {
    signal.throwIfAborted();
    throw new AppError(409,'目录无法列出。请核对项目授权、目录是否有变化，以及此目录是否超过 20,000 项。');
  }
}

// Open each component relative to its directory handle. In digest mode only the hash
// and byte count leave this helper. Never read devices or a file modified while open.
const readScript = `import os,stat,sys,hashlib
root,dev,ino,path,mode=sys.argv[1:]
directory=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
rootfd=os.open(root,directory)
base=os.fstat(rootfd)
if (base.st_dev,base.st_ino)!=(int(dev),int(ino)): raise SystemExit(2)
parts=path.split('/')
def open_file():
 fd=os.dup(rootfd)
 try:
  for p in parts[:-1]:
   child=os.open(p,directory,dir_fd=fd)
   os.close(fd)
   fd=child
   if os.fstat(fd).st_dev!=base.st_dev: raise SystemExit(2)
  return os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
 finally:
  os.close(fd)
def identity(s): return (s.st_dev,s.st_ino,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
limit=131072 if mode=='text' else 16777216
with os.fdopen(open_file(),'rb') as stream:
 before=os.fstat(stream.fileno())
 if not stat.S_ISREG(before.st_mode) or before.st_dev!=base.st_dev or before.st_nlink!=1 or before.st_size>limit: raise SystemExit(2)
 data=stream.read(before.st_size+1)
 if len(data)!=before.st_size or identity(os.fstat(stream.fileno()))!=identity(before): raise SystemExit(2)
again=open_file()
if identity(os.fstat(again))!=identity(before): raise SystemExit(2)
os.close(again)
if mode=='asset':
 sys.stdout.buffer.write(data)
elif mode=='text':
 data.decode('utf-8','strict')
 if b'\\0' in data: raise SystemExit(2)
 sys.stdout.buffer.write(data)
else:
 print(str(len(data))+' '+hashlib.sha256(data).hexdigest())`;

async function inspectFile(grant:WorkspaceGrant,path:string,mode:'text'|'digest'|'asset',signal?:AbortSignal) {
  if (!safeProjectPath(path)) throw new AppError(400,'请选择项目中的普通文件。');
  let data:Buffer;
  try {
    const result = await exec('/usr/bin/python3',['-I','-c',readScript,grant.path,String(grant.device),String(grant.inode),path,mode],
      {cwd:'/',env:{PATH:'/usr/bin:/bin'},encoding:'buffer',timeout:10000,maxBuffer:mode==='asset' ? 16*1024*1024 : 132000,signal});
    data=result.stdout;
  } catch {
    signal?.throwIfAborted();
    throw new AppError(409,mode==='text'?'无法读取所列文件。请核对目录授权、文件状态及大小；评审支持 128 KiB 以内的独立文本文件。':'无法核对该文件。请选择 16 MiB 以内的独立普通文件。');
  }
  verifyWorkspace(grant);
  return data;
}
export async function readProjectText(grant:WorkspaceGrant,path:string,signal?:AbortSignal) {
  const data=await inspectFile(grant,path,'text',signal);
  return {text:data.toString('utf8'),bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};
}
export async function projectFileDigest(grant:WorkspaceGrant,path:string,signal?:AbortSignal) {
  const data=await inspectFile(grant,path,'digest',signal);
  const match=/^(\d+) ([a-f0-9]{64})$/.exec(data.toString().trim());
  if (!match) throw new AppError(409,'文件摘要不可用，请重新核对。');
  return {bytes:Number(match[1]),sha256:match[2]!};
}

export function readPreviewAsset(grant:WorkspaceGrant, path:string, signal:AbortSignal) {
  if (!discoverableProjectPath(path)) throw new AppError(404,'预览文件不存在。');
  return inspectFile(grant,path,'asset',signal);
}
