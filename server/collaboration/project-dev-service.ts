import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { PreviewHttpResponse, ProjectServiceRequest } from '../../shared/project-preview.js';
import { acquireProjectVm } from './project-vm-mount.js';
import type { ProjectVm } from './project-vm.js';

function program() {
  const asset=(name:string)=>readFileSync(new URL('../../scripts/runtime/'+name,import.meta.url),'utf8');
  return 'DEV_SERVICE_PROGRAM='+JSON.stringify(asset('project-dev-service.py'))+'\n'+asset('project-npm.py')+'\n'+asset('project-review-test.py');
}

export async function runProjectService(vm:ProjectVm, roots:string[], hasWriter:()=>boolean, request:ProjectServiceRequest) {
  const {signal,grant}=request;
  const deadline=Date.now()+240_000;
  const check=()=>{signal.throwIfAborted();request.verify();};
  let lease;
  while (!lease) {
    check();
    if (!hasWriter()) {
      try { lease=await acquireProjectVm(vm,grant,signal,roots); }
      catch(e) {
        if (!(e instanceof Error) || !e.message.includes('正在使用或上次退出待核查')) throw e;
      }
    }
    if (!lease) {
      if (Date.now()>deadline) throw new Error('项目虚拟机仍在使用，请结束运行中的项目服务后重试。');
      await delay(350,undefined,{signal});
    }
  }
  let sent=false, confirmed=false;
  try {
    check();
    vm=lease.vm;
    const child=spawn(vm.lima,['shell','--workdir=/','--shell=/bin/sh','--preserve-env=false','--reconnect=false',vm.instance,'--',
      '/usr/bin/python3','-I','-c',program(),vm.bootId,vm.guestDevice,vm.guestInode,vm.runnerSha256],{
      cwd:'/',env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:homedir(),LIMA_HOME:vm.limaHome},stdio:'pipe'});
    const pending=new Map<string,{resolve:(r:PreviewHttpResponse)=>void;reject:(e:Error)=>void}>();
    await new Promise<void>((resolve,reject)=>{
      let buffer='',failure:Error|undefined,killTimer:NodeJS.Timeout|undefined;
      const stop=(reason?:Error)=>{
        if(reason) failure??=reason;
        if (!child.stdin.writableEnded) child.stdin.end();
        killTimer??=setTimeout(()=>child.kill('SIGKILL'),12000);
      };
      const abort=()=>stop();
      const write=(value:unknown)=>{check();if(!child.stdin.writable) throw new Error('项目服务连接已关闭。');child.stdin.write(JSON.stringify(value)+'\n');};
      const timer=setInterval(()=>{try { check(); }catch{stop();}},500);
      const timeout=setTimeout(()=>stop(new Error('项目服务已到运行时限，可重新启动。')),2*60*60*1000);
      const cleanup=()=>{
        clearTimeout(killTimer);clearTimeout(timeout);clearInterval(timer);signal.removeEventListener('abort',abort);
        for(const item of pending.values()) item.reject(new Error('项目服务已停止。'));
        pending.clear();
      };
      signal.addEventListener('abort',abort,{once:true});
      child.stderr.resume();child.stdin.on('error',()=>stop());
      child.on('error',e=>{failure=e;});
      child.once('close',code=>{
        confirmed=confirmed && code===0 && !buffer.length;
        cleanup();
        if(failure) reject(failure);
        else if(!confirmed && sent) reject(new Error('虚拟机未确认项目进程退出，请核对运行状态。'));
        else resolve();
      });
      function frame(line:string) {
        const m=JSON.parse(line);
        if(m.state==='exited') {confirmed=true;return;}
        if(m.state==='failed') {confirmed=true;stop(new Error(String(m.reason)));return;}
        if(signal.aborted) return;
        if(m.state==='ready') {request.snapshot(m.snapshotSha256);write({mode:'npm',service:true,argv:['npm','run','dev']});sent=true;}
        else if(m.state==='download') {
          void request.allowDownload(m.lockSha256,m.packages).then(ok=>{if(ok) write({allow:m.lockSha256});else stop();}).catch(()=>stop());
        } else if(m.state==='error') stop(new Error(String(m.message)));
        else if(m.state==='log') request.log(String(m.message).slice(0,400));
        else if(m.state==='listening') request.listening(async input=>{
          check();const id=randomUUID();
          const timeout=setTimeout(()=>pending.get(id)?.reject(new Error('预览响应超时。')),12000);
          try {
            return await new Promise<PreviewHttpResponse>((resolve,reject)=>{
              pending.set(id,{resolve,reject});write({id,...input});
            });
          }finally{clearTimeout(timeout);pending.delete(id);}
        });
        else if(m.state==='response') pending.get(m.id)?.resolve({status:m.status,mime:m.mime,body:m.body});
      }
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',(chunk:string)=>{
        try {
          buffer+=chunk;
          if(buffer.length>3_100_000) throw new Error('预览响应过大。');
          let idx;while((idx=buffer.indexOf('\n'))>=0) {const line=buffer.slice(0,idx);buffer=buffer.slice(idx+1);frame(line);}
        }catch(e){stop(e as Error);}
      });
      if(signal.aborted) abort();
    });
  } finally {await lease.release(!sent || confirmed);}
}
