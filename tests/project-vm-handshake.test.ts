import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RuntimeRequest } from '../shared/collaboration.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { markerScript, prepareProjectCli, type ProjectVm } from '../server/collaboration/project-vm.js';

test('project handshake refuses a mismatched physical guest directory before forwarding any buffered input', async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(),'project-handshake-')));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const boot = randomUUID(), sha = 'a'.repeat(64);
  const lima = join(dir,'manager.mjs');
  await writeFile(lima,`#!${process.execPath}
import {createInterface} from 'node:readline';
if (!process.argv.includes('sudo')) {
  console.log(${JSON.stringify(boot)}); console.log('${sha}  runner'); console.log('${sha}  codex');
} else {
  for await (const line of createInterface({input:process.stdin})) {
    const frame=JSON.parse(line);
    if (frame.type==='start') console.log(JSON.stringify({type:'ready',gatewayOrigin:'http://127.0.0.1:1234',device:78,inode:2}));
    if (frame.type==='input') console.log(JSON.stringify({type:'output',data:'unexpected forwarded input'}));
    if (frame.type==='stop') { console.log(JSON.stringify({type:'exit',code:125,treeExited:true})); break; }
  }
}
`,{mode:0o700});
  const st = await stat(dir);
  const vm: ProjectVm = {lima,limaHome:dir,hostRoot:dir,instance:'fixture',device:st.dev,inode:st.ino,
    guestDevice:'77',guestInode:'2',runnerSha256:sha,bootId:boot,carriers:{'codex-app-server':sha}};
  const envName = 'SYNTHETIC_HANDSHAKE_KEY';
  process.env[envName]='synthetic-only';
  t.after(() => { delete process.env[envName]; });
  const req: RuntimeRequest = {invocationId:'r',conversationId:'c',cwd:dir,prompt:'never send',signal:AbortSignal.timeout(5000),
    projectWork:true,member:{id:'m',name:'m',enabled:true,carrier:'codex-app-server',accountId:'a',model:'test',instructions:''},
    account:{id:'a',name:'synthetic',provider:'codex',auth:'api',apiKeyEnv:envName,baseUrl:'http://127.0.0.1:1234/v1'},
    workspaceGrant:{path:dir,device:st.dev,inode:st.ino,mode:'project-work',revision:1,authorizedAt:new Date().toISOString(),conversationId:'c',memberIds:['m']},
    onEvent:()=>{},onToolCall:async()=>{}};
  const project = await prepareProjectCli(vm,req);
  try {
    const channel = project.launch([],{}), output: string[]=[];
    const closed = new Promise<boolean>((done,fail) => channel.connect(data=>output.push(data),(_code,_signal,confirmed)=>done(confirmed),fail));
    channel.write(req.prompt);
    await assert.rejects(project.ready,/项目目录/);
    assert.equal(await closed,true);
    assert.equal(project.treeExited,true);
    assert.deepEqual(output,[]);
  } finally { await project.close(); }
});


test('the host mount check accepts internal hard links and requires a private copy for files shared with another directory', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(),'project-file-scope-')));
  t.after(() => rm(base,{recursive:true,force:true}));
  const root = join(base,'project');
  await mkdir(root);
  await writeFile(join(root,'report.csv'),'synthetic');
  await link(join(root,'report.csv'),join(root,'same-report.csv'));
  const st = await stat(root);
  const check = (action: string) => promisify(execFile)('/usr/bin/python3',
    ['-I','-c',markerScript,root,String(st.dev),String(st.ino),'marker','random',action]);
  await check('create');
  await check('remove');
  await link(join(root,'report.csv'),join(base,'shared-report.csv'));
  await assert.rejects(check('create'),{code:37});
});
