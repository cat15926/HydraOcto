import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test,type TestContext } from 'node:test';
import type { NativeFileChange, RuntimeRequest } from '../shared/collaboration.js';
import { claudeCommandApproval } from '../server/collaboration/native-command-approval.js';
import { runEnvironmentCheck } from '../server/collaboration/project-environment-check.js';
import { nativePermissionTarget } from '../server/collaboration/native-permission-target.js';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { claudeFileChange, codexFileChange, NativeFileApprovals } from '../server/collaboration/native-file-approval.js';

function setup(t:TestContext, carrier:'codex'|'claude'='codex') {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'native-file-approval-'))), cwd=join(root,'project'); mkdirSync(cwd);
  const owner=new Store(join(root,'platform','test.sqlite')); t.after(()=>{owner.close();rmSync(root,{recursive:true,force:true});});
  const store=new CollaborationStore(owner,{workspace:cwd,projectWorkAvailability:()=>({available:true})});
  const member = store.members().find(m=>m.carrier === (carrier === 'codex' ? 'codex-app-server' : 'claude-cli'))!;
  process.env.P8_PERMISSION_FIXTURE_KEY='synthetic';
  const account = store.saveAccount({id:'test-api',name:'test-api',provider:carrier,auth:'api',apiKeyEnv:'P8_PERMISSION_FIXTURE_KEY',baseUrl:'https://example.invalid'});
  store.saveMember({...member,accountId:account.id,accountBinding:'override',model:'fixture'});
  const cid=store.create({title:'项目文件审批',memberIds:[member.id],defaultMemberId:member.id,requestId:randomUUID()}).conversation.id;
  const preview=store.workbench.previewWorkspace(cid,{path:cwd,mode:'project-work',nativeFileApprovals:true});
  store.workbench.applyPreview({previewId:preview.id,requestId:randomUUID()},cid);
  store.projects.submit(cid,{content:'新建代码文件。',requestId:randomUUID()});
  const run=store.admitNext()!.invocations[0]!, id=run.id;
  store.startInvocation(id);
  store.recordEvidence(id,{kind:'accepted',detail:{evidence:'test'}});
  store.recordEvidence(id,{kind:'session',detail:{nativeSessionId:'thread',nativeTurnId:'turn'}});
  const contract=store.contract(id), controller=new AbortController();
  const req:RuntimeRequest={member:run.member,account:contract.accountMetadataSnapshot,invocationId:id,conversationId:cid,
    workspaceGrant:contract.workspaceGrant,cwd,projectWork:true,signal:controller.signal,prompt:'fixture',onToolCall:async()=>{},onEvent:()=>{},
    onInteraction: message=>store.interactions.wait(id,message,message.operation.startsWith('can_use_tool/') ? 'claude' : 'codex',controller.signal),
    checkNativePermission:(request,thread,turn,item)=>store.interactions.canReturn(id,request,thread,turn,item),
    onNativePermissionLost:request=>store.interactions.revokeReturn(id,request),onInteractionResolved:request=>store.interactions.resolved(id,request)};
  const gate=new NativeFileApprovals(req);
  const change:NativeFileChange={action:'write',path:'note.md',preview:'hello'};
  const input={file_path:'/mnt/project/note.md',content:'hello'};
  const begin=(tool:'codex'|'claude')=>{
    const exact=tool === 'claude' ? input : [{path:input.file_path,kind:{type:'add'},diff:input.content}];
    const file=tool === 'claude' ? claudeFileChange(input) : codexFileChange({type:'fileChange',changes:exact});
    gate.observe('thread','turn','item',file,exact);
    return gate.decide('thread','turn','item','req',tool,exact);
  };
  const decision=(value:string)=>{
    const item=store.interactions.list(cid)[0]!;
    return store.interactions.answer(item.id,{requestId:randomUUID(),expectedRevision:item.revision,payloadDigest:item.payloadDigest,decision:value});
  };
  return {store,cwd,id,root,begin,gate,req,input,change,decision,controller};
}

for (const cli of ['codex','claude'] as const) {
  for (const [choice,result] of [['allow_once','accept'],['decline','decline'],['cancel','cancel']] as const) {
    test(cli+' returns the exact single file decision '+choice,async t=>{
      const h=setup(t,cli); const answer=h.begin(cli); await new Promise(resolve=>setImmediate(resolve));
      const record=h.store.interactions.list()[0]!;
      assert.equal(record.nativeItemId,'item');assert.equal(record.fileChange?.path,'note.md');assert.equal(record.state,'pending');
      assert.throws(()=>h.decision('allow_session'));
      h.decision(choice);
      assert.equal(await answer,result);
      assert.equal(await h.begin(cli),'decline');
    });
  }
}
test('Claude command decisions bind one foreground command to one project and expire with its grant', async t=>{
    const cli='claude';
    const h=setup(t,cli);
    const item={type:'commandExecution',command:'node --version',cwd:'/mnt/project'};
    const input={command:item.command};
    const exact=input;
    const command=claudeCommandApproval(input);
    assert.deepEqual(command,{command:'node --version',cwd:'/mnt/project'});
    const start=(id:string,args:unknown)=>{
      h.gate.observeCommand('thread','turn',id,command,exact);
      return h.gate.decide('thread','turn',id,id,cli,args,'command');
    };
    assert.equal(await start('wrong',{...exact,command:'pwd'}),'decline');
    assert.equal(await start('wrong-scope',{...exact,run_in_background:true}),'decline');
    for (const [index,choice] of (['allow_once','decline','cancel','revoke'] as const).entries()) {
      const id='cmd-'+index, response=start(id,exact);
      await new Promise(resolve=>setImmediate(resolve));
      const i=h.store.interactions.list().find(x=>x.nativeItemId===id)!;
      assert.deepEqual(i.nativeCommand,command);
      if (choice==='revoke') {
        const c=h.store.workbench.conversation(h.req.conversationId);
        h.store.workbench.revokeWorkspace(c.id,c.revision!,randomUUID());
        assert.throws(()=>h.store.interactions.answer(i.id,{requestId:randomUUID(),expectedRevision:i.revision,payloadDigest:i.payloadDigest,decision:'allow_once'}));
        assert.notEqual(await response,'accept');
      } else {
        h.store.interactions.answer(i.id,{requestId:randomUUID(),expectedRevision:i.revision,payloadDigest:i.payloadDigest,decision:choice});
        assert.equal(await response,choice==='allow_once'?'accept':choice==='decline'?'decline':'cancel');
        assert.equal(await start(id,exact),'decline');
      }
    }
});
test('managed Codex probes execute only once after the exact decision, and retain the executor and exit code',async t=>{
  const h=setup(t), events:string[]=[];
  const execute=async ({argv,verifyAuthorization}:{argv:string[];verifyAuthorization:()=>void})=>{
    verifyAuthorization(); events.push(argv.join(' '));
    return {argv,exitCode:0,output:'/work',snapshotSha256:'a'.repeat(64),treeExited:true as const,truncated:false};
  };
  const call=(id:string)=>runEnvironmentCheck(h.store,h.id,{command:'pwd'},id,h.controller.signal,execute,()=>h.controller.abort());
  const first=call('probe1');
  const duplicate=call('probe1').catch(e=>e);
  assert.equal(events.length,0);
  const item=h.store.interactions.list()[0]!;
  assert.equal(item.transport,'project-check');
  assert.equal(item.nativeCommand?.cwd,'/work');
  h.decision('allow_once');
  const results=await Promise.allSettled([first,duplicate]);
  assert.equal(events.length,1);
  assert.ok(results.some(r=>r.status==='fulfilled' && r.value?.executor==='project_environment'));
  const failed=call('probe2');
  const next=h.store.interactions.list().find(i=>i.nativeItemId==='probe2')!;
  h.store.interactions.answer(next.id,{requestId:randomUUID(),expectedRevision:next.revision,payloadDigest:next.payloadDigest,decision:'decline'});
  await assert.rejects(failed);
  assert.equal(events.length,1);
});
test('additional shell input and external resources cannot obtain a one-shot command decision',()=>{
  assert.equal(claudeCommandApproval({command:'node --version && pwd'}),undefined);
  assert.equal(claudeCommandApproval({command:'pwd',run_in_background:true}),undefined);
  assert.equal(claudeCommandApproval({command:'pwd',dangerouslyDisableSandbox:true}),undefined);
  assert.equal(nativePermissionTarget('item/commandExecution/requestApproval',{networkApprovalContext:{host:'docs.example',protocol:'https'}}),'https://docs.example');
  assert.equal(nativePermissionTarget('can_use_tool/WebFetch',{input:{url:'https://docs.example/path?signature=private'}}),'https://docs.example');
});
test('a changed file, a stopped run, a resolved provider request or a late user answer cannot grant the waiting operation',async t=>{
  for (const cause of ['file','stop','resolved','timeout','grant'] as const) {
    const h=setup(t); const answer=h.begin('codex');await new Promise(resolve=>setImmediate(resolve));
    const record=h.store.interactions.list()[0]!;
    if (cause==='timeout') {
      record.expiresAt=new Date(0).toISOString();
      h.store.db.prepare('UPDATE cc_runtime_interactions SET value=? WHERE id=?').run(JSON.stringify(record),record.id);
    } else if (cause==='resolved') h.gate.closeRequest('req');
    else if (cause==='stop') h.store.cancel(h.id);
    else if (cause==='grant') {
      const c=h.store.workbench.conversation(h.req.conversationId);
      h.store.workbench.revokeWorkspace(c.id,c.revision!,randomUUID());
    } else { h.decision('allow_once');writeFileSync(join(h.cwd,'note.md'),'created elsewhere'); }
    assert.notEqual(await answer,'accept',cause);
    assert.throws(()=>h.decision('allow_once'),cause);
  }
});
test('invalid path, moved file, directory, links, partial preview, mixed edit or wrong native identity yield no allow',async t=>{
  const h=setup(t,'claude');
  const file={type:'fileChange',changes:[{path:'/mnt/project/note.md',kind:{type:'update'},diff:'hi'}]};
  assert.ok(codexFileChange(file));
  for (const path of ['note.md','/etc/config','/mnt/project/.env','/mnt/project/../outside','/mnt/project/\u202enote.md']) {
    assert.equal(codexFileChange({...file,changes:[{...file.changes[0],path}]}),undefined);
  }
  assert.equal(codexFileChange({...file,changes:[...file.changes,...file.changes]}),undefined);
  assert.equal(codexFileChange({...file,changes:[{...file.changes[0],kind:{type:'update',move_path:'/mnt/project/to'}}]}),undefined);
  assert.equal(claudeFileChange({...h.input,content:'x'.repeat(8001)}),undefined);
  assert.equal(claudeFileChange({...h.input,permissions:{}}),undefined);
  h.gate.observe('thread','turn','item',h.change,h.input);
  assert.equal(await h.gate.decide('thread','wrong','item','r1','claude',h.input),'decline');
  assert.equal(await h.gate.decide('thread','turn','item','r1','claude',{...h.input,content:'changed'}),'decline');
  symlinkSync(h.root,join(h.cwd,'linked'));
  h.gate.observe('thread','turn','link',{...h.change,path:'linked/file'},h.input);
  assert.equal(await h.gate.decide('thread','turn','link','r2','claude',h.input),'decline');
  const records=h.store.interactions.list();
  assert.deepEqual(records.map(i=>[i.state,i.payload.reasonCode]),[['unsupported','file_unavailable']]);
  assert.match(records[0]!.reason!,/重新读取/);
});
