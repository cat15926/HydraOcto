// Read-only audit of native attempts during the restart exercise. These functions never dispatch.
import assert from 'node:assert/strict';

const playerTools = ['mcp__platform__game_act','mcp__platform__game_read'];

export function inspectFailedPlayer({mode,run,contract,game,groups,evidence,call}) {
  assert.equal(mode,'--restart','Any unsuccessful execution fails the ordinary game');
  assert.equal(run.status,'failed','An interrupted or cancelled native execution cannot be retried by the acceptance exercise');
  assert(run.acceptance==='accepted' && run.teardown==='confirmed' && !run.cancelRevision && run.nativeSessionId,
    'Player failure needs an exact accepted native session, confirmed release and no cancellation');
  const turn=contract.roomRuleTurn;
  assert(game && turn?.kind==='player' && turn.gameId===game.id && game.room===run.conversationId &&
    run.memberId!==game.host && run.roomMember?.id && contract.roomMember?.id===run.roomMember.id &&
    game.players.some(p=>p.memberId===run.memberId && p.instance===run.roomMember.id),'Failure is not a bound game seat');
  const receipts=evidence.filter(e=>e.invocationId===run.id);
  const exits=receipts.filter(e=>e.kind==='process_exit');
  assert(exits.length===1 && exits[0].detail.confirmed===true && Number.isInteger(exits[0].detail.code) &&
    receipts.some(e=>e.kind==='accepted' && e.detail.nativeSessionId===run.nativeSessionId),'Native acceptance and definitive process exit are required');
  assert(receipts.some(e=>e.kind==='diagnostic' && e.detail.observation==='game_player_tools' &&
    Array.isArray(e.detail.tools) && JSON.stringify([...e.detail.tools].sort())===JSON.stringify(playerTools)),
    'Cannot prove the two-tool private surface');
  assert(call?.id===run.id && call.room===game.room && call.member===run.memberId && call.pid && call.spawn &&
    call.exit>=call.spawn && call.end && receipts.some(e=>e.kind==='prepared' && e.detail.pid===call.pid) && call.tools.every(t=>t.name==='game_read'),
    'Any attempted action or unknown tool effect forbids recovery');
  assert(game.epoch===turn.epoch && !game.actions.some(a=>(a.by===run.memberId && a.epoch===turn.epoch) ||
    a.invocation===run.id || a.previousInvocations?.includes(run.id)),
    'A signed or superseded action cannot be recovered by the no-effect path');
  const group=groups.find(g=>g.sourceId===contract.primarySourceId);
  assert(group?.conversationId===game.room && group.contract?.obligationId===game.id &&
    group.contract.returnTo.instanceId===game.hostInstance &&
    group.contract.participants.some(p=>p.memberId===run.memberId && p.instanceId===run.roomMember.id &&
      p.generation===run.roomMember.generation),'Failure must belong to the actual original invitation');
  const result=group.results?.filter(r=>r.memberId===run.memberId);
  assert(result?.length===1 && result[0].status==='failed' && result[0].invocationId===run.id &&
    result[0].responseId===run.responseId && result[0].content.trim(),'The original group must have recorded the exact failure');
  return {invocation:run.id,response:run.responseId,epoch:turn.epoch,seat:run.memberId,instance:run.roomMember.id,
    group:group.id,nativeSession:run.nativeSessionId,pid:call.pid,exitCode:exits[0].detail.code,exitEvidence:exits[0].id};
}

export function verifyPlayerRecovery(attempt,{details,game,calls,contractFor}) {
  const old=details.groups.find(g=>g.id===attempt.group);
  const failed=details.invocations.find(i=>i.id===attempt.invocation);
  assert(failed?.status==='failed' && failed.responseId===attempt.response && failed.teardown==='confirmed','Original failure was overwritten');
  const receipt=old?.results?.find(r=>r.invocationId===attempt.invocation);
  const wake=details.sources.find(s=>s.id===old?.contract?.wakeSourceId);
  assert(old?.state==='done' && receipt?.status==='failed' && receipt.memberId===attempt.seat && receipt.responseId===attempt.response &&
    wake?.kind==='job_result' && wake.content.includes('['+attempt.seat+' · 执行失败] '+receipt.content),
    'The group must actually return the original failure to the owner');
  const consumed=details.consumptions.filter(c=>c.sourceId===wake.id);
  assert(consumed.length===1 && consumed[0].memberId===game.host,'The original group must return to its owner exactly once');
  const host=details.invocations.find(i=>i.responseId===consumed[0].responseId);
  assert(host?.roomMember?.id===game.hostInstance && host.status==='succeeded' && host.acceptance==='accepted' &&
    host.teardown==='confirmed' && host.nativeSessionId,'No successful owner invocation consumed the exact return');
  const hostCall=calls.find(c=>c.id===host.id && c.room===game.room && c.member===game.host);
  const repairs=details.groups.filter(g=>g.callerInvocationId===host.id && g.contract?.obligationId===game.id && g.targets.includes(attempt.seat));
  assert.equal(repairs.length,1,'The actual owner must invite the original seat exactly once after the failure');
  const repair=repairs[0],invite=hostCall?.tools.findIndex(t=>t.name==='multi_mention' && t.ok && t.group===repair.id &&
    t.obligation===game.id && t.targets.includes(attempt.seat));
  assert(invite>=0 && hostCall.tools.slice(0,invite).some(t=>t.name==='game_read' && t.ok &&
    t.epoch===attempt.epoch && repair.targets.every(id=>t.missing?.includes(id))),
    'The owner must read outstanding seats in this epoch and make the new invitation itself');
  const result=repair.results?.find(r=>r.memberId===attempt.seat);
  const run=details.invocations.find(i=>i.id===result?.invocationId);
  assert(repair.state==='done' && result?.status==='succeeded' && run?.id!==attempt.invocation && run?.status==='succeeded' &&
    run.acceptance==='accepted' && run.teardown==='confirmed' && !run.cancelRevision && run.nativeSessionId &&
    run.conversationId===game.room && run.roomMember?.id===attempt.instance && run.responseId===result.responseId,
    'The same seat must answer on its own fresh, accepted, successfully released execution');
  const contract=contractFor(run.id);
  assert(contract.primarySourceId===repair.sourceId && contract.roomRuleTurn?.kind==='player' &&
    contract.roomRuleTurn.gameId===game.id && contract.roomRuleTurn.epoch===attempt.epoch,'Repair was bound to another invitation or epoch');
  const call=calls.find(c=>c.id===run.id && c.member===attempt.seat && c.room===game.room);
  const exits=details.evidence.filter(e=>e.invocationId===run.id && e.kind==='process_exit');
  assert(call?.pid && call.session===run.nativeSessionId && call.spawn && call.exit>=call.spawn &&
    call.tools.some(t=>t.name==='game_act' && t.epoch===attempt.epoch && t.ok) &&
    exits.length===1 && exits[0].detail.confirmed===true && exits[0].detail.code===0,'No successful native action and exit');
  const actions=game.actions.filter(a=>a.by===attempt.seat && a.epoch===attempt.epoch);
  assert(actions.length===1 && actions[0].invocation===run.id && !actions[0].previousInvocations?.length,
    'Exactly one fresh game action must be included for this seat and epoch');
  return {...attempt,wake:wake.id,ownerInvocation:host.id,repairGroup:repair.id,replacement:run.id,
    replacementResponse:run.responseId,replacementSession:run.nativeSessionId,replacementPid:call.pid,replacementExitEvidence:exits[0].id};
}
