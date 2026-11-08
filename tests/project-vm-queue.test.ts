import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CollaborationStore } from '../server/collaboration/store.js';
import { Store } from '../server/store.js';

test('one project VM waits for the earlier writer to actually exit, including across conversations and different roots', () => {
  const base = mkdtempSync(join(tmpdir(), 'project-queue-'));
  const owner = new Store(join(base, 'private', 'db.sqlite'));
  const store = new CollaborationStore(owner, {singleProjectVm:true, projectWorkAvailability: () => ({available:true})});
  const admit = (name: string) => {
    const project = join(base,name);
    mkdirSync(project);
    const conversation = store.create({ title:name, memberIds:['codex'], defaultMemberId:'codex', requestId:randomUUID() }).conversation;
    const grant = store.workbench.previewWorkspace(conversation.id,{path:project,mode:'project-work'});
    store.workbench.applyPreview({previewId:grant.id,requestId:randomUUID()},conversation.id);
    store.projects.submit(conversation.id,{content:'请修复项目文件',requestId:randomUUID()});
    return store.admitNext()!.invocations[0]!;
  };
  try {
    const first = admit('first'), second = admit('second');
    assert.equal(store.projectWriterReady(first),true);
    assert.equal(store.projectWriterReady(second),false);
    store.prepareInput(first.id);
    store.startInvocation(first.id);
    store.finish(first.id,'interrupted','等待客体退出',undefined,8,'runtime_unknown');
    assert.equal(store.projectWriterReady(second),false);
    store.recordEvidence(first.id,{kind:'process_exit',detail:{confirmed:true,code:0}});
    assert.equal(store.projectWriterReady(second),true);
  } finally { owner.close(); rmSync(base,{recursive:true,force:true}); }
});
