import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/store.js';
import { CollaborationStore } from '../server/collaboration/store.js';
import { runtimeTools } from '../server/collaboration/runtime-common.js';
import { sessionFingerprint } from '../server/collaboration/continuity.js';

test('upgrading schema 16 preserves old input and authority, new contracts bind decision tools to public in-room work', () => {
  const directory=mkdtempSync(join(tmpdir(),'hydra-e67-migrate-')), file=join(directory,'state.sqlite');
  let owner=new Store(file);
  let store=new CollaborationStore(owner);
  try {
    const room=store.create({requestId:randomUUID(),title:'原房间',memberIds:['claude'],defaultMemberId:'claude'}).conversation;
    const old=store.send(room.id,{requestId:randomUUID(),content:'第一份公开委托'}).source;
    delete old.coordinationPolicy;
    store.visibility.put('cc_sources',old);
    const run=store.admitNext()!.invocations[0]!;
    const frozen=store.prepareInput(run.id), contract=store.contract(run.id);
    assert(!frozen.prompt.includes('opinion_open'));
    const historical=()=>['cc_sources','cc_contracts','cc_payloads','cc_messages'].map(table=>owner.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all());
    const before=historical();
    owner.db.exec('DROP TABLE cc_version_package_reads; DROP TABLE cc_version_packages; DROP TABLE cc_opinion_rounds; UPDATE cc_schema SET version=16');
    owner.close();
    owner=new Store(file);
    store=new CollaborationStore(owner);
    assert.equal(owner.db.prepare('SELECT version FROM cc_schema').get()?.version,18);
    assert.deepEqual(historical(),before);
    assert.deepEqual(store.prepareInput(run.id),frozen);
    assert.deepEqual(store.obligations.opinions.list(room.id),[]);
    assert.deepEqual(store.versionPackages.list(room.id),[]);
    assert.equal(store.admitSource({conversationId:room.id,requestedTargets:['claude'],coordinationOriginSourceId:old.id,kind:'job_result',content:'旧委托接回',depth:0}).coordinationPolicy,undefined);
    const latest=store.send(room.id,{requestId:randomUUID(),content:'第二份公开委托'}).source;
    assert.equal(latest.coordinationPolicy,'decision-material-v1');
    const fresh={...contract,coordinationPolicy:latest.coordinationPolicy};
    const published=(c:typeof fresh)=>runtimeTools(c).map(t=>t.name);
    assert(published(fresh).includes('opinion_submit') && published(fresh).includes('package_review'));
    assert(!published(contract).includes('package_review'));
    const identity={supported:true,fingerprint:'unchanged-auth',reason:'fixture'};
    assert.notEqual(sessionFingerprint(contract,identity),sessionFingerprint(fresh,identity));
    const privateSource=store.send(room.id,{requestId:randomUUID(),content:'私聊',privateTo:['claude']}).source;
    assert.equal(privateSource.coordinationPolicy,undefined);
    const other=store.create({requestId:randomUUID(),title:'另房',memberIds:['claude'],defaultMemberId:'claude'}).conversation;
    assert.throws(()=>store.admitSource({conversationId:other.id,requestedTargets:['claude'],coordinationOriginSourceId:latest.id,kind:'job_result',content:'错误接回',depth:0}),/其他会话/);
  } finally { owner.close(); rmSync(directory,{recursive:true,force:true}); }
});
