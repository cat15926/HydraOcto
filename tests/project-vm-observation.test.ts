import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type { AcceptanceEvidence } from '../shared/collaboration.js';
import type { ProjectVm } from '../server/collaboration/project-vm.js';
import { captureProjectDomain,observeProjectDomain } from '../server/collaboration/project-vm-observation.js';

test('P3 domain observations bind the kernel witness to one invocation, backend and original guest boot',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'p3-kernel-fixture-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const lima=join(dir,'fixture'), bootId=randomUUID(), id=randomUUID();
  // A stand-in for the read-only guest command returns only the original kernel identity.
  await writeFile(lima,`#!/usr/bin/python3
import json,sys
args=sys.argv
if 'capture' in args: print(json.dumps(dict(pid='333',ticks='778',namespace='980')))
elif args[-4:] == ['${bootId}','333','778','980']: print('"exited"')
else: print('null')
`,{mode:0o700});
  const vm:ProjectVm={lima,instance:'p03',limaHome:dir,hostRoot:'/test',device:1,inode:2,guestDevice:'1',guestInode:'2',
    runnerSha256:createHash('sha256').update('test runner').digest('hex'),bootId,carriers:{}};
  const witness=await captureProjectDomain(vm,id,'0'.repeat(64),new AbortController().signal);
  assert(witness);
  const event:AcceptanceEvidence={id:randomUUID(),invocationId:id,kind:'diagnostic',createdAt:new Date().toISOString(),detail:witness};
  assert.equal((await observeProjectDomain(vm,id,[event])).state,'exited');
  for(const events of [[],[event,event],[{...event,invocationId:randomUUID()}],[{...event,detail:{...witness,bootId:randomUUID()}}],
    [{...event,detail:{...witness,invocationId:randomUUID()}}],[{...event,detail:{...witness,pid:'33/'}}]]){
    assert.equal((await observeProjectDomain(vm,id,events)).state,'unknown');
  }
  assert.equal((await observeProjectDomain({...vm,instance:'other'},id,[event])).state,'unknown');
});
