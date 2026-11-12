// Run against a read-only source snapshot. No worker or model is started.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { Store } from '../server/store.ts';
import { CollaborationStore } from '../server/collaboration/store.ts';

const [path,...extra] = process.argv.slice(2);
assert(path && !extra.length,'Provide the path to an existing schema 16 or 17 application database');
function history(db) {
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('cc_schema','service_lease') AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({name})=>{
    const hash=createHash('sha256');
    const safeName='"'+name.replaceAll('"','""')+'"';
    let count=0;
    // Compare rows, not just counts; IDs, binary data and frozen JSON must survive byte for byte.
    for(const row of db.prepare('SELECT * FROM '+safeName+' ORDER BY rowid').iterate()){
      hash.update(JSON.stringify(row));hash.update('\n');count++;
    }
    return [name,{count,sha256:hash.digest('hex')}];
  }));
}
const schema=db=>db.prepare('SELECT version FROM cc_schema').get().version;
const directory=await mkdtemp(join(tmpdir(),'hydra-e-migration-'));
const copy=join(directory,'copy.sqlite');
try{
  const source=new DatabaseSync(resolve(path),{readOnly:true});
  try{ await backup(source,copy); } finally {source.close();}
  await chmod(copy,0o600);
  // Release only the cloned runtime lease. The running installation keeps its lease.
  const before=new DatabaseSync(copy);
  before.exec('UPDATE service_lease SET expires_at=0');
  let version,rows;
  try {version=schema(before);assert([16,17].includes(version));rows=history(before);} finally {before.close();}
  const owner=new Store(copy);
  try{
    new CollaborationStore(owner);
    assert.equal(schema(owner.db),18);
    const after=history(owner.db);
    for(const [key,original] of Object.entries(rows))assert.deepEqual(after[key],original,'Prior rows changed in '+key);
    assert.deepEqual(owner.db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(owner.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    console.log(JSON.stringify({from:version,to:18,originalTables:Object.keys(rows).length,originalRows:Object.values(rows).reduce((n,t)=>n+t.count,0),
      addedTables:Object.keys(after).filter(k=>!Object.hasOwn(rows,k)),historicalRowsUnchanged:true,integrity:'ok',passed:true}));
  }finally{owner.close();}
}finally{await rm(directory,{recursive:true,force:true});}
