import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ProjectFileExport } from '../../shared/collaboration.js';
import { AppError, now } from '../store.js';
import { digest } from './continuity.js';
import { folderStamp, sourceStamp, writeExport, type FileStamp, type FolderStamp } from './project-export-files.js';
import { safeProjectPath } from './project-file-read.js';
import type { CollaborationStore } from './store.js';
import { projectPrivateRoots } from './workbench.js';

interface StoredExport extends ProjectFileExport {
  callId:string; fence:string; source:FileStamp; destination?:FolderStamp;
}
const table='cc_project_exports';
const pending=(e:StoredExport)=>e.state==='pending' || e.state==='ready';
const conflict=(message:string):never=>{throw new AppError(409,message);};
function publicExport(e:StoredExport):ProjectFileExport {
  const {callId,fence,source,destination,...record}=e;
  return record;
}
function safeSource(path:unknown) {
  if (!safeProjectPath(path)) throw new AppError(400,'请选择项目中的普通文稿。');
  const name=basename(path);
  if (!/^[\p{L}\p{N}][\p{L}\p{M}\p{N} _()-]{0,119}\.(?:csv|tsv|txt|md)$/iu.test(name) ||
      /^(?:agents|claude|gemini|skill|instructions|readme\.instructions|cmakelists|requirements(?:[-_ ].*)?|constraints(?:[-_ ].*)?|pip[-_ ].*)\./i.test(name))
    throw new AppError(400,'请选择普通 .csv、.tsv、.txt 或 .md 文稿。导出文件名须为单一扩展名，且不能是配置或指令文件。');
  return path;
}
function inside(parent:string,path:string) {
  const rel=relative(parent,path);
  return rel==='' || (rel!=='..' && !rel.startsWith('..'+sep) && !isAbsolute(rel));
}
export class ProjectExports {
  constructor(private readonly store:CollaborationStore) {}
  private get data(){return this.store.artifacts;}
  private get port(){return this.data.port;}
  private rows(cid?:string){return this.data.rows<StoredExport>(table,cid);}
  list(cid:string){return this.rows(cid).map(publicExport);}
  private get(cid:string,id:string){
    const e=this.data.get<StoredExport>(table,id);
    if(e.conversationId!==cid) throw new AppError(404,'找不到此会话的导出请求。');
    return e;
  }
  private save(e:StoredExport){
    e.revision++;
    e.payloadDigest=digest([e.id,e.revision,e.fence,e.path,e.source,e.destination??null,e.expiresAt]);
    this.data.save(table,e,'project.export_changed');
  }
  private authority(id:string) {
    const i=this.store.invocation(id), contract=this.store.contract(id), grant=contract.workspaceGrant;
    if(!contract.mayExportProjectFile || !contract.projectWork || contract.visibility || !grant || contract.toolPolicyVersion!=='cross-action-v1')
      throw new AppError(403,'此执行没有项目文件导出能力。');
    this.store.visibility.assertTool(id,'project_export_request');
    const origin=this.data.origin(i.conversationId,id);
    this.store.projectReviews.requireGrant(i.conversationId,i.memberId,grant.revision,grant);
    return {grant,fence:digest([origin,contract.id,contract.primarySourceId,grant,i.nativeSessionId??null,i.nativeTurnId??null])};
  }
  private invalidate(e:StoredExport){
    if (!pending(e)) return;
    if (Date.parse(e.expiresAt)<=Date.now()) {
      e.state='expired';e.reason='本次授权请求已过期。';
    } else {
      try { if(this.authority(e.invocationId).fence===e.fence) return; } catch { /* scope or exact caller is gone */ }
      e.state='cancelled';e.reason='原执行、输入或项目授权发生变化。';
    }
    this.save(e);
  }
  recover(){
    this.port.tx(()=>{
      for(const e of this.rows()){
        if(e.state==='writing'){e.state='unknown';e.reason='服务在写入完成回执前中断，请核对目标文件。';this.save(e);}
        else this.invalidate(e);
      }
    });
  }
  request(id:string,args:Record<string,unknown>,callId:string) {
    if(Object.keys(args).length!==1 || typeof callId!=='string' || !callId || callId.length>500) throw new AppError(400,'需要当前工具调用和一个项目相对路径。');
    const path=safeSource(args.path);
    return this.port.tx(()=>{
      const {grant,fence}=this.authority(id), i=this.store.invocation(id);
      const same=this.rows(i.conversationId).filter(e=>e.invocationId===id);
      const existing=same.find(e=>e.callId===callId);
      if(existing){
        if(existing.path!==path || existing.fence!==fence) conflict('工具调用标识已绑定另一份导出请求。');
        return publicExport(existing);
      }
      if(same.length>=8 || same.some(pending)) conflict('请先处理正在等待的导出请求，每次执行最多申请 8 次。');
      const source=sourceStamp(grant,path);
      const e:StoredExport={id:randomUUID(),conversationId:i.conversationId,invocationId:id,memberId:i.memberId,
        callId,fence,path,fileName:basename(path),source,bytes:source.bytes,sha256:source.sha256,state:'pending',
        createdAt:now(),expiresAt:new Date(Date.now()+120000).toISOString(),revision:0,payloadDigest:''};
      this.save(e);return publicExport(e);
    });
  }
  async tool(id:string,args:Record<string,unknown>,callId:string,signal:AbortSignal){
    signal.throwIfAborted();
    const r=this.request(id,args,callId);
    for(;;){
      const e=this.get(r.conversationId,r.id);
      if (pending(e)) this.port.tx(()=>{
        if(signal.aborted){e.state='cancelled';e.reason='原执行已停止。';this.save(e);}
        else this.invalidate(e);
      });
      if(!pending(e) && e.state!=='writing')return {id:e.id,state:e.state,fileName:e.fileName,...(e.reason?{reason:e.reason}:{}),
        ...(e.state==='written'?{executor:'platform',sha256:e.sha256,bytes:e.bytes}:{})};
      await new Promise<void>(done=>setTimeout(done,200));
    }
  }
  checkPick(cid:string,id:string,revision:number) {
    const e=this.get(cid,id);
    this.port.tx(()=>this.invalidate(e));
    if(!pending(e) || e.revision!==revision) conflict('导出申请已经变化，请刷新后核对。');
    return e;
  }
  private destination(path:string,project:string,name:string){
    if(!isAbsolute(path) || path.split(sep).some(p=>p.startsWith('.'))) throw new AppError(403,'请选择普通的项目外文件夹。');
    let actual:string;
    try{actual=realpathSync(path);}catch{throw new AppError(409,'选择的文件夹已无法访问。');}
    // macOS presents /tmp and /var aliases through its native picker.
    const expected=process.platform==='darwin'?path.replace(/^\/(tmp|var)(?=\/|$)/,'/private/$1'):path;
    if(resolve(expected)!==actual) throw new AppError(403,'请选择实际文件夹，不能使用符号链接。');
    const dbRoots=(this.store.db.prepare('PRAGMA database_list').all() as {file:string}[]).filter(r=>r.file).map(r=>dirname(resolve(r.file)));
    const blocked=[project,...projectPrivateRoots(),...dbRoots,resolve(this.store.options.artifactDir??'.local-data/collaboration-artifacts'),
      join(homedir(),'Library'),'/Applications','/System','/Library','/usr','/etc','/opt','/bin','/sbin','/dev','/proc','/sys','/boot','/run','/private/etc'];
    if(actual===sep || actual===homedir() || actual.split(sep).some(p=>p.startsWith('.') || /^(?:node_modules|__pycache__)$|\.(?:app|bundle|framework)$/i.test(p)) ||
      blocked.some(p=>{try{return inside(realpathSync(p),actual);}catch{return inside(resolve(p),actual);}}) ||
      (inside('/private/var',actual) && !inside(realpathSync(tmpdir()),actual)) || (inside('/var',actual) && !inside(realpathSync(tmpdir()),actual)))
      throw new AppError(403,'请选择项目外的普通文件夹，避开应用、配置和私有目录。');
    return folderStamp(actual,name);
  }
  pick(cid:string,id:string,revision:number,path:string){
    const e=this.checkPick(cid,id,revision);
    const {grant}=this.authority(e.invocationId);
    const folder=this.destination(path,grant.path,e.fileName);
    if(digest(sourceStamp(grant,e.path))!==digest(e.source))conflict('源文件已变化，请成员重新申请导出。');
    this.port.tx(()=>{
      e.destination=folder;e.targetPath=join(folder.path,e.fileName);e.state='ready';this.save(e);
    });
    return publicExport(e);
  }
  decide(cid:string,id:string,input:{requestId:string;expectedRevision:number;payloadDigest:string;decision:'allow'|'decline'}){
    const record=this.get(cid,id);
    this.port.tx(()=>this.invalidate(record));
    const choice=this.port.tx(()=>this.port.command('project-export-decision:'+input.requestId,{cid,id,...input},()=>{
      const e=this.get(cid,id);
      if(!pending(e) || input.expectedRevision!==e.revision || input.payloadDigest!==e.payloadDigest)conflict('申请已过期、已处理或目标发生变化，请刷新后核对。');
      if(input.decision==='decline'){e.state='declined';e.reason='用户已拒绝导出。';}
      else {
        if(input.decision!=='allow' || e.state!=='ready' || !e.destination)conflict('请先选择并核对目标文件夹。');
        e.state='writing';
      }
      this.save(e);return e.id;
    }));
    // Persist the consumed decision before touching disk. A replay or process restart may only inspect it.
    if(!choice.replayed && input.decision==='allow'){
      this.port.tx(()=>{
        const e=this.get(cid,id), dest=e.destination!;
        if(e.state!=='writing') return;
        try{
          const {grant,fence}=this.authority(e.invocationId);
          if(fence!==e.fence || Date.parse(e.expiresAt)<=Date.now()) throw new Error();
          const receipt=writeExport(grant,e.path,e.fileName,e.source,dest,e.expiresAt);
          e.state=receipt.state;e.reason=receipt.reason;
        }catch{e.state='failed';e.reason='原项目授权或执行已发生变化。';}
        this.save(e);
      });
    }
    return {export:publicExport(this.get(cid,id)),replayed:choice.replayed};
  }
}
