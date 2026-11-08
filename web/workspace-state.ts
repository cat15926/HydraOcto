import type { ConversationDetail } from '../shared/collaboration';

export const workspaceTools = [
  { id: 'project', title: '项目与成员', icon: 'folder', keywords: '项目 工作区 目录 文件夹 只读 授权 默认成员 设置' },
  { id: 'preview', title: '项目预览', icon: 'grid', keywords: '预览 网页 日志 启动 停止 静态项目' },
  { id: 'knowledge', title: '会话资料', icon: 'book', keywords: '记忆 查找 搜索 材料 可见范围 权限 成员组 收藏 已读 导出 回收站' },
  { id: 'tasks', title: '任务跟进', icon: 'check', keywords: '任务 负责人 交接 进度 状态' },
  { id: 'artifacts', title: '产物与评审', icon: 'file', keywords: '产物 审批 发布 评审 文件 版本 问题 回答' },
  { id: 'cooperation', title: '协作调度', icon: 'people', keywords: '协作 调度 排队 来源 追加 征询 咨询 多人 优先级 取消' },
  { id: 'actions', title: '跨会话协作', icon: 'link', keywords: '跨会话 授权 专用责任 Action 条件 等待 接回' },
  { id: 'activity', title: '执行与记录', icon: 'pulse', keywords: '执行 动态 记录 运行 核查 恢复 停止 用量 会话链 输入 证据' },
] as const;
export type WorkspaceTool = typeof workspaceTools[number]['id'];
export type WorkspacePage = 'home' | WorkspaceTool;
type Scoped = { conversationId: string };
export type WorkspaceTarget = Scoped & (
  | { kind: 'tool'; tool: WorkspaceTool }
  | { kind: 'task'; taskId: string }
  | { kind: 'artifact'; artifactId: string; versionId: string }
  | { kind: 'invocation'; invocationId: string }
  | { kind: 'memory'; entryId: string; versionId: string }
  | { kind: 'interaction'; interactionId: string }
  | { kind: 'action'; actionId: string }
  | { kind: 'message'; messageId: string }
);
export type WorkspaceOrigin = { kind: 'home' } | { kind: 'view'; target: WorkspaceTarget } | { kind: 'message'; messageId: string };
export type WorkspaceView = { key: string; target: WorkspaceTarget; origin: WorkspaceOrigin; pinned: boolean };
export type WorkspaceLayout = { schema: 1; conversationId: string; views: WorkspaceView[]; active: string | null; preview: string | null; closed: WorkspaceView[]; recent: string[]; width: number; expanded: boolean };
export type WorkspaceAction =
  | { type: 'open'; target: WorkspaceTarget; origin?: WorkspaceOrigin; preview?: boolean; cause?: 'user' | 'background' }
  | { type: 'activate' | 'close' | 'restore' | 'pin' | 'promote'; key: string }
  | { type: 'home' }
  | { type: 'resize'; width: number }
  | { type: 'expand' };
const id = (v: unknown): v is string => typeof v === 'string' && /^[\w.:-]{1,160}$/.test(v);
export function targetKey(t: WorkspaceTarget): string {
  const identity = t.kind === 'tool' ? t.tool : t.kind === 'task' ? t.taskId : t.kind === 'artifact' ? [t.artifactId, t.versionId] : t.kind === 'memory' ? [t.entryId, t.versionId] : t.kind === 'invocation' ? t.invocationId : t.kind === 'interaction' ? t.interactionId : t.kind === 'action' ? t.actionId : t.messageId;
  return JSON.stringify([t.conversationId, t.kind, identity]);
}
export function targetPage(t: WorkspaceTarget): WorkspaceTool {
  return t.kind === 'tool' ? t.tool : t.kind === 'task' ? 'tasks' : t.kind === 'artifact' || t.kind === 'interaction' ? 'artifacts' : t.kind === 'invocation' ? 'activity' : t.kind === 'action' ? 'actions' : 'knowledge';
}
export function emptyWorkspace(conversationId: string): WorkspaceLayout {
  return { schema: 1, conversationId, views: [], active: null, preview: null, closed: [], recent: [], width: 48, expanded: false };
}
const visit = (recent: string[], key: string) => [key, ...recent.filter(k => k !== key)].slice(0, 3);
const closed = (list: WorkspaceView[], view: WorkspaceView) => [{ ...view, pinned: false }, ...list.filter(v => v.key !== view.key)].slice(0, 5);

/** Presentation only. No domain command, cancellation, execution or authorization is performed here. */
export function workspaceReducer(state: WorkspaceLayout, action: WorkspaceAction): WorkspaceLayout {
  if (action.type === 'home') return { ...state, active: null };
  if (action.type === 'resize') return Number.isFinite(action.width) ? { ...state, width: Math.min(74, Math.max(34, action.width)) } : state;
  if (action.type === 'expand') return { ...state, expanded: !state.expanded };
  if (action.type === 'open') {
    if (action.cause === 'background' || action.target.conversationId !== state.conversationId) return state;
    const key = targetKey(action.target), existing = state.views.find(v => v.key === key);
    const origin = action.origin?.kind === 'view' && targetKey(action.origin.target) === key ? undefined : action.origin;
    if (existing) return { ...state, active: key, views: state.views.map(v => v.key === key && origin ? { ...v, origin } : v), recent: visit(state.recent, key) };
    const oldPreview = action.preview ? state.views.find(v => v.key === state.preview && !v.pinned) : undefined;
    if (!oldPreview && state.views.length >= 40) return state;
    const view: WorkspaceView = { key, target: action.target, origin: origin ?? { kind: 'home' }, pinned: false };
    return { ...state, views: [...state.views.filter(v => v.key !== oldPreview?.key), view], active: key,
      preview: action.preview ? key : state.preview, recent: visit(state.recent, key),
      closed: (oldPreview ? closed(state.closed, oldPreview) : state.closed).filter(v => v.key !== key) };
  }
  if (action.type === 'restore') {
    const view = state.closed.find(v => v.key === action.key);
    if (!view || state.views.length >= 40) return state;
    return { ...state, views: state.views.some(v => v.key === view.key) ? state.views : [...state.views, view], active: view.key, closed: state.closed.filter(v => v.key !== view.key), recent: visit(state.recent, view.key) };
  }
  const view = state.views.find(v => v.key === action.key);
  if (!view) return state;
  if (action.type === 'activate') return { ...state, active: view.key, recent: visit(state.recent, view.key) };
  if (action.type === 'promote') return state.preview === view.key ? { ...state, preview: null } : state;
  if (action.type === 'pin') return { ...state, views: state.views.map(v => v.key === view.key ? { ...v, pinned: !v.pinned } : v), preview: state.preview === view.key ? null : state.preview };
  const views = state.views.filter(v => v.key !== view.key);
  return { ...state, views, active: state.active === view.key ? views.at(-1)?.key ?? null : state.active,
    preview: state.preview === view.key ? null : state.preview, closed: closed(state.closed, view) };
}

function parseTarget(raw: unknown, conversationId: string): WorkspaceTarget | undefined {
  if (!raw || typeof raw !== 'object') return;
  const t = raw as Record<string, unknown>;
  if (t.conversationId !== conversationId) return;
  const base = { conversationId };
  switch (t.kind) {
    case 'tool': if (workspaceTools.some(x => x.id === t.tool)) return { ...base, kind: 'tool', tool: t.tool as WorkspaceTool }; break;
    case 'task': if (id(t.taskId)) return { ...base, kind: 'task', taskId: t.taskId }; break;
    case 'artifact': if (id(t.artifactId) && id(t.versionId)) return { ...base, kind: 'artifact', artifactId: t.artifactId, versionId: t.versionId }; break;
    case 'memory': if (id(t.entryId) && id(t.versionId)) return { ...base, kind: 'memory', entryId: t.entryId, versionId: t.versionId }; break;
    case 'invocation': if (id(t.invocationId)) return { ...base, kind: 'invocation', invocationId: t.invocationId }; break;
    case 'interaction': if (id(t.interactionId)) return { ...base, kind: 'interaction', interactionId: t.interactionId }; break;
    case 'action': if (id(t.actionId)) return { ...base, kind: 'action', actionId: t.actionId }; break;
    case 'message': if (id(t.messageId)) return { ...base, kind: 'message', messageId: t.messageId }; break;
  }
}
/** Whitelist UI references, never restore cached titles, content, credentials or arbitrary fields. */
export function restoreWorkspace(raw: unknown, conversationId: string): WorkspaceLayout {
  const initial = emptyWorkspace(conversationId);
  if (!raw || typeof raw !== 'object') return initial;
  const value = raw as Record<string, unknown>;
  if (value.schema !== 1 || value.conversationId !== conversationId) return initial;
  const parseViews = (items: unknown, max: number) => {
    const result: WorkspaceView[] = [], seen = new Set<string>();
    for (const item of (Array.isArray(items) ? items.slice(0, max) : [])) {
      const target = parseTarget(item?.target, conversationId); if (!target) continue;
      const key = targetKey(target); if (seen.has(key)) continue; seen.add(key);
      const originTarget = item.origin?.kind === 'view' ? parseTarget(item.origin.target, conversationId) : undefined;
      const origin: WorkspaceOrigin = originTarget && targetKey(originTarget) !== key ? { kind: 'view', target: originTarget }
        : item.origin?.kind === 'message' && id(item.origin.messageId) ? { kind: 'message', messageId: item.origin.messageId } : { kind: 'home' };
      result.push({ key, target, origin, pinned: item.pinned === true });
    }
    return result;
  };
  const views = parseViews(value.views, 40), removed = parseViews(value.closed, 5).filter(v => !views.some(o => o.key === v.key)).map(v => ({ ...v, pinned: false }));
  const keys = new Set([...views, ...removed].map(v => v.key));
  return { ...initial, views, closed: removed, active: views.some(v => v.key === value.active) ? value.active as string : null,
    preview: views.some(v => v.key === value.preview && !v.pinned) ? value.preview as string : null,
    recent: Array.from(new Set((Array.isArray(value.recent) ? value.recent : []).filter((k): k is string => typeof k === 'string' && keys.has(k)))).slice(0, 3),
    width: typeof value.width === 'number' && Number.isFinite(value.width) ? Math.min(74, Math.max(34, value.width)) : initial.width,
    expanded: value.expanded === true };
}
export const workspaceStorageKey = (conversationId: string) => `multi-agent:workspace:v1:${conversationId}`;

export function describeTarget(target: WorkspaceTarget, detail: ConversationDetail): { title: string; icon: string; unavailable?: string } {
  const missing = { title: '内容不可用', icon: 'file', unavailable: '对象已移除或不再可见。可关闭此视图，或返回来源查看最新状态。' };
  if (target.conversationId !== detail.conversation.id) return missing;
  if (target.kind === 'tool') { const tool = workspaceTools.find(t => t.id === target.tool)!; return { title: tool.title, icon: tool.icon }; }
  if (detail.conversation.deletedAt) return { ...missing, unavailable: '会话已移入回收站。恢复会话后再打开工作对象。' };
  switch (target.kind) {
    case 'task': { const task = detail.tasks?.find(t => t.id === target.taskId); return task ? { title: task.title, icon: 'check' } : missing; }
    case 'artifact': {
      const artifact = detail.artifacts?.find(a => a.id === target.artifactId), version = detail.artifactVersions?.find(v => v.id === target.versionId && v.artifactId === target.artifactId);
      return artifact && version ? { title: `${artifact.name} · v${version.number}`, icon: 'file' } : missing;
    }
    case 'memory': {
      const entry = detail.memories?.find(e => e.id === target.entryId && e.scope === 'conversation' && !e.revokedAt), version = detail.memoryVersions?.find(v => v.id === target.versionId && v.entryId === target.entryId && v.state !== 'revoked');
      return entry && version ? { title: `${entry.key} · v${version.number}`, icon: 'book' } : missing;
    }
    case 'invocation': return detail.invocations.some(i => i.id === target.invocationId) ? { title: `执行 · ${target.invocationId.slice(0, 8)}`, icon: 'pulse' } : missing;
    case 'interaction': {
      const item = detail.interactions?.find(i => i.id === target.interactionId);
      return item ? { title: item.kind === 'approval' ? '操作确认' : item.transport === 'project-npm' ? '下载测试依赖' : '成员提问', icon: 'question' } : missing;
    }
    case 'action': { const action = detail.actions?.find(a => a.id === target.actionId); return action ? { title: action.title, icon: 'link' } : missing; }
    case 'message': return detail.messages.some(m => m.id === target.messageId && !m.deletedAt) ? { title: '引用的消息', icon: 'message' } : missing;
  }
}
