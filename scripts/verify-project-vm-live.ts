/** Isolated P0/P1 acceptance. Default is a scripted local model and real guest CLIs; --live uses the selected host API accounts. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { CollaborationAccount, CollaborationBootstrap, Member } from '../shared/collaboration.js';
import { createApplication } from '../server/index.js';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';
import { readProjectVm, type ProjectVm } from '../server/collaboration/project-vm.js';
import { createMonthlyFixture, rerunMonthlyTest } from './runtime/monthly-project-fixture.js';
import { startProjectModelFixture } from './runtime/project-model-fixture.js';
import { prepareInterruption, type Fault } from './runtime/project-interruption.js';

const official=process.argv.includes('--official');
const glm=process.argv.includes('--glm');
if (glm) assert(!official && process.argv.slice(2).join(' ')==='--glm claude','--glm accepts only the configured Claude Code GLM account on the P4 test VM');
const exec = promisify(execFile), live = official || glm || process.argv.includes('--live');
assert(!(official && process.argv.includes('--live')),'choose precisely one authentication mode');
const faultArg = process.argv.find(arg => arg.startsWith('--fault='));
const fault = faultArg?.slice('--fault='.length) as Fault | undefined;
const projectInspection=process.argv.includes('--inspect-project');
assert(!projectInspection || (fault==='disconnect' && !live),'scene inspection uses only the dedicated scripted disconnect case');
const supported = ['codex', 'claude'] as const;
const selected = process.argv.slice(2).filter(v => v !== '--glm' && v !== '--official' && v !== '--live' && v !== '--inspect-project' && v !== faultArg);
assert(!faultArg || (!live && ['stop','disconnect'].includes(fault!) && selected.join() === 'codex'), 'fault cases use only the real Codex CLI with the scripted endpoint');
assert(selected.every(v => v === 'codex' || v === 'claude'), 'usage: verify-project-vm-live.ts [--live | --fault=stop|disconnect] [codex] [claude]');
if (official) assert(selected.length===1 && !fault,'official acceptance requires exactly one explicitly selected CLI');
const ids = supported.filter(v => !selected.length || selected.includes(v));
const output = resolve(process.env.VALIDATION_OUTPUT_DIR ?? ((official || glm) ? '.local-data/validation/native-project-p4/executions' : projectInspection ? '.local-data/validation/native-project-p3/executions' : '.local-data/validation/native-project-p01/executions'));
await mkdir(output, { recursive: true });
const folder = await mkdtemp(join(output, fault ? fault+'-' : live ? 'live-' : 'scripted-'));
const records: Record<string, unknown>[] = [];

async function hashFile(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
// Exercise both the index and working tree without consulting the user's global Git configuration.
async function gitGuard(work: string) {
  const env = { PATH:'/usr/bin:/bin', HOME:'/var/empty', GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1',
    GIT_AUTHOR_NAME:'Fixture', GIT_AUTHOR_EMAIL:'fixture@localhost', GIT_COMMITTER_NAME:'Fixture', GIT_COMMITTER_EMAIL:'fixture@localhost' };
  const git = async (...args:string[]) => (await exec('/usr/bin/git',['-c','core.hooksPath=/dev/null','-C',work,...args],{env})).stdout;
  await git('init','--quiet');
  const notes = ['staged-notes.txt','working-notes.txt','personal-untracked.txt'];
  for(const file of notes.slice(0,2)) await writeFile(join(work,file),'baseline\n',{flag:'wx'});
  await git('add','--',...notes.slice(0,2)); await git('commit','--quiet','-m','fixture baseline');
  await writeFile(join(work,notes[0]!),'pending staged change\n');
  await git('add','--',notes[0]!);
  await writeFile(join(work,notes[1]!),'pending unstaged change\n');
  await writeFile(join(work,notes[2]!),'private existing untracked note\n',{flag:'wx'});
  async function snapshot() {
    return {head:(await git('rev-parse','HEAD')).trim(), indexBlob:(await git('rev-parse',':'+notes[0])).trim(),
      stagedDiffSha256:createHash('sha256').update(await git('diff','--cached','--no-ext-diff','--binary')).digest('hex'),
      status:await git('status','--porcelain=v1','--',...notes),
      fileSha256:await Promise.all(notes.map(file=>hashFile(join(work,file))))};
  }
  const before = await snapshot();
  for (const status of ['M  staged-notes.txt',' M working-notes.txt','?? personal-untracked.txt']) assert(before.status.includes(status));
  return async () => { const after=await snapshot(); assert.deepEqual(after,before); return after; };
}
async function candidate(): Promise<ProjectVm> {
  if (official || glm) {
    const vm=readProjectVm(resolve(process.env.P4_VM_CONFIG || '.local-data/validation/native-project-p4/p04.json'));
    assert(vm?.instance==='p03' && vm.officialExecutors?.includes(selected[0]==='codex'?'codex-app-server':'claude-cli'),'official acceptance requires the registered dedicated test VM');
    return vm;
  }
  const p3 = projectInspection ? readProjectVm(resolve(process.env.P3_VM_CONFIG || '.local-data/validation/native-project-p3/p03.json')) : undefined;
  if(projectInspection) assert(p3?.instance==='p03','disconnect inspection requires a dedicated p03 test VM');
  const runtimeDir = resolve(process.env.P01_VM_RUNTIME || '.local-data/vm-runtime');
  const lima = await realpath(join(runtimeDir, 'bin/limactl')), limaHome = await realpath(process.env.P01_LIMA_HOME || '.local-data/lima');
  const instance = p3?.instance || process.env.P01_VM_NAME || 'p01';
  assert.match(instance, /^[a-z0-9][a-z0-9-]{0,48}$/);
  const localProject = p3?.hostRoot || process.env.P01_HOST_PROJECT || (await readFile('.local-data/validation/native-project-p01/vm/host-project.txt', 'utf8')).trim();
  const hostRoot = await realpath(localProject), host = await stat(hostRoot);
  assert(host.isDirectory() && host.uid===process.getuid?.() && basename(hostRoot).startsWith('multi-agent-vm-project-'), '需要专用的合成验收目录');
  const {stdout} = await exec(lima, ['shell','--workdir=/',instance,'--','sh','-ec',
    'cat /proc/sys/kernel/random/boot_id; stat -Lc "%d %i" /mnt/project; sha256sum /opt/multi-agent/project-vm-runner.py /opt/multi-agent/bin/codex /opt/multi-agent/bin/claude'],
  {env:{ HOME:process.env.HOME, PATH:'/usr/bin:/bin:/usr/sbin:/sbin', LIMA_HOME:limaHome }, timeout:15000});
  const [bootId, identity, runnerHash, codexHash, claudeHash] = stdout.trim().split('\n');
  const [guestDevice, guestInode] = identity!.split(' ');
  const runnerSha256 = await hashFile('scripts/runtime/project-vm-runner.py');
  assert.equal(runnerHash!.split(' ')[0], runnerSha256, '受验 runner 源码与客体需一致');
  const carriers: ProjectVm['carriers'] = {};
  for (const id of ids) {
    const sha = await hashFile(join(runtimeDir,id+'-linux'));
    assert.equal((id === 'codex' ? codexHash : claudeHash)!.split(' ')[0], sha, '客体 CLI 与已校验的安装包不一致');
    carriers[id === 'codex' ? 'codex-app-server' : 'claude-cli'] = sha;
  }
  if (p3 || process.env.P01_VM_REGISTRATION) {
    const registered=p3 ?? readProjectVm(process.env.P01_VM_REGISTRATION);
    assert(registered && registered.lima===lima && registered.limaHome===limaHome && registered.instance===instance &&
      registered.hostRoot===hostRoot && registered.device===host.dev && registered.inode===host.ino &&
      registered.runnerSha256===runnerSha256,'existing VM registration does not match the isolated test instance');
    for (const [carrier,sha] of Object.entries(carriers)) assert.equal(registered.carriers[carrier as keyof typeof carriers],sha);
    await writeFile(join(folder,'candidate.json'),JSON.stringify(registered,null,2),{mode:0o600,flag:'wx'});
    return registered;
  }
  const path = join(folder, 'candidate.json');
  await writeFile(path, JSON.stringify({ lima, limaHome, instance, hostRoot, device:host.dev, inode:host.ino,
    guestDevice, guestInode, runnerSha256, bootId, carriers },null,2), {mode:0o600,flag:'wx'});
  return readProjectVm(path)!;
}

async function validate(vm: ProjectVm, id: typeof supported[number], boot?: CollaborationBootstrap) {
  const carrier = id === 'codex' ? 'codex-app-server' : 'claude-cli';
  const work = await mkdtemp(join(vm.hostRoot, id + '-monthly-')), relative = basename(work);
  const token = randomUUID().replaceAll('-', '');
  const inputs = await createMonthlyFixture(work,token);
  const checkGit = id === 'claude' ? await gitGuard(work) : undefined;
  if (!live) await writeFile(join(work,'verify-child.py'), `import os
from pathlib import Path
def hidden(fd):
    try:
        os.readlink("/proc/self/fd/" + str(fd))
        return False
    except OSError:
        return True
with open("ledger.csv") as ledger:
    assert all(hidden(fd) for fd in (0, 1, ledger.fileno()))
assert not os.path.exists("/proc/1/fd")
assert "P01_SYNTHETIC_MODEL_CREDENTIAL" not in os.environ
for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "COLLAB_SELECTED_RUNTIME_API_KEY"):
    assert os.getenv(key) in (None, "", "project-gateway")
Path("child-check.txt").write_text("passed")
`, {flag:'wx'});
  const keyName = 'P01_SYNTHETIC_MODEL_CREDENTIAL';
  const syntheticKey = 'isolated-fixture-' + randomUUID();
  if (!live) process.env[keyName] = syntheticKey;
  const fixture = live ? undefined : await startProjectModelFixture(id, relative, token, syntheticKey, Boolean(fault));
  const result: Record<string, unknown> = { id, carrier, realCli:true, modelMode:live?'real':'scripted',authentication:official?'official-cli':'api', projectCase:relative, passed:false };
  records.push(result);
  const base = createCollaborationRuntime({ projectVm:vm, timeoutMs:180000 });
  let permittedExecutions = 0;
  const runtime: typeof base = { ...base, async invoke(input) {
    assert(input.projectWork && input.member.carrier === carrier && input.account.auth === (official?'cli':'api'), '验收只允许指定项目和 CLI/API 组合');
    assert.equal(permittedExecutions, 0, '单个受验组合已用尽本次成员调用上限');
    permittedExecutions++;
    return base.invoke(input);
  }};
  const staticDir = fault ? join(folder,'web') : undefined;
  if (staticDir) await exec(process.execPath,['node_modules/vite/bin/vite.js','build','--outDir',staticDir],{timeout:60000});
  const app = await createApplication({port:0, staticDir, ...(projectInspection ? {projectFilePicker:async()=>join(work,'first.txt')}:{}), dataDir:join(folder,id,'private'),workspace:join(folder,id,'default'),collaborationRuntime:runtime});
  const store = app.collaborationStore;
  let cid: string | undefined;
  let interrupted: Awaited<ReturnType<typeof prepareInterruption>> | undefined;
  try {
    const source = boot?.members.find(m=>m.id===id && m.enabled && m.carrier===carrier);
    const configured = boot?.accounts.find(a=>a.id===source?.accountId && a.auth==='api');
    if (glm) {
      assert(configured?.id==='claude-glm-key' && configured.apiKeyEnv==='COLLAB_GLM_API_KEY' &&
        configured.baseUrl==='https://open.bigmodel.cn/api/anthropic' && source?.model==='glm-5.3','智谱账户、端点或模型与本轮目标不一致；未发送。');
      Object.assign(result,{model:source.model,providerOrigin:'https://open.bigmodel.cn',credentialSource:'selected host account'});
    }
    if (live && !official) assert(source?.model && configured?.apiKeyEnv && process.env[configured.apiKeyEnv], id+' 缺少当前已配置的 API 账户/模型或主机密钥');
    const account: CollaborationAccount = official ? {id:'official-'+id,name:'本机官方登录',provider:id,auth:'cli'} : configured ?? { id:'fixture-'+id,name:'本地脚本模型',provider:id,auth:'api',apiKeyEnv:keyName,baseUrl:fixture!.baseUrl };
    const member: Member = { id,enabled:true,name:id==='codex'?'Codex':'Claude Code',carrier,instructions:'在已授权项目中使用本轮原生工具完成当前用户委托，只改该委托指定的子目录。', model:official ? undefined : source?.model ?? (id==='codex'?'gpt-5':'claude-sonnet-4-6'),accountId:account.id,accountBinding:'override',modelBinding:'override' };
    store.saveAccount(account); store.saveMember(member);
    const {url}=await app.start();
    async function post(path:string,body:unknown) {
      const response=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':app.csrfToken},body:JSON.stringify(body)});
      assert(response.ok, '验收 HTTP '+response.status+' '+path.split('/').at(-1));
      return response.json();
    }
    const {conversation}=await post('/api/conversations',{title:'原生项目验收',memberIds:[id],defaultMemberId:id,requestId:randomUUID()});
    cid=conversation.id;
    const endpoint='/api/conversations/'+cid;
    const content = fault ? `@Codex 请在项目子目录 ${relative} 里修改文件：写入 first.txt，等我释放同步点后再写入 second.txt。` :
      `@${member.name} 请修复项目中 ${relative}/export.py 漏掉零金额流水的问题。只在 ${relative} 子目录内工作，保留原始 ledger.csv、check.py 和已有数据。${checkGit ? '保留已有 Git 暂存区、工作区和未跟踪文件，勿提交。' : ''}先用原生终端进入该目录执行 python3 check.py 复现失败，读取文件找出原因，修改 export.py 后再执行同一检查，保留生成的 monthly.json。请报告实际结果。`;
    const message = {content,requestId:randomUUID()};
    const {intent} = await post(endpoint+'/messages', message);
    assert(intent?.id && store.detail(cid!).sources.length===0, '授权前应只有待办');
    assert.equal((await post(endpoint+'/messages',message)).intent.id,intent.id);
    const picked = await post(endpoint+'/workspace-preview',{path:vm.hostRoot});
    const grant = await post(endpoint+'/workspace-preview',{fromPreviewId:picked.id,mode:'project-work',intentId:intent.id});
    assert(grant.projectCapabilities?.some((v:{available:boolean})=>v.available), '当前虚拟机组合未开放');
    const apply={previewId:grant.id,requestId:randomUUID()};
    if (fault) interrupted = await prepareInterruption(fault,vm,work,token,url,cid!,folder, projectInspection ? app.csrfToken : undefined);
    await post(endpoint+'/workspace-apply',apply);
    assert.equal((await post(endpoint+'/workspace-apply',apply)).replayed,true);
    if (interrupted) {
      result.interruption=await interrupted.verify(() => store.detail(cid!), () => fixture!.rounds.length);
      assert.equal(await readFile(join(work,'child-check.txt'),'utf8'),'passed');
      result.childFdViewRestrictedAndCredentialsScoped=true;
      result.passed=true;
      return;
    }
    const until=Date.now()+195000;
    let detail = store.detail(cid!);
    while (Date.now()<until && !detail.invocations.some(i=>!['prepared','running','cancel_requested'].includes(i.status))) {
      await new Promise(done=>setTimeout(done,250)); detail=store.detail(cid!);
    }
    const inv=detail.invocations[0];
    const native = detail.evidence.filter(e=>e.invocationId===inv?.id && e.detail.origin==='native');
    const failureIndex=native.findIndex(e=>e.detail.state==='failed');
    Object.assign(result,{memberExecutions:detail.invocations.length,sourceCount:detail.sources.length,
      invocationId:inv?.id, status:inv?.status, acceptance:inv?.acceptance, teardown:inv?.teardown,
      native:native.map(e=>({callId:e.detail.callId,name:e.detail.name,state:e.detail.state,exitCode:e.detail.exitCode})),
      fixtureRounds:fixture?.rounds, fixtureDiagnostics:fixture?.diagnostics});
    assert.equal(detail.sources.length,1);
    assert.deepEqual(detail.sources[0]!.requestedTargets,[id]);
    assert.equal(detail.sources[0]!.content,content);
    assert.equal(detail.sources[0]!.projectWork,true);
    assert.equal(detail.invocations.length,1);
    assert.equal(inv?.memberId,id);
    assert.equal(inv?.status,'succeeded');
    assert.equal(inv.acceptance,'accepted'); assert.equal(inv.teardown,'confirmed');
    if (official) {
      const auth=detail.evidence.filter(e=>e.invocationId===inv.id && e.detail.authentication==='cli');
      assert(auth.length,'必须取得真实 CLI 官方认证回执');
      result.authenticationEvidence=auth.map(e=>({kind:e.kind,evidence:e.detail.evidence}));
    }
    // A successful Bash *wrapper* may observe a failing test. Use the unchanged
    // fixture's fail/pass record below as the test outcome in live Claude runs.
    if (live && id==='claude') {
      assert(native.some(e=>e.detail.name==='Bash' && e.detail.state==='completed'),'缺少真实 Bash 工具回执');
    } else assert(failureIndex>=0 && native.slice(failureIndex+1).some(e=>e.detail.state==='completed'), '缺少失败及随后成功的 CLI 回执');
    const observedChecks = (await readFile(join(work,'checks.log'),'utf8')).trim().split('\n');
    assert(observedChecks.indexOf('fail')>=0 && observedChecks.lastIndexOf('pass')>observedChecks.indexOf('fail'), '原测试未按失败、通过的顺序执行');
    result.testRuns = observedChecks;
    const report = JSON.parse(await readFile(join(work,'monthly.json'),'utf8'));
    assert.deepEqual(report,{rows:{zero:0,charge:11,refund:-3},total:8});
    assert.notEqual(await readFile(join(work,'export.py'),'utf8'),inputs['export.py']);
    for(const name of ['ledger.csv','check.py'] as const) assert.equal(await readFile(join(work,name),'utf8'),inputs[name]);
    if(fixture) assert(fixture.rounds.length===4 && fixture.rounds.every(r=>r.previousResultMatched), '工具结果未进入下一步脚本推理');
    if (checkGit) result.gitStatePreserved=await checkGit();
    if (fixture) {
      assert.equal(await readFile(join(work,'child-check.txt'),'utf8'),'passed');
      result.childFdViewRestrictedAndCredentialsScoped=true;
    }
    await rerunMonthlyTest(vm,relative,'PASS_'+token);
    assert.deepEqual(JSON.parse(await readFile(join(work,'monthly.json'),'utf8')),report);
    Object.assign(result,{passed:true,independentGuestTestPassed:true,hostReadBack:true,sourceAndTestUnchanged:true,outputDigest:await hashFile(join(work,'monthly.json'))});
  } finally {
    result.authorizedInvocationLimit = 1; result.permittedExecutions = permittedExecutions;
    if(cid && !result.passed) {
      const detail=store.detail(cid);
      result.states=detail.invocations.map(i=>({status:i.status,acceptance:i.acceptance,teardown:i.teardown,error:i.error?.slice(0,250)}));
    }
    await interrupted?.close(); await app.close(); await fixture?.close();
  }
}
try {
  const vm=await candidate();
  if(live && !official) { try { process.loadEnvFile('.env'); } catch { /* account references are checked below */ } }
  const boot = live && !official ? await (await fetch('http://127.0.0.1:4310/api/collaboration/bootstrap')).json() as CollaborationBootstrap : undefined;
  for (const id of ids) {
    try { await validate(vm,id,boot); } catch(error) { process.exitCode=1; console.error(id,error instanceof Error ? error.message : 'failed'); }
  }
} finally {
  const text = JSON.stringify(records,null,2);
  const secrets = Object.entries(process.env).filter(([k,v])=>/API_KEY|AUTH_TOKEN|CREDENTIAL/.test(k)&&v && v.length>5).map(([,v])=>v!);
  await writeFile(join(folder,'result.json'),secrets.reduce((s,k)=>s.replaceAll(k,'[redacted]'),text)+'\n',{mode:0o600});
  console.log(folder, records.map(r=>({id:r.id,passed:r.passed})));
}
