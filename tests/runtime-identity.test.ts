import assert from 'node:assert/strict';
import {test} from 'node:test';
import {executionIdentity} from '../shared/runtime-identity.js';
import type {AcceptanceEvidence,CollaborationInvocation,ExecutionContractSnapshot} from '../shared/collaboration.js';
const member={id:'m',name:'成员',carrier:'claude-cli' as const,model:'glm-5.3',enabled:true,instructions:''};
const run={id:'run',member,status:'running',acceptance:'unknown',teardown:'unknown'} as CollaborationInvocation;
const contract={memberSnapshot:member,accountMetadataSnapshot:{id:'a',name:'智谱',provider:'claude',auth:'api'}} as ExecutionContractSnapshot;
const event=(invocationId:string,kind:AcceptanceEvidence['kind'],model:string)=>({id:'e',invocationId,kind,detail:{model}} as AcceptanceEvidence);
test('execution identity never treats configured or diagnostic models as a native model receipt',()=>{
 const value=executionIdentity(run,contract,[event('run','diagnostic','claimed-model'),event('other','session','other-model')]);
 assert.match(value.model,/配置值，待确认/);assert.match(value.status,/等待接受确认/);assert.equal(value.authentication,'API 密钥');
});
test('execution identity uses its own native model receipt and frozen member rather than edited display configuration',()=>{
 const edited={...run,member:{...member,carrier:'codex-app-server' as const,model:'new'}};
 const value=executionIdentity(edited,contract,[event('run','session','glm-5.3')]);
 assert.equal(value.runtime,'Claude Code CLI');assert.equal(value.model,'glm-5.3');assert.equal(value.authentication,'API 密钥');
});
test('execution identity preserves unknown legacy authentication and uncertain process exit',()=>{
 const value=executionIdentity({...run,status:'cancelled'},undefined,[]);assert.match(value.authentication,/未记录/);assert.match(value.status,/退出待核查/);
 assert.equal(executionIdentity({...run,status:'cancelled',teardown:'confirmed'},contract,[]).status,'已停止');
});
