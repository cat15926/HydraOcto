import type { AcceptanceEvidence, CollaborationInvocation, ProjectRepair, ProjectTestEvidence, SourceWork, WorkspaceGrant } from '../../shared/collaboration.js';
import { AppError } from '../store.js';
import { supportedProjectNpmCheck } from './project-review-tools.js';
import type { CollaborationStore } from './store.js';

// Opt in from the user's own instruction, before adding attachment text, history or reviewer notes.
export function requestsReviewRevision(content: string) {
  if (/(?:只(?:需|要)?评审|仅评审|等我|先确认|不要.{0,10}(?:改|修|返工)|不(?:用|必|需).{0,8}(?:改|修)|review only|do not|don.t|wait for me)/iu.test(content)) return false;
  return /(?:^|[，,。；;！!\n]|评审后)\s*(?:若|如(?:果)?|假如)?(?:评审(?:发现|指出)|发现|有)(?:了)?问题[，,\s]*(?:就|请|再|则)?(?:继续|接着|直接|自动)?(?:改(?:正|好|进)?|修(?:改|订|复|正)|返工)(?:[，,。；;！!\s]|$)/u.test(content)
    || /\bif (?:the )?(?:review|tests?) (?:finds? (?:any )?(?:issues?|problems?)|fails?),? (?:please )?(?:continue (?:and |to )?)?(?:fix|revise|repair)\b/i.test(content);
}

function settled(i: CollaborationInvocation) {
  return i.status === 'succeeded' && i.teardown === 'confirmed' && i.acceptance === 'accepted' && !i.cancelRevision;
}

function parseTest(e: AcceptanceEvidence | undefined, name: string): ProjectTestEvidence | undefined {
  if (!e || e.detail.name !== name || e.detail.state !== 'tested' || e.detail.treeExited !== true) return;
  const {argv,exitCode,snapshotSha256} = e.detail;
  if (!Array.isArray(argv) || !argv.every((a):a is string => typeof a === 'string') || typeof exitCode !== 'number' ||
      !Number.isInteger(exitCode) || typeof snapshotSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(snapshotSha256)) return;
  return {evidenceId:e.id,argv,snapshotSha256,exitCode};
}

function indexTests(tests: ProjectTestEvidence[]) {
  return new Map(tests.map(test => [JSON.stringify(test.argv), test]));
}

export class ProjectRevisions {
  constructor(private store: CollaborationStore) {}

  private sources(cid: string) { return this.store.cooperation.sources(cid); }

  private receipts(id: string, origin = 'project_review') {
    const rows = this.store.db.prepare("SELECT value FROM cc_evidence WHERE invocation_id=? AND json_extract(value,'$.kind')='tool' AND json_extract(value,'$.detail.origin')=? ORDER BY rowid").all(id,origin) as {value:string}[];
    return rows.map(row=>JSON.parse(row.value) as AcceptanceEvidence);
  }

  private validateOrigin(id: string, cid: string, grant: WorkspaceGrant) {
    const run = this.store.invocation(id);
    if (run.conversationId !== cid || !settled(run)) throw new AppError(409,'项目接力的前一轮尚未成功退出。');
    this.store.visibility.validateInvocation(id);
    this.store.projectReviews.requireGrant(cid,run.memberId,grant.revision,grant);
    return run;
  }

  validateRepair(source: SourceWork, memberId: string, grant?: WorkspaceGrant) {
    const ref = source.projectRepair;
    if (!ref || !grant || source.kind !== 'a2a' || source.parentInvocationId !== ref.reviewInvocationId || source.requestedTargets.length !== 1) {
      throw new AppError(409,'修订委托缺少准确的项目评审。');
    }
    const author = this.validateOrigin(ref.authorInvocationId,source.conversationId,grant);
    const reviewer = this.validateOrigin(ref.reviewInvocationId,source.conversationId,grant);
    const origin = this.store.visibility.primary(author.id);
    const review = this.store.visibility.primary(reviewer.id);
    if (memberId !== author.memberId || source.authorMemberId !== reviewer.memberId || !origin.allowReviewRevision ||
        review.projectReview?.revisionAuthorInvocationId !== author.id || review.projectReview.originalSourceId !== origin.id ||
        review.parentInvocationId !== author.id || review.projectReview.grantRevision !== grant.revision) {
      throw new AppError(409,'原作者、评审成员或项目授权已变化。');
    }
  }

  private currentReviewTests(id: string): ProjectTestEvidence[] {
    const receipts = this.receipts(id);
    const checked = receipts.findLast(e=>e.detail.state==='checked')?.detail.files;
    const filesVerified = Array.isArray(checked) && checked.some(f=>f.status==='unchanged') &&
      checked.every(f=>f.status==='unchanged' || f.status==='unread');
    if (!filesVerified) return [];
    return this.currentTests(receipts,'project_review_test');
  }

  private currentTests(receipts: AcceptanceEvidence[], tool: string): ProjectTestEvidence[] {
    // A newer project snapshot supersedes results from all older snapshots.
    // Within one snapshot, a passing command only resolves that particular check.
    const latest = new Map<string,AcceptanceEvidence>();
    let snapshot: string | undefined;
    for (const receipt of receipts) {
      if (receipt.detail.name!==tool) continue;
      const test = parseTest(receipt,tool);
      const observedSnapshot = test?.snapshotSha256 ?? (receipt.detail.state === 'test_skipped' &&
        receipt.detail.treeExited === true ? receipt.detail.snapshotSha256 : undefined);
      if (typeof observedSnapshot === 'string' && /^[a-f0-9]{64}$/.test(observedSnapshot) && observedSnapshot!==snapshot) {
        snapshot = observedSnapshot;
        latest.clear();
      }
      latest.set(JSON.stringify(receipt.detail.argv),receipt);
    }
    return Array.from(latest.values()).flatMap(receipt=>{
      const test = parseTest(receipt,tool);
      return test ? [test] : [];
    });
  }

  private repair(reviewer: CollaborationInvocation, source: SourceWork, author: CollaborationInvocation) {
    const scope = source.projectReview!;
    if (!settled(reviewer) || !settled(author) || source.withdrawnAt || source.requestedTargets.length!==1 ||
        scope.rereadOf) return;
    const checks = this.currentReviewTests(reviewer.id).filter(test =>
      supportedProjectNpmCheck(test.argv, scope.projectNpmChecks === true) &&
      (test.argv.length !== 3 || test.argv[2] !== '--'));
    const failed = checks.filter(check => check.exitCode !== 0);
    const test = failed[0];
    if (!test) return;
    const sources = this.sources(source.conversationId);
    if (sources.some(s=>s.projectRepair?.authorInvocationId===author.id)) return;
    const ref: ProjectRepair = {authorInvocationId:author.id,reviewInvocationId:reviewer.id,failedTest:test,
      ...(scope.projectNpmChecks ? {checks} : {})};
    const grant = this.store.contract(reviewer.id).workspaceGrant!;
    this.validateOrigin(reviewer.id,source.conversationId,grant);
    this.validateOrigin(author.id,source.conversationId,grant);
    const summary = this.store.response(reviewer.responseId).content.slice(0,6000);
    const readFiles = this.receipts(reviewer.id).filter(e=>e.detail.state==='read').map(e=>e.detail.path);
    const next = this.store.admitSource({conversationId:source.conversationId,kind:'a2a',projectWork:true,
      projectRepair:ref,projectGrantRevision:scope.grantRevision,requestedTargets:[author.memberId],
      parentInvocationId:reviewer.id,authorMemberId:reviewer.memberId,depth:source.depth+1,
      content:'请在原项目修复评审发现的问题，重新运行失败用例。自测通过后，原评审成员会再次核对。\n失败命令：'+
        JSON.stringify(test.argv)+'，退出码 '+test.exitCode+'。'+
        (failed.length>1 ? '\n同一副本的其他失败用例：'+JSON.stringify(failed.slice(1).map(item=>({argv:item.argv,exitCode:item.exitCode}))) : '')+
        (ref.checks ? '\n修复后在同一新版本逐项自测：'+JSON.stringify(checks.map(check=>check.argv)) : '')+
        '\n评审已读文件：'+JSON.stringify([...new Set(readFiles)].slice(0,16))+'\n评审意见：'+summary});
    this.store.publishSource(next);
  }

  private retest(run: CollaborationInvocation, source: SourceWork) {
    const repair = source.projectRepair!;
    const grant = this.store.contract(run.id).workspaceGrant!;
    this.validateOrigin(run.id,source.conversationId,grant);
    this.validateRepair(source,run.memberId,grant);
    if (this.sources(source.conversationId).some(s=>s.projectReview?.retestOfRepairInvocationId===run.id)) return;
    const checks = repair.checks ?? [repair.failedTest];
    const observed = indexTests(this.currentTests(this.receipts(run.id,'project_author_test'),'project_npm_test'));
    const authorTest = observed.get(JSON.stringify(repair.failedTest.argv));
    if (!authorTest || authorTest.snapshotSha256===repair.failedTest.snapshotSha256) {
      throw new AppError(409,'修订尚未取得新版本同一失败用例的自测通过回执。');
    }
    for (const check of checks) {
      const result = observed.get(JSON.stringify(check.argv));
      if (!result || result.exitCode !== 0 || result.snapshotSha256 !== authorTest.snapshotSha256) {
        throw new AppError(409,'修订缺少同一新版本的自测通过回执：'+JSON.stringify(check.argv));
      }
    }
    const reviewer = this.store.invocation(repair.reviewInvocationId);
    const previous = this.store.visibility.primary(reviewer.id);
    const {revisionAuthorInvocationId, ...scope} = previous.projectReview!;
    const next = this.store.admitSource({conversationId:source.conversationId,kind:'a2a',requestedTargets:[reviewer.memberId],
      parentInvocationId:run.id,authorMemberId:run.memberId,depth:source.depth+1,projectReview:{...scope,initialReviewSourceId:previous.id,
        retestOfRepairInvocationId:run.id,failedTest:repair.failedTest,authorTest},
      content:'请重新读取修订后的文件，在同一新版本的独立副本逐项复跑以下命令：'+JSON.stringify(checks.map(check=>check.argv))+
        '。逐项说明结果。\n初评要求：'+previous.content.slice(0,2000)+'\n作者说明：'+this.store.response(run.responseId).content.slice(0,4000)});
    this.store.publishSource(next);
  }

  validateRetest(source: SourceWork, memberId: string) {
    const repairId = source.projectReview?.retestOfRepairInvocationId;
    if (!repairId) return;
    const run = this.store.invocation(repairId);
    const grant = this.store.contract(run.id).workspaceGrant!;
    const repair = this.store.visibility.primary(run.id);
    this.validateOrigin(repairId,source.conversationId,grant);
    this.validateRepair(repair,run.memberId,grant);
    if (source.parentInvocationId !== repairId || this.store.invocation(repair.projectRepair!.reviewInvocationId).memberId !== memberId) {
      throw new AppError(409,'原修订或复验成员已变化。');
    }
    return repair.projectRepair;
  }

  onFinished(run: CollaborationInvocation, source: SourceWork) {
    if (!settled(run)) return;
    try {
      const scope = source.projectReview;
      if (scope?.retestOfRepairInvocationId && scope.failedTest) {
        const repair = this.validateRetest(source,run.memberId);
        const observed = indexTests(this.currentReviewTests(run.id));
        const checks = (repair?.checks ?? [scope.failedTest]).map(initial => {
          const result = observed.get(JSON.stringify(initial.argv));
          const verified = result && result.snapshotSha256 === scope.authorTest?.snapshotSha256 &&
            result.snapshotSha256 !== initial.snapshotSha256;
          return {argv:initial.argv, previousEvidenceId:initial.evidenceId,
            ...(verified ? {testEvidenceId:result.evidenceId} : {}),
            outcome:!verified ? 'unverified' : result.exitCode === 0 ? 'passed' : 'failed'};
        });
        const outcome = checks.some(check=>check.outcome==='failed') ? 'failed' :
          checks.every(check=>check.outcome==='passed') ? 'passed' : 'unverified';
        const primary = checks.find(check=>check.previousEvidenceId===scope.failedTest?.evidenceId);
        this.store.recordEvidence(run.id,{kind:'tool',detail:{origin:'project_review',state:'revision_verdict',outcome,
          previousEvidenceId:scope.failedTest.evidenceId,testEvidenceId:primary?.testEvidenceId,
          ...(repair?.checks ? {checks} : {})}});
      } else if (source.projectRepair) {
        this.retest(run,source);
      } else if (scope?.revisionAuthorInvocationId) {
        this.repair(run,source,this.store.invocation(scope.revisionAuthorInvocationId));
      } else if (source.allowReviewRevision) {
        // A reviewer may finish while the original author is still exiting.
        const child = this.sources(run.conversationId).find(s=>s.projectReview?.revisionAuthorInvocationId===run.id);
        const reviewer = child && this.store.invocations(run.conversationId).find(i=>this.store.contract(i.id).primarySourceId===child.id);
        if (child && reviewer) this.repair(reviewer,child,run);
      }
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      this.store.recordEvidence(run.id,{kind:'tool',detail:{origin:'project_review',state:'revision_blocked',reason:error.message}});
    }
  }
}
