import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AcceptanceEvidence, CollaborationInvocation, ConversationMessage, MessageVisibility, RoomMemberInstance, SourceWork } from '../../shared/collaboration.js';
import type { FactorKind, FactorNoteInput, FactorRef, FactorView, IssueFactorInput } from '../../shared/factors.js';
import type { Obligation } from '../../shared/obligations.js';
import { AppError, now } from '../store.js';
import type { CollaborationStore } from './store.js';
import { privateScope } from './visibility.js';

export function migrateFactors(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS cc_factors (
    sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, room TEXT NOT NULL REFERENCES cc_conversations(id),
    ref_kind TEXT NOT NULL, ref_id TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0, UNIQUE(room,ref_kind,ref_id,version)
  );
  CREATE INDEX IF NOT EXISTS cc_factors_room_sequence ON cc_factors(room,sequence);
  CREATE TABLE IF NOT EXISTS cc_factor_policy(room TEXT PRIMARY KEY REFERENCES cc_conversations(id), revision INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS cc_factor_parents(
    child TEXT NOT NULL REFERENCES cc_factors(id), parent TEXT NOT NULL REFERENCES cc_factors(id), PRIMARY KEY(child,parent)
  );
  CREATE TABLE IF NOT EXISTS cc_factor_inputs(
    factor_id TEXT NOT NULL REFERENCES cc_factors(id), kind TEXT NOT NULL, ref_id TEXT NOT NULL, revision INTEGER NOT NULL,
    PRIMARY KEY(factor_id,kind,ref_id)
  );
  CREATE TABLE IF NOT EXISTS cc_factor_choices(
    observation_id TEXT PRIMARY KEY REFERENCES cc_factors(id), expression_id TEXT NOT NULL UNIQUE REFERENCES cc_factors(id),
    choice INTEGER NOT NULL, invocation_id TEXT NOT NULL REFERENCES cc_invocations(id)
  );
  CREATE INDEX IF NOT EXISTS cc_factor_descendants ON cc_factor_parents(parent,child);`);
}

type Stored = Omit<FactorView,'sequence'|'parentIds'> & {
  audience: string[] | 'room';
  memberId?: string;
};
type Draft = Pick<Stored,'roomId'|'kind'|'issuer'|'content'|'audience'> & Partial<Pick<Stored,'memberId'|'obligationRef'|'expressionOptions'>>;
type Role = 'public' | 'member' | 'writing' | 'operator';
function invalid(message: string): never { throw new AppError(400,message,'invalid_factor'); }
function denied(): never { throw new AppError(404,'资料不存在或已不可用。','factor_unavailable'); }
function checked(s: unknown, max: number) {
  if (typeof s !== 'string' || s.trim().length === 0 || s.length > max) invalid('内容为空或过长。');
  return s.trim();
}
const personalKinds = new Set<FactorKind>(['observation','expression','note']);

export class FactorService {
  constructor(private readonly store: CollaborationStore) {}
  private get db() { return this.store.db; }
  private get port() { return this.store.artifacts.port; }
  private enabled(cid: string) {
    const room = this.store.workbench.conversation(cid);
    return !room.deletedAt && !room.importedFor && room.collaborationMode === 'continuous';
  }
  private writable(cid: string) {
    if (!this.enabled(cid) || this.store.workbench.conversation(cid).archivedAt) denied();
  }
  private reference(cid: string, kind: FactorRef['kind'], id?: string) {
    if (!id) return undefined;
    const row = this.db.prepare('SELECT id FROM cc_factors WHERE room=? AND ref_kind=? AND ref_id=? ORDER BY version DESC LIMIT 1').get(cid,kind,id);
    return row && String(row.id);
  }
  private insert(d: Draft, ref?: FactorRef, parents: (string|undefined)[] = []) {
    const id = randomUUID();
    const sourceRef = ref ?? {kind:'room-record' as const, id, version:1};
    const value: Stored = {...d, id, version:sourceRef.version, sourceRef, createdAt:now()};
    const row = this.db.prepare('INSERT INTO cc_factors(id,room,ref_kind,ref_id,version,value) VALUES(?,?,?,?,?,?) ON CONFLICT(room,ref_kind,ref_id,version) DO NOTHING')
      .run(id,d.roomId,sourceRef.kind,sourceRef.id,sourceRef.version,JSON.stringify(value));
    if (!row.changes) {
      const existing = this.db.prepare('SELECT id FROM cc_factors WHERE room=? AND ref_kind=? AND ref_id=? AND version=?')
        .get(d.roomId,sourceRef.kind,sourceRef.id,sourceRef.version)!;
      return String(existing.id);
    }
    const insert = this.db.prepare('INSERT INTO cc_factor_parents(child,parent) SELECT ?,id FROM cc_factors WHERE id=? AND room=?');
    for (const p of new Set(parents)) if (p) insert.run(id,p,d.roomId);
    return id;
  }
  cutoff(cid: string) {
    return Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM cc_factors WHERE room=?').get(cid)!.n);
  }
  policyRevision(cid: string) {
    return Number(this.db.prepare('SELECT revision FROM cc_factor_policy WHERE room=?').get(cid)?.revision ?? 0);
  }
  private member(cid: string, actor: RoomMemberInstance) {
    if (!this.enabled(cid) || actor.conversationId !== cid || !this.store.roomMembers.isCurrent(actor)) denied();
    this.store.artifacts.target(cid,actor.memberId);
  }

  issue(cid: string, input: IssueFactorInput) {
    this.writable(cid);
    const request = checked(input.requestId,160);
    return this.port.tx(() => {
      const member = this.store.roomMembers.resolve(cid,checked(input.memberId,160));
      this.member(cid,member);
      const content = checked(input.content,4000);
      const expression = input.publicExpression === undefined ? undefined : checked(input.publicExpression,1000);
      let expressionOptions: string[] | undefined;
      if (input.expressionOptions !== undefined) {
        const options = input.expressionOptions;
        if (expression || !Array.isArray(options) || options.length<2 || options.length>8) invalid('请授权 2–8 种可选表述，或指定单一表述。');
        expressionOptions = options.map(option=>checked(option,1000));
        if (new Set(expressionOptions).size !== options.length) invalid('可披露的选项不能重复。');
      }
      return this.port.command('factor-issue:'+cid+':'+request,{...input,instanceId:member.id},() => {
        const common = {roomId:cid, issuer:'user', memberId:member.memberId, audience:[member.id]};
        const factorId = this.insert({...common,kind:'observation',content,...(expressionOptions && {expressionOptions})});
        const expressionId = expression && this.insert({...common,kind:'expression',content:expression},undefined,[factorId]);
        return {factorId,...(expressionId ? {expressionId} : {})};
      }).result;
    });
  }
  revoke(cid: string, input: {requestId:string;factorId:string}) {
    this.writable(cid);
    const request = checked(input.requestId,160), factorId = checked(input.factorId,200);
    return this.port.tx(() => this.port.command('factor-revoke:'+cid+':'+request,{factorId},() => {
      const row = this.db.prepare("SELECT value FROM cc_factors WHERE id=? AND room=? AND ref_kind='room-record' AND revoked=0").get(factorId,cid);
      if (!row || !['expression','observation'].includes((JSON.parse(String(row.value)) as Stored).kind)) denied();
      this.db.prepare(`WITH RECURSIVE affected(id) AS (
        SELECT ? UNION SELECT e.child FROM cc_factor_parents e JOIN affected a ON e.parent=a.id JOIN cc_factors f ON f.id=e.child WHERE f.ref_kind='room-record'
      ) UPDATE cc_factors SET revoked=1 WHERE room=? AND id IN (SELECT id FROM affected)`).run(factorId,cid);
      this.db.prepare('INSERT INTO cc_factor_policy VALUES(?,1) ON CONFLICT(room) DO UPDATE SET revision=revision+1').run(cid);
      return {factorId,revoked:true as const};
    }).result);
  }
  private audience(cid: string, scope?: MessageVisibility): Stored['audience'] {
    if (!scope || !privateScope(scope)) return 'room';
    const allowed: string[] = [];
    for (const memberId of scope.memberIds) {
      if (!this.store.visibility.allows(cid,scope,memberId)) continue;
      allowed.push(this.store.roomMembers.resolve(cid,memberId).id);
    }
    return allowed;
  }
  private sourceOf(invocationId?: string) {
    if (!invocationId) return undefined;
    return this.store.contract(invocationId).primarySourceId;
  }
  // Issued only in the new reviewed-excerpt transaction. The local receipt has no edge to
  // the granting room, the transfer, the excerpt coordinates or its underlying materials.
  recordApprovedExcerpt(s:SourceWork, targetInstance:string) {
    if(!s.crossRef || !s.roomPolicy || !this.enabled(s.conversationId) || !privateScope(s.visibility) ||
      s.requestedTargets.length!==1 || this.store.roomMembers.resolve(s.conversationId,s.requestedTargets[0]!).id!==targetInstance) return;
    this.insert({roomId:s.conversationId,kind:'request',issuer:'platform',content:'获准摘录已送入本房间',
      audience:[targetInstance]}, {kind:'source',id:s.id,version:s.revision});
  }
  recordSource(s: SourceWork) {
    if (!this.enabled(s.conversationId) || !s.roomPolicy) return;
    // Existing transfer services govern their own references and disclosure contracts.
    if (s.crossRef || s.actionRef || s.excerptRefs?.length) return;
    const cid = s.conversationId;
    this.insert({roomId:cid,kind:'request',issuer:s.authorMemberId ?? (s.kind==='user'?'user':'platform'),
      content:'工作来源 · '+s.kind,audience:this.audience(cid,s.visibility)},
      {kind:'source',id:s.id,version:s.revision},[
        this.reference(cid,'source',this.sourceOf(s.parentInvocationId)),
        this.reference(cid,'message',s.replyTo),
      ]);
  }
  recordMessage(m: ConversationMessage) {
    const cid = m.conversationId;
    if (!this.enabled(cid) || m.deletedAt || m.branchOrigin || m.importedOrigin || m.excerptRefs?.length) return;
    const sourceId = m.sourceId ?? (m.responseId && this.sourceOf(this.store.response(m.responseId).invocationId));
    const origin = this.reference(cid,'source',sourceId);
    // Requirements apply prospectively. Don't reconstruct old sources or transfer histories.
    if (!origin) return;
    const source=sourceId && this.store.artifacts.get<SourceWork>('cc_sources',sourceId);
    if(source && source.crossRef) {
      if(!m.responseId || m.author!=='member') return;
      const run=this.store.invocation(this.store.response(m.responseId).invocationId);
      if(!run.roomMember || run.status!=='succeeded' || run.acceptance!=='accepted' || run.teardown!=='confirmed' ||
        run.roomMember.conversationId!==cid || run.memberId!==source.requestedTargets[0])return;
      this.insert({roomId:cid,kind:'message',issuer:run.memberId,content:'成员已答复获准摘录',audience:[run.roomMember.id]},
        {kind:'message',id:m.id,version:m.revision ?? 1},[origin]);
      return;
    }
    const context = m.responseId && this.store.contract(this.store.response(m.responseId).invocationId).memberContext;
    const material = context ? context.factors.map(f=>f.id) : [];
    const commitments = m.responseId ? this.db.prepare('SELECT obligation_id FROM cc_obligation_sources WHERE source_id=?')
      .all(sourceId!).map(row=>this.reference(cid,'obligation',String(row.obligation_id))) : [];
    this.insert({roomId:cid,kind:'message',issuer:m.memberId ?? m.author,content:'会话消息',
      audience:this.audience(cid,this.store.visibility.messageScope(m))},
      {kind:'message',id:m.id,version:m.revision ?? 1},[origin,this.reference(cid,'message',m.replyTo),...material,...commitments]);
  }
  recordEvidence(i: CollaborationInvocation, e: AcceptanceEvidence) {
    if (e.kind !== 'tool' || !i.roomMember || !this.enabled(i.conversationId)) return;
    const cid = i.conversationId, contract = this.store.contract(i.id);
    if(contract.primarySourceId && this.store.artifacts.get<SourceWork>('cc_sources',contract.primarySourceId).crossRef) return;
    const origin = this.reference(cid,'source',contract.primarySourceId);
    if (!origin) return;
    // Tool output belongs to the original evidence store. The graph only contains its typed reference.
    this.insert({roomId:cid,kind:'evidence',issuer:'tool',content:'工具回执',
      audience:this.audience(cid,contract.visibility)},
      {kind:'evidence',id:e.id,version:1},[origin]);
  }
  recordObligation(o: Obligation, reason: string, returnedChildId?: string) {
    const cid=o.conversationId;
    if (!this.enabled(cid)) return;
    const origin = this.reference(cid,'source',o.originSourceId);
    if (!origin) return;
    const prior = this.reference(cid,'obligation',o.id);
    const parents = [prior,origin,this.reference(cid,'source',o.currentSourceId),this.reference(cid,'obligation',o.parentId),
      this.reference(cid,'message',o.delivery?.messageId),...(o.report?.evidenceIds ?? []).map(id=>this.reference(cid,'evidence',id))];
    if (returnedChildId) parents.push(this.reference(cid,'obligation',returnedChildId));
    this.insert({roomId:cid,kind:'obligation',issuer:'platform',content:'责任'+o.revision+' · '+reason,audience:'room',
      obligationRef:{id:o.id,revision:o.revision,parentId:o.parentId,ownerId:o.owner.memberId,ownerGeneration:o.owner.generation,
        ownerRevision:o.ownerRevision,returnToId:o.returnTo?.memberId,state:o.state,acceptance:o.acceptance,version:o.version}},
      {kind:'obligation',id:o.id,version:o.revision},parents);
  }

  // Private writers receive the current turn and personal factors. Both can carry revocable inputs.
  private bindWriterInputs(factorId: string, invocationId: string) {
    const source = this.store.visibility.primary(invocationId);
    const insert = this.db.prepare('INSERT OR IGNORE INTO cc_factor_inputs VALUES(?,?,?,?)');
    insert.run(factorId, 'source', source.id, source.revision);
    if (source.replyTo) {
      const quoted = this.store.artifacts.get<ConversationMessage>('cc_messages', source.replyTo);
      insert.run(factorId, 'message', quoted.id, quoted.revision ?? 1);
    }
    for (const ref of source.excerptRefs ?? []) insert.run(factorId, 'message', ref.messageId, ref.revision);
  }

  private project(cid: string, role: Role, actor?: RoomMemberInstance, cutoff = this.cutoff(cid), personal = false): FactorView[] {
    if (!this.enabled(cid)) return [];
    if (actor) this.member(cid,actor);
    const rows = this.db.prepare(`WITH RECURSIVE stale(id) AS (
      SELECT i.factor_id FROM cc_factors f JOIN cc_factor_inputs i ON i.factor_id=f.id
      LEFT JOIN cc_sources s ON i.kind='source' AND s.id=i.ref_id
      LEFT JOIN cc_messages m ON i.kind='message' AND m.id=i.ref_id
      WHERE f.room=? AND f.sequence<=? AND
        ((i.kind='source' AND (s.id IS NULL OR json_extract(s.value,'$.withdrawnAt') IS NOT NULL OR json_extract(s.value,'$.revision')!=i.revision)) OR
         (i.kind='message' AND (m.id IS NULL OR json_extract(m.value,'$.deletedAt') IS NOT NULL OR coalesce(json_extract(m.value,'$.revision'),1)!=i.revision)))
      UNION SELECT p.child FROM cc_factor_parents p JOIN stale ON stale.id=p.parent JOIN cc_factors f ON f.id=p.child WHERE f.ref_kind='room-record'
    ) SELECT value FROM cc_factors WHERE room=? AND sequence<=? AND revoked=0 AND id NOT IN (SELECT id FROM stale)` +
      (personal ? " AND ref_kind='room-record'" : '') + " ORDER BY sequence").all(cid,cutoff,cid,cutoff);
    const selected: Stored[] = [];
    for (const r of rows) {
      const f = JSON.parse(String(r.value)) as Stored;
      if (role === 'operator') {
        if (f.kind !== 'observation' && f.kind !== 'expression') continue;
      } else if (f.audience !== 'room') {
        if (!actor || !f.audience.includes(actor.id) || (role==='writing' && f.kind!=='expression')) continue;
      }
      if (personal && !personalKinds.has(f.kind)) continue;
      if (f.sourceRef.kind === 'source') {
        const source=this.store.artifacts.get<SourceWork>('cc_sources',f.sourceRef.id);
        if(source.withdrawnAt)continue;
        if(source.crossRef) {
          // Grants, exact source versions, workspace identities and both endpoint generations
          // may change before the periodic sweep. Check the original authority on every read.
          try {this.store.cross.material(source);} catch(e) {if(e instanceof AppError)continue;throw e;}
        }
      }
      if (f.sourceRef.kind === 'evidence') {
        const receipt = this.db.prepare('SELECT invocation_id FROM cc_evidence WHERE id=?').get(f.sourceRef.id);
        if (!receipt || this.store.visibility.primary(String(receipt.invocation_id)).withdrawnAt) continue;
      }
      if (f.sourceRef.kind==='message') {
        const m=this.store.artifacts.get<ConversationMessage>('cc_messages',f.sourceRef.id);
        if (!this.store.visibility.visible(m,actor?.memberId) || (m.revision ?? 1)!==f.sourceRef.version) continue;
        if (role === 'public' && privateScope(this.store.visibility.messageScope(m))) continue;
      }
      selected.push(f);
    }
    const ids = new Set(selected.map(f=>f.id));
    const parents = this.db.prepare('SELECT parent FROM cc_factor_parents WHERE child=? ORDER BY rowid');
    return selected.map((f,idx) => {
      const {audience, ...view} = f;
      return {...view, sequence:idx+1,
        parentIds: parents.all(f.id).map(r=>String(r.parent)).filter(id=>ids.has(id))};
    });
  }
  list(cid: string, actor?: RoomMemberInstance) { return this.project(cid,actor?'member':'public',actor); }
  operatorList(cid: string) { return this.project(cid,'operator',undefined,this.cutoff(cid),true); }
  snapshot(cid: string, actor: RoomMemberInstance, scope: 'public'|'private', cutoff = this.cutoff(cid)) {
    return this.project(cid,scope === 'private' ? 'member' : 'writing',actor,cutoff,true);
  }
  private writer(invocationId: string) {
    const run=this.store.invocation(invocationId), contract=this.store.contract(invocationId);
    if (run.status !== 'running' || run.acceptance !== 'accepted' || run.cancelRevision ||
        !run.roomMember || !contract.roomMember || contract.roomMember.id!==run.roomMember.id || !privateScope(contract.visibility) ||
        contract.visibility!.memberIds.length!==1 || contract.visibility!.memberIds[0]!==run.memberId) denied();
    const cid=run.conversationId;
    this.member(cid,run.roomMember);
    this.store.tasks.actor(invocationId,true);
    this.store.visibility.validateInvocation(invocationId);
    const frozen = contract.memberContext;
    if (!frozen || frozen.mode !== 'private' || frozen.instanceId !== run.roomMember.id || frozen.generation !== run.roomMember.generation) denied();
    const factors=this.snapshot(cid,run.roomMember,'private',frozen.cutoff);
    if (frozen.factors.length!==factors.length || frozen.factors.some((f,n)=>f.id!==factors[n]?.id || f.version!==factors[n]?.version)) denied();
    return {run,contract,factors,cid,member:run.roomMember};
  }
  select(invocationId: string, input: {requestId:string;observationId:string;choice:number}) {
    return this.port.tx(() => {
      const {factors,cid,member,contract}=this.writer(invocationId);
      const observation=factors.find(f=>f.id===input.observationId && f.kind==='observation');
      if (!observation?.expressionOptions) denied();
      const choice=input.choice;
      if (!Number.isInteger(choice) || choice<1 || choice>observation.expressionOptions.length) invalid('请选择已授权的表述。');
      const content=observation.expressionOptions[choice-1]!;
      const key='factor-select:'+invocationId+':'+checked(input.requestId,160);
      return this.port.command(key,{observationId:observation.id,choice},() => {
        const old=this.db.prepare('SELECT expression_id,choice FROM cc_factor_choices WHERE observation_id=?').get(observation.id);
        if (old) {
          if (!this.snapshot(cid,member,'private').some(f=>f.id===old.expression_id)) denied();
          if (old.choice!==choice) throw new AppError(409,'本次判断已经登记。','choice_recorded');
          return {expressionId:String(old.expression_id)};
        }
        const expressionId=this.insert({roomId:cid,kind:'expression',issuer:member.memberId,memberId:member.memberId,
          audience:[member.id],content},undefined,[this.reference(cid,'source',contract.primarySourceId), ...factors.map(f=>f.id)]);
        this.bindWriterInputs(expressionId, invocationId);
        this.db.prepare('INSERT INTO cc_factor_choices VALUES(?,?,?,?)').run(observation.id,expressionId,choice,invocationId);
        return {expressionId};
      }).result;
    });
  }
  note(invocationId: string, input: FactorNoteInput) {
    const request=checked(input.requestId,160), content=checked(input.content,2000);
    const ids=input.parentIds ?? [];
    if (!Array.isArray(ids) || ids.length>16 || ids.some(x=>typeof x!=='string')) invalid('笔记来源无效。');
    return this.port.tx(() => {
      const {run,cid,contract,factors}=this.writer(invocationId);
      if (ids.some(id=>!factors.some(f=>f.id===id))) denied();
      return this.port.command('factor-note:'+invocationId+':'+request,input,() => {
        const origin=this.reference(cid,'source',contract.primarySourceId);
        // The writer saw its private context. Keep its permissions even when the model omits citations.
        const parents = [...ids,...factors.map(f=>f.id),origin];
        const factorId = this.insert({roomId:cid,kind:'note',issuer:run.memberId,memberId:run.memberId,
          content,audience:[run.roomMember!.id]},undefined,parents);
        this.bindWriterInputs(factorId, invocationId);
        return {factorId};
      }).result;
    });
  }
}
