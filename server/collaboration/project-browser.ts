import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { chromiumPath } from './project-browser-path.js';
import puppeteer, { type Frame, type Page, type ElementHandle, type HTTPRequest } from 'puppeteer-core';
import type { ProjectPreviews } from './project-preview.js';
import type { CollaborationStore } from './store.js';
import { AppError } from '../store.js';

type Step={action:'inspect'|'fill'|'click'|'reload'|'expect';target?:string;value?:string};
const normalize=(s:string)=>s.trim().replace(/\s+/g,' ');
function stepsFor(input:Record<string,unknown>):Step[] {
  if(Object.keys(input).some(k=>k!=='steps') || !Array.isArray(input.steps) || !input.steps.length || input.steps.length>12)
    throw new AppError(400,'每次页面验收需要 1–12 个操作。');
  return input.steps.map((s:Step)=>{
    if(!s || !['inspect','fill','click','reload','expect'].includes(s.action)) throw new AppError(400,'不支持的页面操作。');
    const keys=s.action==='fill'?['action','target','value']:['click','expect'].includes(s.action)?['action','target']:['action'];
    if(Object.keys(s).some(k=>!['action','target','value'].includes(k)) || keys.some(k=>typeof s[k as keyof Step]!=='string') ||
        (s.target!==undefined && (typeof s.target!=='string' || s.target.length>160)) || (keys.includes('target') && !s.target?.trim()) ||
        (s.value!==undefined && (typeof s.value!=='string' || s.value.length>256)))
      throw new AppError(400,'请提供页面可见的控件名称或期望文字。');
    return {action:s.action,...(keys.includes('target')&&{target:s.target!.trim()}),...(s.action==='fill'&&{value:s.value!})};
  });
}
export const projectBrowserTool={name:'project_browser_check',
  description:'Operate the active preview of this conversation in a fresh browser. Use inspect for visible page text and named controls, then fill/click by exact label, reload and expect visible text. Put dependent actions in one call. Use observed page facts in the reply. Screenshots are recorded by the platform.',
  inputSchema:{type:'object',properties:{steps:{type:'array',minItems:1,maxItems:12,items:{type:'object',
    properties:{action:{type:'string',enum:['inspect','click','fill','reload','expect']},target:{type:'string',description:'Visible control label for fill/click, expected visible text for expect. Omit for inspect/reload.'},value:{type:'string',description:'Text for fill only.'}},required:['action'],additionalProperties:false}}},
    required:['steps'],additionalProperties:false}};

async function currentPage(page:Page,origin:string):Promise<Frame> {
  return page.waitForFrame(f=>f.parentFrame()===page.mainFrame() && new URL(f.url()||'about:blank').origin===origin,{timeout:6500});
}
async function view(frame:Frame) {
  return frame.evaluate(()=>{
    const controls=[...document.querySelectorAll<HTMLElement>('button,input,textarea,select,[role="button"]')].filter(e=>e.getClientRects().length>0 && getComputedStyle(e).visibility!=='hidden').map(e=>{
      const input=e as HTMLInputElement;
      return (e.getAttribute('aria-label') || input.labels?.[0]?.innerText || input.placeholder || e.innerText || '').trim().slice(0,100);
    }).filter(Boolean).slice(0,35);
    return {text:document.body.innerText.slice(0,4800),controls};
  });
}

async function perform(page:Page,origin:string,step:Step) {
  if(step.action==='reload') {await page.reload({waitUntil:'domcontentloaded'});await currentPage(page,origin);return;}
  const frame=await currentPage(page,origin);
  if(step.action==='inspect') return;
  const name=normalize(step.target!);
  if(step.action==='expect') {
    await frame.waitForFunction(s=>document.body.innerText.replace(/\s+/g,' ').includes(s),{timeout:6500},name)
      .catch(()=>{throw new Error('页面未显示期望的文字「'+name+'」。');});
    return;
  }
  const element=await frame.evaluateHandle((action,needle)=>{
    const selector=action==='fill'?'input:not([type]),input[type=text],input[type=search],input[type=email],textarea':'button,[role=button],input[type=submit],input[type=button],input[type=checkbox]';
    const matches=[...document.querySelectorAll<HTMLElement>(selector)].filter(e=>{
      const input=e as HTMLInputElement;
      const label=e.getAttribute('aria-label')||input.labels?.[0]?.innerText||input.placeholder||e.innerText||input.value||'';
      return !input.disabled && !!e.getClientRects().length && label.trim().replace(/\s+/g,' ')===needle;
    });
    return matches.length===1?matches[0]:null;
  },step.action,name);
  try {
    const handle=element.asElement() as ElementHandle<HTMLElement>|null;
    if(!handle) throw new Error('没有找到唯一可操作的「'+name+'」。');
    if(step.action==='fill') await handle.asLocator().setTimeout(5000).fill(step.value!);
    else await handle.click();
  } finally {await element.dispose().catch(()=>{});}
  await page.waitForNetworkIdle({idleTime:200,timeout:2000}).catch(()=>{});
}

// Chrome never connects to arbitrary destinations. Relay only HTTP requests to the
// currently authorized listener. Redirects and subframes are checked again on each request.
async function relay(req:HTTPRequest,origin:URL,verify:()=>void,signal:AbortSignal) {
  try {
    verify();const url=new URL(req.url());
    if(url.origin!==origin.origin || !['GET','HEAD','POST','OPTIONS'].includes(req.method()) || url.username || url.password) throw Error();
    const body=req.postData()||'';
    if(Buffer.byteLength(body)>96*1024) throw Error();
    const received=await new Promise<{status:number;headers:Record<string,string>;body:Buffer}>((resolve,reject)=>{
      const upstream=httpRequest({hostname:'127.0.0.1',port:origin.port,path:url.pathname+url.search,method:req.method(),
        headers:{host:origin.host,origin:'null','content-type':req.headers()['content-type'] || 'text/plain'},
        agent:false,signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])},res=>{
        const chunks:Buffer[]=[];let size=0;
        res.on('data',(b:Buffer)=>{size+=b.length;if(size>2*1024*1024) res.destroy(new Error('页面资源过大'));else chunks.push(b);});
        res.on('error',reject);res.on('end',()=>{
          const headers:Record<string,string>={};
          for(const [k,v] of Object.entries(res.headers)) if(typeof v==='string' && !['connection','transfer-encoding','content-length'].includes(k)) headers[k]=v;
          resolve({status:res.statusCode ?? 502,headers,body:Buffer.concat(chunks)});
        });
      });
      upstream.once('error',reject);upstream.end(body);
    });
    verify();await req.respond(received);
  } catch {await req.abort().catch(()=>{});}
}

export class ProjectBrowser {
  private active=new Set<string>();
  constructor(private store:CollaborationStore,private previews:ProjectPreviews,private directory:string) {}
  async check(id:string,args:Record<string,unknown>,callId:string,signal:AbortSignal) {
    const grant=this.store.requireProjectCapability(id,'projectBrowser');
    const run=this.store.invocation(id),cid=run.conversationId;
    const steps=stepsFor(args),old=this.store.projectToolEvents(id,'project_browser').findLast(e=>e.callId===callId);
    const state=this.previews.state(cid);
    if(state.status!=='running' || !state.url || !state.id) throw new AppError(409,'请先在本会话打开项目预览或启动开发服务。');
    const signature=createHash('sha256').update(JSON.stringify(steps)).digest('hex');
    if(old) {
      if(old.signature!==signature || old.previewId!==state.id || old.grantRevision!==grant.revision || !old.result)
        throw new AppError(409,'原页面操作已失效，请重新验收当前预览。');
      return old.result;
    }
    const origin=new URL(state.url);
    const timeout=AbortSignal.any([signal,AbortSignal.timeout(75000)]);
    const verify=()=>{
      timeout.throwIfAborted();this.store.requireProjectCapability(id,'projectBrowser');
      const current=this.previews.state(cid);
      if(current.id!==state.id || current.status!=='running' || current.url!==state.url) throw new AppError(409,'原项目预览已停止或切换。');
    };
    const evidenceId=randomUUID(),folder=join(this.directory,evidenceId),trace:string[]=[];
    const record=(stateName:string,result?:unknown)=>this.store.recordEvidence(id,{kind:'tool',detail:{origin:'project_browser',callId,
      signature,evidenceId,previewId:state.id,grantRevision:grant.revision,state:stateName,...(result===undefined?{}:{result})}});
    const executablePath=await chromiumPath();verify();
    if(this.active.has(cid) || this.active.size>=3) throw new AppError(409,'浏览器正在验收页面，请稍后重试。');
    this.active.add(cid);
    let browser, timer:NodeJS.Timeout|undefined;
    try {
      record('started');
      browser=await puppeteer.launch({executablePath,headless:true,pipe:true,timeout:12000,handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false,
        env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'},args:['--no-first-run','--disable-extensions','--disable-background-networking','--disable-sync',
          '--proxy-server=http://127.0.0.1:9','--proxy-bypass-list=<-loopback>','--force-webrtc-ip-handling-policy=disable_non_proxied_udp']});
      const session=browser;
      timer=setInterval(()=>{try{verify();}catch{void session.close().catch(()=>{});}},250);
      const page=await browser.newPage();
      await page.setViewport({width:1000,height:760});
      await page.setBypassServiceWorker(true);await page.setRequestInterception(true);
      page.on('request',r=>{void relay(r,origin,verify,timeout);});
      page.on('dialog',d=>{void d.dismiss().catch(()=>{});});
      await page.goto(state.url,{waitUntil:'networkidle2',timeout:12000});
      await currentPage(page,origin.origin);verify();
      await mkdir(folder,{recursive:true,mode:0o700});
      await page.screenshot({path:join(folder,'before.png')});
      let error:string|undefined;
      for(const step of steps) {
        verify();
        try {await perform(page,origin.origin,step);trace.push(step.action+(step.target?' · '+step.target:''));}
        catch(e) {error=(e as Error).message.slice(0,240);break;}
      }
      verify();const observed=await view(await currentPage(page,origin.origin));
      await page.screenshot({path:join(folder,'after.png')});verify();
      const result={passed:!error,asserted:!error && steps.some(s=>s.action==='expect'),trace,...observed,...(error && {error}),evidenceId};
      record(error?'failed':'completed',result);return result;
    } catch(e) {
      await rm(folder,{recursive:true,force:true});
      record('failed',{passed:false,error:timeout.aborted?'页面操作已取消。':(e as Error).message.slice(0,240)});
      throw e;
    } finally {
      clearInterval(timer);try{await browser?.close();}finally{this.active.delete(cid);}
    }
  }
  async image(invocationId:string,evidenceId:string,when:'before'|'after') {
    if(!/^[a-f0-9-]{36}$/.test(evidenceId)) throw new AppError(404,'截图不存在。');
    const run=this.store.invocation(invocationId);
    const row=this.store.projectToolEvents(invocationId,'project_browser').find(e=>e.evidenceId===evidenceId && ['completed','failed'].includes(String(e.state)));
    if(!row) throw new AppError(404,'找不到本次验收截图。');
    this.store.visibility.validateInvocation(invocationId);
    this.store.projectReviews.requireGrant(run.conversationId,run.memberId,Number(row.grantRevision),this.store.contract(invocationId).workspaceGrant);
    return readFile(join(this.directory,evidenceId,when+'.png')).catch(()=>{throw new AppError(404,'未生成此截图。');});
  }
}
