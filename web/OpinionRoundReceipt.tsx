import type { OpinionRound } from '../shared/opinions';
import './review-progress.css';

const stateLabels: Record<OpinionRound['state'], string> = {
  collecting: '征询中', ready: '达到决策人数', locked: '决定依据已锁定', expired: '已到期', cancelled: '已取消',
};

export function opinionProgress(round: OpinionRound) {
  const state = round.state === 'collecting' && round.lockMode === 'deadline' && round.validCount >= round.minimum
    ? '人数已够，等待截止' : stateLabels[round.state];
  return `${state} · ${round.validCount} 人已回应，至少需 ${round.minimum} 人`;
}

export function OpinionRoundReceipt({round, name, onMessage}: {round: OpinionRound; name: (id: string) => string; onMessage?: (id:string) => void}) {
  const locked = new Set(round.lockedOpinionIds ?? []);
  const reviews = new Map(round.resolutions.map(entry => [entry.opinionId, entry]));
  const checked = (id:string) => { const review = reviews.get(id); return review && review.valid !== false; };
  const latest = new Map<string, number>();
  for (const opinion of round.opinions) {
    if (!opinion.late) latest.set(opinion.instanceId, Math.max(opinion.version, latest.get(opinion.instanceId) ?? 0));
  }
  const waiting = round.participants.filter(p => !latest.has(p.instanceId));
  return <details className="cc-review-progress" data-opinion-round={round.id}>
    <summary><strong>{round.question}</strong><span>{opinionProgress(round)}</span></summary>
    <p>{name(round.decider.memberId)} 负责决定 · {new Date(round.deadline).toLocaleString()} 截止</p>
    {round.state === 'ready' && <p>{round.lockMode === 'deadline' ? '截止时锁定本次决定依据。' : '负责人可以锁定用于决定的意见版本。'}</p>}
    {round.reason && <p>{round.reason}</p>}
    {round.state === 'locked' && round.objectionIds?.some(id => !checked(id)) && <p className="cc-review-objection">有署名异议待核查，暂不能交付。</p>}
    {(round.state === 'collecting' || round.state === 'expired') && waiting.length > 0 && <p>尚待回应 · {waiting.map(p => name(p.memberId)).join('、')}</p>}
    {!!round.opinions.length && <ul className="cc-review-rows">{round.opinions.map(opinion => {
      const review = reviews.get(opinion.id);
      const included = locked.has(opinion.id);
      const current = latest.get(opinion.instanceId) === opinion.version;
      const disposition = opinion.late ? '迟到归档' : included ? '已纳入决定依据' : current ? '' : '历史意见';
      return <li key={opinion.id}>
        <strong>{name(opinion.memberId)} · 第 {opinion.version} 版</strong>{disposition && <small>{disposition}</small>}
        <p>{opinion.text}</p>
        {opinion.objection && <p className="cc-review-objection">{review?.valid === false ? '证据失效，待重新核查' : review ? '异议已核查' : opinion.late ? '迟到异议' : '署名异议'}</p>}
        {review && review.valid !== false && <><p>核查结论 · {review.finding}</p>
          {review.evidenceMessageId && onMessage && <button type="button" onClick={()=>onMessage(review.evidenceMessageId!)}>查看核查依据</button>}
        </>}
      </li>;
    })}</ul>}
  </details>;
}
