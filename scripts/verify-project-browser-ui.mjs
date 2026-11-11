// Real headless Chrome, an isolated workbench and a scripted member. No provider or VM.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createApplication} from '../server/index.ts';

const out=resolve(process.env.VALIDATION_OUTPUT_DIR || await mkdtemp(join(await realpath(tmpdir()),'browser-workbench-')));
await mkdir(out,{recursive:true,mode:0o700});
const site=await mkdtemp(join(await realpath(tmpdir()),'browser-demo-site-'));
let saved=''; const marker=randomUUID();
const template='<meta charset=utf-8><h1>'+marker+'</h1><label>备注<input></label><button>保存</button><p>__SAVED__</p><script>document.querySelector("button").onclick=async()=>{await fetch("/save",{method:"POST",body:document.querySelector("input").value});location.reload()}</script>';
let result,app,calls=0;
try {
  app=await createApplication({port:0,workspace:join(out,'default'),dataDir:join(out,'data'),collaborationRuntime:{
    projectWorkAvailability:()=>({available:true}),probe:async()=>[],
    async runProjectService(req) {
      req.listening(async input=>{
        if(input.method==='POST' && input.path==='/save')saved=Buffer.from(input.body,'base64').toString();
        return {status:200,mime:'text/html; charset=utf-8',body:Buffer.from(template.replace('__SAVED__',saved)).toString('base64')};
      });
      await new Promise(resolve=>req.signal.addEventListener('abort',resolve,{once:true}));
    },
    async invoke(req){
      const id=++calls;
      assert.equal(req.projectBrowser,true);req.onEvent({kind:'accepted',detail:{source:'browser-ui-fixture'}});
      const steps=id===1?[{action:'inspect'},{action:'fill',target:'备注',value:'已验证'},{action:'click',target:'保存'},{action:'reload'},{action:'expect',target:'已验证'}]
        :[{action:'reload'},{action:'expect',target:'不应该存在的文字'}];
      try {result=await req.onToolCall('project_browser_check',{steps},'check-'+id);} catch(e){result={error:e.message};throw e;}
      req.onEvent({kind:'process_exit',detail:{confirmed:true}});return {text:'验收已结束。',continuity:'unknown'};
    }}});
  const store=app.collaborationStore,{url}=await app.start();
  const post=async(path,body)=>{const res=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':app.csrfToken},body:JSON.stringify(body)});const data=await res.json();assert(res.ok,JSON.stringify(data));return data;};
  const {conversation:c}=await post('/api/conversations',{title:'页面操作',memberIds:['codex'],defaultMemberId:'codex',requestId:randomUUID()});
  const path='/api/conversations/'+c.id;
  const g=await post(path+'/workspace-preview',{path:site,mode:'project-work'});
  await post(path+'/workspace-apply',{previewId:g.id,requestId:randomUUID()});
  await post(path+'/project-preview/start',{mode:'service',previousId:null,grantRevision:store.workbench.conversation(c.id).workspaceGrant.revision});
  for(let i=0;i<50;i++) {if((await (await fetch(url+path+'/project-preview')).json()).status==='running')break;await delay(100);}
  let firstShot;
  for(const expected of [true,false]) {
    result=undefined;
    await post(path+'/messages',{content:'@Codex 请验收当前预览的表单。',requestId:randomUUID()});
    for(let i=0;i<180 && !result;i++) await delay(250);
    assert.equal(result?.passed,expected,JSON.stringify(result));
    assert(result.text.includes(marker));
    const event=store.detail(c.id).evidence.find(e=>e.detail.evidenceId===result.evidenceId && e.detail.result);
    assert(event);const shot=url+'/api/invocations/'+event.invocationId+'/browser-evidence/'+result.evidenceId+'/after.png';
    for(const url of [shot,shot.replace('after.png','before.png')]){const res=await fetch(url);assert(res.ok);const bytes=Buffer.from(await res.arrayBuffer());assert.equal(bytes.readUInt32BE(0),0x89504e47);}
    if(expected) {assert.equal(saved,'已验证');assert.equal(result.asserted,true);assert(result.text.includes('已验证'));assert(result.controls.includes('保存'));firstShot=shot;}
    else assert(result.error.includes('不应该存在的文字'));
  }
  store.workbench.revokeWorkspace(c.id,store.workbench.conversation(c.id).revision,randomUUID());
  assert(!(await fetch(firstShot)).ok);
  await writeFile(join(out,'result.json'),JSON.stringify({passed:true,realBrowser:true,modelCalls:0,checks:['fill/click','visible text','real marker','negative assertion','two PNGs','revoked evidence access']}));console.log('PASS',out);
}finally {await app?.close();}
