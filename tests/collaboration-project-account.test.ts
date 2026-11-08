import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { discoverAccount, projectLoginGuidance, resolveCodexExecutable } from '../server/collaboration/account-discovery.js';
import { protectProjectLogin, verifyWorkspace } from '../server/collaboration/workbench.js';

test('a dedicated project account is seeded once even when an existing ordinary account already occupies its preferred ID',()=>{
  const root=mkdtempSync(join(tmpdir(),'account-upgrade-')), db=join(root,'db','cc.sqlite');
  let owner = new Store(db);
  try {
    const start=new CollaborationStore(owner);
    owner.db.prepare('DELETE FROM cc_accounts WHERE id=?').run('codex-project-cli');
    const personal=start.saveAccount({id:'codex-project-cli',name:'旧登录',provider:'codex',auth:'cli'});
    const member=start.saveMember({...start.members()[0]!,accountId:personal.id,accountBinding:'override'});
    owner.close(); owner=new Store(db);
    const next=new CollaborationStore(owner);
    assert.deepEqual(next.accounts().find(a=>a.id===personal.id),personal);
    assert.deepEqual(next.members().find(m=>m.id===member.id),member);
    const special=next.accounts().filter(a=>a.codexHome==='project');
    assert.equal(special.length,1); assert.notEqual(special[0]!.id,personal.id);
    assert.throws(()=>next.saveAccount({...personal,codexHome:'project'}));
    assert.throws(()=>next.saveAccount({...special[0]!,provider:'claude'}));
    const renamed=next.saveAccount({id:special[0]!.id,name:'账本项目',auth:'cli',provider:'codex'});
    assert.equal(renamed.codexHome,'project');
    owner.close(); owner=new Store(db);
    assert.deepEqual(new CollaborationStore(owner).accounts().filter(a=>a.codexHome==='project'),[renamed]);
  } finally {owner.close();rmSync(root,{recursive:true,force:true});}
});

test('project login discovery uses the dedicated CODEX_HOME even while the personal CLI is authenticated; old and new grants protect its location',async t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'project-account-')));
  const visible=join(root,'workspace'), dedicated=join(visible,"project's private home"), personal=join(root,'personal');
  mkdirSync(visible); mkdirSync(dedicated,{mode:0o700}); mkdirSync(personal,{mode:0o700});
  const previousProject=process.env.COLLAB_CODEX_PROJECT_HISTORY_HOME, previousPersonal=process.env.CODEX_HOME;
  t.after(()=>{
    if(previousProject===undefined) delete process.env.COLLAB_CODEX_PROJECT_HISTORY_HOME; else process.env.COLLAB_CODEX_PROJECT_HISTORY_HOME=previousProject;
    if(previousPersonal===undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME=previousPersonal;
    rmSync(root,{recursive:true,force:true});
  });
  process.env.CODEX_HOME=personal;
  const owner=new Store(join(root,'db','cc.sqlite'));
  t.after(()=>owner.close());
  const store=new CollaborationStore(owner);
  const cid=store.create({title:'测试',memberIds:['codex'],defaultMemberId:'codex',requestId:randomUUID()}).conversation.id;
  const preview=store.workbench.previewWorkspace(cid,{path:visible});
  store.workbench.applyPreview({previewId:preview.id,requestId:randomUUID()},cid);
  const grant=store.workbench.conversation(cid).workspaceGrant!;
  process.env.COLLAB_CODEX_PROJECT_HISTORY_HOME=dedicated;
  for (const path of [visible,dedicated]) {
    assert.throws(()=>store.workbench.previewWorkspace(cid,{path}),/专用登录/);
    assert.throws(()=>protectProjectLogin(path,'read-only'),/专用登录/);
  }
  assert.throws(()=>verifyWorkspace(grant),/专用登录/);
  const cmd=join(root,"vendor's test cli.cjs");
  writeFileSync(cmd,'#!'+process.execPath+'\n'+`if(process.argv.includes('--version')){console.log('codex-fixture');process.exit();}
    if(process.argv[2]==='login'){console.log(process.env.CODEX_HOME);process.exit();}
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const {id,method}=JSON.parse(line); if(id===undefined)return;
      const result=method==='config/read'?{config:{mcp_servers:{}}}:method==='account/read'?
        {account:process.env.CODEX_HOME===${JSON.stringify(personal)}?{type:'chatgpt',email:'fixture@example.test'}:null}:
        method==='model/list'?{data:[]}:{};
      console.log(JSON.stringify({jsonrpc:'2.0',id,result}));
    });`,{mode:0o700});
  const commands={codex:cmd,claude:cmd};
  assert.equal((await discoverAccount(store.accounts().find(a=>a.id==='codex-cli')!,commands)).identity.state,'authenticated');
  assert.equal((await discoverAccount(store.accounts().find(a=>a.codexHome==='project')!,commands)).identity.state,'not_authenticated');
  const quoted=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
  const safeCommand='CODEX_HOME='+quoted(dedicated)+' '+quoted(cmd)+' login';
  assert.equal(resolveCodexExecutable(cmd),cmd);
  assert.equal(projectLoginGuidance(cmd).loginCommand,safeCommand);
  const shell=process.platform==='darwin'?'/bin/zsh':'/bin/sh';
  assert.equal(execFileSync(shell,['-c',safeCommand],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8'}).trim(),dedicated);
  const absent=projectLoginGuidance(join(root,'missing-codex'));
  assert.equal(absent.loginCommand,undefined);
  assert.match(absent.loginIssue!,/未检测到可执行的 Codex CLI/);
  process.env.COLLAB_CODEX_PROJECT_HISTORY_HOME=personal;
  assert.match(projectLoginGuidance(cmd).loginIssue!,/目录/);
  process.env.COLLAB_CODEX_PROJECT_HISTORY_HOME=join(visible,'.private','codex-home');
  assert.doesNotThrow(()=>verifyWorkspace(grant)); // Old read grants enforce hidden components.
  assert.throws(()=>protectProjectLogin(visible,'project-work'),/专用登录/);
});
