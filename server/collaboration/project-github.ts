import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type { GitDeliveryPreview, ProjectCiCheck, ProjectPullStatus } from '../../shared/collaboration.js';
import { officialProjectNetworkEnv } from './project-official-network.js';

const exec = promisify(execFile);
export type GitHubApi = ((path:string, fields?:Record<string,string>) => Promise<unknown>) & {
  failedLog?:(repo:string,run:string,job:string)=>Promise<string|undefined>;
};
type Ref = {ref:string; sha:string; repo:{full_name:string}|null};
type Pull = {number:number; state:string; base:Ref; head:Ref};
type Check = {id:number; name:string; status:string; conclusion:string|null; head_sha:string; details_url?:string; output?:{title?:string}};
type Status = {context:string; state:string; target_url?:string; description?:string};
const clean = (s:string|undefined, n:number) => (s || '').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,n);
function link(raw?:string) {
  try {
    const url=new URL(raw || '');
    if (url.protocol==='https:' && !url.username && !url.password) return url.href;
  } catch { /* The check remains visible without a link. */ }
}
export function repository(remote:string) {
  const match=/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\.git$/.exec(remote);
  if (!match || match[1]!.split('/').some(n=>n==='.'||n==='..')) throw new Error('GitHub 仓库地址无效。');
  return match[1]!;
}
export async function githubApi(signal:AbortSignal):Promise<GitHubApi> {
  let bin:string|undefined;
  for (const path of ['/opt/homebrew/bin/gh','/usr/local/bin/gh','/usr/bin/gh']) {
    if (await access(path).then(()=>true,()=>false)) { bin=path; break; }
  }
  if (!bin) throw new Error('本机需要安装 GitHub CLI（gh）。');
  const executable=bin;
  const token=process.env.COLLAB_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const env=await officialProjectNetworkEnv({PATH:'/usr/bin:/bin',HOME:homedir(),GH_PROMPT_DISABLED:'1',
    ...(process.env.XDG_CONFIG_HOME && {XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME}), ...(process.env.GH_CONFIG_DIR && {GH_CONFIG_DIR:process.env.GH_CONFIG_DIR}), ...(token && {GH_TOKEN:token})});
  const api:GitHubApi=async(path,fields) => {
    const args=['api','--hostname','github.com','--method',fields?'POST':'GET',path];
    for (const [key,val] of Object.entries(fields||{})) args.push('-f',key+'='+val);
    try {
      const {stdout}=await exec(executable,args,{cwd:'/',env,signal,timeout:18000,maxBuffer:5*1024*1024});
      return JSON.parse(stdout);
    } catch (e) {
      signal.throwIfAborted();
      const error=e as {code?:number|string;stderr?:string};
      if (error.code==='ENOENT') throw new Error('本机需要安装 GitHub CLI（gh）。');
      if (error.code===4 || /not logged|auth login|HTTP 401/i.test(error.stderr||''))
        throw new Error('本机 GitHub CLI 尚未登录。请在终端运行 gh auth login，完成后重新尝试。');
      if (/HTTP 403/i.test(error.stderr||'')) throw new Error('GitHub 拒绝访问。请核对账户对目标仓库的 PR、检查和 Actions 权限。');
      throw new Error('GitHub 暂未确认结果，将重新核对同一工作分支。');
    }
  };
  api.failedLog=async(repo,run,job)=>{
    try {
      const {stdout}=await exec(executable,['run','view',run,'--repo','github.com/'+repo,'--job',job,'--log-failed'],
        {cwd:'/',env,signal,timeout:20000,maxBuffer:1024*1024});
      const excerpt=stdout.split(/\r?\n/).filter(l=>/##\[error\]|AssertionError|ERR_ASSERTION|Expected|actual:|expected:|error TS\d+|not ok |test failed/i.test(l))
        .filter(l=>!/(?:authorization|password|token[=:]|api[_-]?key|secret[=:]|private key)/i.test(l))
        .map(l=>l.replace(/^.*?\d{4}-\d\d-\d\dT[\d:.]+Z\s*/, '').replace(/\x1b\[[0-9;]*m/g,''))
        .slice(0,8).join(' ').replace(/(?:github_pat_|gh[pousr]_|sk-)[A-Za-z0-9_-]{10,}/g,'[redacted]');
      return clean(token ? excerpt.split(token).join('[redacted]') : excerpt,600);
    } catch {signal.throwIfAborted();return undefined;}
  };
  return api;
}
function checkItems(runs:Check[], statuses:Status[], commit:string):ProjectCiCheck[] {
  return [...runs.filter(r=>r.head_sha===commit).map((r):ProjectCiCheck=>({
    name:clean(r.name,180), url:link(r.details_url), summary:clean(r.output?.title,500),
    state:r.status!=='completed'?'pending':r.conclusion==='success'?'passed':['neutral','skipped'].includes(r.conclusion||'')?'skipped':'failed',
  })),...statuses.map((r):ProjectCiCheck=>({name:clean(r.context,180),url:link(r.target_url),summary:clean(r.description,500),
    state:r.state==='success'?'passed':r.state==='failure'||r.state==='error'?'failed':'pending'}))];
}
export async function observePull(plan:GitDeliveryPreview, number:number|undefined, api:GitHubApi, verify:()=>void):Promise<ProjectPullStatus> {
  const dest=plan.pull!;
  const slug=repository(plan.remote), root='repos/'+slug;
  const matches=(p:Pull)=>p.head.repo?.full_name.toLowerCase()===slug.toLowerCase() &&
    p.base.repo?.full_name.toLowerCase()===slug.toLowerCase() && p.base.ref===dest.base && p.head.ref===plan.branch;
  const read=async<T>(path:string)=>{ verify(); return await api(root+path) as T; };
  let pull:Pull|undefined;
  if (number) pull=await read<Pull>('/pulls/'+number);
  else {
    const query=new URLSearchParams({state:'all',head:slug.split('/')[0]+':'+plan.branch,base:dest.base});
    const candidates=await read<Pull[]>('/pulls?'+query);
    pull=candidates.find(matches);
    if (!pull) {
      const ref=await read<{object:{sha:string}}>('/git/ref/heads/'+plan.branch);
      if (ref.object.sha!==plan.commit) return {state:'superseded',commit:plan.commit,observedHead:ref.object.sha};
      verify();
      pull=await api(root+'/pulls',{base:dest.base,head:plan.branch,title:plan.message,
        body:'本次提交：'+plan.commit+'\n\n'+plan.files.map(f=>'- '+f).join('\n')}) as Pull;
    }
  }
  if (!matches(pull) || !Number.isSafeInteger(pull.number) || pull.number<1) throw new Error('PR 仓库或分支已经变化。');
  const receipt={number:pull.number, url:'https://github.com/'+slug+'/pull/'+pull.number,commit:plan.commit};
  function headStatus(current:Pull):ProjectPullStatus|undefined {
    if (!matches(current)) throw new Error('PR 仓库或分支已经变化。');
    if (current.state!=='open') return {...receipt,state:'closed'};
    if (current.head.sha===plan.commit) return;
    // Git updates the ref before GitHub necessarily exposes that SHA on the pull.
    // The approved predecessor is expected during delivery and API propagation.
    if (current.head.sha===dest.expectedHead) {
      return {...receipt,state:'waiting',reason:'等待 GitHub 将本次提交关联到 PR。'};
    }
    return {...receipt,state:'superseded',observedHead:current.head.sha};
  }
  const beforeChecks=headStatus(pull);
  if (beforeChecks) return beforeChecks;
  const sha='/commits/'+plan.commit;
  const [runs,statuses]=await Promise.all([read<{total_count:number;check_runs:Check[]}>(sha+'/check-runs?per_page=100&filter=latest'),
    read<{sha:string;total_count:number;statuses:Status[]}>(sha+'/status?per_page=100')]);
  if (statuses.sha!==plan.commit || runs.total_count>runs.check_runs.length || statuses.total_count>statuses.statuses.length)
    throw new Error('GitHub 检查清单不完整，尚无法确认结果。');
  const checks=checkItems(runs.check_runs,statuses.statuses,plan.commit);
  for (const check of checks.filter(c=>c.state==='failed' && c.url).slice(0,3)) {
    const url=new URL(check.url!);
    const job=/^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)\/?$/.exec(url.pathname);
    if (!api.failedLog || url.origin!=='https://github.com' || !job || job[1]!.toLowerCase()!==slug.toLowerCase()) continue;
    verify();
    const excerpt=await api.failedLog(slug,job[2]!,job[3]!);
    if (excerpt) check.summary=excerpt;
  }
  const latest=await read<Pull>('/pulls/'+pull.number);
  const afterChecks=headStatus(latest);
  if (afterChecks) return afterChecks;
  verify();
  const state=!checks.length?'waiting':checks.some(c=>c.state==='failed')?'failed':
    checks.some(c=>c.state==='pending')?'pending':checks.some(c=>c.state==='passed')?'passed':'waiting';
  return {...receipt,state,checks};
}
