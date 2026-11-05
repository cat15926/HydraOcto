import { CooperationPanel } from './CooperationPanel';
import { ArtifactPanel } from './ArtifactPanel';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type {
  Carrier, CollaborationAccount, CollaborationBootstrap, CollaborationInvocation,
  Conversation, ConversationDetail, Delivery, HoldRecheck, InputManifest, Member, RecoveryCheck, RecoveryRequest, RoutingDecision, SendMessage,
} from '../shared/collaboration';

import { TaskPanel } from './TaskPanel';

const API = '/api';
const carrierNames: Record<Carrier, string> = {
  'codex-app-server': 'Codex CLI', 'claude-cli': 'Claude Code CLI',
  'openai-api': 'OpenAI 兼容 API', 'anthropic-api': 'Anthropic API',
};
const statusNames: Record<string, string> = {
  prepared: '准备输入', running: '执行中', succeeded: '已交付', failed: '执行失败',
  interrupted: '执行中断', cancel_requested: '等待停止确认', cancelled: '已取消',
  pending: '等待投递', consumed: '已交给执行', held: '暂缓投递', withdrawn: '已撤回',
};
const evidenceNames: Record<string, string> = {
  prepared: '准备输入', exposed: '输入已暴露', accepted: '承载接受输入', not_accepted: '承载明确未接受',
  session: '原生会话证据', session_replaced: '原生会话重建', usage: '承载报告用量', text: '输出片段', tool: '工具调用', process_exit: '退出证据', transport_settled: '请求传输终结', diagnostic: '运行诊断',
};
const routingNames: Record<string, string> = {
  explicit_mention: '本条消息点名', explicit: '本条消息点名', recent_user_mention: '延续最近点名',
  historical_mention: '延续最近点名', latest_user_mention: '延续最近点名',
  last_user_mention: '延续最近点名', last_healthy_responder: '延续最近成功回复',
  recent_responder: '延续最近成功回复', last_responder: '延续最近成功回复',
  default_member: '会话默认成员', default: '会话默认成员', participant_fallback: '可用参与成员',
  available_participant: '可用参与成员', preferred_parallel: '会话并行讨论偏好', concierge_preferred: '会话接待成员', preferred_member: '会话偏好成员',
};
const recoveryNames: Record<RecoveryCheck['resolution'], string> = {
  running: '原执行仍在运行', unresolved: '仍待核查', closed_result_unknown: '退出已确认，结果仍未知',
  resolved: '已按准确证据收敛', already_settled: '执行已收敛',
};
const date = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const short = (id: string) => id.slice(0, 8);
const active = (run: CollaborationInvocation) => ['prepared', 'running', 'cancel_requested'].includes(run.status);
const uncertain = (run: CollaborationInvocation) => run.recoveryState === 'pending' || (run.dispatchStarted && run.teardown === 'unknown' && !['prepared', 'running'].includes(run.status));
class CommandError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

function Icon({ name, size = 18 }: { name: 'plus' | 'send' | 'settings' | 'close' | 'chat' | 'activity' | 'menu' | 'chevron' | 'check' | 'stop' | 'arrow' | 'refresh'; size?: number }) {
  const paths = {
    plus: 'M12 5v14M5 12h14', send: 'M12 19V5m-6 6 6-6 6 6', settings: 'M9 4h6l1 3 3 1 2 4-2 4-3 1-1 3H9l-1-3-3-1-2-4 2-4 3-1 1-3Zm3 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
    close: 'm6 6 12 12M6 18 18 6', chat: 'M21 11a8 8 0 0 1-8 8H8l-5 3 1-6a8 8 0 1 1 17-5Z', activity: 'M3 12h4l3-8 4 16 3-8h4', menu: 'M4 6h16M4 12h16M4 18h16', chevron: 'm9 5 7 7-7 7', check: 'm5 12 4 4L19 6', stop: 'M6 6h12v12H6z', arrow: 'M5 12h14m-6-6 6 6-6 6', refresh: 'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
function Avatar({ member, user = false, small = false }: { member?: Member; user?: boolean; small?: boolean }) {
  return <span className={`cc-avatar ${user ? 'cc-avatar-user' : member?.carrier.startsWith('claude') || member?.carrier === 'anthropic-api' ? 'cc-avatar-claude' : ''} ${small ? 'cc-avatar-small' : ''}`} aria-hidden="true">{user ? '你' : member?.carrier.startsWith('claude') || member?.carrier === 'anthropic-api' ? '✳' : '⌘'}</span>;
}
function Status({ status, warning = false }: { status: string; warning?: boolean }) { return <span className={`cc-status cc-status-${warning ? 'warning' : status}`}><i />{warning ? '待核查' : statusNames[status] ?? status}</span>; }
async function read<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '读取失败，请稍后重试。');
  return body as T;
}
function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className={`cc-dialog ${wide ? 'cc-dialog-wide' : ''}`} onCancel={e => { e.preventDefault(); onClose(); }} aria-labelledby="cc-dialog-title"><header><div><span className="cc-eyebrow">工作空间设置</span><h2 id="cc-dialog-title">{title}</h2></div><button className="cc-icon-button" onClick={onClose} aria-label="关闭设置"><Icon name="close" /></button></header>{children}</dialog>;
}

function Settings({ data, saving, onSaveMember, onSaveAccount, onRefresh, onClose }: {
  data: CollaborationBootstrap; saving: boolean;
  onSaveMember: (member: Member) => Promise<void>; onSaveAccount: (account: CollaborationAccount) => Promise<void>;
  onRefresh: () => Promise<void>; onClose: () => void;
}) {
  const [tab, setTab] = useState<'members' | 'accounts'>('members');
  const [editMember, setEditMember] = useState<Member>();
  const [editAccount, setEditAccount] = useState<CollaborationAccount>();
  const [carrier, setCarrier] = useState<Carrier>('codex-app-server');
  const [memberAccountId, setMemberAccountId] = useState('');
  const [provider, setProvider] = useState<CollaborationAccount['provider']>('codex');
  const [auth, setAuth] = useState<CollaborationAccount['auth']>('cli');
  const [error, setError] = useState('');
  const [formRevision, setFormRevision] = useState(0);
  const nativeProvider = provider === 'codex' || provider === 'claude';
  const expectedProvider = carrier === 'codex-app-server' ? 'codex' : carrier === 'claude-cli' ? 'claude' : carrier === 'openai-api' ? 'openai' : 'anthropic';
  const matchingAccounts = data.accounts.filter(a => a.provider === expectedProvider);
  const selectedAccountId = matchingAccounts.some(a => a.id === memberAccountId) ? memberAccountId : matchingAccounts[0]?.id ?? '';
  const selectedAccount = matchingAccounts.find(a => a.id === selectedAccountId);
  const modelRequired = selectedAccount?.auth === 'api';
  const keyDefaults = { codex: 'COLLAB_CODEX_API_KEY', claude: 'COLLAB_CLAUDE_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };
  const urlExamples = { codex: 'https://api.deepseek.com', claude: 'https://open.bigmodel.cn/api/anthropic', openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1' };
  function newMember() { setEditMember(undefined); setCarrier('codex-app-server'); setMemberAccountId(''); setError(''); }
  function newAccount() { setEditAccount(undefined); setProvider('codex'); setAuth('cli'); setError(''); }
  async function saveMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    const model = String(form.get('model')).trim();
    if (modelRequired && !model) { setError('API 认证需要填写服务实际支持的模型名称。'); return; }
    try {
      await onSaveMember({ id: editMember?.id ?? crypto.randomUUID(), name: String(form.get('name')), instructions: String(form.get('instructions')), carrier, accountId: selectedAccountId, model: model || undefined, enabled: form.get('enabled') === 'on' });
      newMember(); setFormRevision(value => value + 1);
    } catch (e) { setError((e as Error).message); }
  }
  async function saveAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); const form = new FormData(event.currentTarget);
    try {
      await onSaveAccount({ id: editAccount?.id ?? crypto.randomUUID(), name: String(form.get('name')), provider, auth, ...(auth === 'api' ? { apiKeyEnv: String(form.get('apiKeyEnv')), baseUrl: String(form.get('baseUrl')).trim() || undefined } : {}) });
      newAccount(); setFormRevision(value => value + 1);
    } catch (e) { setError((e as Error).message); }
  }
  return <Modal title="成员与运行时" onClose={onClose} wide>
    <div className="cc-tabs" role="tablist" aria-label="设置类别"><button role="tab" aria-selected={tab === 'members'} onClick={() => { setTab('members'); setError(''); }}>成员与运行时</button><button role="tab" aria-selected={tab === 'accounts'} onClick={() => { setTab('accounts'); setError(''); }}>账户与登录</button></div>
    {error && <p className="cc-form-error" role="alert">{error}</p>}
    {tab === 'members' ? <div className="cc-settings-grid"><section className="cc-settings-list">
      <h3>协作成员 <span>{data.members.length}</span></h3>
      {data.members.map(m => <button key={m.id} className={`cc-settings-item ${editMember?.id === m.id ? 'selected' : ''}`} onClick={() => { setEditMember(m); setCarrier(m.carrier); setMemberAccountId(m.accountId); setError(''); }}><Avatar member={m} /><span><strong>{m.name}</strong><small>{carrierNames[m.carrier]}</small></span><span className="cc-member-enabled">{m.enabled ? '已启用' : '已停用'}</span></button>)}
      <button className="cc-text-button" onClick={newMember}><Icon name="plus" size={15} />添加成员</button><p className="cc-note">成员的职责由你定义。协作中的交接由实际请求触发，不预设固定执行顺序。</p>
    </section><form key={`${editMember?.id ?? 'new-member'}-${formRevision}`} onSubmit={saveMember} className="cc-settings-form">
      <h3>{editMember ? `编辑 ${editMember.name}` : '添加协作成员'}</h3>
      <label>成员名称<input name="name" required maxLength={60} defaultValue={editMember?.name ?? ''} placeholder="例如：产品分析师" /></label>
      <label>职责与工作方式<textarea name="instructions" rows={4} required maxLength={10000} defaultValue={editMember?.instructions ?? ''} placeholder="描述擅长的工作、协作方式和交付要求。" /></label>
      <label>运行时<select value={carrier} onChange={e => { setCarrier(e.target.value as Carrier); setMemberAccountId(''); }}>{Object.entries(carrierNames).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>
      <label>使用账户<select name="accountId" required value={selectedAccountId} onChange={e => setMemberAccountId(e.target.value)}><option value="" disabled>请选择相应账户</option>{matchingAccounts.map(a => <option value={a.id} key={a.id}>{a.name} · {a.auth === 'api' ? 'API 密钥' : '官方登录'}</option>)}</select></label>
      {!matchingAccounts.length && <p className="cc-note">请先在「账户与登录」添加匹配的账户。</p>}
      {selectedAccount && <p className="cc-note">{selectedAccount.auth === 'api' ? '使用此账户的 API 密钥启动运行时，不要求本机官方账号登录。' : '使用本机官方 CLI 登录。'}</p>}
      <label>模型 <span className="cc-optional">{modelRequired ? '必填，使用 API 服务支持的模型标识' : '可选，留空使用运行时默认值'}</span><input name="model" required={modelRequired} maxLength={200} defaultValue={editMember?.model ?? ''} placeholder={modelRequired ? 'API 模型名称' : '默认模型'} /></label>
      <label className="cc-checkbox"><input type="checkbox" name="enabled" defaultChecked={editMember?.enabled ?? true} />启用此成员</label>
      <footer><button className="cc-button-primary" disabled={saving || !matchingAccounts.length}>{saving ? '保存中…' : '保存成员'}</button></footer>
    </form></div> : <div className="cc-settings-grid"><section className="cc-settings-list">
      <h3>运行账户 <span>{data.accounts.length}</span></h3>
      {data.accounts.map(a => <button key={a.id} className={`cc-settings-item ${editAccount?.id === a.id ? 'selected' : ''}`} onClick={() => { setEditAccount(a); setProvider(a.provider); setAuth(a.auth); setError(''); }}><span className="cc-account-icon">{a.auth === 'cli' ? '⌘' : '↗'}</span><span><strong>{a.name}</strong><small>{a.auth === 'cli' ? (a.configured ? '官方 CLI 已登录' : '官方 CLI 尚未登录') : a.configured ? 'API 密钥环境变量已配置' : 'API 密钥环境变量未配置'}</small></span></button>)}
      <button className="cc-text-button" onClick={newAccount}><Icon name="plus" size={15} />添加账户</button>
      <div className="cc-runtime-list"><div className="cc-section-title"><h3>本机运行时</h3><button className="cc-icon-button" onClick={() => { void onRefresh().catch(e => setError(e.message)); }} aria-label="重新检测运行时"><Icon name="refresh" size={15} /></button></div>
        {data.runtimes.map(r => <div key={r.carrier}><strong>{carrierNames[r.carrier]}</strong><small>{r.version ?? (r.installed ? '已安装' : '未检测到')}</small><p>{r.authentication === 'cli' ? `官方登录模式：${r.available ? '可用' : '未就绪'}。API 认证是否可用取决于所选账户和实际调用。` : r.reason || (r.available ? '协议适配器可用，密钥与模型在调用时验证。' : '当前不可用')}</p>{r.authentication === 'cli' && r.reason && <p>{r.reason}</p>}<span className="cc-proof-level">{r.verified === 'live_tested' ? '真实接入已验证' : r.verified === 'protocol_tested' ? '协议测试通过 · 尚待真实验收' : '尚待真实验收'}</span></div>)}
      </div>
    </section><form key={`${editAccount?.id ?? 'new-account'}-${formRevision}`} onSubmit={saveAccount} className="cc-settings-form">
      <h3>{editAccount ? '编辑账户' : '添加运行账户'}</h3>
      <label>账户名称<input name="name" required maxLength={80} defaultValue={editAccount?.name ?? ''} placeholder="例如：我的 Codex API 账户" /></label>
      <label>运行程序或 API 协议<select name="provider" value={provider} onChange={e => { const next = e.target.value as CollaborationAccount['provider']; setProvider(next); if (next === 'openai' || next === 'anthropic') setAuth('api'); }}><option value="codex">Codex CLI</option><option value="claude">Claude Code CLI</option><option value="openai">OpenAI 兼容 API</option><option value="anthropic">Anthropic API</option></select></label>
      <label>认证方式<select name="auth" value={auth} onChange={e => setAuth(e.target.value as CollaborationAccount['auth'])}>{nativeProvider && <option value="cli">本机官方 CLI 登录</option>}<option value="api">API 密钥</option></select></label>
      {auth === 'cli' ? <div className="cc-login-guide"><strong>沿用本机官方登录</strong><p>在本机终端完成官方 CLI 登录，再回到这里发送消息。平台不会读取或保存你的登录令牌。</p><code>{provider === 'codex' ? 'codex login' : 'claude auth login'}</code><small>CLI 已安装不代表账户已登录，实际运行结果会显示在会话中。</small></div> : <>
        <label>API 密钥环境变量名<input key={`key-${provider}`} name="apiKeyEnv" required pattern="[A-Z][A-Z0-9_]*" maxLength={100} defaultValue={editAccount?.apiKeyEnv ?? keyDefaults[provider]} placeholder={keyDefaults[provider]} autoComplete="off" /></label>
        <label>API 地址 <span className="cc-optional">{nativeProvider ? '必填，使用供应商提供的兼容接口根地址' : '可选'}</span><input key={`url-${provider}`} name="baseUrl" type="url" required={nativeProvider} maxLength={2000} defaultValue={editAccount?.baseUrl ?? ''} placeholder={urlExamples[provider]} /></label>
        <p className="cc-note">这里只填写环境变量名称，不填写密钥。请在服务启动环境配置相应变量，修改环境后重启服务。CLI 的 API 认证使用所选服务与模型，不回退到官方登录。</p>
      </>}
      <footer><button className="cc-button-primary" disabled={saving}>{saving ? '保存中…' : '保存账户'}</button></footer>
    </form></div>}
  </Modal>;
}

function InputAudit({ invocationId, manifest }: { invocationId: string; manifest?: InputManifest }) {
  const [payload, setPayload] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const manifestRef = useRef(manifest?.id);
  manifestRef.current = manifest?.id;
  useEffect(() => { setPayload(undefined); setError(''); }, [manifest?.id]);
  async function loadPayload() {
    if (!manifest) return;
    setBusy(true); setError('');
    try {
      const result = await read<{ manifest: InputManifest; prompt: string }>(`${API}/invocations/${encodeURIComponent(invocationId)}/input`);
      if (manifestRef.current !== manifest.id) return;
      if (result.manifest.id !== manifest.id || result.manifest.renderDigest !== manifest.renderDigest) throw new Error('输入记录已变化，请刷新会话后再查看。');
      setPayload(result.prompt);
    } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  }
  if (!manifest) return <p className="cc-note">此执行尚无输入清单。历史执行未捕获的内容不会事后重建为原始输入。</p>;
  return <div className="cc-input-audit" data-manifest-id={manifest.id}>
    <p className="cc-note">记录平台准备的输入，不代表承载已经接受或模型已读。</p>
    <dl><dt>输入版本 / 截止点</dt><dd>{manifest.inputRevision} / {manifest.historyCutoff}</dd><dt>输入预算（估算）</dt><dd>{manifest.budget.usedEstimatedTokens} / {manifest.budget.maxEstimatedTokens} tokens · {manifest.budget.method}</dd><dt>渲染策略 / 阶段</dt><dd>{manifest.renderVersion} · 平台输入</dd><dt>内容摘要值</dt><dd>{manifest.renderDigest}</dd></dl>
    <ul className="cc-input-items">{manifest.items.map((item, index) => <li key={`${item.kind}-${item.reference}-${index}`} className={item.representation === 'omitted' ? 'cc-input-omitted' : ''}>
      <div><strong>{({ source: '本次请求', request: '本次请求', current_request: '本次请求', trigger: '本次请求', history: '相关历史', identity: '成员身份', roster: '协作成员', caller: '准确请求者', instructions: '成员职责', task: '普通任务与准确执行绑定', context: '背景材料', background: '背景材料' } as Record<string, string>)[item.kind] ?? item.kind}</strong><span>{item.representation === 'omitted' ? '已省略' : item.complete ? '完整' : '部分 / 引用'}</span></div>
      <code>{item.reference}</code><small>{item.characters} 字符 · {item.representation}</small>{item.reason && <p>{item.reason}</p>}
      {item.visibilityOnly && <div className="cc-source-responsibility" data-source-id={item.sourceResponsibility?.sourceId}>
        <p>此条目仅记录背景可见性；是否另行全文纳入，请查看本轮准确请求与输入归并记录。</p>
        {item.sourceResponsibility ? <><code>来源 {item.sourceResponsibility.sourceId} · 版本 {item.sourceResponsibility.sourceRevision}</code><small>输入冻结时的原投递责任 · 目标：{item.sourceResponsibility.requestedTargets.join('、')}</small>
          {item.sourceResponsibility.deliveries.map(delivery => <div key={delivery.deliveryId} className="cc-responsibility-delivery"><span>{delivery.memberId} · {statusNames[delivery.status] ?? delivery.status}</span>
            {(delivery.status === 'pending' || delivery.status === 'held') && <small>仍由此原投递负责{delivery.holdReason ? `：${delivery.holdReason}` : '，尚未交给执行'}</small>}
            {delivery.consumptions.map(consumption => <code key={consumption.id}>既有消费 → 回复 {consumption.responseId}</code>)}
          </div>)}</> : <small>{item.responsibilityEvidence === 'not_applicable' ? '此背景不关联来源投递。' : '历史投递责任未捕获，无法核验当时状态；不按当前状态重建。'}</small>}
      </div>}
    </li>)}</ul>
    <button type="button" className="cc-text-button" onClick={() => { if (payload !== undefined) setPayload(undefined); else void loadPayload(); }} disabled={busy}>{busy ? '读取输入…' : payload === undefined ? '查看本次平台输入' : '收起平台输入'}</button>
    {error && <p className="cc-operation-note cc-operation-error" role="alert">{error}</p>}
    {payload !== undefined && <pre className="cc-input-payload" tabIndex={0} aria-label="本次平台输入正文">{payload}</pre>}
  </div>;
}

function ExecutionPanel({ detail, members, cancelling, operating, notices, onCancel, onReconcile, onRecheck }: {
  detail?: ConversationDetail; members: Member[]; cancelling?: string; operating?: string; notices: Record<string, string>;
  onCancel: (id: string) => void; onReconcile: (run: CollaborationInvocation) => void; onRecheck: (delivery: Delivery) => void;
}) {
  const pending = detail?.deliveries.filter(d => d.status === 'pending' || d.status === 'held') ?? [];
  const running = detail?.invocations.filter(active) ?? [];
  const uncertainRuns = detail?.invocations.filter(uncertain) ?? [];
  const name = (id: string) => members.find(m => m.id === id)?.name ?? id;
  const recovery = (run: CollaborationInvocation) => detail?.recoveryChecks?.filter(check => check.invocationId === run.id).at(-1);
  const reconcileButton = (run: CollaborationInvocation) => <button type="button" className="cc-text-button cc-reconcile-button" data-invocation-id={run.id} onClick={() => onReconcile(run)} disabled={!!operating}><Icon name="refresh" size={12} />{operating === run.id ? '正在核查…' : '核查原执行'}</button>;
  return <>
    <section className="cc-monitor-section"><div className="cc-section-title"><h3>当前执行</h3><span>{running.length}</span></div>
      {running.length ? running.map(run => <div className="cc-run-card" key={run.id}><div><strong>{name(run.memberId)}</strong><Status status={run.status} /></div><p>{run.blockedReason || (run.acceptance === 'accepted' ? '运行时已确认接受输入' : '输入已分配，等待运行时证据')}</p><button className="cc-text-button" onClick={() => onCancel(run.id)} disabled={cancelling === run.id || run.status === 'cancel_requested'}><Icon name="stop" size={12} />{run.status === 'cancel_requested' ? '已请求停止' : '停止本次执行'}</button></div>) : <p className="cc-panel-empty">当前没有正在执行的成员。</p>}
    </section>
    <section className="cc-monitor-section"><div className="cc-section-title"><h3>等待投递</h3><span>{pending.length}</span></div>
      {pending.length ? pending.map(delivery => {
        const source = detail?.sources.find(s => s.id === delivery.sourceId);
        const check = detail?.holdRechecks?.filter(c => c.deliveryId === delivery.id).at(-1);
        return <div className="cc-queue-item" key={delivery.id}><span className="cc-queue-dot" /><div><strong>{name(delivery.memberId)}</strong><small>{source?.kind === 'a2a_failure' ? '失败回报' : source?.kind === 'a2a' ? '成员协作请求' : '会话消息'}</small><p>{delivery.holdReason || source?.content}</p><Status status={delivery.status} />
          {delivery.status === 'held' && !delivery.handoffId && <button type="button" className="cc-text-button cc-recheck-button" data-delivery-id={delivery.id} onClick={() => onRecheck(delivery)} disabled={!!operating}><Icon name="refresh" size={12} />{operating === delivery.id ? '正在重验…' : '重新检查投递条件'}</button>}
          {(notices[delivery.id] || check) && <div className="cc-operation-note" role="status">{notices[delivery.id] || `${check?.outcome === 'pending' ? '投递条件已满足' : '仍暂缓投递'}：${check?.reason}`}</div>}
        </div></div>;
      }) : <p className="cc-panel-empty">新消息和成员请求会在这里等待可用的执行机会。</p>}
    </section>
    {uncertainRuns.length > 0 && <section className="cc-monitor-section cc-uncertain"><div className="cc-section-title"><h3>需要核查</h3><span>{uncertainRuns.length}</span></div><p>原执行的结果或退出证据尚不完整。核查读取已有执行证据，不会重新发送任务。</p>{uncertainRuns.map(run => {
      const check = recovery(run);
      return <div key={run.id}><strong>{name(run.memberId)}</strong><small>{run.error || '等待准确的运行证据'}</small><code>{short(run.id)}</code>{reconcileButton(run)}
        {(notices[run.id] || check) && <p className="cc-operation-note" role="status">{notices[run.id] || `${recoveryNames[check!.resolution]}：${check!.reason}`}</p>}
      </div>;
    })}</section>}
    {!!detail?.nativeSessions?.length && <section className="cc-monitor-section cc-session-chain"><div className="cc-section-title"><h3>成员原生会话链</h3><span>{detail.nativeSessions.length}</span></div>
      <p className="cc-note">各成员独立保存原生历史。续接沿用既有上下文；不代表可向运行中的执行追加输入。</p>
      {[...detail.nativeSessions].reverse().map(session => <details key={session.id} data-session-id={session.id}><summary>{name(session.memberId)} · 第 {session.sequence} 代 · {session.status === 'ready' ? '可续接' : session.status === 'sealed' ? '已封存' : '本轮使用中'}</summary>
        <p>{session.reason}</p><dl><dt>运行版本</dt><dd>{session.runtimeVersion || '未知'}</dd><dt>原生身份</dt><dd>{session.nativeSessionId || '尚未取得'}</dd><dt>模型 / 账户</dt><dd>{session.model || '默认'} / {session.accountId} · 修订 {session.accountRevision}</dd><dt>上一代绑定</dt><dd>{session.previousBindingId || '首代'}</dd><dt>最近历史锚点</dt><dd>{session.anchor || '未知'}</dd></dl>
      </details>)}
    </section>}
    <section className="cc-monitor-section"><div className="cc-section-title"><h3>执行记录</h3><span>{detail?.invocations.length ?? 0}</span></div>
      {detail?.invocations.length ? [...detail.invocations].reverse().map(run => {
        const batch = detail.batches.find(b => b.id === run.batchId);
        const source = detail.sources.find(s => s.id === batch?.sourceId);
        const evidence = detail.evidence.filter(e => e.invocationId === run.id);
        const response = detail.responses.find(r => r.id === run.responseId);
        const contract = detail.contracts?.find(c => c.id === run.contractId);
        const manifest = detail.inputManifests?.find(m => m.invocationId === run.id);
        const routing = detail.routingDecisions?.find(r => r.id === source?.routingDecisionId);
        const check = recovery(run);
        return <details className="cc-execution" key={run.id} data-invocation-id={run.id}><summary><div><strong>{name(run.memberId)}</strong><small>{date(run.createdAt)} · {batch?.mode === 'parallel' ? '多人并行' : '单成员执行'}</small></div><Status status={run.status} warning={uncertain(run)} /></summary><div className="cc-execution-body">
          {(run.error || run.blockedReason) && <p className="cc-execution-error">{run.blockedReason || run.error}</p>}
          <dl><dt>执行身份</dt><dd>{run.id}</dd><dt>输入接受</dt><dd>{run.acceptance === 'accepted' ? '已确认接受' : run.acceptance === 'not_accepted' ? '明确未接受' : '未知'}</dd><dt>退出状态</dt><dd>{run.teardown === 'confirmed' ? '已确认' : '尚未确认'}</dd><dt>会话连续性</dt><dd>{run.continuity === 'resumed' ? '已恢复原生会话' : run.continuity === 'fresh' ? '新建原生会话' : '尚未确认'}</dd>
            {run.nativeSessionId && <><dt>原生会话</dt><dd>{run.nativeSessionId}</dd></>}{run.nativeTurnId && <><dt>原生轮次</dt><dd>{run.nativeTurnId}</dd></>}
            {run.sessionPlan && <><dt>会话选择</dt><dd>{({ fresh: '首次新建', resume: '请求续接', replace: '重建新代', unsupported: '不支持续接' })[run.sessionPlan.mode]}：{run.sessionPlan.reason}</dd></>}
            <dt>承担输入</dt><dd>{response?.inputSourceIds.map(short).join('、') || '—'}</dd>
            <dt>准确请求者</dt><dd>{manifest?.caller ? `${name(manifest.caller.memberId)} · ${manifest.caller.invocationId}` : source?.authorMemberId && source.parentInvocationId ? `${name(source.authorMemberId)} · ${source.parentInvocationId}` : source?.kind === 'user' ? '用户输入' : '未记录准确调用者'}</dd>
            <dt>路由依据</dt><dd>{routing ? routingNames[routing.reason] ?? routing.reason : source?.kind === 'a2a' ? '成员结构化协作请求' : source?.kind === 'mention' ? '串行回复的有效行首点名' : source?.kind === 'a2a_failure' ? '准确调用者的失败回报' : '历史记录未捕获路由决定'}</dd>
          </dl>
          <div className="cc-native-usage"><strong>承载报告用量</strong><p className="cc-note">{run.usage ? `${run.usage.scope === 'invocation' ? '本次 CLI 执行' : '最后一次模型请求（非整轮合计）'} · ${run.usage.source}` : '未取得原生用量；未知不记为零。'}</p><dl>
            <dt>输入 / 输出 tokens</dt><dd>{run.usage?.inputTokens ?? '未知'} / {run.usage?.outputTokens ?? '未知'}</dd><dt>缓存读取 / 写入</dt><dd>{run.usage?.cachedInputTokens ?? '未知'} / {run.usage?.cacheWriteInputTokens ?? '未知'}</dd><dt>原生报告成本（USD）</dt><dd>{run.usage?.costUsd !== undefined ? `$${run.usage.costUsd.toFixed(6)}（非供应商账单）` : '未知'}</dd>
          </dl></div>
          <h4>本次冻结规则</h4>{contract ? <dl className="cc-contract-audit"><dt>行为 / 上下文</dt><dd>{contract.behaviorVersion} / {contract.contextPolicyVersion}</dd><dt>路由 / 工具</dt><dd>{contract.routingPolicyVersion} / {contract.toolPolicyVersion}</dd><dt>承载能力</dt><dd>{contract.adapterCapabilityVersion}</dd><dt>成员与账户</dt><dd>{contract.memberSnapshot.name} · {contract.accountMetadataSnapshot.name}</dd><dt>历史截止点</dt><dd>{contract.historyCutoff}</dd></dl> : <p className="cc-note">历史执行未保存此版本的契约快照。</p>}
          <h4>本轮材料</h4><InputAudit invocationId={run.id} manifest={manifest} />
          {(check || notices[run.id]) && <div className="cc-recovery-result"><h4>最近核查</h4><p className="cc-operation-note" role="status">{notices[run.id] || `${recoveryNames[check!.resolution]}：${check!.reason}`}</p>{check && <small>{date(check.createdAt)} · {check.observation.state === 'unsupported' ? '承载暂不支持此项核查' : check.observation.state === 'unknown' ? '证据仍不充分' : '基于原执行观察'}</small>}</div>}
          {uncertain(run) && reconcileButton(run)}
          <h4>真实运行证据 · {evidence.length}</h4>{evidence.length ? evidence.map(e => <details className="cc-evidence" key={e.id}><summary>{evidenceNames[e.kind] ?? e.kind}<time>{date(e.createdAt)}</time></summary><pre>{JSON.stringify(e.detail, null, 2)}</pre></details>) : <p className="cc-note">尚无承载回执。执行记录本身不代表模型已经接受输入。</p>}
        </div></details>;
      }) : <p className="cc-panel-empty">每次执行的输入、状态和运行证据都会保留。</p>}
    </section>
  </>;
}

function ConversationSettings({ conversation, members, onSave, onClose }: { conversation: Conversation; members: Member[]; onSave: (memberIds: string[], defaultMemberId: string) => Promise<void>; onClose: () => void }) {
  const [selected, setSelected] = useState(conversation.memberIds);
  const [defaultMember, setDefaultMember] = useState(conversation.defaultMemberId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const available = members.filter(member => member.enabled || selected.includes(member.id));
  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id];
    setSelected(next); if (!next.includes(defaultMember)) setDefaultMember(next[0] ?? '');
  };
  const save = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await onSave(selected, defaultMember); onClose(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <Modal title="会话成员" onClose={onClose}><form className="cc-conversation-settings" onSubmit={save}><p className="cc-note">设置一次，之后直接发送消息。未指定对象时会延续合法的会话历史，默认成员用于兜底；@成员可明确邀请参与者。</p><fieldset><legend>参与本会话的成员</legend>{available.map(member => <label className="cc-checkbox" key={member.id}><input type="checkbox" checked={selected.includes(member.id)} onChange={() => toggle(member.id)} /><Avatar member={member} small /><span>{member.name}{!member.enabled && <small> · 已停用</small>}</span></label>)}</fieldset><label>默认接收成员<select value={defaultMember} onChange={e => setDefaultMember(e.target.value)} required>{!selected.length && <option value="">请先选择一位成员</option>}{members.filter(member => selected.includes(member.id)).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>{error && <p className="cc-form-error" role="alert">{error}</p>}<footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="cc-button-primary" disabled={busy || !selected.length}>{busy ? '保存中…' : '保存会话设置'}</button></footer></form></Modal>;
}

export default function CollaborationApp() {
  const [data, setData] = useState<CollaborationBootstrap>();
  const [detail, setDetail] = useState<ConversationDetail>();
  const [selected, setSelected] = useState<string>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [online, setOnline] = useState(false);
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState(false);
  const [conversationSettings, setConversationSettings] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [monitor, setMonitor] = useState(false);
  const [mentions, setMentions] = useState(false);
  const [query, setQuery] = useState('');
  const [cancelling, setCancelling] = useState<string>();
  const [operating, setOperating] = useState<string>();
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [operationResult, setOperationResult] = useState('');
  const [routePreview, setRoutePreview] = useState<{ content: string; conversationId: string; routing?: RoutingDecision; error?: string }>();
  const [previewing, setPreviewing] = useState(false);
  const selectedRef = useRef<string | undefined>(undefined);
  const selectionMade = useRef(false);
  const csrf = useRef('');
  const cursor = useRef(0);
  const requestVersion = useRef(0);
  const mounted = useRef(true);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const pendingMessage = useRef<{ content: string; requestId: string; conversationId?: string; createId: string } | undefined>(undefined);
  const pendingOperations = useRef(new Map<string, RecoveryRequest | { requestId: string; expectedDeliveryRevision: number; expectedSourceRevision: number }>());

  const loadDetail = useCallback(async (id: string) => {
    const version = ++requestVersion.current;
    const value = await read<ConversationDetail>(`${API}/conversations/${encodeURIComponent(id)}`);
    if (mounted.current && selectedRef.current === id && version === requestVersion.current) setDetail(value);
  }, []);
  const choose = useCallback((id?: string) => {
    selectedRef.current = id; selectionMade.current = true; requestVersion.current++;
    setSelected(id); setDetail(undefined); setDraft(''); setMentions(false); setSidebar(false); setError(''); setOperationResult('');
    atBottom.current = true; pendingMessage.current = undefined;
    if (id) void loadDetail(id).catch(e => setError(e.message));
  }, [loadDetail]);
  const refresh = useCallback(async () => {
    const value = await read<CollaborationBootstrap>(`${API}/collaboration/bootstrap`);
    if (!mounted.current) return;
    csrf.current = value.csrfToken; cursor.current = Math.max(cursor.current, value.eventCursor); setData(value);
    if (!selectionMade.current && value.conversations[0]) choose(value.conversations[0].id);
    else if (selectedRef.current) await loadDetail(selectedRef.current);
  }, [choose, loadDetail]);
  useEffect(() => {
    mounted.current = true; let disposed = false; let source: EventSource | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (disposed || source) return;
      source = new EventSource(`${API}/collaboration/events?after=${cursor.current}`);
      source.onopen = () => { setOnline(true); sync(); };
      source.onerror = () => setOnline(false);
      source.addEventListener('collaboration-event', (event: MessageEvent<string>) => {
        const id = Number(event.lastEventId); if (!Number.isSafeInteger(id) || id <= cursor.current) return;
        cursor.current = id; if (debounce) clearTimeout(debounce); debounce = setTimeout(sync, 100);
      });
    };
    const sync = () => { void refresh().then(connect).catch(e => { if (!disposed) { setOnline(false); setError(e.message); } }); };
    sync();
    // A persisted snapshot also recovers missed events and a restarted service's CSRF token.
    const poll = setInterval(sync, 5000);
    return () => { disposed = true; mounted.current = false; source?.close(); if (debounce) clearTimeout(debounce); clearInterval(poll); };
  }, [refresh]);
  useEffect(() => { if (atBottom.current && log.current) log.current.scrollTop = log.current.scrollHeight; }, [detail]);
  useEffect(() => {
    const content = draft.trim();
    if (!selected || !content || !data?.csrfToken || sending) { setRoutePreview(undefined); setPreviewing(false); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      // Do not enqueue a synchronous effect update on every controlled-input keystroke.
      setPreviewing(true);
      void fetch(`${API}/conversations/${encodeURIComponent(selected)}/route-preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.current },
        body: JSON.stringify({ content }), signal: controller.signal,
      }).then(async response => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '暂未取得路由预览，发送时由服务端解析。');
        if (!controller.signal.aborted) setRoutePreview({ content, conversationId: selected, routing: result.routing });
      }).catch(cause => {
        if (!controller.signal.aborted) setRoutePreview({ content, conversationId: selected, error: (cause as Error).message });
      }).finally(() => { if (!controller.signal.aborted) setPreviewing(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [draft, selected, data?.csrfToken, data?.eventCursor, detail?.conversation.revision, sending]);
  async function command<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.current }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) { if (response.status === 403) await refresh(); throw new CommandError(result.error || '操作失败。', response.status, result.code); }
    return result as T;
  }
  async function send() {
    const content = draft.trim(); if (!content || sending || !data) return;
    setSending(true); setError('');
    if (!pendingMessage.current || pendingMessage.current.content !== content || pendingMessage.current.conversationId !== selectedRef.current) pendingMessage.current = { content, requestId: crypto.randomUUID(), conversationId: selectedRef.current, createId: crypto.randomUUID() };
    const pending = pendingMessage.current;
    try {
      let id = pending.conversationId;
      if (!id) {
        const members = data.members.filter(m => m.enabled); if (!members.length) throw new Error('请先在「成员与运行时」启用一名成员。');
        const result = await command<{ conversation: Conversation }>(`${API}/conversations`, { title: content.slice(0, 60), memberIds: members.map(m => m.id), defaultMemberId: members[0].id, requestId: pending.createId });
        id = result.conversation.id; pending.conversationId = id; selectedRef.current = id; selectionMade.current = true; setSelected(id); setDetail(undefined);
      }
      await command(`${API}/conversations/${encodeURIComponent(id)}/messages`, { content, requestId: pending.requestId } satisfies SendMessage);
      pendingMessage.current = undefined; setDraft(''); setMentions(false); atBottom.current = true; await refresh(); textarea.current?.focus();
    } catch (e) { setError((e as Error).message); } finally { setSending(false); }
  }
  async function saveMember(member: Member) { setSaving(true); try { await command(`${API}/members`, member); await refresh(); } finally { setSaving(false); } }
  async function saveAccount(account: CollaborationAccount) { setSaving(true); try { await command(`${API}/accounts`, account); await refresh(); } finally { setSaving(false); } }
  async function saveConversation(memberIds: string[], defaultMemberId: string) {
    if (!selectedRef.current) return;
    await command(`${API}/conversations/${encodeURIComponent(selectedRef.current)}/settings`, { memberIds, defaultMemberId }); await refresh();
  }
  async function cancel(id: string) { setCancelling(id); setError(''); try { await command(`${API}/invocations/${encodeURIComponent(id)}/cancel`, {}); await refresh(); } catch (e) { setError((e as Error).message); } finally { setCancelling(undefined); } }
  async function recoveryCommand(id: string, path: string, body: RecoveryRequest | { requestId: string; expectedDeliveryRevision: number; expectedSourceRevision: number }, kind: 'reconcile' | 'recheck') {
    if (operating) return;
    const origin = selectedRef.current;
    setOperating(id); setError(''); setOperationResult('');
    const pending = pendingOperations.current.get(id) ?? body;
    pendingOperations.current.set(id, pending);
    setNotices(value => ({ ...value, [id]: kind === 'reconcile' ? '正在读取原执行证据…' : '正在重新检查此投递…' }));
    try {
      const result = await command<{ check: RecoveryCheck | HoldRecheck }>(path, pending);
      pendingOperations.current.delete(id);
      const check = result.check;
      const label = 'resolution' in check ? recoveryNames[check.resolution] : check.outcome === 'pending' ? '投递条件已满足，等待合法调度' : '仍暂缓投递';
      setNotices(value => ({ ...value, [id]: `${label}：${check.reason}` }));
      if (selectedRef.current === origin) setOperationResult(`${label}：${check.reason}`);
      await refresh();
    } catch (cause) {
      const failure = cause as Error;
      if (failure instanceof CommandError && failure.status >= 400 && failure.status < 500) pendingOperations.current.delete(id);
      const message = failure instanceof CommandError && failure.status === 409 ? `${failure.message} 状态已变化，正在刷新；请依据最新状态再次操作。` : failure.message;
      setNotices(value => ({ ...value, [id]: message })); if (selectedRef.current === origin) setError(message);
      if (failure instanceof CommandError && failure.status === 409) await refresh().catch(() => undefined);
    } finally { setOperating(undefined); }
  }
  async function reconcile(run: CollaborationInvocation) {
    const response = detail?.responses.find(item => item.id === run.responseId);
    if (!response) { setError('尚未读取该执行的输入版本，请刷新会话后再核查。'); return; }
    await recoveryCommand(run.id, `${API}/invocations/${encodeURIComponent(run.id)}/reconcile`, {
      requestId: crypto.randomUUID(), expectedInvocationRevision: run.invocationRevision ?? 1,
      expectedCancelRevision: run.cancelRevision ?? 0, expectedInputRevision: response.inputRevision,
    }, 'reconcile');
  }
  async function recheck(delivery: Delivery) {
    const source = detail?.sources.find(item => item.id === delivery.sourceId);
    if (!source) { setError('尚未读取该投递的来源版本，请刷新会话后再重验。'); return; }
    await recoveryCommand(delivery.id, `${API}/deliveries/${encodeURIComponent(delivery.id)}/recheck`, {
      requestId: crypto.randomUUID(), expectedDeliveryRevision: delivery.revision, expectedSourceRevision: source.revision,
    }, 'recheck');
  }

  const members = data?.members ?? [];
  const availableMembers = members.filter(m => detail ? detail.conversation.memberIds.includes(m.id) : m.enabled);
  const defaultMember = members.find(m => m.id === detail?.conversation.defaultMemberId) ?? availableMembers[0];
  const currentPreview = routePreview && routePreview.conversationId === selected && routePreview.content === draft.trim() ? routePreview : undefined;
  const running = detail?.invocations.filter(active) ?? [];
  const waiting = detail?.deliveries.filter(d => d.status === 'pending' || d.status === 'held') ?? [];
  const missingMessages = detail?.responses.filter(response => !detail.messages.some(m => m.responseId === response.id)) ?? [];
  const conversationTitle = detail?.conversation.title ?? (selected ? '正在读取会话…' : '新的协作');
  const filtered = data?.conversations.filter(c => c.title.toLowerCase().includes(query.toLowerCase())) ?? [];
  function mention(member: Member) { setDraft(value => `${value}${value && !/\s$/.test(value) ? ' ' : ''}@${member.name} `); setMentions(false); textarea.current?.focus(); }
  return <div className="cc-shell">
    {sidebar && <button className="cc-mobile-scrim" onClick={() => setSidebar(false)} aria-label="关闭会话列表" />}
    <aside className={`cc-sidebar ${sidebar ? 'cc-open' : ''}`}><a className="cc-brand" href="/" aria-label="协作工坊首页"><span className="cc-brand-mark"><i /><i /><i /></span><span>协作工坊<small>CONTINUOUS COLLABORATION</small></span></a><button className="cc-new-button" onClick={() => choose()} disabled={sending}><Icon name="plus" size={17} />新的协作<span>＋</span></button><div className="cc-sidebar-heading"><span>会话</span><span>{data?.conversations.length ?? 0}</span></div><label className="cc-search"><span className="cc-visually-hidden">搜索会话</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索会话…" /></label><nav className="cc-conversation-list" aria-label="会话列表">{filtered.length ? filtered.map(c => <button key={c.id} disabled={sending} className={selected === c.id ? 'selected' : ''} onClick={() => choose(c.id)}><Icon name="chat" size={16} /><span><strong>{c.title}</strong><small>{date(c.updatedAt)}</small></span></button>) : <p>{query ? '没有匹配的会话。' : '从一条消息开始，协作过程会保留在这里。'}</p>}</nav><div className="cc-sidebar-bottom"><button onClick={() => setSettings(true)} disabled={!data}><Icon name="settings" />成员与运行时<Icon name="chevron" size={13} /></button><div className="cc-local-status"><span className={online ? 'connected' : ''} />{online ? '本地服务已连接' : data ? '快照同步中' : '正在连接本地服务'}<small>v{data?.version.split('-')[0] ?? '0.5.0'}</small></div></div></aside>
    <main className="cc-main"><header className="cc-topbar"><button className="cc-icon-button cc-mobile-menu" onClick={() => setSidebar(true)} aria-label="打开会话列表"><Icon name="menu" /></button><div className="cc-conversation-heading"><span>工作空间 <span>/</span> 持续协作</span><h1>{conversationTitle}</h1></div><div className="cc-topbar-actions">{detail && <button className="cc-icon-button cc-conversation-settings-button" onClick={() => setConversationSettings(true)} aria-label="设置会话成员与默认成员"><Icon name="settings" size={17} /></button>}<span className="cc-topbar-members">{availableMembers.slice(0, 4).map(m => <span key={m.id} title={m.name}><Avatar member={m} small /></span>)}</span><button className={`cc-monitor-button ${monitor ? 'selected' : ''}`} onClick={() => setMonitor(value => !value)} aria-expanded={monitor} aria-controls="cc-monitor"><Icon name="activity" size={17} /><span>协作动态</span>{running.length > 0 && <b>{running.length}</b>}</button></div></header>
      {error && <div className="cc-error-banner" role="alert"><span>{error}</span><button className="cc-icon-button" onClick={() => setError('')} aria-label="关闭提示"><Icon name="close" size={15} /></button></div>}
      {operationResult && <div className="cc-result-banner" role="status"><span>{operationResult}</span><button className="cc-icon-button" onClick={() => setOperationResult('')} aria-label="关闭操作结果"><Icon name="close" size={15} /></button></div>}
      <div className="cc-main-content"><div className="cc-chat-column"><div className="cc-chat-scroll" ref={log} onScroll={() => { const element = log.current; if (element) atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
        {!detail?.messages.length && !missingMessages.length ? <div className="cc-welcome"><div className="cc-welcome-symbol"><span>⌘</span><i /><span>✳</span></div><span className="cc-eyebrow">一个会话，持续推进</span><h2>把下一件事，<br />一起做好。</h2><p>说出你的目标，成员会在这里开展协作。<br />随时补充想法，或用 @ 邀请另一位成员。</p><div className="cc-welcome-members">{availableMembers.map(m => <button key={m.id} onClick={() => mention(m)} title={`在消息中提及 ${m.name}`}><Avatar member={m} small /><span>{m.name}<small>{carrierNames[m.carrier]}</small></span><Icon name="plus" size={12} /></button>)}</div><p className="cc-welcome-note">连接真实运行时 · 对话与执行记录保存在本机</p></div> : <div className="cc-message-list" aria-label="会话消息">{detail?.messages.map(message => {
          const member = members.find(m => m.id === message.memberId); const run = detail.invocations.find(i => i.responseId === message.responseId);
          const source = detail.sources.find(s => s.id === message.sourceId);
          return <article className={`cc-message cc-message-${message.author}`} key={message.id}><Avatar member={member} user={message.author === 'user'} /><div className="cc-message-content"><div className="cc-message-meta"><strong>{message.author === 'user' ? '你' : message.author === 'system' ? '协作记录' : member?.name ?? '成员'}</strong><time>{date(message.createdAt)}</time>{source?.kind === 'a2a' && <span className="cc-message-tag">协作请求</span>}{run && <Status status={run.status} warning={uncertain(run)} />}</div><div className="cc-prose">{message.content || (run && active(run) ? '正在执行，等待输出…' : '暂无正文')}</div>{source?.requestedTargets.length ? <div className="cc-message-route"><Icon name="arrow" size={12} />{source.requestedTargets.map(id => members.find(m => m.id === id)?.name ?? id).join('、')}</div> : null}</div></article>;
        })}{missingMessages.map(response => { const member = members.find(m => m.id === response.memberId); const run = detail?.invocations.find(i => i.id === response.invocationId); return <article className="cc-message cc-message-member" key={response.id}><Avatar member={member} /><div className="cc-message-content"><div className="cc-message-meta"><strong>{member?.name ?? '成员'}</strong><time>{date(response.createdAt)}</time><Status status={response.status} warning={run && uncertain(run)} /></div><div className={`cc-prose ${!response.content ? 'cc-prose-pending' : ''}`}>{response.content || run?.error || (response.status === 'prepared' ? '已分配输入，准备启动。' : (run && active(run)) ? '正在执行，等待输出…' : '本次执行没有输出正文。')}</div></div></article>; })}</div>}
      </div><div className="cc-composer-wrap">{(running.length > 0 || waiting.length > 0) && <div className="cc-live-summary"><span className={running.length ? 'cc-pulse' : ''} /><strong>{running.length ? `${running.map(r => members.find(m => m.id === r.memberId)?.name ?? '成员').join('、')} 正在推进` : '消息等待投递'}</strong>{waiting.length > 0 && <small>{waiting.length} 项待投递</small>}<button onClick={() => setMonitor(true)}>查看动态 <Icon name="chevron" size={12} /></button></div>}<form className="cc-composer" onSubmit={event => { event.preventDefault(); void send(); }}><label htmlFor="cc-message-input" className="cc-visually-hidden">发送消息</label><textarea id="cc-message-input" ref={textarea} rows={3} maxLength={20000} value={draft} disabled={sending} onChange={e => setDraft(e.target.value)} placeholder={selected ? '继续讨论，或 @成员邀请协作…' : '描述你想完成的事…'} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); } }} /><div className="cc-composer-bottom"><div className="cc-mention-wrap"><button type="button" className="cc-mention-button" onClick={() => setMentions(value => !value)} aria-label="提及成员" aria-expanded={mentions} disabled={sending}>@</button>{mentions && <div className="cc-mention-menu"><small>邀请成员参与</small>{availableMembers.map(m => <button type="button" key={m.id} onClick={() => mention(m)}><Avatar member={m} small /><strong>{m.name}</strong><small>{carrierNames[m.carrier]}</small></button>)}</div>}</div><span className="cc-composer-hint">Enter 发送 · Shift + Enter 换行</span><button className="cc-send-button" type="submit" disabled={!draft.trim() || sending || !data || (!selected && !availableMembers.length)} aria-label={sending ? '正在发送' : '发送消息'}>{sending ? <span className="cc-send-loading" /> : <Icon name="send" size={19} />}</button></div></form><div className="cc-route-preview" aria-live="polite" aria-atomic="true">{selected && draft.trim() ? previewing ? '正在确认本条消息的目标…' : currentPreview?.routing ? <><Icon name="arrow" size={12} /><span>预计交给 {currentPreview.routing.targets.map(id => members.find(m => m.id === id)?.name ?? id).join('、') || '暂无可用成员'}<small>{routingNames[currentPreview.routing.reason] ?? currentPreview.routing.reason} · 发送时再次核验</small></span></> : <span className="cc-preview-note">{currentPreview?.error || '发送时由服务端解析目标。'}</span> : <span>{selected ? '沿会话历史继续讨论，@ 可明确指定成员' : defaultMember ? `新会话默认由 ${defaultMember.name} 接收，@ 可指定成员` : '先在设置中启用协作成员'}</span>}</div><div className="cc-composer-footnote"><span>直接输入即可，无需选择消息类型</span><span>按承载能力追加或排队</span></div></div></div>
        <aside id="cc-monitor" className={`cc-monitor ${monitor ? 'cc-open' : ''}`}><header><div><span className="cc-eyebrow">协作过程</span><h2>发生了什么</h2></div><button className="cc-icon-button" onClick={() => setMonitor(false)} aria-label="收起协作动态"><Icon name="close" size={17} /></button></header><div className="cc-monitor-scroll">{detail && <CooperationPanel key={`cooperation-${detail.conversation.id}`} detail={detail} members={members} command={command} refresh={refresh} />}{detail && <ArtifactPanel key={`artifacts-${detail.conversation.id}`} detail={detail} members={members} command={command} refresh={refresh} />}{detail && <TaskPanel key={detail.conversation.id} detail={detail} members={members} command={command} refresh={refresh} />}<ExecutionPanel detail={detail} members={members} cancelling={cancelling} operating={operating} notices={notices} onCancel={id => { void cancel(id); }} onReconcile={run => { void reconcile(run); }} onRecheck={delivery => { void recheck(delivery); }} /></div><footer>排队、执行与接受证据分别记录。</footer></aside>
      </div></main>{conversationSettings && detail && <ConversationSettings conversation={detail.conversation} members={members} onSave={saveConversation} onClose={() => setConversationSettings(false)} />}{settings && data && <Settings data={data} saving={saving} onSaveMember={saveMember} onSaveAccount={saveAccount} onRefresh={refresh} onClose={() => setSettings(false)} />}
  </div>;
}
