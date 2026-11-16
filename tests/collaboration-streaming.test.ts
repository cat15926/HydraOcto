import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readProviderMessage } from '../server/collaboration/runtime-api-stream.js';
import { streamRedactor } from '../server/collaboration/stream-redaction.js';

function frames(values:unknown[]) {
  const buffer = new TextEncoder().encode(values.map(v=>'data: '+(v==='[DONE]' ? v : JSON.stringify(v))+'\r\n\r\n').join(''));
  let i=0;
  return new Response(new ReadableStream({pull(c){if(i>=buffer.length)c.close();else {c.enqueue(buffer.slice(i,i+7));i+=7;}}}),{headers:{'Content-Type':'text/event-stream'}});
}
test('OpenAI stream assembles tool arguments and emits only visible text even across UTF-8 boundaries',async()=>{
  const choice=(delta:object,finish_reason:string|null=null)=>({choices:[{index:0,delta,finish_reason}]});
  const chunks:string[]=[];
  const {data}=await readProviderMessage(frames([choice({role:'assistant',reasoning_content:'hidden'}),choice({content:'你好',tool_calls:[{index:0,id:'t',type:'function',function:{name:'read',arguments:'{"p"'}}]}),choice({tool_calls:[{index:0,function:{arguments:':1}'}}]},'tool_calls'),'[DONE]']),false,t=>chunks.push(t));
  assert.deepEqual(chunks,['你好']);assert.equal(data.choices[0].message.tool_calls[0].function.arguments,'{"p":1}');
});
test('Anthropic stream keeps signed reasoning for provider continuation and requires a terminal event',async()=>{
  const rows=[{type:'message_start',message:{id:'m',type:'message',role:'assistant',content:[]}},{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}},{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'hidden'}},{type:'content_block_start',index:1,content_block:{type:'text',text:''}},{type:'content_block_delta',index:1,delta:{type:'text_delta',text:'正文'}},{type:'message_delta',delta:{stop_reason:'end_turn'}}];
  const chunks:string[]=[];
  const {data}=await readProviderMessage(frames([...rows,{type:'message_stop'}]),true,t=>chunks.push(t));
  assert.deepEqual(chunks,['正文']);assert.equal(data.content[0].thinking,'hidden');
  await assert.rejects(readProviderMessage(frames(rows),true,()=>{}),/Incomplete/);
});
test('split configured credentials stay out of visible fragments',()=>{
  const safe=streamRedactor(['sample-secret']);
  assert.equal(['hello sam','ple-se','cret world'].map(safe).join(''),'hello [redacted] world');
});
