/* Original interaction prototype. No model, authentication or network calls. */
(() => {
  'use strict';
  const STORAGE = 'collab-review-prototype-v4';
  const members = {
    lin: { name: '林', alias: '@lin', role: '方案与复核', runtime: 'Claude Code', family: 'claude', cls: '', description: '拆解问题、组织协作，结合证据复核结果。' },
    xu: { name: '序', alias: '@xu', role: '实现与验证', runtime: 'Codex', family: 'codex', cls: 'codex', description: '实现具体方案，通过验证提交可追踪的结果。' },
    zhi: { name: '知', alias: '@zhi', role: '资料与分析', runtime: 'API', family: 'api', cls: 'api', description: '检索材料、交叉检查约束，提供独立判断。' }
  };
  const scenarios = {
    assist: { name: '01 · 边工作，边请求协助', title: '协作可以同时发生', subtitle: '独立协助立即开始；依赖任务等待前序材料。', steps: 6 },
    parallel: { name: '02 · 并行复核与统一返回', title: '独立判断，一次汇总', subtitle: '分支进展不会打断发起者；整组终结才统一返回。', steps: 6 },
    consume: { name: '03 · 运行中补充与消费归并', title: '补充只交付给正确的一轮', subtitle: '发表、排队、输入交付、读取、业务处理分别留证。', steps: 5 },
    pause: { name: '04 · 暂停、积累与继续', title: '暂停的是推进，而非记录', subtitle: '结果仍然保存；只有明确继续，才会再次推进。', steps: 5 },
    handoff: { name: '05 · 正式转交与责任版本', title: '责任可以转交，不能凭一句话跳过', subtitle: '提议、接受、旧执行释放与责任变更，各有明确边界。', steps: 6 },
    fairness: { name: '06 · 用户工作与自动链公平调度', title: '让新请求进得来，让协作继续走', subtitle: '在领取边界选择可运行工作；忙成员不堵住其他空闲成员。', steps: 8 },
    context: { name: '07 · 上下文审计与会话重建', title: '这一轮，到底提供了哪些材料', subtitle: '保留明确请求与来源；会话失效后，从公共记录重建。', steps: 6 },
    recovery: { name: '08 · 结果未知与安全恢复', title: '没有回执，不等于没有执行', subtitle: '先核对既有结果与进程，再决定续接；暂停由用户明确解除。', steps: 6 }
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const name = id => members[id]?.name || ({ user: '你', system: '协作平台' }[id] || id);
  const accountName = (family, n) => `${family === 'claude' ? 'Claude' : family === 'codex' ? 'Codex' : 'API'} 演示账户 ${n === 'one' ? '一' : '二'}`;
  const resolvedAccount = id => state.bindings[id] === 'follow' ? state.defaults[members[id].family] : state.bindings[id];
  let state, toastTimer;
  function fresh(scenario = 'assist') {
    return { version: 4, recentExplicitTargets:[], defaultRecipient:'lin', lastSuccessfulResponder:null, history: [], events: [], owner: ({consume:'xu',fairness:'xu',context:'zhi',recovery:'xu'}[scenario]||'lin'), ownerRevision:1, handoff:null, queue:[], userStreak:0, claims:[], contextItems:[], contextMode:'尚未组装', sessions:{lin:'lin-session-1',xu:'xu-session-1',zhi:'无原生会话'}, configVersion:1, runConfigs:{}, recovery:null, recoveryChoice:'found', selectedRelation:null, view: 'conversation', scenario, step: 0, serial: 0, messages: [], requests: [], edges: [], selectedMessage: null, selectedMember: 'lin', paused: false, pauseGeneration: 0, taskStatus: '推进中', states: {lin:'执行中',xu:'空闲',zhi:'空闲'}, invocations:{lin:1,xu:0,zhi:0}, bindings:{lin:'follow',xu:'follow',zhi:'follow'}, defaults:{claude:'one',codex:'one',api:'one'}, snapshots:{lin:'one',xu:'one',zhi:'one'}, pendingDefaults:{}, group: null, returns: 0, observation: '同一个会话中，成员可以主动发起协作。点击“下一步”观察消息与责任如何变化；这是可操作的状态演示。', nextHint: '林将向序发出一个可立即处理的独立协助请求。', persisted: false };
  }
  function message(sender, body, options = {}) {
    const id = `M-${String(++state.serial).padStart(3,'0')}`;
    const recipients = options.to || [];
    const item = {id,sender,body,kind:options.kind || 'progress', requestId:options.requestId || null, time:`09:${String(20+state.serial).padStart(2,'0')}`, deliveries: recipients.map(member => ({member,status:options.delivery || (state.paused?'积累待恢复':'待派发'),invocation: options.invocation || null, receipts:['消息已发表'], consumed:false})), ...options};
    // Delivery records are platform-owned, never accepted from arbitrary message text.
    state.messages.push(item); state.selectedMessage=id;
    if(members[sender]&&['reply','result'].includes(item.kind))state.lastSuccessfulResponder=sender;
    return item;
  }
  function initScenario(id, preserveSettings = true) {
    const old = state;
    state = fresh(id);
    if (old && preserveSettings) { state.bindings = {...old.bindings}; state.defaults = {...old.defaults}; state.configVersion=old.configVersion; state.snapshots = Object.fromEntries(Object.keys(members).map(k => [k,resolvedAccount(k)])); }
    if (id === 'assist') message('user','@林 请完善本地协作方案，并组织成员检查实现约束。',{to:['lin'],delivery:'本轮已交付',kind:'work'});
    if (id === 'parallel') { message('user','@林 请让序和知独立复核方案 v1，收齐后告诉我结论。',{to:['lin'],delivery:'本轮已交付',kind:'work'}); state.nextHint='林将创建一个双分支复核组，固定方案 v1 和公共历史截止点。'; }
    if (id === 'consume') { state.states.lin='等待'; const started=startMember('xu'); message('user','@序 请整理协作请求的数据结构。',{to:['xu'],delivery:started?'本轮已交付':'等待执行槽',kind:'work',invocation:started?'xu-run-1':null}); state.nextHint='序开始执行后，用户继续补充一个约束。'; }
    if (id === 'pause') { message('user','@林 请组织一次方案复核，我稍后再确认。',{to:['lin'],delivery:'本轮已交付',kind:'work'}); state.nextHint='先建立需要正式结果的复核请求。'; }
    if (['fairness','context','recovery'].includes(id)) {state.states.lin='空闲';state.states.xu='空闲';state.states.zhi='空闲';if(startMember(state.owner))state.selectedMember=state.owner;}
    if(id==='handoff') {message('user','@林 请将后续实现与最终交付责任正式转交给序，保留审计记录。',{to:['lin'],delivery:'本轮已交付',kind:'work'});state.nextHint='林先提出转交；此时负责人仍然是林。';}
    if(id==='fairness') {message('user','请处理我新增的检查要求，同时继续已有自动协作链。',{kind:'work'});state.nextHint='序仍在执行旧工具；先观察知能否领取独立工作。';state.queue=[{id:'A1',origin:'自动',to:'xu',seq:1,status:'待领取'},{id:'A0',origin:'自动',to:'zhi',seq:2,status:'待领取'},{id:'U1',origin:'用户',to:'xu',seq:3,status:'待领取'},{id:'U2',origin:'用户',to:'xu',seq:4,status:'待领取'},{id:'U3',origin:'用户',to:'xu',seq:5,status:'待领取'},{id:'U4',origin:'用户',to:'xu',seq:6,status:'待领取'},{id:'A2',origin:'自动',to:'xu',seq:7,status:'待领取'}];}
    if(id==='context') {state.states.zhi='等待';state.selectedMember='xu';const source=message('zhi','请序复核订单方案 v3 的事务边界，确认 Redis 故障时也不能超卖。',{to:['xu'],delivery:'请求已保存 · 等待输入',kind:'contract',requestId:'R-701'});state.requests.push({id:'R-701',from:'zhi',to:'xu',title:'复核订单方案 v3 的事务边界',status:'等待输入',generation:1,depends:'输入审计与完整正文接受',group:null,manual:false,result:null,returnStatus:'尚未产生',wakeCount:0,artifact:'订单方案 v3',messageId:source.id});state.edges.push({from:'zhi',to:'xu',type:'明确请求已保存 · 等待输入',request:'R-701',status:'waiting'});state.nextHint='构建本轮输入清单，逐项记录材料与省略原因。';}
    if(id==='recovery') {message('user','@序 请运行演示产物发布，并在结果不明确时先核对。',{to:['xu'],delivery:'本轮已交付',kind:'work'});state.recovery={operation:'OP-801',attempt:0,status:'尚未发出',process:'未启动工具',result:null,retryAllowed:false};state.nextHint='发出一次模拟工具操作，建立稳定的操作身份。';}
    Object.keys(members).forEach(id=>captureRunConfig(id));
    save(); render();
  }
  function save() {
    try { state.persisted=true; localStorage.setItem(STORAGE, JSON.stringify(state)); }
    catch { state.persisted=false; }
  }
  try {
    const value=JSON.parse(localStorage.getItem(STORAGE)||'null');
    if(value?.version===4 && scenarios[value.scenario] && Array.isArray(value.messages)) {state=value;state.persisted=true;}
  } catch { /* File origins may disallow storage. The prototype still works in memory. */ }
  const needsInitialScenario = !state;
  if(!state) state = fresh('assist');

  const processOccupied = id => ['执行中','等待退出','核对中'].includes(state.states[id]);
  const isOccupied = id => processOccupied(id)||state.states[id]==='等待交接';
  const freeformQueueOnly = () => state.step < scenarios[state.scenario].steps || ['handoff','recovery'].includes(state.scenario);
  function startMember(id) {
    if(state.paused||isOccupied(id)||Object.keys(members).filter(processOccupied).length>=2)return false;
    state.invocations[id]++;state.snapshots[id]=resolvedAccount(id);
    state.states[id]='执行中';captureRunConfig(id);return true;
  }
  function captureRunConfig(id){state.runConfigs[id]={version:state.configVersion,runtime:members[id].runtime,account:state.snapshots[id],workspace:'方案评审 / workspace-v1',session:state.sessions[id],run:invocation(id)};}
  function remember(){const {history,...snapshot}=state;state.history.push(JSON.parse(JSON.stringify(snapshot)));}
  function eventRecord(title, detail){state.events.push({step:state.step,title,detail});}
  function previousStep(){if(!state.history.length)return;const history=state.history;state={...history.pop(),history};save();render();}
  function invocation(id){return `${id}-run-${state.invocations[id]}`;}
  function deliver(msg,id,status='本轮已交付') {
    const d=msg?.deliveries.find(v=>v.member===id); if(!d)return;
    d.status=status; d.invocation=invocation(id);
    if(!d.receipts.includes('目标待办已建立'))d.receipts.push('目标待办已建立');
    if(status==='本轮已交付'&&!d.receipts.includes('完整正文已交给指定执行'))d.receipts.push('完整正文已交给指定执行');
  }
  function request({id,from='lin',to='xu',title,depends=null,group=null,manual=false}) {
    const r={id,from,to,title,status:depends?'等待依赖':state.paused?'积累待恢复':'处理中',generation:1,depends,group,manual,result:null,returnStatus:'尚未产生',wakeCount:0,artifact:'方案 v1'};
    state.requests.push(r);
    const m=message(from, title, {to:[to],kind:'contract',requestId:id,delivery:depends?'等待依赖':state.paused?'积累待恢复':'本轮已交付'});
    r.messageId=m.id;
    if(!depends&&!state.paused){if(startMember(to)){r.invocation=invocation(to);deliver(m,to);}else {r.status='排队中';m.deliveries[0].status='已排队 · 等待执行槽';}}
    state.edges.push({from,to,type:depends?'依赖满足后':r.status==='排队中'?'等待执行槽':'需正式结果',request:id,status:depends||r.status==='排队中'?'waiting':'active'});
    return r;
  }
  function settle(r,status='已完成',body='已核对演示材料，正式提交本请求的结论与证据。') {
    if(!r)return;
    if(['已完成','已失败','已超时','已取消'].includes(r.status)) {message(r.to,body,{kind:'late',requestId:r.id});toast('已保存为迟到证据，不改变原结算，也不再次唤醒。');return;}
    r.status=status;r.result=body;r.completedAt=state.serial+1;
    message(r.to,body,{kind:status==='已完成'?'result':'failure',requestId:r.id});
    if(r.invocation&&invocation(r.to)===r.invocation)state.states[r.to]='空闲';
    const edge=state.edges.find(e=>e.request===r.id);if(edge){edge.status='done';edge.type=status==='已完成'?'正式结果已提交':status;}
    if(r.group){r.returnStatus='由组统一回传';maybeCloseGroup();}
    else emitReturn(r);
    emitGroupReturn();
  }
  function emitReturn(r) {
    if(!r)return;
    if(r.from==='user'){r.returnStatus=state.paused?'已保存 · 待恢复':'已通知用户';return;}
    if(r.wakeCount>0)return;
    r.returnStatus=state.paused?'已保存 · 待恢复':isOccupied(r.from)?'已保存 · 待当前轮结束':'已交付';
    if(state.paused||isOccupied(r.from))return;
    if(!startMember(r.from)){r.returnStatus='已保存 · 等待执行槽';return;}
    r.wakeCount=1;state.returns++;
    const m=message('system',`${r.id} 的正式结果已交给${name(r.from)}。只产生一次有效续跑。`,{to:[r.from],kind:'return',requestId:r.id,delivery:'本轮已交付'});deliver(m,r.from);
  }
  function emitGroupReturn(){
    const group=state.group;if(!group?.closed||group.wakeCount>0)return;
    const recipient=group.returnTo||'lin';
    group.returnStatus=state.paused?'已保存 · 待用户继续':isOccupied(recipient)?'已保存 · 等待接收者释放':'已保存 · 等待执行槽';
    if(!startMember(recipient))return;
    group.wakeCount=1;group.returnStatus='已交付';group.returnInvocation=invocation(recipient);state.returns++;
    const m=message('system',`整组汇总已交给${name(recipient)}，统一续跑一次。`,{to:[recipient],delivery:'本轮已交付',kind:'return'});deliver(m,recipient);
  }
  function maybeCloseGroup(force=false) {
    if(!state.group)return;
    if(state.group.closed){emitGroupReturn();return;}
    const branches=state.requests.filter(r=>r.group===state.group.id);
    if(!force&&branches.some(r=>!['已完成','已失败','已超时','已取消'].includes(r.status)))return;
    state.group.closed=true;state.group.summarySaved=true;state.group.returnStatus='已保存 · 待交付';
    const summary=branches.map(r=>`${name(r.to)}：${r.status}`).join('；');
    message('system',`复核组 ${state.group.id} 已终结。${summary}。已形成一份组级汇总，分支不会各自唤醒发起者。`,{kind:'group'});
    emitGroupReturn();
  }
  function pauseTask() {
    if(state.paused)return;
    state.paused=true;state.pauseGeneration++;state.taskStatus='已暂停';
    if(['handoff','recovery'].includes(state.scenario)){
      Object.keys(state.states).forEach(id=>{if(state.states[id]==='执行中')state.states[id]='等待退出';});
      message('system','调度已关闭，停止请求已发出；未收到退出证据的执行继续保留占用。',{kind:'control'});
      state.observation='已暂停调度；停止请求不等于进程退出。等待后续退出或核对证据后释放占用。';return;
    }
    Object.keys(state.states).forEach(id=>{if(state.states[id]==='执行中')state.states[id]='已停止';});
    state.observation='任务自动推进已关闭。已有消息与结果继续保存；不会因成员结束、迟到结果或刷新页面而自动恢复。';
    message('system','用户暂停任务。相关活动轮次在本演示中已停止；调度保持关闭。',{kind:'control'});
  }
  function resumeTask() {
    if(!state.paused)return;
    if(state.scenario==='recovery'&&state.step<4){toast('先核对操作结果与进程退出；未知结果不能靠恢复按钮绕过。');return;}
    state.paused=false;state.pauseGeneration++;state.taskStatus='推进中';
    message('system','用户明确继续任务。先对账积累结果，再派发尚未消费的工作。',{kind:'control'});
    for(const r of state.requests){
      if(freeformQueueOnly()&&r.manual)continue;
      if(r.result&&!r.group&&r.wakeCount===0)emitReturn(r);
      else if(r.status==='积累待恢复'){
        const msg=state.messages.find(m=>m.id===r.messageId);
        if(isOccupied(r.to)){r.status='排队中';const d=msg?.deliveries.find(d=>d.member===r.to);if(d)d.status='已排队 · 下一轮';}
        else if(startMember(r.to)){r.status='处理中';r.invocation=invocation(r.to);deliver(msg,r.to);}else{r.status='排队中';}
      }
    }
    emitGroupReturn();
    for(const m of state.messages) for(const d of m.deliveries)if(d.status==='积累待恢复') {
      if(freeformQueueOnly()&&m.sender==='user'){d.status='已排队 · 本场景不模拟派发';continue;}
      if(m.kind==='notify')d.status='仅供后续上下文';
      else if(isOccupied(d.member))d.status='已排队 · 下一轮';
      else if(startMember(d.member))deliver(m,d.member);else d.status='已排队 · 等待执行槽';
    }
    state.observation='已恢复。正式结果只消费一次；刷新页面不会重复生成返回。普通知会只进入后续可见上下文。';
  }
  function nextStep(){
    const s=scenarios[state.scenario];
    if(state.step>=s.steps)return;
    if(state.paused&&!['pause','recovery'].includes(state.scenario)){toast('任务正在暂停。请先点击“继续任务”，再推进场景。');return;}
    remember();
    const before={owner:state.owner,revision:state.ownerRevision,returns:state.returns,paused:state.paused};
    state.step++;
    const step=state.step;
    if(state.scenario==='assist'){
      if(step===1){request({id:'R-101',title:'请序独立检查：协作请求必须保存哪些关联字段？你可以立即开始。'});state.observation='序立即开始独立协助，林仍在组织方案。两人可以重叠工作，任务负责人仍是林。';state.nextHint='林继续工作，同时发送不需要回复的知会。';}
      if(step===2){message('lin','@知 方案背景已更新，供你后续参考，无需回复。',{to:['zhi'],kind:'notify',delivery:'仅供后续上下文'});message('lin','我继续整理依赖边界。请序在方案 v1 正式发布后，再检查版本一致性。',{kind:'progress'});request({id:'R-102',title:'检查方案 v1 的版本一致性。',depends:'方案 v1 已发布'});state.observation='知会保存到公共历史，不启动知，也不自动回唤林。第二个请求依赖尚未发布的 v1，因此等待。';state.nextHint='序发表进展；进展不等于正式提交结果。';}
      if(step===3){message('xu','已找到请求关联和消费归并两个关键点。我正在补充证据，还没有提交正式结果。',{requestId:'R-101',kind:'progress'});state.observation='序的进展已经可见，R-101 仍在处理中。执行结束或说“完成了”都不会自动替代正式结果提交。';state.nextHint='提交 R-101 的正式结果，林的当前轮次仍继续。';}
      if(step===4){settle(state.requests.find(r=>r.id==='R-101'),'已完成','正式提交 R-101：建议关联请求身份、处理代次、来源消息和消费执行；证据为演示方案中的字段清单。');state.observation='正式结果已登记，但林仍在执行。本原型将返回排到林的下一轮，避免同时启动同一成员的第二次执行。';state.nextHint='林发布 v1 并结束本轮，释放依赖，同时消费待返回的结果。';}
      if(step===5){message('lin','方案 v1 已发布；我结束本轮，等待汇总协助结果。',{kind:'progress'});state.states.lin='等待';const r=state.requests.find(r=>r.id==='R-102');if(r&&r.status==='等待依赖'){r.depends=null;const edge=state.edges.find(e=>e.request===r.id);if(startMember('xu')){r.status='处理中';r.invocation=invocation('xu');deliver(state.messages.find(m=>m.id===r.messageId),'xu');edge.type='依赖已满足';edge.status='active';}else{r.status='排队中';edge.type='依赖已满足 · 等待执行槽';edge.status='waiting';}}emitReturn(state.requests.find(r=>r.id==='R-101'));state.observation='依赖已满足，R-102 开始。R-101 的正式结果交给林的新一轮；请求负责人和任务负责人分别记录。';state.nextHint='完成版本检查，观察两条请求各自只有一次返回。';}
      if(step===6){state.states.lin='等待';settle(state.requests.find(r=>r.id==='R-102'),'已完成','正式提交 R-102：方案 v1 与请求所绑定版本一致，演示检查通过。');message('lin','已结合两份结果更新方案。接下来由你评审是否进入开发。',{kind:'progress'});state.taskStatus='等待用户';state.observation='两条有结果契约分别结算；知会未产生返回。始终没有因为协助而改变任务负责人，也没有自动将任务标为完成。';state.nextHint='可选择其他场景，或自由发送演示消息。';}
    }
    if(state.scenario==='parallel'){
      if(step===1){state.states.lin='等待';state.group={id:'G-201',closed:false,wakeCount:0,summarySaved:false,cutoff:state.serial,variant:'timeout'};request({id:'R-201',title:'独立复核方案 v1 的实现与恢复行为。',to:'xu',group:'G-201'});request({id:'R-202',title:'独立复核方案 v1 的消息语义与边界。',to:'zhi',group:'G-201'});state.states.lin='等待';state.observation='两位成员获得同一份方案 v1 和冻结的公共历史。序提前发表的观点不会注入知的独立复核输入。';state.nextHint='序发布进展，组仍继续等待正式结果。';}
      if(step===2){message('xu','进展：请求恢复逻辑基本完整，正在核对迟到结果。此消息不结算分支。',{requestId:'R-201',kind:'progress'});state.observation='这是公开进展，林未被唤醒，组也未完成。知的本轮上下文截止点保持不变，稍后仍可读取这条消息。';state.nextHint='序正式提交结果；知仍未返回。';}
      if(step===3){settle(state.requests.find(r=>r.id==='R-201'),'已完成','正式提交 R-201：方案 v1 的恢复行为通过演示复核，附关联记录与检查点。');state.observation='序的分支已完成，只更新组内状态。整组仍等待知，尚未回唤林。可在右侧把知模拟为失败，或继续演示截止。';state.nextHint='组达到截止，按部分结果终结；也可在右侧模拟分支失败。';}
      if(step===4){const r=state.requests.find(r=>r.id==='R-202');if(!['已失败','已完成','已超时'].includes(r.status))settle(r,'已超时','R-202 达到组截止时间，未收到正式结果。已记录超时，不推断复核通过。');state.observation=state.group.wakeCount?'组以“序完成、知超时或失败”形成一份汇总，已回唤林一次。失败分支没有另开返回链。':`组已形成汇总，${state.group.returnStatus}；尚未回唤林。失败分支没有另开返回链。`;state.nextHint='知的迟到结果将保存为证据，不再次回唤。';}
      if(step===5){settle(state.requests.find(r=>r.id==='R-202'),'已完成','迟到证据：我已核对消息语义，补充两个边界说明。该结果在组终结后到达。');state.observation='迟到证据保留在历史中，G-201 的结算和回唤次数保持不变。需要采纳时，由林或用户明确决定下一步。';state.nextHint='林根据部分结果提出下一步，任务不自动验收。';}
      if(step===6){state.states.lin='等待';emitGroupReturn();if(state.group.wakeCount){message('lin','实现复核已完成；另一分支未在截止前交付。迟到材料已保存，我建议补一次针对边界的复核，再提交交付。',{kind:'progress'});state.states.lin='等待';}state.taskStatus=state.group.wakeCount?'等待用户':'等待组汇总交付';state.observation=state.group.wakeCount?'一次组级返回已完成。部分结果、缺席原因与迟到证据都可追踪，任务仍需要业务判断。':`汇总已经保存，${state.group.returnStatus}。尚未形成有效续跑。`;state.nextHint='重置本场景后，可用右侧“模拟失败”观察失败与超时采用相同汇总边界。';}
    }
    if(state.scenario==='consume'){
      if(step===1){message('xu','我已开始本轮整理，当前执行为 xu-run-1。',{kind:'progress'});const m=message('user','补充：正式结果必须关联被复核的产物版本。',{to:['xu'],kind:'supplement',delivery:'追加接受待对账',invocation:'xu-run-1'});m.deliveries[0].receipts.push('绑定目标执行 xu-run-1','待办已建立；追加接受尚不明确');state.observation='补充绑定到发送时的 xu-run-1。追加回执尚不明确，平台先对账，不悄悄改投新执行，也不重复注入。';state.nextHint='适配器确认完整正文已交付，归并当前执行与队列待办。';}
      if(step===2){const m=state.messages.find(m=>m.kind==='supplement');const d=m.deliveries[0];d.status='本轮已消费 · 待办已归并';d.consumed=true;d.invocation='xu-run-1';d.receipts.push('完整正文已交给 xu-run-1','来源消息 × 序的消费归属已保存','原队列待办已归并');state.selectedMessage=m.id;state.observation='消费事实与队列归并同时落地。即使仍看到历史待办，也不会在序结束后为这条补充再启动一轮。';state.nextHint='出现读取回执，但请求业务完成仍需另一份证据。';}
      if(step===3){const m=state.messages.find(m=>m.kind==='supplement');m.deliveries[0].receipts.push('运行时已确认读取（本场景模拟支持）');message('xu','已读取版本关联约束，并将其纳入字段设计。',{kind:'progress'});state.selectedMessage=m.id;state.observation='“读取”说明运行时读到了输入；“消费”说明它属于哪次执行；两者都不能替代业务请求的正式结果。';state.nextHint='旧执行结束后，模拟另一个迟到追加的投递失败。';}
      if(step===4){state.states.xu='空闲';const m=message('user','补充：增加来源消息引用。',{to:['xu'],kind:'stale',delivery:'旧执行失效 · 转下一轮',invocation:'xu-run-1'});m.deliveries[0].receipts.push('原目标 xu-run-1 已结束','明确未被接受，建立下一轮待办');state.observation='第二条补充原本发往 xu-run-1，但该轮已结束。确认未被接受后，明确转下一轮；第一条补充不再派发。';state.nextHint='下一轮只处理第二条补充，验证无重复消费。';}
      if(step===5){const m=state.messages.find(m=>m.kind==='stale');if(!startMember('xu')){state.observation='下一轮仍在等待执行槽，未登记交付。';state.step--;save();render();return;}deliver(m,'xu');m.deliveries[0].consumed=true;m.deliveries[0].status='下一轮已交付';m.deliveries[0].receipts.push('明确交付给 xu-run-2');message('xu','新一轮只处理尚未消费的来源引用补充；版本约束已经属于上一轮，不重复执行。',{kind:'progress'});state.selectedMessage=m.id;state.observation='下一轮明确绑定 xu-run-2。第一条补充的消费归属仍为 xu-run-1，没有因为队列恢复而重复启动。';state.nextHint='点击不同消息的“投递详情”，比较两条补充的消费路径。';}
    }
    if(state.scenario==='pause'){
      if(step===1){request({id:'R-301',title:'请序复核方案 v1，并正式返回结论。'});state.states.lin='等待';state.observation='序正在处理 R-301，林等待正式结果。此时可以暂停整个任务，或仅停止某个成员本轮回复。';state.nextHint='下一步将持久关闭任务调度，并停止相关活动执行。';}
      if(step===2){pauseTask();state.nextHint='模拟在暂停前已发出的外部结果，稍后才抵达平台。';}
      if(step===3){settle(state.requests.find(r=>r.id==='R-301'),'已完成','延迟抵达的正式结果：R-301 的方案 v1 检查已完成。结果源在暂停前已发出。');state.observation='暂停期间到达的结果已保存，标为“待恢复”。林没有启动。现在可以刷新页面观察暂停与结果仍在。';state.nextHint='明确继续任务后，平台才会消费积累的结果。';}
      if(step===4){resumeTask();state.observation='你明确继续任务，保存的正式结果被交付，林续跑一次。暂停代次已更新，旧回调不能重新打开调度。';state.nextHint='模拟旧回调重复投递，验证不会再次续跑。';}
      if(step===5){message('system','收到 R-301 的重复结果回调，命中已有提交记录；未新增结果，也未新增续跑。',{kind:'control'});state.observation='重复回调已被归并，R-301 的有效续跑仍为 1 次。停止单轮与暂停任务分开，暂停不会被回调覆盖。';state.nextHint='可再次暂停，再刷新页面；只有点击“继续任务”才恢复。';}
    }
    if(['handoff','fairness','context','recovery'].includes(state.scenario)) expandedStep(step);
    emitGroupReturn();
    const changes=[];
    if(before.owner!==state.owner)changes.push(`负责人 ${name(before.owner)} → ${name(state.owner)}，责任 v${before.revision} → v${state.ownerRevision}`);
    if(before.returns!==state.returns)changes.push(`有效续跑 ${before.returns} → ${state.returns}`);
    if(before.paused!==state.paused)changes.push(`调度 ${before.paused?'暂停':'允许'} → ${state.paused?'暂停':'允许'}`);
    eventRecord(`第 ${step} 步${changes.length?' · '+changes.join('；'):''}`,state.observation);
    save();render();scrollChat();
  }

  function queueChoice(){
    const active=Object.values(state.states).filter(s=>['执行中','等待退出','核对中'].includes(s)).length;
    if(state.paused)return {item:null,reason:'任务已暂停，禁止领取'};
    if(active>=2)return {item:null,reason:'全局两个执行槽均被占用'};
    const ready=state.queue.filter(q=>q.status==='待领取'&&state.states[q.to]==='空闲').sort((a,b)=>a.seq-b.seq);
    const human=ready.filter(q=>q.origin==='用户'),automatic=ready.filter(q=>q.origin==='自动');
    const item=human.length&&(state.userStreak<2||!automatic.length)?human[0]:automatic[0]||human[0];
    const reason=!item?'暂无可运行工作；等待资源释放':item.origin==='用户'?`用户工作可运行；连续用户领取 ${state.userStreak}/2，取用户类最早入队`:(human.length?'已连续领取 2 个用户工作，自动类获得一次机会': '当前无可运行用户工作，取自动类最早可运行项');
    return {item,reason};
  }
  function claimQueue(){const {item,reason}=queueChoice();if(!item||!startMember(item.to))return;item.status='执行中';item.reason=reason;state.userStreak=item.origin==='用户'?Math.min(2,state.userStreak+1):0;state.claims.push(item.id);state.selectedMember=item.to;message('system',`${item.id} 由${name(item.to)}领取。${reason}。`,{kind:'control'});}
  function finishQueueRuns(){for(const q of state.queue){if(q.status==='执行中'){q.status='已完成';state.states[q.to]='空闲';}}}
  function expandedStep(step){
    if(state.scenario==='handoff'){
      if(step===1){state.handoff={id:'H-501',from:'lin',to:'xu',expectedRevision:1,status:'等待序接受',accepted:false,released:false};state.edges.push({from:'lin',to:'xu',type:'转交提议 · 尚未生效',request:'H-501',status:'waiting'});message('lin','我提议由序承担后续实现和最终交付责任，交接方案 v3 与未完成清单。',{kind:'contract'});state.observation='林提出正式转交，仍是当前负责人。发消息或建立交接记录都不直接改变责任。';state.nextHint='序接受交接，平台随后检查旧任务执行占用。';}
      if(step===2){state.handoff.accepted=true;state.handoff.status='已接受 · 等待旧执行退出';state.states.xu='等待交接';message('xu','我接受交接范围；等待林的旧任务执行实际释放。',{kind:'progress'});state.observation='序已经接受，但旧任务执行仍在运行。责任仍为林 v1，序不能提前作为新负责人修改任务。';state.nextHint='请求停止旧执行；取消请求成功不等于进程已退出。';}
      if(step===3){state.states.lin='等待退出';state.handoff.status='停止请求已发送 · 退出待确认';message('system','旧执行已收到停止请求；工具子进程退出尚未确认，任务占用保留。',{kind:'control'});state.observation='停止请求只改变控制意图。旧执行尚未确认退出，林继续持有责任 v1，不能向序开放任务写入。';state.nextHint='下一步模拟得到“进程已退出、工作区占用已释放”的证据。';}
      if(step===4){state.handoff.released=true;state.handoff.status='退出已核实 · 等待原子交接';state.states.lin='空闲';message('system','模拟退出证据已核对：林的旧执行及相关工具进程已退出，任务与工作区占用已释放。',{kind:'control'});state.observation='已经核实真实退出的模拟证据。责任尚未更新；下一步使用预期责任版本 v1 提交交接。';state.nextHint='原子更新负责人和责任版本，再启动序的后续执行。';}
      if(step===5){const h=state.handoff;if(!h.accepted||!h.released||h.expectedRevision!==state.ownerRevision||state.owner!==h.from){state.observation='交接条件不满足：须已接受、已释放旧执行且责任版本匹配。';state.step--;return;}state.owner='xu';state.ownerRevision++;state.handoff.status='已生效';state.selectedMember='xu';state.states.xu='空闲';const started=startMember('xu');if(!started)state.handoff.status='责任已生效 · 后续执行等待槽';const edge=state.edges.find(e=>e.request==='H-501');edge.status='done';edge.type='正式责任已转交';message('system','H-501 生效：负责人 林 → 序，责任 v1 → v2。责任转交与后续执行分别登记。',{kind:'control'});state.observation=started?'序成为唯一负责人 v2，并开始后续执行。林可以继续协助，但不再拥有旧责任版本的写入权。':'序成为唯一负责人 v2，后续执行等待资源；尚未开始执行。';state.nextHint='让林的旧执行迟到提交一次结果，观察版本栅栏。';}
      if(step===6){state.handoff.staleRejected=true;message('system','拒绝林旧执行的交付提交：携带责任 v1，当前为序 v2。正文保存为历史证据，不结算当前交付。',{kind:'late'});state.observation='旧责任结果被拒绝用于当前交付。它仍可查阅，不能恢复林的责任，也不会覆盖序 v2 的状态。';state.nextHint='使用“上一步”对比转交前后；关系和责任卡均随状态改变。';}
    }
    if(state.scenario==='fairness'){
      if(step===1){claimQueue();state.observation='序正占用执行槽且旧工具不被抢占。A1、U1 等待序；使用独立可用工作区和账户的知领取 A0，全局活动执行为 2。';state.nextHint='旧执行与知的独立工作结束后，在新领取边界选择用户 U1。';}
      if(step>=2&&step<=7){finishQueueRuns();if(step===2)state.states.xu='空闲';claimQueue();state.observation=`本次领取 ${state.claims.at(-1)}；累计领取 ${state.claims.join(' → ')}。先过滤不可运行项，再按用户/自动配额和各类入队序号选择；不抢占正在执行的工具。`;state.nextHint=step===7?'最后一项完成，检查有限且持续可运行的候选都获得了机会。':'完成本轮，再观察下一次领取理由与配额。';}
      if(step===8){finishQueueRuns();state.taskStatus='等待用户';state.observation='所有演示工作已完成。资源释放后的顺序为 U1 → U2 → A1 → U3 → U4 → A2；初始忙碌期间知先处理 A0。该规则约束领取机会，不承诺墙钟时延。';state.nextHint='可逐步回退检查配额；刷新也保留配额与领取记录。';}
    }
    if(state.scenario==='context'){
      if(step===1){state.contextMode='准备输入 · 尚未交给运行时';state.contextItems=[
        {item:'本次明确请求',source:`R-701 / ${state.requests.find(r=>r.id==='R-701').messageId} · 知的复核请求`,representation:'全文',decision:'提供',reason:'来源可见；优先保留具体问题',version:'请求 v1'},
        {item:'不能超卖，Redis 故障时仍须正确',source:'用户已确认约束',representation:'全文',decision:'提供',reason:'有效约束；与本次检查直接相关',version:'约束 v2'},
        {item:'订单方案',source:'共享产物',representation:'引用',decision:'受控补取',reason:'固定版本，读取时仍校验权限',version:'v3'},
        {item:'既往方案讨论',source:'公开历史',representation:'摘要',decision:'提供',reason:'仅作背景；成员建议不升格为用户决定',version:'截止 M-042'},
        {item:'另一复核者的提前结论',source:'同组公开发言',representation:'未提供',decision:'延后',reason:'保证本组独立复核，保留待投递身份',version:'本组之后'},
        {item:'不可访问的触发材料',source:'未披露',representation:'未提供',decision:'权限过滤',reason:'触发身份不能绕过权限；不展示受限正文或标识',version:'不披露'}
      ];state.observation='输入清单区分全文、摘要、引用、延后和权限过滤。这里显示选择结果，不声称模型已理解或完成任务。';state.nextHint='模拟原生 session 恢复失败，保留公共请求和未处理来源。';}
      if(step===2){state.sessions.xu='失效 · xu-session-1';state.contextMode='会话续接失败 · 等待重建';state.observation='序的原生 session 失效。公共请求、用户约束、产物版本及投递记录仍在；没有取得林或知的私有 transcript。';state.nextHint='建立隔离新 session，重新核验输入清单与运行绑定。';}
      if(step===3){state.sessions.xu='xu-session-2 · 重建';state.contextMode='新会话已建 · 待输入';state.observation='从授权公共记录重建序的上下文，保留同一请求身份。当前独立复核不复用可能接触他人结论的旧会话。';state.nextHint='完成权限与材料检查后，将本轮选中的输入交给序。';}
      if(step===4){const r=state.requests.find(r=>r.id==='R-701');if(!startMember('xu')){state.observation='输入仍在等待目标执行槽，未登记完整正文接受。';state.step--;return;}else{r.status='处理中';r.depends=null;r.invocation=invocation('xu');deliver(state.messages.find(m=>m.id===r.messageId),'xu');const e=state.edges.find(e=>e.request===r.id);e.type='输入已提供 · 处理中';e.status='active';}state.contextMode='本轮输入已提供 · 模拟回执';state.contextItems.find(x=>x.item==='订单方案').representation='全文';state.contextItems.find(x=>x.item==='订单方案').decision='提供';state.contextItems.find(x=>x.item==='订单方案').reason='引用经权限校验补取，正文绑定 v3';message('system','模拟适配器回执：明确请求、约束、方案 v3 与背景摘要已交给序的当前执行。未提供的材料仍标注原因。',{kind:'control'});state.observation='输入已提供的模拟事实绑定到精确执行。完整正文、摘要与被省略材料分别记录，未把“输入已提供”画成“模型已理解”。';state.nextHint='用户发布方案 v4，本轮输入仍保持方案 v3 的快照。';}
      if(step===5){state.contextItems.push({item:'用户后续发布的订单方案',source:'用户新要求',representation:'未提供',decision:'延后',reason:'在当前轮输入截止之后；保留下一轮待办',version:'v4'});message('user','订单方案已更新为 v4。请后续检查新版本。',{kind:'supplement',to:['xu'],delivery:'已排队 · 下一轮'});state.observation='序当前检查的是 v3，新 v4 明确保留在后续待办。更改配置和材料不会重写已开始执行的快照。';state.nextHint='序提交 v3 的结果；该结果不能充当 v4 已通过。';}
      if(step===6){settle(state.requests.find(r=>r.id==='R-701'),'已完成','正式提交 R-701 / 订单方案 v3 的复核记录。此结论不覆盖后来发布的 v4。');state.taskStatus='等待新版本复核';state.observation='R-701 的 v3 正式结果已结算，回传知一次。v4 仍需新复核；会话重建保留同一请求身份，权限过滤项未被补入，新要求未被游标丢弃。';state.nextHint='展开运行绑定与输入清单，核对材料版本、表示形式和延后原因。';}
    }
    if(state.scenario==='recovery'){
      const r=state.recovery;
      if(step===1){r.attempt=1;r.status='已发出 · 等待回执';r.process='工具可能正在执行';message('system','OP-801 第 1 次模拟操作已发出，开始等待结果。',{kind:'control'});state.observation='先保存稳定操作身份和尝试记录，再模拟发出工具操作。重连不能凭空再创建一份相同副作用。';state.nextHint='模拟网络断开，工具回执未能到达平台。';}
      if(step===2){r.status='结果未知 · 禁止自动重试';r.process='退出未确认 · 保留占用';state.states.xu='核对中';state.observation='回执丢失，无法判断外部操作是否成功，也无法证明进程退出。保留占用并进入核对；禁止自动重试该副作用。';state.nextHint='先暂停任务，再从右侧选择核对分支；核对可以继续，调度不能继续。';}
      if(step===3){pauseTask();state.observation='任务已持久暂停，并发出停止请求；进程仍未确认退出。核对结果可以入库，但不得自动唤醒成员。';state.nextHint='选择“发现既有结果”或“确认从未执行”，下一步模拟对应证据。';}
      if(step===4){r.process='退出证据已核实 · 占用释放';state.states.xu='空闲';if(state.recoveryChoice==='found'){r.status='既有结果已核对 · 待用户继续';r.result='既有产物发布记录匹配 OP-801';r.retryAllowed=false;}else{r.status='确认未执行 · 待用户继续';r.result='核对证明操作未被执行，且旧进程已退出';r.retryAllowed=true;}state.observation=state.recoveryChoice==='found'?'已找到匹配 OP-801 的既有结果，并确认旧进程退出。保存这一结果，尝试数仍为 1；任务继续暂停。':'已取得“未执行”及“旧进程退出”的模拟证据；可在用户明确继续后重试，当前仍暂停。';state.nextHint='下一步代表用户明确点击继续；单独收到核对证据不会续跑。';}
      if(step===5){resumeTask();if(!startMember('xu')){state.observation='用户已允许继续，但执行槽尚不可用；没有新工具尝试。';state.step--;return;}if(r.retryAllowed){r.attempt++;r.retryAllowed=false;r.status='用户继续后重试 · 第 2 次';r.process='新工具执行中';message('system','用户明确继续。核对已确认未执行，复用 OP-801 开始第 2 次模拟尝试。',{kind:'control'});}else{r.status='消费既有结果 · 无新工具调用';message('system','用户明确继续，序消费已核对的既有结果；没有重发 OP-801。',{kind:'control'});}state.observation=state.recoveryChoice==='found'?'用户明确恢复后才消费既有结果。未新增工具尝试，避免重复副作用。':'用户明确恢复后才开始第二次尝试。重试建立在“确认未执行”证据上，不是因为等得太久。';state.nextHint='保存最终结果；重复或过期回调只进入审计，不另开一次续跑。';}
      if(step===6){r.status='已结算 · 重复回调已归并';r.process='已退出';state.states.xu='空闲';state.taskStatus='等待用户';state.returns=1;message('system','OP-801 已形成一个逻辑结果。重复回调命中已有结算，不新增执行或副作用。',{kind:'control'});state.observation=`恢复分支完成：工具尝试 ${r.attempt} 次，有效逻辑结果 1 份。此原型模拟证据及状态转换，不承诺外部副作用恰好一次。`;state.nextHint='重置并选择另一核对分支，比较尝试次数与恢复条件。';}
    }
  }
  function relationPanel(){
    const relations=state.edges;
    const picked=relations.find(e=>e.request===state.selectedRelation);
    return `<div class="relation-strip">${relations.length?relations.map(e=>`<button type="button" class="relation-chip ${picked===e?'active':''}" data-action="select-relation" data-id="${esc(e.request)}">${name(e.from)} → ${name(e.to)} <span>${esc(e.request)}</span></button>`).join(''):'<span class="muted">负责人、请求处理者和执行成员可以不同。</span>'}${picked?`<div class="relation-inspect"><strong>${name(picked.from)} → ${name(picked.to)}</strong> · ${esc(picked.type)}<br>任务负责人：${name(state.owner)} v${state.ownerRevision} · ${picked.request==='H-501'?'这是显式任务责任转交':'这条协作关系不自动转移任务责任'}</div>`:''}</div>`;
  }
  function runConfigPanel(id){const c=state.runConfigs[id];if(!c)return '';return `<details class="run-config"><summary>查看本轮绑定与下一轮配置</summary><dl><dt>配置版本</dt><dd>本轮 v${c.version} / 当前 v${state.configVersion}</dd><dt>运行时</dt><dd>${esc(c.runtime)} · 模拟能力</dd><dt>本轮账户</dt><dd>${accountName(members[id].family,c.account)}</dd><dt>下一轮账户</dt><dd>${accountName(members[id].family,resolvedAccount(id))}</dd><dt>工作区</dt><dd>${esc(c.workspace)}</dd><dt>原生会话</dt><dd>${esc(c.session)}</dd><dt>执行</dt><dd>${esc(c.run)}</dd></dl><p class="rail-note">账户与配置修改在下一轮解析，凭据内容不进入快照。</p></details>`;}
  function scenarioPanel(){
    if(state.scenario==='handoff'){const h=state.handoff;return `<section class="card scenario-detail"><div class="card-head"><h2>正式责任转交流程</h2>${badge(h?.status||'尚未提出')}</div><div class="detail-body"><div class="phase-track">${['提议','接受','退出确认','责任更新'].map((label,i)=>`<div class="${state.step>=[1,2,4,5][i]?'complete':''}"><span>${i+1}</span>${label}</div>`).join('')}</div><div class="fact-grid"><div><small>当前任务负责人</small><strong>${name(state.owner)} · v${state.ownerRevision}</strong></div><div><small>旧执行占用</small><strong>${h?.released?'已释放':state.step>=3?'等待退出证据':'仍由林持有'}</strong></div><div><small>旧 v1 结果</small><strong>${h?.staleRejected?'拒绝结算 · 作为历史':'尚未迟到'}</strong></div></div><p class="inline-help">只有“接受 + 旧执行释放 + 预期版本仍匹配”才能变更责任。普通协助不会走这条转交路径。</p></div></section>`;}
    if(state.scenario==='fairness'){const next=queueChoice();return `<section class="card scenario-detail"><div class="card-head"><h2>可运行候选与领取顺序</h2>${badge(`连续用户 ${state.userStreak}/2`)}</div><div class="detail-body"><div class="next-claim"><small>下一次可领取</small><strong>${next.item?`${next.item.id} · ${name(next.item.to)}`:'等待'}</strong><p>${esc(next.reason)}</p></div><div class="claim-trace">${state.claims.length?state.claims.map(id=>`<span>${id}</span>`).join('<b>→</b>'):'尚未领取'}</div><details open><summary>查看候选队列与等待原因</summary><div class="table-scroll"><table class="data-table compact"><thead><tr><th>候选 / 入队序</th><th>来源 / 成员</th><th>状态与原因</th></tr></thead><tbody>${state.queue.map(q=>`<tr class="${next.item?.id===q.id?'next-row':''}"><td>${q.id} <small>#${q.seq}</small></td><td>${q.origin} · ${name(q.to)}</td><td>${q.status}<small>${q.status==='待领取'?state.states[q.to]!=='空闲'?'等待目标成员释放执行槽':next.item?.id===q.id?'下一领取候选':'等待配额 / 同类先到项':esc(q.reason||'已结束')}</small></td></tr>`).join('')}</tbody></table></div></details><p class="inline-help">全局并发 2；过滤权限、暂停、依赖后，按类内 FIFO 取可运行项。最多连续 2 次用户领取后，给可运行自动工作 1 次机会。资源不足暂跳过，不抢占工具；不承诺墙钟时延。演示工作区与账户除成员占用外均可用。</p></div></section>`;}
    if(state.scenario==='context')return `<section class="card scenario-detail"><div class="card-head"><h2>本轮提供的上下文</h2>${badge(state.contextMode)}</div><div class="detail-body"><p class="context-summary">接收成员：序 · 公共请求持续保留 · 原生会话：${esc(state.sessions.xu)}</p><details open><summary>展开材料清单与选择原因</summary>${state.contextItems.length?`<div class="context-list">${state.contextItems.map(x=>`<article class="context-item"><div class="row between"><strong>${esc(x.item)}</strong>${badge(x.decision,['延后','权限过滤'].includes(x.decision)?'amber':'')}</div><div class="context-meta">${esc(x.representation)} · ${esc(x.version)} · ${esc(x.source)}</div><p>${esc(x.reason)}</p></article>`).join('')}</div>`:'<p class="empty">点击下一步，为接收者组装有权限的材料。</p>'}</details>${runConfigPanel('xu')}<p class="inline-help">此清单描述选择和输入事实，不能证明模型理解。权限过滤示例不披露受限正文或标识；摘要也不会改变原材料的事实身份。</p></div></section>`;
    if(state.scenario==='recovery'){const r=state.recovery;return `<section class="card scenario-detail"><div class="card-head"><h2>外部操作恢复</h2>${badge(r.status,state.step>=2&&state.step<=4?'amber':'')}</div><div class="detail-body"><div class="fact-grid"><div><small>操作身份</small><strong>${r.operation}</strong></div><div><small>工具尝试次数</small><strong>${r.attempt}</strong></div><div><small>进程与占用</small><strong>${esc(r.process)}</strong></div></div><div class="recovery-guard">${state.step>=2&&state.step<=4?'自动重试关闭 · 核对可以继续，任务推进保持受控':'模拟操作，不调用真实工具'}</div><label class="branch-choice" for="recovery-choice">选择核对分支<select id="recovery-choice" ${state.step>=4?'disabled':''}><option value="found" ${state.recoveryChoice==='found'?'selected':''}>发现既有结果 · 直接复用</option><option value="absent" ${state.recoveryChoice==='absent'?'selected':''}>确认从未执行 · 恢复后重试</option></select></label>${r.result?`<p class="evidence-note">核对证据：${esc(r.result)}</p>`:''}<p class="inline-help">“没收到回执”与“确认未执行”不同。退出未知时保留占用；用户明确恢复之前，结果与回调都不能启动后续工作。</p></div></section>`;}
    return '';
  }
  function eventPanel(){return `<details class="card event-panel"><summary>步骤记录与状态变化 <span>${state.events.length} 条</span></summary><div class="event-list">${state.events.length?state.events.map(e=>`<article><strong>${esc(e.title)}</strong><p>${esc(e.detail)}</p></article>`).join(''):'<p class="empty">每一步都记录状态变化；可用“上一步”恢复上一快照。</p>'}</div></details>`;}

  const badge=(text, tone='')=>`<span class="badge ${tone}">${esc(text)}</span>`;
  function avatar(id){return `<span class="avatar ${members[id]?.cls||id}">${esc(name(id).slice(0,1))}</span>`;}
  function shell(content){return `<header class="topbar"><div class="brand"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>协作之间</div><div class="row"><span class="top-note">让协作有来有回，让责任始终清楚</span><span class="prototype-tag"><span class="dot"></span> 交互原型 · 模拟运行</span></div></header><div class="shell"><aside class="sidebar"><div class="workspace"><p class="eyebrow">PERSONAL WORKSPACE</p><h2>我的协作空间</h2><p>本地演示 · 无真实模型调用</p></div><nav class="navigation" aria-label="主导航">${[['conversation','◫','协作会话'],['members','♧','成员与运行时'],['accounts','⌘','账户与登录']].map(([id,icon,label])=>`<button type="button" data-action="view" data-view="${id}" class="nav ${state.view===id?'active':''}" ${state.view===id?'aria-current="page"':''}><span class="nav-icon" aria-hidden="true">${icon}</span>${label}</button>`).join('')}</nav><div class="session-list"><p class="eyebrow">当前会话</p><div class="session-pill"><span class="dot" style="color:#7b976c"></span> 持续协作方案评审<small>3 位成员 · 同一个公共会话</small></div></div><div class="sidebar-note">这里演示产品行为。<br>没有登录、密钥或模型连接；<br>所有响应均为预设模拟数据。<div style="margin-top:10px">${state.persisted?'演示进度保存在当前浏览器':'当前浏览器仅保留本页内存状态'}</div></div></aside><main class="main">${content}<p class="footer-note">独立设计交互原型 · 对应综合实施报告 · 8 个可回退演示场景 · ${state.persisted?'刷新保留当前演示，重置只清除所选场景的进度。':'当前环境不支持本地存储；刷新将重置演示。'} 未接入真实服务。</p></main></div>`;}
  function graph(){
    const positions={lin:{x:30,y:28},xu:{x:225,y:104},zhi:{x:420,y:28}};
    let lines='';
    for(const [index,e] of state.edges.entries()){
      const a=positions[e.from]||positions.lin,b=positions[e.to];if(!b)continue;
      const ax=a.x+70,ay=a.y+36,bx=b.x+70,by=b.y+36;
      const y=(ay+by)/2+(index%2?20:-10);
      lines+=`<path class="edge ${e.status==='active'&&!state.paused?'hot':e.status==='done'?'done':''}" d="M${ax},${ay} Q${(ax+bx)/2},${y+45} ${bx},${by}" marker-end="url(#arrow)"/><text class="edge-label" x="${(ax+bx)/2}" y="${y+15}">${esc(e.request)} · ${esc(e.type)}</text>`;
    }
    if(!state.edges.length)lines='<path class="edge" d="M100 64 Q200 132 295 140 T490 64"/><text class="edge-label" x="295" y="46">按当前需要建立协作关系</text>';
    return `<section class="card graph-card"><div class="card-head"><h2>此刻的协作关系</h2><small>点击成员查看当前执行</small></div><div class="graph-stage"><svg class="graph" viewBox="0 0 590 200" role="group" aria-label="成员协作关系图"><defs><marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="none" stroke="#88a27e" stroke-width="1"/></marker></defs>${lines}${Object.entries(members).map(([id,m])=>{const p=positions[id];return `<g class="graph-node ${state.selectedMember===id?'selected':''} ${state.states[id]==='执行中'&&!state.paused?'running':''}" role="button" tabindex="0" data-action="select-member" data-member="${id}" aria-label="查看成员${m.name}：${state.states[id]}"><rect x="${p.x}" y="${p.y}" width="140" height="72" rx="12"/><circle cx="${p.x+25}" cy="${p.y+25}" r="13"/><text class="avatar-text" x="${p.x+25}" y="${p.y+30}">${m.name}</text><text class="name" x="${p.x+47}" y="${p.y+24}">${m.name}</text><text class="runtime" x="${p.x+47}" y="${p.y+39}">${m.runtime}</text><circle class="status-dot" cx="${p.x+19}" cy="${p.y+56}" r="2.5"/><text class="status" x="${p.x+28}" y="${p.y+60}">${esc(state.states[id])}${id===state.owner?' · 负责人':''}</text></g>`;}).join('')}</svg></div>${relationPanel()}<div class="graph-caption"><div class="legend"><span><i></i>协作中 / 等待依赖</span><span><i class="solid"></i>正式结果已登记</span></div><button type="button" class="quiet" data-action="view" data-view="members">查看运行绑定 ↗</button></div></section>`;
  }
  const kindNames={progress:'公开进展',notify:'仅知会',reply:'请回复',contract:'需正式结果',result:'正式结果',return:'结果返回',failure:'异常结算',late:'迟到证据',group:'组级汇总',supplement:'运行中补充',stale:'执行失效降级',work:'用户要求',control:'调度记录'};
  function messages(){return state.messages.map(m=>`<article class="message ${m.sender==='user'?'user':''} ${m.sender==='system'?'system':''} ${state.selectedMessage===m.id?'selected':''}">${avatar(m.sender)}<div class="message-main"><div class="message-meta"><strong>${esc(name(m.sender))}</strong><span class="muted">${esc(members[m.sender]?.role||'')}</span><small>${esc(m.time)}</small></div><div class="bubble">${esc(m.body)}</div><div class="message-footer"><span>${esc(kindNames[m.kind]||'消息')}</span>${m.requestId?`<span class="message-request">${esc(m.requestId)}</span>`:''}${m.deliveries.length?`<span>→ ${m.deliveries.map(d=>esc(name(d.member))).join('、')}</span>`:''}<button type="button" class="message-detail-btn" data-action="select-message" data-id="${esc(m.id)}" aria-label="查看 ${esc(m.id)} 的投递详情">投递详情 ↗</button></div></div></article>`).join('');}
  function requestCards(){
    if(!state.requests.length)return '<p class="empty">当前没有结果请求。<br>普通消息无需创建协作契约。</p>';
    return state.requests.map(r=>{
      const canSubmit=r.status==='处理中'&&r.invocation;
      const canDispatch=!freeformQueueOnly()&&!state.paused&&!isOccupied(r.to)&&['排队中','积累待恢复'].includes(r.status);
      const manualControls=r.manual&&!r.result?`<div class="row wrap">${!r.invocation?`<button type="button" data-action="dispatch-manual" data-id="${r.id}" ${canDispatch?'':'disabled'}>派发演示请求</button>`:''}<button type="button" data-action="submit-result" data-id="${r.id}" ${canSubmit?'':'disabled'}>提交正式结果</button><button type="button" data-action="fail-request" data-id="${r.id}" ${canSubmit?'':'disabled'}>模拟失败</button></div>${!r.invocation?(freeformQueueOnly()?'<div class="inline-help">分步演示中仅保存和排队；结束后可派发。转交/恢复场景始终保持隔离。</div>':'<div class="inline-help">等待成员与执行槽可用后可派发；停止请求不等于进程退出。</div>'):`<div class="inline-help">已绑定执行 ${esc(r.invocation)}</div>`}`:'';
      return `<div class="request"><div class="request-top"><span class="request-title">${esc(r.id)} · ${name(r.from)} → ${name(r.to)}</span>${badge(r.status,['已超时','已失败'].includes(r.status)?'rose':r.status==='等待依赖'?'amber':'')}</div><div class="request-meta">${esc(r.title)}<br>${r.group?`归组 ${r.group} · 分支不单独回唤`:r.depends?`依赖：${esc(r.depends)}`:`返回：${esc(r.returnStatus)}`}<br>处理代次 ${r.generation} · 产物 ${esc(r.artifact)}${!r.group?` · 续跑 ${r.wakeCount} 次`:''}</div>${manualControls}${r.group&&r.to==='zhi'&&!r.result&&state.step>=3?`<div class="row"><button type="button" data-action="fail-request" data-id="${r.id}">模拟知的分支失败</button></div>`:''}</div>`;
    }).join('');
  }

  function deliveryPanel(){
    const m=state.messages.find(x=>x.id===state.selectedMessage);
    if(!m)return '<p class="empty">选择一条消息，查看逐接收者投递事实。</p>';
    return `<div class="row between"><span class="mono">${esc(m.id)}</span>${badge(kindNames[m.kind]||'消息')}</div><p class="rail-note">${esc(m.body.slice(0,95))}${m.body.length>95?'…':''}</p>${m.deliveries.length?m.deliveries.map(d=>`<div class="delivery"><div class="row between"><strong>接收者 · ${name(d.member)}</strong>${d.consumed?badge('已归并'):''}</div><small>${esc(d.status)}${d.invocation?`<br><span class="mono">${esc(d.invocation)}</span>`:''}</small>${m.kind==='reply'&&m.sender==='user'&&d.status.startsWith('已排队')?`<button type="button" class="small" data-action="dispatch-reply" data-id="${esc(m.id)}" data-member="${d.member}" ${freeformQueueOnly()||state.paused||isOccupied(d.member)||Object.keys(members).filter(processOccupied).length>=2?'disabled':''}>派发普通回复</button>`:''}${d.receipts.map(r=>`<div class="receipt">${esc(r)}</div>`).join('')}${!d.consumed&&['supplement','stale'].includes(m.kind)?'<div class="receipt pending">尚无正文消费归属</div>':''}</div>`).join(''):'<p class="rail-note">已保存到公共会话。未创建特定接收者的投递，因此不会仅凭这条公开回复自动唤醒其他成员。</p>'}<div class="compact-divider"></div><p class="rail-note">已发表 ≠ 已交付 ≠ 已读取 ≠ 正式提交结果。每种状态需要对应证据。</p>`;
  }
  function rightRail(){const id=state.selectedMember,m=members[id];return `<aside class="right-rail"><section class="card"><div class="card-head"><h2>任务与责任</h2>${badge(state.taskStatus,state.paused?'amber':'')}</div><div class="rail-body"><div class="task-title">让成员在同一会话里<br>持续、可靠地协作</div><div class="label-value"><span>唯一负责人</span><span>${name(state.owner)} · ${members[state.owner].role}</span></div><div class="label-value"><span>责任版本</span><span>v${state.ownerRevision}</span></div><div class="label-value"><span>自动推进</span><span>${state.paused?'已暂停':'允许'}</span></div><div class="label-value"><span>有效结果续跑</span><span>${state.returns} 次</span></div><div class="label-value"><span>暂停 / 恢复代次</span><span>${state.pauseGeneration}</span></div><button type="button" class="task-action ${state.paused?'primary':''}" data-action="${state.paused?'resume':'pause'}">${state.paused?'继续任务':'暂停任务'}</button><p class="rail-note">协助不会转移任务责任。暂停关闭整项任务的调度；停止单轮只针对一个成员；退出确认后才释放占用。</p></div></section><section class="card"><div class="card-head"><h2>协作请求</h2><small>${state.requests.length} 条${state.group?` · ${state.group.id}`:''}</small></div><div class="rail-body">${state.group?`<div class="observation" style="padding:10px;margin-bottom:12px"><strong>复核组 ${state.group.id}</strong>冻结公共历史至 M-${String(state.group.cutoff).padStart(3,'0')}<br>汇总：${state.group.closed?'已终结':'等待分支'} · 回唤 ${state.group.wakeCount} 次<br>返回：${esc(state.group.returnStatus||'等待组终结')}</div>`:''}${requestCards()}</div></section><section class="card"><div class="card-head"><h2>消息投递详情</h2><small>逐接收者</small></div><div class="rail-body">${deliveryPanel()}</div></section><section class="card"><div class="card-head"><h2>当前查看的成员</h2><small>点击关系图切换</small></div><div class="member-mini"><div class="member-mini-head">${avatar(id)}<div><strong>${m.name} · ${m.role}</strong><small>${m.runtime} · 运行时默认模型</small></div></div><div class="member-state">${esc(state.states[id])} · ${invocation(id)}<br>本轮快照：${accountName(m.family,state.snapshots[id])}</div>${runConfigPanel(id)}<button type="button" class="danger" data-action="stop-member" data-member="${id}" ${state.states[id]!=='执行中'?'disabled':''}>停止${m.name}本次回复</button><p class="rail-note">任务自动调度保持${state.paused?'暂停':'允许'}。停止不会自动将协作请求标为完成。</p></div></section></aside>`;}
  function conversation(){const s=scenarios[state.scenario];return `<div class="page-title"><div><div class="breadcrumb">协作会话 / 持续协作方案评审</div><h1>${s.title}</h1><p class="subtitle">${s.subtitle}</p></div><div class="title-right">${badge('工作区 · 方案评审')}${badge('3 位成员')}</div></div><section class="scenario-bar" aria-label="演示场景"><div><label class="scenario-label" for="scenario">选择一个场景观察</label><select id="scenario" class="scenario-select">${Object.entries(scenarios).map(([id,s])=>`<option value="${id}" ${id===state.scenario?'selected':''}>${s.name}</option>`).join('')}</select></div><div class="scenario-controls"><span class="step-count">${state.step} / ${s.steps} 步</span><button type="button" class="small" data-action="previous" ${state.history.length?'':'disabled'}>← 上一步</button><button type="button" class="small" data-action="reset">重置场景</button><button type="button" class="primary small" data-action="next" ${state.step>=s.steps?'disabled':''}>${state.step>=s.steps?'演示已完成':'下一步 →'}</button></div></section><div class="workbench"><div class="center">${graph()}<div class="observation" role="status"><strong>本步观察 · ${String(state.step).padStart(2,'0')}</strong>${esc(state.observation)}<div class="next-hint">${esc(state.nextHint)}</div></div>${scenarioPanel()}${eventPanel()}<section class="card"><div class="card-head"><h2>公共会话</h2><small>成员共享已发表的信息，保留各自运行上下文</small></div><div class="chat-list" id="chat-log" role="log" aria-label="协作消息"><div class="date-line">演示会话 · 方案 v1</div>${messages()}</div><form id="composer" class="composer"><label for="message-input" class="sr-only">消息内容</label><textarea id="message-input" maxlength="1200" placeholder="输入消息，可用 @成员 指定接收者" aria-describedby="route-preview mention-hint" required></textarea><div id="route-preview" class="route-preview" aria-live="polite" aria-atomic="true"></div><div class="composer-bottom"><span id="mention-hint">可用 @林、@序、@知或 @全部，前后以空格或标点分隔。邮箱和反引号代码不指定成员。<br>Ctrl / ⌘ + Enter 发送</span><button class="primary" type="submit">发送</button></div></form><p class="prototype-boundary">原型说明：仅模拟路由与状态，不生成真实回答。${freeformQueueOnly()?'分步场景中自定义消息先排队；场景结束后可模拟派发，转交与恢复场景始终保持隔离。':'可在投递详情中查看本次消息的接收者与派发进度。'}</p></section></div>${rightRail()}</div>`;}
  function memberView(){return `<div class="view-wide"><div class="page-title"><div><div class="breadcrumb">工作空间 / 成员与运行时</div><h1>一个成员，不止一个配置</h1><p class="subtitle">身份、职责、运行时与账户各自独立；历史始终归属于成员。</p></div></div><div class="intro-banner"><h2>角色决定怎样工作，运行绑定决定怎样调用</h2><p>更换账户只影响下一次执行。本轮已绑定的快照保留，模型使用“运行时默认”，本原型不宣称已检测到真实能力。</p></div><div class="member-grid">${Object.entries(members).map(([id,m])=>`<section class="card member-profile"><div>${avatar(id)}<h2>${m.name} <small class="muted">${m.alias}</small></h2><p>${m.description}</p></div><div class="relation-list"><div><small>角色 / 职责</small><strong>${m.role}</strong></div><div><small>运行时</small><strong>${m.runtime}</strong></div><div><small>模型</small><strong>跟随运行时默认</strong></div><div><small>下一次执行账户</small><strong>${accountName(m.family,resolvedAccount(id))}</strong></div></div><div class="profile-bindings"><label for="bind-${id}">账户绑定方式<select id="bind-${id}" data-binding="${id}"><option value="follow" ${state.bindings[id]==='follow'?'selected':''}>跟随 ${m.runtime} 默认账户</option><option value="one" ${state.bindings[id]==='one'?'selected':''}>指定演示账户一</option><option value="two" ${state.bindings[id]==='two'?'selected':''}>指定演示账户二</option></select></label><div class="inline-help">本轮快照：${accountName(m.family,state.snapshots[id])}<br>状态：${esc(state.states[id])} · 配置修改不重写历史</div></div></section>`).join('')}</div><section class="card table-card"><div class="card-head"><h2>运行能力展示</h2>${badge('全部为模拟')}</div><div class="table-scroll"><table class="data-table"><thead><tr><th>成员</th><th>原生会话</th><th>输入追加</th><th>工具与审批</th></tr></thead><tbody><tr><td>林 · Claude Code</td><td>按成员隔离<small>本演示未连接 CLI</small></td><td>由真实适配器验证</td><td>依能力声明开放</td></tr><tr><td>序 · Codex</td><td>按成员隔离<small>本演示未连接 CLI</small></td><td>场景 03 模拟可对账追加</td><td>写入需明确授权</td></tr><tr><td>知 · API</td><td>公共记录组装上下文</td><td>不支持时进入下一轮</td><td>平台函数工具</td></tr></tbody></table></div></section><div class="review-points"><section class="card review-point"><small>01 / STABLE IDENTITY</small><h3>成员不会因换号而消失</h3><p>公开消息、任务责任与协作请求关联稳定的成员身份。</p></section><section class="card review-point"><small>02 / IMMUTABLE RUN</small><h3>一次执行使用一份快照</h3><p>实际账户和权限在开始时固定，中途改配置只影响下一次。</p></section><section class="card review-point"><small>03 / VERIFIED CAPABILITY</small><h3>能力检测通过后才开放</h3><p>运行时已安装、已登录、可调用与可追加分别验证。</p></section></div></div>`;}
  function accountsView(){const pending=Object.entries(state.pendingDefaults);return `<div class="view-wide"><div class="page-title"><div><div class="breadcrumb">工作空间 / 账户与登录</div><h1>先看影响，再切换账户</h1><p class="subtitle">这里只模拟账户选择，不读取凭据、不启动登录，也不调用真实服务。</p></div></div><div class="intro-banner"><h2>新账户可用，不代表自动替所有成员换号</h2><p>选择默认账户后，先预览跟随默认的成员。单独指定的成员保持原绑定；当前执行继续使用自己的配置快照。</p></div><div class="account-list">${[['claude','Claude Code','官方 CLI 登录'],['codex','Codex','官方 CLI 登录'],['api','API 连接','API 密钥']].map(([family,label,method])=>`<section class="card account-card"><div><h2>${label}</h2><p>${method} · 未真实登录</p></div><div class="account-facts"><div><small>演示连接状态</small>${badge('模拟身份 · 未验证','amber')}</div><div><label for="default-${family}"><small>默认账户</small></label><select id="default-${family}" data-default="${family}"><option value="one" ${(state.pendingDefaults[family]||state.defaults[family])==='one'?'selected':''}>${label} 演示账户一</option><option value="two" ${(state.pendingDefaults[family]||state.defaults[family])==='two'?'selected':''}>${label} 演示账户二</option></select></div></div><button type="button" class="small" data-action="login-info" data-family="${family}">查看登录流程示意</button></section>`).join('')}</div><section class="card account-preview"><div class="row between"><h2>切换影响预览</h2>${badge(pending.length?`${pending.length} 项待应用`:'没有待应用变更',pending.length?'amber':'')}</div>${pending.length?pending.map(([family,value])=>Object.entries(members).filter(([,m])=>m.family===family).map(([id,m])=>`<div class="change-row"><div class="row between"><strong>${m.name} · ${m.runtime}</strong>${badge(state.bindings[id]==='follow'?'下一次执行生效':'保留成员指定')}</div><p style="margin-top:7px">${state.bindings[id]==='follow'?`${accountName(family,state.defaults[family])} → ${accountName(family,value)}`:`该成员单独指定 ${accountName(family,state.bindings[id])}，不跟随默认切换。`}</p><span class="muted">当前 / 最近执行快照：${accountName(family,state.snapshots[id])}</span></div>`).join('')).join(''):'<p>在上方选择另一个演示账户，即可看到哪些成员会受到影响。</p>'}<div class="row" style="margin-top:18px"><button type="button" class="primary small" data-action="apply-accounts" ${!pending.length?'disabled':''}>确认应用演示切换</button><button type="button" class="small" data-action="discard-accounts" ${!pending.length?'disabled':''}>撤销选择</button></div></section><div class="review-points"><section class="card review-point"><small>LOGIN</small><h3>登录由官方工具处理</h3><p>真实产品应由用户本人完成授权，本原型没有登录入口或密码输入。</p></section><section class="card review-point"><small>VERIFY</small><h3>凭据、身份、连接分别确认</h3><p>“已配置”不会被画成“已验证”；未知额度也不显示成零。</p></section><section class="card review-point"><small>SWITCH</small><h3>绑定变化有明确生效边界</h3><p>已开始的执行保留原快照。新执行才解析新的默认或指定账户。</p></section></div></div>`;}
  function render(){
    const draft=document.getElementById('message-input')?.value||'';
    document.getElementById('app').innerHTML=shell(state.view==='members'?memberView():state.view==='accounts'?accountsView():conversation());
    if(document.getElementById('message-input')){document.getElementById('message-input').value=draft;updateRoutePreview();}
  }
  function toast(text){document.querySelector('.toast')?.remove();const el=document.createElement('div');el.className='toast';el.setAttribute('role','status');el.textContent=text;document.body.append(el);document.getElementById('announcement').textContent=text;clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.remove(),6000);}
  function scrollChat(){requestAnimationFrame(()=>{const el=document.getElementById('chat-log');if(el)el.scrollTop=el.scrollHeight;});}
  // Routing is separate from scheduling: a busy or paused target stays the target.
  function textOutsideCode(content){
    let result='',index=0;
    while(index<content.length){
      if(content[index]!=='`'){result+=content[index++];continue;}
      let count=1;while(content[index+count]==='`')count++;
      let end=index+count,closed=false;
      while(end<content.length){
        if(content[end]!=='`'){end++;continue;}
        let closeCount=1;while(content[end+closeCount]==='`')closeCount++;
        if(closeCount===count){end+=closeCount;closed=true;break;}
        end+=closeCount;
      }
      if(!closed)end=content.length;
      result+=content.slice(index,end).replace(/[^\n]/g,' ');index=end;
    }
    return result;
  }
  function resolveRoute(content){
    const aliases={lin:'lin',xu:'xu',zhi:'zhi','林':'lin','序':'xu','知':'zhi'};
    const explicit=[],unknown=[];
    // Mentions are independent tokens. This excludes name@example.com and URL paths.
    const pattern=/(^|[\s（）()【\[】\]「」『』“”‘’"'，,。.;；:：!?！？、])@([^\s.,;:!?，。；：！？、（）()[\]{}<>「」『』“”‘’【】"'`]+)/gu;
    for(const match of textOutsideCode(content).matchAll(pattern)){
      const token=match[2],alias=token.toLowerCase();
      if(alias==='全部'||alias==='all')explicit.push(...Object.keys(members));
      else if(Object.hasOwn(aliases,alias))explicit.push(aliases[alias]);
      else unknown.push('@'+token);
    }
    if(unknown.length)return {to:[],source:'invalid',valid:false,reason:`未找到成员：${[...new Set(unknown)].join('、')}。请检查 @ 名称；草稿会保留。`};
    if(explicit.length)return {to:[...new Set(explicit)],source:'explicit',valid:true,reason:'按你本条消息的 @ 指定'};
    const recent=[...new Set((Array.isArray(state.recentExplicitTargets)?state.recentExplicitTargets:[]).filter(id=>Object.hasOwn(members,id)))];
    if(recent.length)return {to:recent,source:'recent-explicit',valid:true,reason:'沿用你最近一次明确指定的成员'};
    if(Object.hasOwn(members,state.owner))return {to:[state.owner],source:'task-owner',valid:true,reason:'当前任务负责人'};
    const responder=Object.hasOwn(members,state.lastSuccessfulResponder)?state.lastSuccessfulResponder:[...state.messages].reverse().find(m=>members[m.sender]&&['reply','result'].includes(m.kind))?.sender;
    if(responder)return {to:[responder],source:'recent-reply',valid:true,reason:'最近成功回复的成员'};
    const fallback=Object.hasOwn(members,state.defaultRecipient)?state.defaultRecipient:'lin';
    return {to:[fallback],source:'conversation-default',valid:true,reason:'会话默认成员'};
  }
  function updateRoutePreview(){
    const input=document.getElementById('message-input'),preview=document.getElementById('route-preview');
    if(!input||!preview)return;
    const route=resolveRoute(input.value);
    preview.dataset.recipients=route.to.join(',');preview.dataset.source=route.source;preview.dataset.valid=String(route.valid);
    preview.classList.toggle('invalid',!route.valid);input.setAttribute('aria-invalid',String(!route.valid));
    const wait=state.paused?'任务已暂停，消息保存后等待继续':route.to.some(isOccupied)?'目标正在处理工作，消息排队等待':'';
    preview.innerHTML=route.valid?`<strong>交给 ${route.to.map(id=>esc(name(id))).join('、')}</strong><span>${esc(route.reason)}${wait?' · '+esc(wait):''}</span>`:`<strong>请检查 @ 成员</strong><span>${esc(route.reason)}</span>`;
  }
  function userSend(event){
    event.preventDefault();const input=document.getElementById('message-input');const content=input.value.trim();if(!content){input.focus();return;}
    const route=resolveRoute(content);
    if(!route.valid){updateRoutePreview();input.focus();toast(route.reason);return;}
    if(route.source==='explicit')state.recentExplicitTargets=[...route.to];
    const to=route.to;
    const m=message('user',content,{to,kind:'reply',routeSource:route.source,routeReason:route.reason,delivery:state.paused?'积累待恢复':'待派发'});
    for(const id of to)if(!state.paused){
      if(isOccupied(id)||freeformQueueOnly()){
        const d=m.deliveries.find(x=>x.member===id);d.status='已排队 · 下一轮';
        d.receipts.push(freeformQueueOnly()?'分步演示期间仅积累，不改变预设执行':'已有活动执行，排到下一轮');
      }else if(startMember(id))deliver(m,id);
      else m.deliveries.find(x=>x.member===id).status='已排队 · 等待执行槽';
    }
    state.observation=`消息已保存，交给${to.map(name).join('、')}。${route.reason}；普通消息不会改变任务负责人。`;
    if(freeformQueueOnly())state.observation+=' 自定义消息先排队，不改变正在展示的预设过程。';
    input.value='';save();render();scrollChat();toast('消息已发送，投递进度可在右侧查看。');
  }
  function settleManual(r,failure=false){
    if(!r)return;
    if(r.from==='user'){
      if(r.status!=='处理中'||!r.invocation){toast('这条请求尚未派发，不能提前提交正式结果。');return;}
      r.status=failure?'已失败':'已完成';r.result=failure?'演示执行失败':'演示正式结果';r.returnStatus=state.paused?'已保存 · 待恢复':'已通知用户';r.wakeCount=0;if(invocation(r.to)===r.invocation&&state.states[r.to]==='执行中')state.states[r.to]='空闲';message(r.to,`${failure?'正式报告失败':'正式提交结果'}：${r.id}。这里只演示结算动作，未执行或验证你的输入内容。`,{kind:failure?'failure':'result',requestId:r.id});
      state.observation=state.paused?'用户请求结果已保存，任务继续暂停。':'结果契约已结算并通知用户；没有把模拟内容当成真实工作成果。';emitGroupReturn();
    }else settle(r,failure?'已失败':'已完成',failure?`正式报告 ${r.id} 失败：演示适配器连接中断。失败归入复核组，不独立回唤。`:`正式提交 ${r.id} 的演示结果。`);
  }
  document.addEventListener('click',event=>{
    const el=event.target.closest('[data-action]');if(!el||el.disabled)return;
    const action=el.dataset.action;
    if(action==='view'){state.view=el.dataset.view;save();render();return;}
    if(action==='next'){nextStep();return;}
    if(action==='previous'){previousStep();return;}
    if(action==='select-relation'){state.selectedRelation=el.dataset.id;save();render();return;}
    if(action==='reset'){initScenario(state.scenario);toast('已重置当前场景，账户演示配置保留。');return;}
    if(action==='select-member'){state.selectedMember=el.dataset.member;const scroll=document.getElementById('chat-log')?.scrollTop;save();render();if(scroll)document.getElementById('chat-log').scrollTop=scroll;return;}
    if(action==='select-message'){state.selectedMessage=el.dataset.id;const scroll=document.getElementById('chat-log')?.scrollTop;save();render();if(scroll)document.getElementById('chat-log').scrollTop=scroll;return;}
    if(action==='pause'){pauseTask();save();render();toast('任务已暂停。收到结果只积累，不自动续跑。');return;}
    if(action==='resume'){resumeTask();save();render();if(!state.paused)toast('已明确恢复任务，积累结果按关联逐一对账。');return;}
    if(action==='stop-member'){const id=el.dataset.member;
      if(['handoff','recovery'].includes(state.scenario)){state.states[id]='等待退出';message('system',`已请求停止${name(id)}；退出尚未确认，保留占用。`,{kind:'control'});state.observation='停止按钮仅发送控制请求。场景中的退出证据步骤才释放占用，不会绕过责任交接或未知结果核对。';save();render();return;}
      state.states[id]='已停止';message('system',`只停止${name(id)}的本次回复 ${invocation(id)}。任务自动调度${state.paused?'仍为暂停':'保持允许'}，其他成员和待办不被同时取消。`,{kind:'control'});state.observation=`${name(id)}本轮已停止，未把协作请求当作完成。任务调度状态保持原样；点击“下一步”仍可推进其他演示事件。`;emitGroupReturn();save();render();return;}
    if(action==='dispatch-reply'){const m=state.messages.find(m=>m.id===el.dataset.id);const id=el.dataset.member;const d=m?.deliveries.find(d=>d.member===id);if(m?.kind==='reply'&&d?.status.startsWith('已排队')&&!freeformQueueOnly()&&startMember(id)){deliver(m,id);save();render();toast('普通回复待办已绑定演示执行，不生成真实回复。');}return;}
    if(action==='dispatch-manual'){const r=state.requests.find(r=>r.id===el.dataset.id);if(r&&!freeformQueueOnly()&&!r.result&&startMember(r.to)){r.status='处理中';r.invocation=invocation(r.to);deliver(state.messages.find(m=>m.id===r.messageId),r.to);save();render();toast('演示请求已派发，现可提交模拟正式结果。');}return;}
    if(action==='submit-result'||action==='fail-request'){settleManual(state.requests.find(r=>r.id===el.dataset.id),action==='fail-request');save();render();scrollChat();return;}
    if(action==='apply-accounts'){Object.assign(state.defaults,state.pendingDefaults);state.configVersion++;state.pendingDefaults={};save();render();toast('演示默认账户已更新；本轮快照保留，下一次执行才生效。');return;}
    if(action==='discard-accounts'){state.pendingDefaults={};save();render();return;}
    if(action==='login-info'){const family=el.dataset.family;toast(family==='api'?'真实流程：配置 API 连接 → 验证连接 → 选择默认或指定绑定。本原型不收集密钥。':'真实流程：由官方 CLI 发起登录 → 用户本人授权 → 确认身份 → 选择绑定。本原型未启动登录。');return;}
  });
  document.addEventListener('change',event=>{
    const el=event.target;
    if(el.id==='scenario'){initScenario(el.value);return;}
    if(el.id==='recovery-choice'){state.recoveryChoice=el.value;save();render();return;}
    if(el.dataset.binding){state.bindings[el.dataset.binding]=el.value;state.configVersion++;save();render();toast('成员绑定已更新；当前执行快照保持原值。');}
    if(el.dataset.default){if(state.defaults[el.dataset.default]===el.value)delete state.pendingDefaults[el.dataset.default];else state.pendingDefaults[el.dataset.default]=el.value;save();render();}
  });
  document.addEventListener('input',event=>{if(event.target.id==='message-input')updateRoutePreview();});
  document.addEventListener('submit',event=>{if(event.target.id==='composer')userSend(event);});
  document.addEventListener('keydown',event=>{
    if(event.target.matches('.graph-node')&&['Enter',' '].includes(event.key)){event.preventDefault();event.target.dispatchEvent(new MouseEvent('click',{bubbles:true}));}
    if(event.target.id==='message-input'&&(event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();document.getElementById('composer').requestSubmit();}
  });
  if(needsInitialScenario) initScenario('assist',false);
  else render();
})();
