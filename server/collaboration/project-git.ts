import { spawn } from 'node:child_process';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ExecutionContractSnapshot, GitDeliveryPreview, RuntimeEvent, WorkspaceGrant } from '../../shared/collaboration.js';
import { officialProjectNetworkEnv } from './project-official-network.js';
import { requestsPullRequest } from './project-pulls.js';
import { githubApi, repository } from './project-github.js';
import { AppError } from '../store.js';
import { discoverableProjectPath, projectFileDigest } from './project-file-read.js';
import type { CollaborationStore } from './store.js';

const helper = fileURLToPath(new URL('../../scripts/runtime/project-git.py', import.meta.url));
export const gitDeliveryTool = {
  name:'project_git_deliver',
  description:'When the user requests a Git commit and push, supply the exact project-relative files from completed member edits and a commit message. The platform prepares a diff, asks the user once, and verifies the remote SHA. Never run git push through the shell. For a pull request set pullRequest=true, optionally base (target branch) and number (an existing platform PR to update). Supply only the relative files you edited. A PR uses a separate work branch. Only report success after the corresponding receipt.',
  inputSchema:{type:'object',properties:{paths:{type:'array',items:{type:'string'},minItems:1,maxItems:8},message:{type:'string',maxLength:200},pullRequest:{type:'boolean'},base:{type:'string',maxLength:130},number:{type:'integer',minimum:1}},required:['paths','message'],additionalProperties:false}
};

class GitFailure extends AppError {
  constructor(message:string,readonly sending:boolean) { super(409,message); }
}

async function runHelper<T>(action:string, grant:WorkspaceGrant, temp:string, input:unknown, signal:AbortSignal):Promise<T> {
  signal.throwIfAborted();
  const env=action === 'inventory' ? {PATH:'/usr/bin:/bin'} : await officialProjectNetworkEnv({PATH:'/usr/bin:/bin'});
  signal.throwIfAborted();
  const child = spawn('/usr/bin/python3',['-I',helper,action,grant.path,String(grant.device),String(grant.inode),temp],{
    cwd:'/',env,detached:true,stdio:['pipe','pipe','ignore']
  });
  return new Promise((resolve,reject) => {
    const kill = () => { if (child.pid) { try { process.kill(-child.pid,'SIGKILL'); } catch { /* already exited */ } } };
    const timer = setTimeout(kill,60000);
    signal.addEventListener('abort',kill,{once:true});
    const chunks:Buffer[] = []; let size = 0;
    child.stdout.on('data',(chunk:Buffer) => { size+=chunk.length; if (size>4*1024*1024) kill(); else chunks.push(chunk); });
    child.stdin.on('error',()=>{}); child.stdin.end(JSON.stringify(input));
    child.once('error',reject);
    child.once('close',code=>{
      clearTimeout(timer); signal.removeEventListener('abort',kill);
      try {
        signal.throwIfAborted();
        if (code!==0) throw new AppError(409,'Git 操作已中断，请核对远端提交。');
        const result=JSON.parse(Buffer.concat(chunks).toString());
        if (result.error) throw new GitFailure(result.error,result.sending===true);
        resolve(result);
      } catch(e) { reject(e); }
    });
  });
}

export class GitFileChanges {
  private pending:Promise<void> = Promise.resolve();
  private constructor(private store:CollaborationStore, private id:string, private grant:WorkspaceGrant,
    private baseline:Record<string,string>,private signal:AbortSignal) {}
  static async start(store:CollaborationStore,id:string,contract:ExecutionContractSnapshot,signal:AbortSignal) {
    const grant = contract.workspaceGrant;
    if (!contract.gitDelivery || !grant) return;
    if (!(await lstat(join(grant.path,'.git')).catch(()=>null))?.isDirectory()) return;
    try {
      const baseline=await runHelper<Record<string,string>>('inventory',grant,'/',{},signal);
      return new GitFileChanges(store,id,grant,baseline,signal);
    } catch {
      signal.throwIfAborted();
      store.recordEvidence(id,{kind:'diagnostic',detail:{observation:'git_inventory_unavailable'}});
    }
  }
  observe(event:RuntimeEvent) {
    const info = event.detail;
    if (event.kind!=='tool' || info?.origin!=='native' || info.state!=='completed' ||
      !['Write','Edit','fileChange'].includes(String(info.name))) return;
    const paths=Array.isArray(info.paths) ? info.paths : [info.path];
    for (const path of paths) if (discoverableProjectPath(path)) {
      this.pending=this.pending.then(async()=>{
        const before=Object.hasOwn(this.baseline,path) ? this.baseline[path] : null;
        if (before==='?') return;
        const after=await projectFileDigest(this.grant,path,this.signal);
        if (before===after.sha256) return;
        this.store.recordEvidence(this.id,{kind:'tool',detail:{origin:'git_file_change',state:'completed',
          grantRevision:this.grant.revision,callId:info.callId,path,before,after:after.sha256}});
      }).catch(()=>{ /* A missing digest cannot authorize delivery. */ });
    }
  }
  settle() { return this.pending; }
}

export async function deliverGit(store:CollaborationStore,id:string,args:Record<string,unknown>,callId:string,
  signal:AbortSignal,redact:(s:string)=>string,cancel:()=>void) {
  const grant=store.requireProjectCapability(id,'gitDelivery');
  const run=store.invocation(id);
  if (!Array.isArray(args.paths) || args.paths.length<1 || args.paths.length>8 || !args.paths.every(discoverableProjectPath) ||
      typeof args.message!=='string' || !args.message.trim() || args.message.length>200 || /[\x00-\x1f\x7f]/.test(args.message) ||
      (args.pullRequest!==undefined && typeof args.pullRequest!=='boolean') ||
      (args.base!==undefined && (typeof args.base!=='string' || !/^[a-zA-Z0-9][a-zA-Z0-9/._-]{0,129}$/.test(args.base))) ||
      (args.number!==undefined && (!Number.isSafeInteger(args.number) || Number(args.number)<1)) ||
      Object.keys(args).some(k=>!['paths','message','pullRequest','base','number'].includes(k))) throw new AppError(400,'请选择 1–8 个成员修改的文本文件，并填写提交说明。');
  const paths=[...new Set(args.paths as string[])].sort();
  const source=store.visibility.primary(id);
  const pr=Boolean(source.projectCiRepair || args.pullRequest || args.number || args.base || requestsPullRequest(source.routingContent ?? source.content));
  const interactions=pr ? store.interactions.list(run.conversationId) : [];
  const previousCard=source.projectCiRepair ? store.interactions.get(source.projectCiRepair.interactionId) :
    args.number ? interactions.findLast(item=>item.pullStatus?.number===args.number && item.gitDelivery?.commit===item.pullStatus?.commit &&
      item.memberId===run.memberId && item.payload.grantRevision===grant.revision && item.state==='answered') : undefined;
  if (args.number && !previousCard || previousCard && (['closed','superseded','stopped'].includes(previousCard.pullStatus?.state ?? '') ||
      args.number && previousCard.pullStatus?.number!==args.number || args.base && previousCard.gitDelivery?.pull?.base!==args.base))
    throw new AppError(409,'请在创建此 PR 的原会话和原项目授权下更新同一个 PR。');
  const pull=pr ? {branch:previousCard?.gitDelivery?.branch ?? 'codex/collab-'+id,
    base:previousCard?.gitDelivery?.pull?.base ?? args.base, expectedHead:previousCard?.gitDelivery?.commit,
    number:previousCard?.pullStatus?.number, repair:source.allowCiRepair===true || Boolean(source.projectCiRepair)} : undefined;
  const history=store.detail(run.conversationId).evidence;
  const files=await Promise.all(paths.map(async path=>{
    const current=await projectFileDigest(grant,path,signal);
    const match=history.findLast(e=>e.kind==='tool' && e.detail.origin==='git_file_change' && e.detail.path===path &&
      e.detail.after===current.sha256 && e.detail.grantRevision===grant.revision);
    if (!match) throw new AppError(409,'缺少该文件在当前项目授权中的成员修改记录：'+path);
    let before=match.detail.before;
    for (const earlier of history.slice(0,history.indexOf(match)).reverse()) {
      if (earlier.detail.origin==='project_git' && earlier.detail.state==='completed' &&
          (earlier.detail.plan as GitDeliveryPreview | undefined)?.files.includes(path)) break;
      if (earlier.detail.origin==='git_file_change' && earlier.detail.grantRevision===grant.revision &&
          earlier.detail.path===path && earlier.detail.after===before) before=earlier.detail.before;
    }
    return {path,before,after:current.sha256};
  }));
  const temp=await mkdtemp(join(tmpdir(),'collab-git-'));
  const record=(fields:Record<string,unknown>)=>store.recordEvidence(id,{kind:'tool',detail:{origin:'project_git',callId,...fields}});
  const verify=()=>{ signal.throwIfAborted(); store.requireProjectCapability(id,'gitDelivery'); };
  const local=new AbortController();
  const active=AbortSignal.any([signal,local.signal]);
  const timer=setInterval(()=>{ try {verify();} catch(e){local.abort(e);} },350);
  try {
    const signature=pull ? JSON.stringify([files,'pull',pull.number ?? null,pull.base ?? null]) : JSON.stringify(files);
    const previous=history.findLast(e=>e.detail.origin==='project_git' && e.detail.signature===signature &&
      e.detail.grantRevision===grant.revision && ['sending','completed','unknown','failed'].includes(String(e.detail.state)));
    if (previous?.detail.plan && previous.detail.state!=='failed') {
      const plan=previous.detail.plan as GitDeliveryPreview;
      const result=await runHelper<{tip:string}>('check',grant,temp,{plan},active);
      verify();
      if (result.tip===plan.commit) {
        if (plan.pull) {
          const item=interactions.find(entry=>entry.gitDelivery?.commit===plan.commit && entry.state==='answered');
          return {state:'branch_confirmed',commit:plan.commit,branch:plan.branch,pull:item?.pullStatus ?? 'waiting'};
        }
        record({state:'completed',commit:plan.commit,branch:plan.branch,remote:plan.remote,reconciled:true});
        return {state:'confirmed',commit:plan.commit,branch:plan.branch,remote:plan.remote};
      }
      if (!plan.pull || result.tip!==plan.pull.expectedHead) throw new AppError(409,'上次推送的提交与当前远端不同，请先核对分支历史。');
    }
    const lastDelivery=history.findLast(e=>e.detail.origin==='project_git' && e.detail.state==='completed' && e.detail.plan && !(e.detail.plan as GitDeliveryPreview).pull &&
      e.detail.grantRevision===grant.revision)?.detail.plan;
    const plan=await runHelper<GitDeliveryPreview>('prepare',grant,temp,{files,lastDelivery,pull,message:args.message.trim(),date:new Date().toISOString()},active);
    if (redact(JSON.stringify(plan))!==JSON.stringify(plan)) throw new AppError(403,'差异含有受保护信息，无法推送。');
    verify();
    const requestId='git:'+callId;
    const answer=await store.interactions.wait(id,{kind:'approval',operation:'project_git_deliver',providerRequestId:requestId,
      nativeItemId:callId,gitDelivery:plan,payload:{grantRevision:grant.revision}},'project-git',active);
    if (answer.cancelledByUser) cancel();
    if (answer.state!=='answered') return {state:answer.state,pushed:false};
    verify();
    const proof={plan,signature,grantRevision:grant.revision};
    try {
      if (plan.pull) {
        const api=await githubApi(active);
        const repo=await api('repos/'+repository(plan.remote)) as {permissions?:{push?:boolean}};
        if (!repo.permissions?.push) throw new GitFailure('GitHub API 账户缺少测试或项目仓库的推送权限。',false);
        if (previousCard && plan.pull.number) {
          const old=await api('repos/'+repository(plan.remote)+'/pulls/'+plan.pull.number) as {state:string;head:{sha:string;ref:string;repo:{full_name:string}};base:{ref:string}};
          if (old.state!=='open' || old.head.sha!==plan.pull.expectedHead || old.head.ref!==plan.branch ||
              old.head.repo.full_name.toLowerCase()!==repository(plan.remote).toLowerCase() || old.base.ref!==plan.pull.base)
            throw new GitFailure('PR 已关闭或分支已变化，请重新核对。',false);
        }
      }
    } catch (e) {
      record({state:'failed',...proof,reason:(e as Error).message});
      throw new AppError(409,(e as Error).message);
    }
    verify();
    record({state:'sending',...proof});
    try {
      const result=await runHelper<{tip:string}>('push',grant,temp,{files,plan},active);
      if(result.tip!==plan.commit) throw new Error('tip changed');
      record({state:'completed',...proof,commit:plan.commit,remote:plan.remote,branch:plan.branch});
      return {state:plan.pull?'branch_confirmed':'confirmed',commit:plan.commit,remote:plan.remote,branch:plan.branch,
        ...(plan.pull && {pull:'等待平台核对 PR 和 CI，请查看会话中的确认卡。'})};
    } catch (error) {
      const state=error instanceof GitFailure && !error.sending ? 'failed' : 'unknown';
      record({state,...proof,reason:error instanceof AppError ? error.message : '远端提交待核对。'});
      throw new AppError(409,(error instanceof AppError ? error.message+' ' : '')+'未确认远端提交。重新查询会核对同一提交。');
    }
  } finally {
    clearInterval(timer); local.abort(); await rm(temp,{recursive:true,force:true});
  }
}
