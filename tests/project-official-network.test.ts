import test from 'node:test';
import assert from 'node:assert/strict';
import {applySystemProxy} from '../server/collaboration/project-official-network.js';
test('only enabled local system proxy is inherited by a host CLI lacking its own explicit route',()=>{
 const config='  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 7897\n  HTTPSEnable : 1\n  HTTPEnable : 0';
 assert.deepEqual(applySystemProxy({},config),{https_proxy:'http://127.0.0.1:7897',HTTPS_PROXY:'http://127.0.0.1:7897'});
 for(const invalid of [config.replace('127.0.0.1','remote.invalid'),config.replace('7897','70000'),config+'\nProxyAutoConfigEnable : 1'])
   assert.deepEqual(applySystemProxy({},invalid),{});
 assert.deepEqual(applySystemProxy({HTTPS_PROXY:'operator'},config),{HTTPS_PROXY:'operator'});
});
