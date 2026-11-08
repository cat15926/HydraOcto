// Only native tool results can supply a marker to the scripted second turn or reviewer.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { nativeFixtureStream } from './project-model-fixture.js';

export type Carrier = 'codex' | 'claude';
export async function sessionFixture(id:Carrier, folder:string, credential:string) {
  if (!/^p[23]-[A-Za-z0-9]+$/.test(folder)) throw new Error('Expected a synthetic directory');
  const path = folder+'/review.txt';
  const state = { phase:'first' as 'first'|'second'|'write'|'review'|'export', step:0 };
  const rounds: {phase:string;step:number;tool:string;receivedMarker:boolean;exportResult?:string}[] = [];
  const diagnostics:string[] = [];
  const server = createServer(async (req,res) => {
    const json = (n:number,body:unknown) => {res.writeHead(n,{'content-type':'application/json'});res.end(JSON.stringify(body));};
    try {
      if (req.method !== 'POST' || (req.headers.authorization !== 'Bearer '+credential && req.headers['x-api-key'] !== credential)) return json(403,{});
      let raw='';
      for await (const chunk of req) { raw+=chunk; if (raw.length>8_388_608) return json(413,{}); }
      if (req.url?.includes('count_tokens')) return json(200,{input_tokens:200});
      const input = JSON.parse(raw), {phase} = state, step=state.step;
      const names:string[] = (input.tools ?? []).flatMap((t:any)=>[t.name,...(t.tools ?? []).map((s:any)=>s.name)]).filter(Boolean);
      const shell=id==='claude'?'Bash':names.includes('exec_command')?'exec_command':'shell_command';
      const reviewTool=names.find(n=>n.endsWith('project_review_read'));
      const consult=names.find(n=>n.endsWith('collaboration_request'));
      const main=phase==='review' ? Boolean(reviewTool) : names.includes(shell);
      const returned = id==='codex' ? (input.input ?? []).filter((it:any)=>it.type==='function_call_output')
        : (input.messages ?? []).flatMap((it:any)=>Array.isArray(it.content)?it.content.filter((b:any)=>b.type==='tool_result'):[]);
      const marker=JSON.stringify(returned).match(/P2_[a-f0-9]{32}/)?.[0];
      let action:{name:string;args:Record<string,unknown>}|undefined, answer='已处理。';
      if (main) {
        state.step++;
        if(step>6) return json(400,{});
        let command:string|undefined;
        if(phase==='first' && step===0) command='cat '+folder+'/private.txt && echo ready > '+folder+'/first.txt';
        if(phase==='second' && step===0 && marker) command='echo '+marker+' > '+folder+'/second.txt';
        if(phase==='export' && step===0) command='cp '+folder+'/seed.csv '+folder+'/monthly.csv';
        if(phase==='write' && step===0) command='cp '+folder+'/private.txt '+path;
        if(command) action={name:shell,args:shell==='exec_command'?{cmd:command}:{command,description:'验证项目文件'}};
        if(phase==='export' && step===1){
          const exportTool=names.find(n=>n.endsWith('project_export_request'));
          if(exportTool) action={name:exportTool,args:{path:folder+'/monthly.csv'}};
        }
        if(phase==='write' && step===1 && consult) action={name:consult,args:{targets:['claude'],content:'请实际读取指定文件，并报告文件中的验收标记。',projectReview:{paths:[path]}}};
        if(phase==='review' && step===0 && reviewTool) action={name:reviewTool,args:{path}};
        if(phase==='review' && step>0 && marker) answer='已读取，文件标记为 '+marker;
        const exportResult=phase==='export' && step===2 ? ['written','declined','failed','cancelled','expired','unknown'].find(state=>JSON.stringify(returned.at(-1) ?? '').includes(state)) : undefined;
        rounds.push({phase,step,tool:action?.name ?? 'finish',receivedMarker:!!marker,...(exportResult?{exportResult}:{})});
        if(!action && (step===0 || phase==='review' && !marker || phase==='write' && step===1)) diagnostics.push('Missing expected input/tool: '+phase+' '+step+' '+names.join(',').slice(0,700));
      } else diagnostics.push('auxiliary: '+names.join(',').slice(0,220));
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(nativeFixtureStream(id,input.model,randomUUID().replaceAll('-',''),answer,action));
    } catch { if(!res.headersSent) json(400,{}); else res.end(); }
  });
  await new Promise<void>((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
  return {baseUrl:'http://127.0.0.1:'+(server.address() as AddressInfo).port+'/v1',rounds,diagnostics,
    phase(value:typeof state.phase){state.phase=value;state.step=0;},
    async close(){server.closeAllConnections(); await new Promise<void>(ok=>server.close(()=>ok()));}};
}
