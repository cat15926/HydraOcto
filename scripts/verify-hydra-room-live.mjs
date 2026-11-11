// Run with HYDRA_CONFIG_ROOT=/path/to/installation node --import tsx scripts/verify-hydra-room-live.mjs --live
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {parseEnv} from 'node:util';
import {Store} from '../server/store.ts';
import {CollaborationEngine} from '../server/collaboration/engine.ts';
import {CollaborationStore} from '../server/collaboration/store.ts';
import {createCollaborationRuntime} from '../server/collaboration/runtime.ts';

const mode=process.argv.slice(2);
assert(mode.length===1 && ['--live','--check-config'].includes(mode[0]), 'Select --check-config or --live');
const installed=resolve(process.env.HYDRA_CONFIG_ROOT || '.');
function readConfig() {
  const db=new DatabaseSync(join(installed,'.local-data/platform.sqlite'),{readOnly:true});
  try{
    const m=JSON.parse(db.prepare('SELECT value FROM cc_members WHERE id=?').get('claude')?.value || 'null');
    assert(m?.enabled && m.carrier==='claude-cli' && m.model,'Configured Claude Code member required');
    const a=JSON.parse(db.prepare('SELECT value FROM cc_accounts WHERE id=?').get(m.accountId)?.value || 'null');
    assert(a?.provider==='claude' && a.auth==='api' && a.apiKeyEnv==='COLLAB_GLM_API_KEY' &&
      a.baseUrl==='https://open.bigmodel.cn/api/anthropic' && !a.deletedAt,'Configured Zhipu API account required');
    return {model:m.model,account:a};
  }finally{db.close();}
}
const {model,account}=readConfig();
const secret=process.env[account.apiKeyEnv] || parseEnv(await readFile(join(installed,'.env'),'utf8'))[account.apiKeyEnv];
assert(secret,'Missing configured test credential');
if(mode[0]==='--check-config'){console.log(JSON.stringify({carrier:'claude-cli',model,maxInvocations:2}));process.exit(0);}
process.env[account.apiKeyEnv]=secret;
const dir=await mkdtemp(join(tmpdir(),'hydra-room-live-'));
const work=join(dir,'workspace');
process.env.CLAUDE_CONFIG_DIR=join(dir,'claude-config');
await mkdir(work,{mode:0o700});await mkdir(process.env.CLAUDE_CONFIG_DIR,{mode:0o700});
const owner=new Store(join(dir,'test.db')),store=new CollaborationStore(owner,{workspace:work,artifactDir:join(dir,'artifacts')});
const native=createCollaborationRuntime({timeoutMs:90000});
const calls=[];
const engine=new CollaborationEngine(store,{...native,async invoke(input){
  assert(calls.length<2 && input.member.carrier==='claude-cli' && input.account.id===account.id &&
    !input.projectWork && input.cwd===work,'Unexpected runtime invocation');
  const own=input.conversationId===rooms[0]?'ROOM_ALPHA':'ROOM_BETA', foreign=own==='ROOM_ALPHA'?'ROOM_BETA':'ROOM_ALPHA';
  assert(input.prompt.includes(own) && !input.prompt.includes(foreign),'Foreign private prompt');
  calls.push(input.invocationId);
  return native.invoke(input);
}},{workspace:work});
const terminal=new Set(['succeeded','failed','interrupted','cancelled']);
async function until(check,reason){
  const deadline=Date.now()+100000;
  while(!check() && Date.now()<deadline){
    if(store.invocations().some(i=>i.status==='failed')) throw new Error('Runtime failed; inspect isolated database');
    await delay(40);
  }
  assert(check(),reason);
}
const rooms=[],pids={};
const result={dir,model,carrier:'claude-cli',maxInvocations:2,passed:false};
try{
  store.saveAccount(account);
  store.saveMember({id:'claude',name:'Claude Code',carrier:'claude-cli',accountId:account.id,model,
    accountBinding:'override',modelBinding:'override',instructions:'按用户要求作简短回答。',enabled:true});
  for(const label of ['ALPHA','BETA']){
    const c=store.create({title:'实机隔离 '+label,memberIds:['claude'],defaultMemberId:'claude',requestId:randomUUID()}).conversation;
    rooms.push(c.id);
    const content=label==='ALPHA'?'请解释排序算法，按顺序简述三种。房间标记 ROOM_ALPHA。':'请只回复 ROOM_BETA。';
    store.send(c.id,{content,privateTo:['claude'],requestId:randomUUID()});
  }
  engine.start();
  const run=cid=>store.invocations(cid)[0];
  const getPid=cid=>store.detail(cid).evidence.find(e=>e.kind==='prepared' && e.detail.processStarted)?.detail.pid;
  await until(()=>rooms.every(cid=>Number.isSafeInteger(getPid(cid)) && !!run(cid)?.nativeSessionId), 'Missing per-room native identities');
  const [a,b]=rooms;
  assert.notEqual(run(a).nativeSessionId,run(b).nativeSessionId);
  assert.notEqual(run(a).roomMember.id,run(b).roomMember.id);
  assert.notEqual(getPid(a),getPid(b));
  for(const cid of rooms){pids[cid]=getPid(cid);process.kill(pids[cid],0);}
  assert(!terminal.has(run(a).status) && !terminal.has(run(b).status),'Both processes must be live before cancellation');
  engine.cancel(run(a).id);
  await until(()=>run(a).status==='cancelled' && run(a).teardown==='confirmed', 'Stopped room did not close');
  await until(()=>run(b).status==='succeeded' && run(b).teardown==='confirmed','Other room did not complete');
  assert.equal(run(b).acceptance,'accepted');
  assert.match(store.response(run(b).responseId).content,/ROOM_BETA/);
  result.passed=true;
}finally{
  await engine.stop();
  result.calls=calls.length;
  result.rooms=rooms.map(cid=>{
    const i=store.invocations(cid)[0];return {cid,instanceId:i?.roomMember?.id,id:i?.id,pid:pids[cid],sid:i?.nativeSessionId,
      acceptance:i?.acceptance,status:i?.status,teardown:i?.teardown,privateInputs:store.detail(cid).sources.length};
  });
  owner.close();
  await writeFile(join(dir,'result.json'),JSON.stringify(result,null,2),{mode:0o600});
  console.log(JSON.stringify(result));
}
