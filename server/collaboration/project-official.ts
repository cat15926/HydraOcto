import { randomUUID } from 'node:crypto';
import type { RuntimeRequest } from '../../shared/collaboration.js';
import { startProjectExecutorBridge } from './project-executor-bridge.js';
import { verifyWorkspace } from './workbench.js';
import type { ProjectCli } from './project-vm.js';

/** Starts the credential-free guest before the authenticated host CLI sees user input. */
export async function attachOfficialExecutor(project:ProjectCli, request:RuntimeRequest):Promise<() => void> {
  if (request.account.auth !== 'cli' || !request.workspaceGrant || !request.projectWork) throw new Error('缺少官方登录项目授权。');
  const grant=request.workspaceGrant;
  verifyWorkspace(grant);
  if (request.member.carrier === 'codex-app-server') {
    const link=await startProjectExecutorBridge(()=>project.launch(['exec-server','--listen','stdio://'],{}));
    project.officialCodex={url:link.url,bearer:link.capability};
    return () => {link.close();};
  }
  if (request.member.carrier !== 'claude-cli') throw new Error('官方项目执行器不支持此成员。');
  const transport=project.launch([],{});
  let partial='',ended=false, used=0;
  type Reply={output:string;exitCode:number};
  let active:{id:string;resolve:(r:Reply)=>void;reject:(e:Error)=>void}|undefined;
  const stop=()=>{ended=true; active?.reject(new Error('项目命令通道已关闭，请核对本轮执行。')); active=undefined;};
  transport.connect(chunk=>{
    try {
      partial+=chunk;
      if (partial.length>500_000) throw new Error();
      let end:number;
      while ((end=partial.indexOf('\n'))>=0) {
        const r=JSON.parse(partial.slice(0,end)); partial=partial.slice(end+1);
        if (!active || r.id!==active.id || typeof r.output!=='string' || r.output.length>66_000 || !Number.isInteger(r.exitCode)) throw new Error();
        const prev=active; active=undefined; prev.resolve({output:r.output,exitCode:r.exitCode});
      }
    } catch {stop(); transport.kill('SIGTERM');}
  },stop,()=>{stop();transport.kill('SIGTERM');});
  project.officialClaude={async run(command) {
    request.signal.throwIfAborted();
    await project.ready;
    verifyWorkspace(grant);
    if (ended || active || ++used>128 || typeof command!=='string' || !command.trim() || command.includes('\0') || Buffer.byteLength(command)>16384) throw new Error('本轮项目命令不可执行。');
    const id=randomUUID();
    return new Promise<Reply>((resolve,reject)=>{
      active={id,resolve,reject};
      try { transport.write(JSON.stringify({command,id})+'\n'); } catch {stop();}
    });
  }};
  return stop;
}
