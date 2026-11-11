import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname,join } from 'node:path';
import { mkdirSync,readFileSync,renameSync,writeFileSync } from 'node:fs';
import type { Conversation, WorkspaceGrant } from '../../shared/collaboration.js';
import type { PreviewHttpRequest, PreviewHttpResponse, ProjectServiceRequest, ProjectPreviewState } from '../../shared/project-preview.js';
import { AppError } from '../store.js';
import { discoverableProjectPath, readPreviewAsset } from './project-file-read.js';
import { verifyWorkspace } from './workbench.js';

interface Instance {
  state: ProjectPreviewState;
  grant: WorkspaceGrant;
  controller: AbortController;
  host: string;
  directory: string;
  server?: Server;
  readers: number;
  forward?: (input:PreviewHttpRequest)=>Promise<PreviewHttpResponse>;
  download?: (allow:boolean)=>void;
  task?: Promise<void>;
}

const mime: Record<string,string> = {
  '.html':'text/html; charset=utf-8', '.htm':'text/html; charset=utf-8', '.css':'text/css', '.js':'text/javascript', '.mjs':'text/javascript',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif', '.ico':'image/x-icon',
  '.svg':'image/svg+xml', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf',
};
const wrapperPath = '/.project-preview';
const idle = (): ProjectPreviewState => ({status:'idle',logs:[]});
const live = (instance:Instance) => !instance.controller.signal.aborted;
function log(instance: Instance, message: string) {
  instance.state.logs.push({time:new Date().toISOString(),message});
  if (instance.state.logs.length > 40) instance.state.logs.shift();
}
function stop(instance: Instance, message: string, failed=false) {
  if (!live(instance)) return;
  instance.controller.abort();
  instance.download?.(false);delete instance.state.download;
  instance.server?.closeAllConnections();
  instance.state.status=failed ? 'failed':'stopped';
  delete instance.state.url;
  log(instance,message);
}
function matches(grant:WorkspaceGrant | undefined, saved:WorkspaceGrant) {
  return grant && grant.path===saved.path && grant.device===saved.device && grant.inode===saved.inode &&
    grant.revision===saved.revision && grant.authorizedAt===saved.authorizedAt;
}

export class ProjectPreviews {
  private instances = new Map<string,Instance>();
  private closed = false;
  private readonly sweep: ReturnType<typeof setInterval>;
  constructor(private readonly conversation:(id:string)=>Conversation,
    private readonly runService?:(request:ProjectServiceRequest)=>Promise<void>, private readonly journal?:string) {
    this.sweep=setInterval(()=>{
      for (const [cid,instance] of this.instances) if(live(instance)) this.reconcile(cid);
    }, 3000);
    this.sweep.unref();
  }

  private grant(cid:string) {
    const c=this.conversation(cid);
    if (c.archivedAt || c.deletedAt || !c.workspaceGrant) throw new AppError(409,'请在有效会话中选择并授权项目文件夹。');
    verifyWorkspace(c.workspaceGrant);
    return c.workspaceGrant;
  }
  reconcile(cid:string) {
    const instance=this.instances.get(cid);
    if (!instance || !live(instance)) return;
    try { if(matches(this.grant(cid),instance.grant)) return; } catch { /* grant no longer valid */ }
    stop(instance,'项目授权已变更，预览已停止。');
  }
  private save(cid:string,instance:Instance,settled:boolean) {
    if(!this.journal || !/^[a-z0-9-]{1,80}$/i.test(cid) || this.instances.get(cid)!==instance) return;
    mkdirSync(this.journal,{recursive:true,mode:0o700});
    const file=join(this.journal,cid+'.json'), {id,entry,snapshot,status}=instance.state;
    writeFileSync(file+'.tmp',JSON.stringify({revision:instance.grant.revision,settled,id,entry,snapshot,status}),{mode:0o600});
    renameSync(file+'.tmp',file);
  }
  private previous(cid:string,revision:number|undefined):ProjectPreviewState|undefined {
    if(!this.journal || !/^[a-z0-9-]{1,80}$/i.test(cid)) return;
    try {
      const item=JSON.parse(readFileSync(join(this.journal,cid+'.json'),'utf8'));
      if(revision!==item.revision || typeof item.id!=='string') return;
      return {id:item.id,entry:item.entry,snapshot:item.snapshot,mode:'service',
        status:item.settled && item.status==='stopped'?'stopped':'failed',
        logs:[{time:'',message:item.settled?'上次开发服务已结束。':'平台与原开发服务的连接已中断，旧预览地址已失效。'}]};
    }catch{return;}
  }
  state(cid:string) {
    const c=this.conversation(cid);
    this.reconcile(cid);
    return this.instances.get(cid)?.state ?? this.previous(cid,c.workspaceGrant?.revision) ?? idle();
  }
  close() {
    this.closed=true;
    clearInterval(this.sweep);
    for(const instance of this.instances.values()) stop(instance,'服务已关闭。');
    const tasks=[...this.instances.values()].map(i=>i.task);
    if (!tasks.some(Boolean)) this.instances.clear();
    return Promise.allSettled(tasks).finally(()=>this.instances.clear());
  }
  async endAndWait(cid:string,id:unknown) {
    const state=this.end(cid,id);
    await this.instances.get(cid)?.task;
    return state;
  }
  end(cid:string, id:unknown) {
    const state=this.state(cid);
    if(typeof id!=='string' || state.id!==id) throw new AppError(409,'预览实例已变更，请刷新后重试。');
    const current=this.instances.get(cid);if(current) stop(current,'预览地址已关闭。');
    return state;
  }
  approveDownload(cid:string,id:unknown,lock:unknown) {
    const state=this.state(cid), instance=this.instances.get(cid);
    if(!instance?.download || !state.download || state.id!==id || state.download.lock!==lock)
      throw new AppError(409,'依赖清单或预览实例已经变化。');
    instance.download(true);
    return state;
  }
  async releaseForWriter(cid:string) {
    const instance=this.instances.get(cid);
    if(instance?.state.mode==='service' && instance.task) {
      stop(instance,'正在启动新的项目执行，本次副本预览已关闭。');
      await instance.task;
    }
  }
  start(cid:string, expected:unknown, revision:unknown, mode:'static'|'service'='static', guard?:()=>void) {
    const old=this.state(cid), grant=this.grant(cid);
    if(this.closed || grant.revision!==revision || (old.id ?? null)!==expected) throw new AppError(409,'项目或预览状态已变更，请刷新后重试。');
    if(old.status==='starting' || old.status==='running') {
      if ((old.mode ?? 'static')!==mode) throw new AppError(409,'请先停止当前预览，再切换启动方式。');
      return old;
    }
    if(mode==='service' && (grant.mode!=='project-work' || !this.runService))
      throw new AppError(409,'启动开发服务需要项目工作授权和已登记的 Linux 虚拟机。');
    if(mode==='service' && [...this.instances.entries()].some(([other,i])=>other!==cid && live(i) && i.state.mode==='service'))
      throw new AppError(409,'另一会话正在使用项目虚拟机运行开发服务，请先停止该服务。');
    if([...this.instances.values()].filter(live).length >= 8) throw new AppError(409,'已有 8 个项目预览在运行，请先停止其中一个。');
    if(this.instances.size>=128 && !this.instances.has(cid)) {
      const evict=[...this.instances].find(([,instance])=>!live(instance));
      if(!evict) throw new AppError(409,'预览数量已达上限，请先停止已打开的预览。');
      this.instances.delete(evict[0]);
    }
    const id=randomBytes(18).toString('hex'), host='preview-'+id+'.localhost';
    const instance:Instance={state:{id,status:'starting',logs:[]},grant:structuredClone(grant),controller:new AbortController(),host,directory:'',readers:0};
    this.instances.set(cid,instance);
    if(mode==='service') {
      instance.state.mode='service';instance.state.entry='npm run dev';
      this.save(cid,instance,false);
      instance.task=this.service(cid,instance,guard);
    } else void this.launch(cid,instance);
    return instance.state;
  }

  private async launch(cid:string, instance:Instance) {
    const {grant,host}=instance;
    try {
      for(const directory of ['dist/','build/','','public/']) {
        const entry=directory+'index.html';
        try { await readPreviewAsset(grant,entry,instance.controller.signal); }
        catch { instance.controller.signal.throwIfAborted(); continue; }
        instance.directory=directory; instance.state.entry=entry; break;
      }
      if(!instance.state.entry) throw new AppError(409,'没有找到可预览的 index.html。请先生成静态页面，或选择含有页面的项目。');
      await this.listen(cid,instance);
    } catch(error) {
      if(!live(instance)) return;
      stop(instance,error instanceof AppError ? error.message : '无法启动预览，请重试。',true);
    }
  }

  private async listen(cid:string,instance:Instance) {
    const {host}=instance;
      const server=createServer((req,res)=>void this.serve(cid,instance,req,res));
      instance.server=server;
      server.requestTimeout=10_000;
      server.maxConnections=32;
      await new Promise<void>((resolve,reject)=>{
        server.once('error',reject);
        server.once('close',()=>reject(new Error('预览已关闭。')));
        server.listen({host:'127.0.0.1',port:0,signal:instance.controller.signal},resolve);
      });
      this.reconcile(cid);
      instance.controller.signal.throwIfAborted();
      const address=server.address();
      if(!address || typeof address==='string') throw new Error('无法取得预览监听地址。');
      instance.state.url='http://'+host+':'+address.port+wrapperPath;
      instance.state.status='running';
      log(instance,'已启动预览 · '+instance.state.entry);
  }

  private async service(cid:string,instance:Instance,guard?:()=>void) {
    const signal=instance.controller.signal;
    const verify=()=>{
      signal.throwIfAborted();
      if(this.instances.get(cid)!==instance || !matches(this.grant(cid),instance.grant))
        throw new Error('项目授权已变化。');
      guard?.();
    };
    try {
      await this.runService!({grant:instance.grant,signal,verify,
        snapshot:sha=>{verify();instance.state.snapshot=sha;this.save(cid,instance,false);},
        log:message=>{if(live(instance) && message.trim()) log(instance,message);},
        allowDownload:(lock,packages)=>new Promise(resolve=>{
          verify();instance.state.download={lock,count:packages.length};
          instance.download=allow=>{delete instance.state.download;delete instance.download;resolve(allow);};
        }),
        listening:forward=>{
          verify();instance.forward=forward;
          void this.listen(cid,instance).catch(()=>stop(instance,'无法打开开发服务预览。',true));
        }});
      if(live(instance)) stop(instance,'开发服务已退出。',true);
      log(instance,'虚拟机已结束本次服务进程。');
      this.save(cid,instance,true);
    } catch(e) {
      const message=(e as Error).message;
      if(live(instance)) stop(instance,message,true); else {
        if(message.includes('未确认')) instance.state.status='failed';
        log(instance,message);
      }
      this.save(cid,instance,!message.includes('未确认'));
    }
  }

  private async serve(cid:string, instance:Instance, request:IncomingMessage, response:ServerResponse) {
    const address=instance.server?.address();
    if(!address || typeof address==='string' || request.headers.host!==instance.host+':'+address.port ||
        (!['GET','HEAD'].includes(request.method ?? '') && !(instance.forward && ['POST','OPTIONS'].includes(request.method ?? '')))) { response.writeHead(403).end(); return; }
    this.reconcile(cid);
    if(!live(instance) || this.instances.get(cid)!==instance) {response.writeHead(410).end();return;}
    if(instance.readers>=8) { response.writeHead(503).end(); return; }
    const origin='http://'+request.headers.host;
    const ancestors='http://127.0.0.1:* http://localhost:*';
    response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('X-Content-Type-Options','nosniff');
    response.setHeader('Cache-Control','no-store');
    if(request.url===wrapperPath) {
      // This trusted outer document confines self navigation by the untrusted inner document.
      response.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-src "+origin+"; frame-ancestors "+ancestors);
      response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>项目预览</title><style>html,body,iframe{display:block;width:100%;height:100%;margin:0;border:0}</style><iframe title="项目页面" sandbox="allow-scripts" src="/"></iframe></html>');
      return;
    }
    // Module scripts in the sandboxed inner frame have an opaque origin.
    response.setHeader('Access-Control-Allow-Origin','null');
    response.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src "+origin+" 'unsafe-inline'; style-src "+origin+" 'unsafe-inline'; img-src "+origin+" data:; font-src "+origin+" data:; connect-src "+origin+"; frame-ancestors "+origin+' '+ancestors+"; base-uri 'none'; form-action 'none'; object-src 'none'");
    if(instance.forward && request.method==='POST' && request.headers.origin!=='null' && request.headers.origin!==origin) {
      response.writeHead(403).end();return;
    }
    if(instance.forward && request.method==='OPTIONS') {
      response.setHeader('Access-Control-Allow-Methods','GET, HEAD, POST');
      response.setHeader('Access-Control-Allow-Headers','Content-Type');
      response.writeHead(204).end();return;
    }
    instance.readers++;
    try {
      if(instance.forward) {
        const target=new URL(request.url ?? '/',origin);
        if(target.origin!==origin || target.pathname.length+target.search.length>4096) throw new Error('invalid path');
        const chunks:Buffer[]=[];let size=0;
        for await(const chunk of request) {
          size+=chunk.length;if (size>96*1024) throw new Error('request too large');
          chunks.push(chunk);
        }
        const upstream=await instance.forward({method:request.method as PreviewHttpRequest['method'],
          path:target.pathname+target.search,contentType:request.headers['content-type'] ?? 'text/plain',body:Buffer.concat(chunks).toString('base64')});
        this.reconcile(cid);instance.controller.signal.throwIfAborted();
        const status=Number(upstream.status);
        if(!Number.isInteger(status) || status<200 || status>599) throw new Error('invalid response');
        response.setHeader('Content-Type',upstream.mime);
        response.writeHead(status).end(request.method==='HEAD'?undefined:Buffer.from(upstream.body,'base64'));
        return;
      }
      let path=decodeURIComponent(new URL(request.url ?? '/',origin).pathname).slice(1);
      if(!path || path.endsWith('/')) path+='index.html';
      const type=mime[extname(path).toLowerCase()];
      if(!type || !discoverableProjectPath(path)) throw new Error('unavailable asset');
      const bytes=await readPreviewAsset(instance.grant,instance.directory+path,instance.controller.signal);
      this.reconcile(cid);
      if(!live(instance) || this.instances.get(cid)!==instance) throw new Error('preview ended');
      log(instance,'200 · /'+path);
      response.writeHead(200,{'Content-Type':type}).end(request.method==='HEAD'?undefined:bytes);
    } catch {
      if(!response.destroyed) response.writeHead(404).end();
      if(live(instance)) log(instance,'404 · 预览资源不可用');
    } finally { instance.readers--; }
  }
}
