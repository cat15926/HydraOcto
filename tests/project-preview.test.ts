import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Conversation, WorkspaceGrant } from '../shared/collaboration.js';
import { ProjectPreviews } from '../server/collaboration/project-preview.js';

async function until<T>(read:()=>T, ready:(value:T)=>boolean) {
  let value=read();
  for(let i=0; i<120 && !ready(value); i++) { await delay(40); value=read(); }
  assert.ok(ready(value)); return value;
}

test('project preview binds the selected grant, rejects stale stops and closes outstanding listeners on shutdown',async () => {
  const temp=await mkdtemp(join(await realpath(tmpdir()),'preview-grant-'));
  const root=join(temp,'site');
  await mkdir(root);
  const identity=await stat(root);
  const grant:WorkspaceGrant={path:root,device:identity.dev,inode:identity.ino,mode:'read-only',authorizedAt:new Date().toISOString(),revision:1};
  const c:Conversation={id:'c',title:'订单',memberIds:[],defaultMemberId:'codex',createdAt:'',updatedAt:'',workspaceGrant:grant};
  const previews=new ProjectPreviews(()=>c);
  const status=()=>previews.state('c');
  const local=(url:string)=>'http://127.0.0.1:'+new URL(url).port;
  const request=(url:string,path:string)=>new Promise<{status:number;text:string}>((resolve,reject)=>{
    const req=get(local(url)+path,{headers:{host:new URL(url).host},agent:false,signal:AbortSignal.timeout(2000)},res=>{
      let text='';
      res.setEncoding('utf8').on('data',chunk=>{text+=chunk;});
      res.on('end',()=>resolve({status:res.statusCode!,text}));
    });
    req.on('error',reject);
  });
  try {
    const first=previews.start('c',null,1);
    previews.end('c',first.id);
    await delay(60);
    assert.equal(status().status,'stopped');
    assert.equal(status().url,undefined);
    const second=previews.start('c',first.id,1);
    await until(status,s=>s.status==='failed');
    assert.ok(status().logs.at(-1)?.message.includes('index.html'));
    await mkdir(join(root,'dist'));
    await writeFile(join(root,'dist/index.html'),'<h1>当前版本</h1>');
    await writeFile(join(temp,'other.js'),'private data');
    await symlink(join(temp,'other.js'),join(root,'dist/linked.js'));
    const running=previews.start('c',second.id,1);
    await until(status,s=>s.status==='running');
    const url=status().url!;
    assert.equal((await request(url,'/')).text,await readFile(join(root,'dist/index.html'),'utf8'));
    assert.equal((await request(url,'/linked.js')).status,404);
    assert.equal((await request(url,'/.hidden/index.html')).status,404);
    assert.equal((await fetch(local(url)+'/')).status,403);
    assert.throws(()=>previews.end('c',first.id));
    assert.equal(previews.start('c',running.id,1).id,running.id);
    // Same pathname after the original directory is moved is a different grant.
    await rename(root,join(temp,'old'));
    await mkdir(root);
    previews.reconcile('c');
    assert.equal(status().status,'stopped');
    await assert.rejects(request(url,'/'));
    await rm(root,{recursive:true});
    await rename(join(temp,'old'),root);
    const next=previews.start('c',running.id,1);
    await until(status,s=>s.status==='running');
    const replacedUrl=status().url!;
    delete c.workspaceGrant;
    previews.reconcile('c');
    assert.equal(status().status,'stopped');
    await assert.rejects(request(replacedUrl,'/'));
    c.workspaceGrant=grant;
    previews.start('c',next.id,1);
    await until(status,s=>s.status==='running');
    const finalUrl=status().url!;
    previews.close();
    assert.equal(status().status,'idle');
    await assert.rejects(request(finalUrl,'/'));
  } finally { previews.close(); await rm(temp,{recursive:true,force:true}); }
});

test('service grants, dependency approval, stop and restart stay bound to the original instance',async t=>{
  const temp=await mkdtemp(join(await realpath(tmpdir()),'service-'));
  t.after(()=>rm(temp,{recursive:true,force:true}));
  const root=join(temp,'project');await mkdir(root);
  const info=await stat(root);
  const c:Conversation={id:'c',title:'开发项目',memberIds:['codex'],defaultMemberId:'codex',createdAt:'',updatedAt:'',
    workspaceGrant:{path:root,device:info.dev,inode:info.ino,mode:'read-only',authorizedAt:'t',revision:1}};
  const journal=join(temp,'journal');let exits=0;
  const previews=new ProjectPreviews(()=>c,async req=>{
    req.verify();req.snapshot('one');
    if(!await req.allowDownload('lock',['fixture'])) return;
    if(!exits++) throw new Error('项目缺少 dev 脚本');
    req.listening(async()=>({status:200,mime:'text/plain',body:'b2s='}));
    await new Promise<void>(resolve=>req.signal.addEventListener('abort',()=>resolve(),{once:true}));
  },journal);
  t.after(()=>previews.close());
  assert.throws(()=>previews.start('c',null,1,'service'));
  c.workspaceGrant!.mode='project-work';
  const first=previews.start('c',null,1,'service');
  assert.equal(first.download?.count,1);
  assert.throws(()=>previews.approveDownload('c',first.id,'stale'));
  previews.approveDownload('c',first.id,'lock');
  await until(()=>previews.state('c'),s=>s.status==='failed');
  const next=previews.start('c',first.id,1,'service');
  assert.throws(()=>previews.end('c',first.id));
  previews.approveDownload('c',next.id,'lock');
  await until(()=>previews.state('c'),s=>s.status==='running');
  const again=new ProjectPreviews(()=>c,undefined,journal);
  assert.equal(again.state('c').status,'failed');
  await again.close();
  c.workspaceGrant!.revision++;previews.reconcile('c');
  assert.equal(previews.state('c').status,'stopped');
  await previews.close();
  const recovered=new ProjectPreviews(()=>c,undefined,journal);
  assert.equal(recovered.state('c').status,'idle');
  await recovered.close();
});
