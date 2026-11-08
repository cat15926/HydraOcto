// A bounded host-side copy. Do not pass either directory or any extra permission to the project CLI.
import { spawnSync } from 'node:child_process';
import type { WorkspaceGrant } from '../../shared/collaboration.js';
import { AppError } from '../store.js';

export interface FileStamp { dev:string; ino:string; sha256:string; bytes:number }
export interface FolderStamp { path:string; dev:string; ino:string }
export interface ExportReceipt { state:'written'|'failed'|'unknown'; reason?:string }
const helper = String.raw`import hashlib,json,os,stat,sys,time
q=json.load(sys.stdin)
flags=os.O_RDONLY|os.O_NOFOLLOW|os.O_DIRECTORY
def check(ok):
 if not ok: raise ValueError()
def root(path):
 check(os.path.isabs(path))
 fd=os.open('/',flags)
 for part in path.split('/'):
  if not part: continue
  check(part not in ('.','..'))
  new=os.open(part,flags,dir_fd=fd)
  os.close(fd)
  fd=new
 return fd
def ident(fd):
 s=os.fstat(fd)
 return (str(s.st_dev),str(s.st_ino))
def still_bound(path,fd):
 new=root(path)
 try: check(ident(new)==ident(fd))
 finally: os.close(new)
def source():
 g=q['grant']
 base=root(g['path'])
 check(ident(base)==(str(g['device']),str(g['inode'])))
 parent=os.dup(base)
 parts=q['path'].split('/')
 for part in parts[:-1]:
  child=os.open(part,flags,dir_fd=parent);os.close(parent);parent=child
  check(os.fstat(parent).st_dev==os.fstat(base).st_dev)
 file=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
 def stamp(st):
  return (st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns,st.st_nlink)
 st=os.fstat(file)
 check(stat.S_ISREG(st.st_mode) and st.st_nlink==1 and st.st_size<=131072 and st.st_dev==os.fstat(base).st_dev)
 with os.fdopen(file,'rb') as f:
  data=f.read(131073)
  check(len(data)==st.st_size and stamp(os.fstat(f.fileno()))==stamp(st))
 data.decode('utf8','strict')
 check(b'\0' not in data)
 # Re-open the full parent chain, including the selected root, to check final binding.
 current=root(os.path.join(g['path'],*parts[:-1]))
 check(ident(current)==ident(parent) and stamp(os.stat(parts[-1],dir_fd=current,follow_symlinks=False))==stamp(st))
 still_bound(g['path'],base)
 return data,dict(dev=str(st.st_dev),ino=str(st.st_ino),bytes=len(data),sha256=hashlib.sha256(data).hexdigest())
def dest():
 p=q['folder']
 d=root(p)
 check(os.fstat(d).st_uid==os.getuid())
 try: os.stat(q['name'],dir_fd=d,follow_symlinks=False)
 except FileNotFoundError: pass
 else: raise FileExistsError()
 still_bound(p,d)
 return d,dict(path=p,dev=ident(d)[0],ino=ident(d)[1])
created=False
try:
 if q['op']=='source': out=source()[1]
 elif q['op']=='pick': out=dest()[1]
 else:
  data,stamp=source()
  check(stamp==q['expectedSource'])
  d,folder=dest()
  check(folder==q['expectedFolder'])
  check(time.time()<q['expiresAt']/1000)
  fd=os.open(q['name'],os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=d)
  created=True
  with os.fdopen(fd,'w+b') as f:
   f.write(data);f.flush();os.fsync(f.fileno());f.seek(0)
   check(f.read(131073)==data)
   s=os.fstat(f.fileno())
   name=os.stat(q['name'],dir_fd=d,follow_symlinks=False)
   check((s.st_dev,s.st_ino)==(name.st_dev,name.st_ino) and s.st_nlink==1)
  os.fsync(d)
  still_bound(q['folder'],d)
  out={'state':'written'}
except (OSError,ValueError):
 if q['op']!='write': sys.exit(2)
 out={'state':'unknown' if created else 'failed'}
print(json.dumps(out))
`;
function call<T>(input:Record<string,unknown>):T {
  const result=spawnSync('/usr/bin/python3',['-I','-c',helper],{cwd:'/',env:{PATH:'/usr/bin:/bin'},encoding:'utf8',
    input:JSON.stringify(input),timeout:5000,maxBuffer:8192});
  if (result.error || result.status!==0) throw new AppError(409,'文件、目录或权限已变化，或目标文件已存在。请核对后再选择。');
  return JSON.parse(result.stdout) as T;
}
export function sourceStamp(grant:WorkspaceGrant,path:string) {
  return call<FileStamp>({op:'source',grant,path});
}
export function folderStamp(folder:string,name:string) {
  return call<FolderStamp>({op:'pick',folder,name});
}
export function writeExport(grant:WorkspaceGrant,path:string,name:string,stamp:FileStamp,folder:FolderStamp,expiresAt:string):ExportReceipt {
  try {
    const result=call<ExportReceipt>({op:'write',grant,path,name,expectedSource:stamp,expectedFolder:folder,folder:folder.path,expiresAt:Date.parse(expiresAt)});
    if (result.state==='written') return result;
    if (result.state==='failed') return {state:'failed',reason:'源文件、目标或授权时限已变化，未创建目标文件。'};
  } catch { /* Losing the helper after exclusive creation cannot prove that no bytes reached disk. */ }
  return {state:'unknown',reason:'缺少完整的写入回执，请先核对目标文件。'};
}
