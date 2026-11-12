// Run an explicitly selected matrix branch against one checked-out candidate.
// Domain assertions and native invocation limits belong to each branch's verifier.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cases = {
  '01-codex': ['obligation-live','--live','--author=codex'],
  '01-claude': ['obligation-live','--live','--author=claude'],
  '01-drift': ['obligation-live','--live','--author=codex','--drift'],
  '02-five-rounds': ['debate-live','--live'],
  '02-restart': ['debate-live','--live','--restart'],
  '03-passed': ['ci-live','--live','passed'],
  '03-failed': ['ci-live','--live','failed'],
  '03-expired': ['ci-live','--live','expired'],
  '04-standard': ['werewolf-live','--normal'],
  '04-restart': ['werewolf-live','--restart'],
  '05-accepted': ['shift-live'],
  '05-declined-restart': ['shift-live','--decline-first','--restart-on-accept'],
  '06-opinions': ['decision-material-live','opinions'],
  '06-objection': ['decision-material-live','objection'],
  '07-materials': ['decision-material-live','materials'],
  '07-relocation': ['decision-material-live','relocation'],
  '08-shared': ['cross-excerpt-live'],
  '08-revoked': ['cross-excerpt-live','--revoke-before-dispatch'],
  '09-booked': ['external-live'],
  '09-unknown-restart': ['external-live','--lost-receipt'],
  '10-and-control': ['research-live'],
};
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (...args) => execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const sha256 = data => createHash('sha256').update(data).digest('hex');

function snapshot() {
  const commit=git('rev-parse','HEAD');
  assert.equal(git('status','--porcelain','--untracked-files=no'),'','Commit tracked edits before starting matrix acceptance');
  assert.equal(git('ls-files','--others','--exclude-standard','--','server','shared','web','scripts','tests'),'','Untracked source would change the candidate');
  return {commit,tree:git('rev-parse',commit+'^{tree}'),
    scheduler:git('rev-parse',commit+':server/collaboration'),shared:git('rev-parse',commit+':shared'),
    prompt:git('rev-parse',commit+':server/collaboration/context.ts'),tools:git('rev-parse',commit+':server/collaboration/runtime-common.ts')};
}

async function receipts(directory) {
  const results=[];
  for(const entry of await readdir(directory,{withFileTypes:true})){
    if(!entry.isDirectory())continue;
    const path=join(directory,entry.name,'result.json');
    let content;
    try { content=await readFile(path); }
    catch(error){if(error.code==='ENOENT')continue; throw error;}
    const data=JSON.parse(content);
    results.push({path:relative(directory,path),sha256:sha256(content),
      passed:data.passed===true || data.accepted===true});
  }
  return results;
}

async function runCase(name,base,source) {
  const [script,...args]=cases[name];
  const dir=await mkdtemp(join(base,name+'-'));
  const log=await open(join(dir,'run.log'),'wx',0o600);
  const record={name,source,script,args,startedAt:new Date().toISOString(),node:process.version,passed:false};
  try {
    const child=spawn(process.execPath,['--import','tsx','scripts/verify-hydra-'+script+'.mjs',...args],
      {cwd:root,env:{...process.env,VALIDATION_OUTPUT_DIR:dir},stdio:['ignore',log.fd,log.fd]});
    const {code,signal}=await new Promise((ok,fail)=>{
      child.once('error',fail);child.once('close',(code,signal)=>ok({code,signal}));
    });
    Object.assign(record,{code,signal,receipts:await receipts(dir)});
    assert.deepEqual(snapshot(),source,'Candidate changed while verification was running');
    record.passed=code===0 && record.receipts.length>0 && record.receipts.every(r=>r.passed);
  } catch(error){record.error=error.message;}
  finally {
    await log.close();record.finishedAt=new Date().toISOString();
    await writeFile(join(dir,'branch.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
  }
  console.log(JSON.stringify({name,passed:record.passed,report:join(dir,'branch.json')}));
  return record.passed;
}

async function audit(base, source) {
  // Never infer a pass from a log, another checkout or an earlier failed/superseded attempt.
  const groups = new Map(Object.keys(cases).map(name => [name, []]));
  const entries = await readdir(base, {withFileTypes:true}).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  for (const dir of entries) {
    if (!dir.isDirectory()) continue;
    const name = [...groups.keys()].find(k => dir.name.startsWith(k+'-'));
    if (!name) continue;
    const path = join(base,dir.name);
    let record;
    try {
      record=JSON.parse(await readFile(join(path,'branch.json'),'utf8'));
      assert.deepEqual(record.source,source);
      assert.equal(record.name,name);
      assert.deepEqual([record.script,...record.args],cases[name]);
      assert(record.finishedAt && record.startedAt);
      const onDisk=await receipts(path);
      assert(onDisk.length>0);
      const sortByPath=(a,b)=>a.path.localeCompare(b.path);
      assert.deepEqual(onDisk.sort(sortByPath),record.receipts.sort(sortByPath));
      assert.equal(record.code,0);
      assert(!record.signal && record.passed && onDisk.every(r=>r.passed));
      groups.get(name).push({attempt:dir.name,status:'passed'});
    } catch (error) {
      groups.get(name).push({attempt:dir.name,status:error.code==='ENOENT' && !record ? 'incomplete' : 'failed',reason:error.message});
    }
  }
  // Keep every failed/incomplete attempt visible; never silently pick the best run.
  const branches=Object.fromEntries([...groups].map(([name,attempts]) => [name,{
    status: !attempts.length?'unverified':attempts.every(r=>r.status==='passed')?'passed':'needs_review',attempts
  }]));
  const knownMatrixPassed = Object.values(branches).every(item=>item.status==='passed');
  return {source,knownMatrixPassed,branches,blindTest:'independent_report_required',release:'independent_signoff_required'};
}

const args=process.argv.slice(2);
if(args.length===1 && args[0]==='--list')console.log(Object.keys(cases).join('\n'));
else if(args.length===1 && args[0]==='--audit'){
  const source=snapshot();
  const base=join(resolve(process.env.VALIDATION_OUTPUT_DIR || join(root,'.local-data','validation','stage-e')),source.commit);
  const report=await audit(base,source);
  console.log(JSON.stringify(report,null,2));
  if(!report.knownMatrixPassed)process.exitCode=1;
}
else {
  assert(args.length>0 && args.every(n=>Object.hasOwn(cases,n)),'Use --list and select one or more known branches');
  const source=snapshot();
  const base=join(resolve(process.env.VALIDATION_OUTPUT_DIR || join(root,'.local-data','validation','stage-e')),source.commit);
  await mkdir(base,{recursive:true,mode:0o700});
  for(const name of args)if(!await runCase(name,base,source))process.exitCode=1;
}
