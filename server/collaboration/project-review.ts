import { createHash } from 'node:crypto';
import { projectNpmPermission } from './project-npm-permission.js';
import type { AcceptanceEvidence, CollaborationRuntime, ProjectReviewCheck, ProjectReviewScope, SourceWork, WorkspaceGrant } from '../../shared/collaboration.js';
import { AppError, now } from '../store.js';
import type { CollaborationStore } from './store.js';
import { verifyWorkspace } from './workbench.js';

import { discoverableProjectPath, listProjectDirectory, readProjectText } from './project-file-read.js';
import { MissingProjectScript, supportedProjectNpmCheck } from './project-review-tools.js';

export function reviewPaths(input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => k !== 'paths')) throw new AppError(400,'项目评审需要指定相对文件路径。');
  const paths = (input as {paths?: unknown}).paths;
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 8 || new Set(paths).size !== paths.length ||
      paths.some(p => typeof p !== 'string' || Buffer.from(p).toString('utf8') !== p || p.length > 512 || /[\\:\x00-\x1f\x7f]/.test(p) || p.split('/').some((part:string) => !part || part.startsWith('.')))) {
    throw new AppError(400,'请选择 1 至 8 个不重复的项目相对文件路径，不能包含隐藏目录或上级目录。');
  }
  return paths;
}

export class ProjectReviews {
  constructor(private store: CollaborationStore) {}
  requireGrant(cid:string, memberId:string, revision:number, frozen?: WorkspaceGrant) {
    const c = this.store.workbench.conversation(cid), g = c.workspaceGrant;
    const binding = this.store.workbench.projectMemberBinding(memberId);
    if (c.archivedAt || c.deletedAt || c.importedFor || !c.memberIds.includes(memberId) || !g || g.mode !== 'project-work' ||
        g.revision !== revision || g.conversationId !== cid || !g.memberIds?.includes(memberId) || !binding || g.memberBindings?.[memberId] !== binding ||
        (frozen && (g.path !== frozen.path || g.device !== frozen.device || g.inode !== frozen.inode || g.revision !== frozen.revision || g.reviewMode !== frozen.reviewMode))) {
      throw new AppError(409,'评审所用的项目、成员或授权已变化。');
    }
    verifyWorkspace(g);
    return g;
  }
  originalRequest(cid:string, scope:ProjectReviewScope) {
    const source = this.store.artifacts.get<SourceWork>('cc_sources',scope.originalSourceId);
    if (source.conversationId !== cid || !source.projectWork || source.kind !== 'user' || source.visibility || source.excerptRefs?.length || source.withdrawnAt) {
      throw new AppError(409,'原始公开委托已失效。');
    }
    return {id: source.id, content: this.store.visibility.sourceContent(source)};
  }
  private context(cid:string,id:string) {
    const run = this.store.invocation(id), contract = this.store.contract(id), scope = contract.projectReview;
    if (!scope || contract.visibility || contract.projectWork || run.conversationId !== cid || !contract.workspaceGrant) throw new AppError(404,'找不到此会话的项目评审。');
    const primary = this.store.visibility.primary(id);
    if (primary.withdrawnAt || primary.visibility || !primary.requestedTargets.includes(run.memberId)) throw new AppError(409,'原评审请求已失效。');
    this.originalRequest(cid,scope);
    return {run,contract,scope};
  }
  private receipts(id:string,origin='project_review') {
    const rows = this.store.db.prepare('SELECT value FROM cc_evidence WHERE invocation_id=? ORDER BY rowid').all(id) as {value:string}[];
    return rows.map(r=>JSON.parse(r.value) as AcceptanceEvidence).filter(e=>e.kind==='tool' && e.detail.origin===origin);
  }
  private verifier(id:string, tool:string, signal:AbortSignal) {
    return () => {
      signal.throwIfAborted();
      const cid = this.store.invocation(id).conversationId;
      const {scope,contract,run} = this.context(cid,id);
      this.store.visibility.assertTool(id,tool);
      if (run.status !== 'running' || run.acceptance !== 'accepted') throw new AppError(409,'评审成员需要先接受委托并保持运行。');
      if (tool !== 'project_review_read' && scope.mode !== 'project') throw new AppError(403,'项目查阅和测试需要单独授权。');
      const grant = this.requireGrant(cid,run.memberId,scope.grantRevision,contract.workspaceGrant);
      if (scope.mode === 'project' && grant.reviewMode !== 'project') throw new AppError(403,'此项目未授权评审成员自主查阅和测试。');
      return grant;
    };
  }
  async list(id:string,args:Record<string,unknown>,callId:string,signal:AbortSignal) {
    const {path='',after=''} = args;
    if (Object.keys(args).some(key=>key!=='path' && key!=='after') || typeof path!=='string' || typeof after!=='string') {
      throw new AppError(400,'请提供目录相对路径。');
    }
    const verify = this.verifier(id,'project_review_list',signal);
    const page = await listProjectDirectory(verify(),path,after,signal);
    verify();
    const receipts = this.receipts(id).filter(e=>e.detail.state==='listed');
    const previous = receipts.find(e=>e.detail.callId===callId);
    const sha256 = createHash('sha256').update(JSON.stringify(page)).digest('hex');
    if (previous && (previous.detail.path!==path || previous.detail.after!==after || previous.detail.sha256!==sha256)) {
      throw new AppError(409,'该编号对应的目录列表已变化，请重新查阅。');
    }
    if (!previous) {
      if (receipts.length>=64) throw new AppError(409,'本次评审已达到目录浏览上限。');
      this.store.recordEvidence(id,{kind:'tool',detail:{origin:'project_review',state:'listed',name:'project_review_list',callId,path,after,sha256,count:page.entries.length}});
    }
    return page;
  }
  async read(id:string,args:Record<string,unknown>,callId:string,signal:AbortSignal) {
    const scope = this.store.contract(id).projectReview;
    const path = args.path;
    if (!scope || Object.keys(args).length !== 1 || typeof path!=='string' ||
        !(scope.mode==='project' ? discoverableProjectPath(path) : scope.paths.includes(path))) {
      throw new AppError(403,'只能读取本次评审范围内的项目文件。');
    }
    const verify = this.verifier(id,'project_review_read',signal);
    const file = await readProjectText(verify(),path,signal);
    verify();
    const receipts = this.receipts(id).filter(e=>e.detail.state==='read'), previous = receipts.find(e=>e.detail.callId===callId);
    if (previous && (previous.detail.path!==path || previous.detail.sha256!==file.sha256)) throw new AppError(409,'该读取编号已绑定之前的文件版本，请重新发起读取。');
    if (!previous) {
      if (receipts.length>=64) throw new AppError(409,'本次评审已达到读取上限。');
      this.store.recordEvidence(id,{kind:'tool',detail:{origin:'project_review',state:'read',name:'project_review_read',callId,path,sha256:file.sha256,bytes:file.bytes}});
    }
    return {path,...file};
  }
  authorNpmTest(id:string,args:Record<string,unknown>,callId:string,signal:AbortSignal,execute?:CollaborationRuntime['runProjectReviewTest']) {
    const extended = this.store.contract(id).projectNpmChecks === true;
    const script = args.script === undefined ? 'test' : args.script;
    const extra = args.args ?? [];
    if (Object.keys(args).some(key => key !== 'args' && !(extended && key === 'script')) || !Array.isArray(extra) ||
        (script !== 'test' && (!extended || (script !== 'build' && script !== 'typecheck') || extra.length))) {
      throw new AppError(400, extended ? '请选择 test、typecheck 或 build；只有 test 可追加参数。' : '请提供 npm test 的测试参数。');
    }
    const verify = () => {
      signal.throwIfAborted();
      const run = this.store.invocation(id), contract = this.store.contract(id), grant = contract.workspaceGrant;
      if (run.status !== 'running' || run.acceptance !== 'accepted' || !contract.mayRunProjectNpmTest ||
          !contract.projectWork || contract.visibility || !grant) throw new AppError(403,'本次执行未获得项目测试授权。');
      this.store.visibility.assertTool(id,'project_npm_test');
      this.store.artifacts.origin(run.conversationId,id);
      return this.requireGrant(run.conversationId,run.memberId,grant.revision,grant);
    };
    const argv = script === 'test' ? ['npm','test',...(extra.length ? ['--', ...extra] : [])] : ['npm','run',script];
    return this.runTest(id,{argv},callId,signal,verify,execute,true);
  }
  async verifyTests(id:string,args:Record<string,unknown>,callId:string,signal:AbortSignal,execute?:CollaborationRuntime['runProjectReviewTest']) {
    return this.runTest(id,args,callId,signal,this.verifier(id,'project_review_test',signal),execute,false);
  }
  private async runTest(id:string,args:Record<string,unknown>,callId:string,signal:AbortSignal,verify:()=>WorkspaceGrant,
    execute:CollaborationRuntime['runProjectReviewTest'],author:boolean) {
    const argv = args.argv;
    if (Object.keys(args).length!==1 || !Array.isArray(argv) || argv.length<1 || argv.length>32 ||
        !argv.every((part):part is string => typeof part==='string' && part.length<=1024 && !part.includes('\0')) ||
        !argv[0] || argv.join(' ').length>4096) throw new AppError(400,'请提供测试程序名和分开的参数。');
    if (!callId || callId.length>200) throw new AppError(400,'测试调用编号无效。');
    const grant = verify();
    if (!execute) throw new AppError(409,'当前项目没有可用于评审的隔离测试环境。');
    const contract = this.store.contract(id);
    const extended = (author ? contract.projectNpmChecks : contract.projectReview?.projectNpmChecks) === true;
    const namedCheck = argv[0] === 'npm' && argv[1] === 'run' && (argv[2] === 'typecheck' || argv[2] === 'build');
    const npmTest = author || (contract.projectReview?.npmTest === true && argv[0] === 'npm' && (extended || argv[1] === 'test'));
    if ((namedCheck && (!npmTest || !extended)) || (npmTest && !supportedProjectNpmCheck(argv, extended))) {
      throw new AppError(403,'此 npm 检查命令超出本次执行范围。');
    }
    const permission = npmTest ? projectNpmPermission(this.store,id,callId,argv,signal,verify) : undefined;
    const origin = author ? 'project_author_test' : 'project_review';
    const receipts = this.receipts(id,origin);
    const started = receipts.filter(e=>e.detail.state==='test_started');
    const previous = started.find(e=>e.detail.callId===callId);
    if (previous) {
      if (JSON.stringify(previous.detail.argv)!==JSON.stringify(argv)) throw new AppError(409,'此测试编号已绑定另一条命令。');
      const finished = receipts.find(e=>e.detail.callId===callId && (e.detail.state==='tested' || e.detail.state==='test_skipped'));
      if (!finished) throw new AppError(409,'该测试已发起，尚无完整结果。');
      if (finished.detail.state === 'test_skipped') return {argv,state:'skipped',reason:finished.detail.reason,snapshotSha256:finished.detail.snapshotSha256,treeExited:true,replayed:true};
      return {argv,exitCode:finished.detail.exitCode,snapshotSha256:finished.detail.snapshotSha256,treeExited:true,replayed:true};
    }
    if (started.length>=4 || started.some(e=>!receipts.some(result=>result.detail.callId===e.detail.callId && (result.detail.state==='tested' || result.detail.state==='test_skipped')))) {
      throw new AppError(409,'本轮已有待确认的测试，或已达到四次测试上限。');
    }
    // Persist the claim before launching. A crash or concurrent callback may not replay the test.
    const receipt = {origin,name:author ? 'project_npm_test' : 'project_review_test',callId,argv};
    this.store.recordEvidence(id,{kind:'tool',detail:{...receipt,state:'test_started'}});
    try {
      const result = await execute({grant,argv,signal,verifyAuthorization:verify,...(permission ? {npm:permission.hooks, ...(extended ? {projectNpmChecks:true as const} : {})} : {}),...(author ? {authorInvocationId:id} : {})});
      verify();
      if (result.treeExited!==true || !Number.isInteger(result.exitCode) || !/^[a-f0-9]{64}$/.test(result.snapshotSha256) ||
          JSON.stringify(result.argv)!==JSON.stringify(argv)) throw new AppError(409,'未收到完整的隔离测试回执。');
      const outputSha256 = createHash('sha256').update(result.output).digest('hex');
      this.store.recordEvidence(id,{kind:'tool',detail:{...receipt,state:'tested',exitCode:result.exitCode,snapshotSha256:result.snapshotSha256,
        outputSha256,truncated:result.truncated,treeExited:true}});
      permission?.record('tested',{exitCode:result.exitCode,snapshotSha256:result.snapshotSha256,treeExited:true});
      return result;
    } catch (error) {
      if (permission && extended && error instanceof MissingProjectScript && error.script === (argv[1] === 'test' ? 'test' : argv[2]) &&
          /^[0-9a-f]{64}$/.test(error.snapshotSha256)) {
        verify();
        const detail = {reason:error.message,snapshotSha256:error.snapshotSha256,treeExited:true};
        this.store.recordEvidence(id,{kind:'tool',detail:{...receipt,...detail,state:'test_skipped'}});
        permission.record('skipped',detail);
        return {argv,state:'skipped',...detail};
      }
      if (permission && !permission.declined) {
        const reason = error instanceof Error && /^(评审测试|项目|依赖|测试|锁文件|作者|此|请)/.test(error.message)
          ? error.message.slice(0,180) : '测试未能完成，请查看本次执行记录。';
        permission.record('failed',{reason});
      }
      this.store.recordEvidence(id,{kind:'tool',detail:{...receipt,state:'test_incomplete'}});
      throw error;
    }
  }
  async check(cid:string,id:string,signal?:AbortSignal):Promise<ProjectReviewCheck> {
    const {run,contract,scope} = this.context(cid,id), receipts = this.receipts(id).filter(e=>e.detail.state==='read');
    const verify = () => this.requireGrant(cid,run.memberId,scope.grantRevision,contract.workspaceGrant);
    const files: ProjectReviewCheck['files'] = [];
    const paths = new Set(scope.paths);
    if (scope.mode==='project') {
      for (const {detail} of receipts) if (discoverableProjectPath(detail.path)) paths.add(detail.path);
    }
    for (const path of paths) {
      const receipt = receipts.findLast(e=>e.detail.path===path), sha256 = receipt?.detail.sha256;
      if (typeof sha256 !== 'string') { files.push({path,status:'unread'}); continue; }
      try {
        const current = await readProjectText(verify(),path,signal);
        verify();
        files.push({path,sha256,currentSha256:current.sha256,status:sha256===current.sha256?'unchanged':'changed'});
      } catch { files.push({path,sha256,status:'unavailable'}); }
    }
    return {checkedAt:now(),files};
  }
  reread(cid:string,id:string,requestId:string) {
    const {run,scope,contract} = this.context(cid,id), port = this.store.artifacts.port;
    return port.tx(()=>port.command('project-review-reread:'+requestId,{cid,id},()=>{
      if (!['succeeded','failed','cancelled','interrupted'].includes(run.status) || run.teardown!=='confirmed') throw new AppError(409,'请等待评审执行确认退出。');
      this.requireGrant(cid,run.memberId,scope.grantRevision,contract.workspaceGrant);
      const existing = this.store.artifacts.rows<SourceWork>('cc_sources',cid).find(source => !source.withdrawnAt && source.projectReview?.rereadOf === id);
      if (existing) return {sourceId:existing.id};
      const original = this.store.visibility.primary(id);
      const first = scope.initialReviewSourceId ? this.store.artifacts.get<SourceWork>('cc_sources', scope.initialReviewSourceId) : original;
      if (first.conversationId !== cid || first.kind !== 'a2a' || first.withdrawnAt || first.visibility || !first.requestedTargets.includes(run.memberId)) throw new AppError(409,'最初的评审请求已失效。');
      const projectReview: ProjectReviewScope = {paths:scope.paths,originalSourceId:scope.originalSourceId,grantRevision:scope.grantRevision,mode:scope.mode,npmTest:scope.npmTest,projectNpmChecks:scope.projectNpmChecks,rereadOf:id,initialReviewSourceId:first.id};
      const source = this.store.admitSource({conversationId:cid,kind:'user',requestedTargets:[run.memberId],depth:0,
        content:'请重新读取评审文件并复核原问题。\n'+first.content,projectReview});
      this.store.publishSource(source);
      return {sourceId:source.id};
    }));
  }
}
