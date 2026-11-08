import type { CollaborationInvocation, ConversationDetail, SourceWork } from '../shared/collaboration';

export function ProjectRevisionActivity({ detail, run, source }: {
  detail: ConversationDetail; run: CollaborationInvocation; source?: SourceWork;
}) {
  if (!source) return null;
  const events = detail.evidence.filter(e => e.invocationId === run.id && e.kind === 'tool' && e.detail.origin === 'project_review').reverse();
  const blocked = events.find(e => e.detail.state === 'revision_blocked');
  if (blocked) return <p role="status" className="cc-revision-phase">本轮协作已停止{typeof blocked.detail.reason === 'string' && ' · ' + blocked.detail.reason}</p>;
  const repair = source.projectRepair;
  const review = source.projectReview;
  const expected = repair?.failedTest ?? review?.failedTest;
  const active = run.status === 'running' || run.status === 'prepared';
  const repairRequest = detail.sources.find(s => s.projectRepair?.reviewInvocationId === run.id && !s.withdrawnAt);
  if (repairRequest) {
    const delivery = detail.deliveries.find(d => d.sourceId === repairRequest.id);
    const label = delivery?.status === 'held' ? '修订暂缓' : delivery?.status === 'pending' ? '等待原作者修订' : '已退回原作者修订';
    return <p className="cc-revision-phase" role="status">{label}{delivery?.holdReason && ' · ' + delivery.holdReason}</p>;
  }
  if (!expected) return null;
  const previous = detail.invocations.find(i => i.id === (repair?.reviewInvocationId ?? review?.retestOfRepairInvocationId));
  const previousMessage = previous && detail.messages.find(m => m.responseId === previous.responseId && !m.deletedAt);
  const verdict = events.find(e => e.detail.state === 'revision_verdict');
  let label: string;
  if (repair) {
    const next = detail.sources.find(s => s.projectReview?.retestOfRepairInvocationId === run.id && !s.withdrawnAt);
    label = next ? '已提交修订，交由同伴复验' : active ? '原作者正在修订' : '本次修订已结束，尚无复验结果';
  } else if (review?.retestOfRepairInvocationId) {
    const outcome = verdict?.detail.outcome;
    label = outcome === 'passed' ? '复验通过' : outcome === 'failed' ? '复验仍未通过，等待你决定' :
      outcome === 'unverified' || !active ? '复验结果待核查' : '评审成员正在复验';
  } else return null;

  const repairRef = repair ?? detail.sources.find(s => s.projectRepair?.failedTest.evidenceId === expected.evidenceId)?.projectRepair;
  const checks = repairRef?.checks ?? [expected];
  const verdicts = Array.isArray(verdict?.detail.checks) ? verdict.detail.checks : [];
  return <section className="cc-revision-evidence" aria-label="修订与复验">
    <strong role="status">{label}</strong>
    {checks.map(check => {
      const resultId = verdicts.find(item => item?.previousEvidenceId === check.evidenceId)?.testEvidenceId ??
        (check.evidenceId === expected.evidenceId ? verdict?.detail.testEvidenceId : undefined);
      const rerun = resultId && events.find(e => e.id === resultId && e.detail.state === 'tested' && e.detail.treeExited === true);
      return <div key={check.evidenceId}><p><code>{check.argv.join(' ')}</code></p>
      <dl className="cc-project-file-pair">
      <dt>初评</dt><dd>{check.exitCode === 0 ? '通过' : '失败'} · 退出码 {check.exitCode} · <span title={check.snapshotSha256}>副本 {check.snapshotSha256.slice(0, 12)}</span></dd>
      {rerun && typeof rerun.detail.exitCode === 'number' && typeof rerun.detail.snapshotSha256 === 'string' &&
        <><dt>复验</dt><dd>{rerun.detail.exitCode === 0 ? '通过' : '失败'} · 退出码 {rerun.detail.exitCode} · <span title={rerun.detail.snapshotSha256}>副本 {rerun.detail.snapshotSha256.slice(0, 12)}</span></dd></>}
      {verdict && !rerun && <><dt>复验</dt><dd>未取得本次副本的完整结果</dd></>}
      </dl></div>;
    })}
    {previousMessage && <a className="cc-reply-reference" href={'#message-' + previousMessage.id}>{repair ? '查看原评审' : '查看原作者的修订'}</a>}
  </section>;
}
