import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname } from 'node:path';
import type { Conversation, WorkspaceGrant } from '../../shared/collaboration.js';
import type { ProjectPreviewState } from '../../shared/project-preview.js';
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
  constructor(private readonly conversation:(id:string)=>Conversation) {
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
  state(cid:string) {
    this.conversation(cid);
    this.reconcile(cid);
    return this.instances.get(cid)?.state ?? idle();
  }
  close() {
    this.closed=true;
    clearInterval(this.sweep);
    for(const instance of this.instances.values()) stop(instance,'服务已关闭。');
    this.instances.clear();
  }
  end(cid:string, id:unknown) {
    const state=this.state(cid);
    if(typeof id!=='string' || state.id!==id) throw new AppError(409,'预览实例已变更，请刷新后重试。');
    stop(this.instances.get(cid)!,'已停止预览并关闭监听端口。');
    return state;
  }
  start(cid:string, expected:unknown, revision:unknown) {
    const old=this.state(cid), grant=this.grant(cid);
    if(this.closed || grant.revision!==revision || (old.id ?? null)!==expected) throw new AppError(409,'项目或预览状态已变更，请刷新后重试。');
    if(old.status==='starting' || old.status==='running') return old;
    if([...this.instances.values()].filter(live).length >= 8) throw new AppError(409,'已有 8 个项目预览在运行，请先停止其中一个。');
    if(this.instances.size>=128 && !this.instances.has(cid)) {
      const evict=[...this.instances].find(([,instance])=>!live(instance));
      if(!evict) throw new AppError(409,'预览数量已达上限，请先停止已打开的预览。');
      this.instances.delete(evict[0]);
    }
    const id=randomBytes(18).toString('hex'), host='preview-'+id+'.localhost';
    const instance:Instance={state:{id,status:'starting',logs:[]},grant,controller:new AbortController(),host,directory:'',readers:0};
    this.instances.set(cid,instance);
    void this.launch(cid,instance);
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
    } catch(error) {
      if(!live(instance)) return;
      stop(instance,error instanceof AppError ? error.message : '无法启动预览，请重试。',true);
    }
  }

  private async serve(cid:string, instance:Instance, request:IncomingMessage, response:ServerResponse) {
    const address=instance.server?.address();
    if(!address || typeof address==='string' || request.headers.host!==instance.host+':'+address.port ||
        (request.method!=='GET' && request.method!=='HEAD')) { response.writeHead(403).end(); return; }
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
    instance.readers++;
    try {
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
