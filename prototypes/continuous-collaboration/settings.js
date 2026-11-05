/* Original offline settings prototype. No network, credentials or native CLI calls. */
(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const families = { codex: 'Codex', claude: 'Claude Code', api: '兼容 API' };
  const option = (value, label, selected) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
  const button = (action, label, id = '', cls = '') => `<button type="button" class="button ${cls}" data-action="settings-${action}" data-id="${esc(id)}">${esc(label)}</button>`;
  const note = '<p class="notice">离线原型 · 仅保存配置元数据和模拟状态。不会启动 CLI、发送模型请求、读取目录或保存真实密钥。</p>';
  function ensure(state) {
    state.settings ||= {};
    state.settings.revision ||= 1;
    state.members ||= [];
    state.accounts ||= [];
    state.defaults ||= {};
    state.workspace ||= { path: '', connected: false };
  }
  const accountFor = (state, member) => state.accounts.find(account => account.id === (member.binding === 'follow' ? state.defaults[member.runtime] : member.binding));
  function memberEditor(state) {
    const key = state.settings.memberEditor;
    if (!key) return '';
    const existing = state.members.find(member => member.id === key);
    const member = existing || { name: '', alias: '', role: '', runtime: 'codex', model: '', binding: 'follow', enabled: true };
    return `<section class="card stack"><div class="toolbar"><h2>${existing ? '编辑成员' : '创建成员'}</h2>${button('member-cancel', '关闭')}</div>
      <form id="settings-member-form" data-id="${esc(existing?.id || '')}" class="stack">
      <div class="grid"><label class="field">成员名称<input name="name" maxlength="30" required value="${esc(member.name)}" placeholder="例如：序"></label>
      <label class="field">@ 别名<input name="alias" maxlength="30" required value="${esc(String(member.alias || '').replace(/^@/, ''))}" placeholder="例如：xu"></label></div>
      <label class="field">角色与职责<textarea name="role" rows="3" maxlength="1200" placeholder="说明成员擅长什么，以及何时请求它协助">${esc(member.role)}</textarea></label>
      <div class="grid"><label class="field">运行时<select name="runtime">${Object.entries(families).map(([id, label]) => option(id, label, member.runtime)).join('')}</select></label>
      <label class="field">模型<input name="model" maxlength="100" value="${esc(member.model)}" placeholder="留空使用运行时默认模型"></label></div>
      <label class="field">账户绑定<select name="binding">${option('follow', '跟随该运行时的默认账户', member.binding)}${state.accounts.map(account => option(account.id, `${families[account.family]} · ${account.name}`, member.binding)).join('')}</select></label>
      <p class="muted">切换运行时后，不兼容的指定账户自动改为跟随默认。模型名称只保存配置，不在原型中验证可用性。正在执行的配置快照保持原值。</p>
      <label class="field"><span><input name="enabled" type="checkbox"${member.enabled !== false ? ' checked' : ''}> 允许路由到此成员</span></label>
      <div class="toolbar"><button class="button primary" type="submit">保存成员</button>${button('member-cancel', '取消')}</div></form></section>`;
  }
  function membersView(state) {
    return `<div class="stack"><div class="toolbar"><div><h1>成员与运行时</h1><p class="muted">角色决定协作职责，运行时承载执行，账户提供身份。</p></div>${button('member-new', '＋ 创建成员', '', 'primary')}</div>${note}${memberEditor(state)}
      <div class="grid">${state.members.map(member => {
        const account = accountFor(state, member);
        return `<section class="card stack"><div class="toolbar"><h2>${esc(member.name)}</h2><span class="badge">${member.enabled === false ? '已停用' : '可路由'}</span></div>
          <p class="muted">@${esc(String(member.alias).replace(/^@/, ''))} · ${esc(families[member.runtime] || member.runtime)}</p><p>${esc(member.role || '尚未填写职责')}</p>
          <dl><dt>模型</dt><dd>${esc(member.model || '运行时默认')}</dd><dt>账户</dt><dd>${member.binding === 'follow' ? '跟随默认' : '成员指定'} · ${esc(account?.name || '未配置')}</dd><dt>身份验证</dt><dd>${account?.status === 'simulated' ? '演示连接 · 未经真实验证' : '未验证'}</dd></dl>
          <div class="toolbar">${button('member-edit', '编辑成员', member.id)}${button('member-toggle', member.enabled === false ? '启用' : '停用', member.id)}${button('member-delete', '删除', member.id, 'danger')}</div></section>`;
      }).join('')}</div>
      <section class="card stack"><h2>运行时能力</h2><p class="muted">真实服务需分别探测安装、版本、会话续接、精确追加和取消能力。这里的选择只改变演示状态，不代表本机已安装。</p>
      <div class="grid">${Object.entries(families).map(([id, label]) => `<div><strong>${label}</strong><p>${id === 'api' ? '按接口协议接入；追加能力待验证' : '官方 CLI 登录或 API 账户；承载能力待验证'}</p><span class="badge">${state.settings.runtimeProbe?.[id] ? '模拟探测完成 · 未验真' : '未探测'}</span> ${button('runtime-probe', '模拟探测', id)}</div>`).join('')}</div>
      <details><summary>Codex 实例权限设置（演示）</summary><form id="settings-permission-form" class="stack"><div class="grid"><label class="field">沙箱<select name="sandbox">${['read-only', 'workspace-write'].map(value => option(value, value, state.settings.codexSandbox || 'workspace-write')).join('')}</select></label><label class="field">审批策略<select name="approval">${['on-request', 'untrusted'].map(value => option(value, value, state.settings.codexApproval || 'on-request')).join('')}</select></label></div><p class="muted">实例级设置。实际生效必须由承载落实，文字说明不构成权限隔离。</p><button type="submit" class="button">保存演示策略</button></form></details></section></div>`;
  }
  function accountEditor(state) {
    const key = state.settings.accountEditor;
    if (!key) return '';
    const existing = state.accounts.find(account => account.id === key);
    const account = existing || { name: '', family: 'codex', kind: 'cli', endpoint: '', model: '' };
    return `<section class="card stack"><div class="toolbar"><h2>${existing ? '编辑连接信息' : '添加账户连接'}</h2>${button('account-cancel', '关闭')}</div>
      <form id="settings-account-form" data-id="${esc(existing?.id || '')}" class="stack"><label class="field">显示名称<input name="name" required maxlength="60" value="${esc(account.name)}" placeholder="例如：工作账户"></label>
      <div class="grid"><label class="field">适用运行时<select name="family"${existing ? ' disabled' : ''}>${Object.entries(families).map(([id, label]) => option(id, label, account.family)).join('')}</select></label><label class="field">认证方式<select name="kind"${existing ? ' disabled' : ''}>${option('cli', '官方 CLI 登录（流程模拟）', account.kind)}${option('api', 'API 密钥（仅连接元数据）', account.kind)}</select></label></div>
      <label class="field">API Endpoint<input name="endpoint" type="url" value="${esc(account.endpoint || '')}" placeholder="https://api.example.com/v1"></label><label class="field">默认模型<input name="model" maxlength="100" value="${esc(account.model || '')}" placeholder="可选"></label>
      <p class="notice">请勿粘贴真实密钥、令牌或含凭据的 URL。API 连接只保存名称、地址和模型；真实凭据应由服务端凭据设施接收。CLI 账户的 Endpoint 留空。</p>
      <div class="toolbar"><button class="button primary" type="submit">保存连接信息</button>${button('account-cancel', '取消')}</div></form></section>`;
  }
  function defaultPreview(state) {
    const preview = state.settings.defaultPreview;
    if (!preview) return '';
    const account = state.accounts.find(item => item.id === preview.next);
    return `<section class="card stack"><h2>切换影响预览</h2><p>${esc(families[preview.family])} 默认账户将切换为 <strong>${esc(account?.name || '已不存在')}</strong>。</p><p>下一轮受影响的成员：${esc(preview.followers.join('、') || '暂无跟随默认的成员')}。</p><p>保留指定账户：${esc(preview.overrides.join('、') || '无')}。正在执行的轮次仍使用启动时的账户快照。</p><div class="toolbar">${button('default-apply', '应用切换', '', 'primary')}${button('default-cancel', '取消')}</div></section>`;
  }
  function accountsView(state) {
    const login = state.accounts.find(account => account.id === state.settings.loginAccount);
    return `<div class="stack"><div class="toolbar"><div><h1>账户与登录</h1><p class="muted">连接身份与运行时分开管理，成员默认跟随，也可单独指定。</p></div>${button('account-new', '＋ 添加账户', '', 'primary')}</div>${note}${accountEditor(state)}${defaultPreview(state)}
      ${login ? `<section class="card stack"><h2>${esc(login.name)} · 官方登录流程示意</h2><ol><li>真实服务会在隔离的用户配置目录启动官方 CLI 授权。</li><li>用户在官方页面自行完成登录，不把订阅令牌粘贴给平台。</li><li>平台重新检测身份和连接状态，再供成员选择。</li></ol><p class="notice">本页不会打开授权、启动命令或改变本机登录。点击下方按钮仅模拟第三步。</p><div class="toolbar">${button('login-complete', '模拟登录完成', login.id, 'primary')}${button('login-cancel', '取消流程')}</div></section>` : ''}
      <div class="grid">${state.accounts.map(account => `<section class="card stack"><div class="toolbar"><h2>${esc(account.name)}</h2><span class="badge">${account.status === 'simulated' ? '演示连接' : '未验证'}</span></div><p>${esc(families[account.family])} · ${account.kind === 'cli' ? '官方 CLI 登录' : 'API 密钥认证'}</p><p class="muted">${account.kind === 'api' ? esc(account.endpoint || '尚未填写 Endpoint') : '独立连接配置 · 原型不访问本机认证文件'}</p><dl><dt>身份</dt><dd>${esc(account.identity || '未知')}</dd><dt>最近调用</dt><dd>尚无真实调用</dd><dt>额度</dt><dd>未知 · 不等于零</dd></dl><div class="toolbar">${account.kind === 'cli' ? button('login-start', '查看登录流程', account.id) : button('api-check', '模拟连接检测', account.id)}${button('account-edit', '编辑', account.id)}${button('account-disconnect', '断开', account.id)}${button('account-delete', '删除', account.id, 'danger')}</div></section>`).join('')}</div>
      <section class="card stack"><h2>各运行时的默认账户</h2><p class="muted">先预览影响，再应用。成员单独指定的账户不会被覆盖。</p>${Object.entries(families).map(([id, label]) => `<form id="settings-default-${id}" data-family="${id}" class="toolbar"><label class="field">${label}<select name="account" aria-label="${label} 默认账户">${option('', '未配置', state.defaults[id] || '')}${state.accounts.filter(account => account.family === id).map(account => option(account.id, account.name, state.defaults[id])).join('')}</select></label><button type="submit" class="button">预览切换</button></form>`).join('')}</section></div>`;
  }
  function workspaceView(state) {
    const workspace = state.workspace;
    const pending = state.settings.workspacePreview;
    return `<div class="stack"><h1>工作区与项目接入</h1><p class="muted">同一会话的成员共享项目来源；每一轮保留启动时的目录和权限快照。</p>${note}
      <section class="card stack"><div class="toolbar"><h2>当前工作区</h2><span class="badge">${workspace.connected ? '演示已连接' : '未连接'}</span></div><p><code>${esc(workspace.path || '尚未选择目录')}</code></p><p class="muted">目录身份版本 ${Number(workspace.revision || 0)} · 真实目录存在性、权限与文件变更尚未检测</p>${workspace.connected ? button('workspace-disconnect', '断开演示连接') : ''}</section>
      <section class="card stack"><h2>连接本地项目</h2><form id="settings-workspace-form" class="stack"><label class="field">项目目录<input name="path" required value="${esc(workspace.path || '')}" placeholder="/Users/you/projects/example"></label><p class="muted">仅记录路径元数据；不会授予文件系统权限。材料可从会话输入区添加。切换后现有执行保留原目录，后续会话兼容性需重新核验。</p><button type="submit" class="button primary">预览连接</button></form></section>
      ${pending ? `<section class="card stack"><h2>工作区变更预览</h2><p>新路径：<code>${esc(pending.path)}</code></p><p>下一轮将使用新的目录身份。既有会话的续接状态需重新核验；原型不假定相同 session ID 即成功续接。</p><div class="toolbar">${button('workspace-apply', '应用演示连接', '', 'primary')}${button('workspace-cancel', '取消')}</div></section>` : ''}</div>`;
  }
  function render(state, view) {
    ensure(state);
    if (view === 'members') return membersView(state);
    if (view === 'accounts') return accountsView(state);
    if (view === 'workspace') return workspaceView(state);
    return '';
  }
  function historyHasMember(state, id) {
    return (state.threads || []).some(thread => JSON.stringify({ messages: thread.messages, runs: thread.runs, tasks: thread.tasks, queue: thread.queue }).includes(`"${id}"`));
  }
  function commit(state, api, message) {
    state.settings.revision++;
    api.commit();
    if (message) api.notify(message);
    return true;
  }
  function handle(action, element, state, api) {
    if (!action.startsWith('settings-')) return false;
    ensure(state);
    const key = action.slice(9);
    const id = element.dataset.id;
    const member = state.members.find(item => item.id === id);
    const account = state.accounts.find(item => item.id === id);
    const enabledCount = state.members.filter(item => item.enabled !== false).length;
    if (key === 'member-new') state.settings.memberEditor = '__new__';
    else if (key === 'member-edit' && member) state.settings.memberEditor = id;
    else if (key === 'member-cancel') delete state.settings.memberEditor;
    else if (key === 'member-toggle' && member) {
      if (member.enabled !== false && enabledCount <= 1) { api.notify('至少保留一位可路由成员。'); return true; }
      member.enabled = member.enabled === false;
      return commit(state, api, member.enabled ? '成员已启用。' : '成员已停用；已有消息与执行身份保留。');
    } else if (key === 'member-delete' && member) {
      if (member.enabled !== false && enabledCount <= 1) { api.notify('不能删除最后一位可路由成员。'); return true; }
      if (historyHasMember(state, id)) {
        member.enabled = false;
        return commit(state, api, '成员已有会话记录，已改为停用并保留历史身份。');
      }
      state.members = state.members.filter(item => item.id !== id);
      if (state.settings.memberEditor === id) delete state.settings.memberEditor;
      return commit(state, api, '成员已删除。');
    } else if (key === 'account-new') state.settings.accountEditor = '__new__';
    else if (key === 'account-edit' && account) state.settings.accountEditor = id;
    else if (key === 'account-cancel') delete state.settings.accountEditor;
    else if (key === 'login-start' && account?.kind === 'cli') state.settings.loginAccount = id;
    else if (key === 'login-cancel') delete state.settings.loginAccount;
    else if (key === 'login-complete' && account?.kind === 'cli' && state.settings.loginAccount === id) {
      account.status = 'simulated'; account.identity = '本地演示身份 · 未经真实验证'; delete state.settings.loginAccount;
      return commit(state, api, '已模拟登录完成；本机 CLI 登录状态未改变。');
    } else if (key === 'api-check' && account?.kind === 'api') {
      if (!account.endpoint) { api.notify('请先编辑连接，填写 Endpoint 元数据。'); return true; }
      account.status = 'simulated'; account.identity = 'API 演示身份 · 未发送请求';
      return commit(state, api, '仅模拟连接成功，未测试密钥或网络。');
    } else if (key === 'account-disconnect' && account) {
      account.status = 'unverified'; delete account.identity;
      if (state.settings.loginAccount === id) delete state.settings.loginAccount;
      return commit(state, api, '已清除演示连接状态；运行中的快照保留。');
    } else if (key === 'account-delete' && account) {
      const bound = state.members.filter(item => item.binding === id);
      if (bound.length || Object.values(state.defaults).includes(id)) { api.notify('此账户仍是默认账户或被成员指定。请先切换相关绑定，再删除。'); return true; }
      const active = (state.threads || []).some(thread => (thread.runs || []).some(run => ['running', 'stopping', 'unknown'].includes(run.status) && JSON.stringify(run).includes(`"${id}"`)));
      if (active) { api.notify('此账户仍被活动执行快照使用，等待该轮结束后再删除。'); return true; }
      state.accounts = state.accounts.filter(item => item.id !== id);
      if (state.settings.accountEditor === id) delete state.settings.accountEditor;
      if (state.settings.loginAccount === id) delete state.settings.loginAccount;
      return commit(state, api, '账户元数据已删除；没有删除本机凭据。');
    } else if (key === 'default-cancel') delete state.settings.defaultPreview;
    else if (key === 'default-apply') {
      const preview = state.settings.defaultPreview;
      if (!preview) return true;
      const target = state.accounts.find(item => item.id === preview.next && item.family === preview.family);
      if (!target || state.settings.revision !== preview.revision || (state.defaults[preview.family] || '') !== preview.previous) {
        delete state.settings.defaultPreview;
        return commit(state, api, '配置已改变，请重新预览切换影响。');
      }
      state.defaults[preview.family] = preview.next; delete state.settings.defaultPreview;
      return commit(state, api, '默认账户已更新；下一轮生效，活动执行快照不变。');
    } else if (key === 'runtime-probe' && families[id]) {
      state.settings.runtimeProbe ||= {}; state.settings.runtimeProbe[id] = true;
      return commit(state, api, '模拟探测完成；未运行安装检查或能力测试。');
    } else if (key === 'workspace-cancel') delete state.settings.workspacePreview;
    else if (key === 'workspace-disconnect') {
      state.workspace = { ...state.workspace, connected: false, revision: Number(state.workspace.revision || 0) + 1 };
      return commit(state, api, '演示工作区已断开，历史与活动执行快照保留。');
    } else if (key === 'workspace-apply') {
      const preview = state.settings.workspacePreview;
      if (!preview) return true;
      state.workspace = { path: preview.path, connected: true, revision: Number(state.workspace.revision || 0) + 1 };
      delete state.settings.workspacePreview;
      return commit(state, api, '演示工作区已连接；未读取或授权真实目录。');
    } else return false;
    api.commit();
    return true;
  }
  function submit(form, state, api) {
    if (!form.id.startsWith('settings-')) return false;
    ensure(state);
    const data = new FormData(form);
    const text = name => String(data.get(name) || '').trim();
    const reject = message => { api.notify(message); return true; };
    if (form.id === 'settings-member-form') {
      const existing = state.members.find(item => item.id === form.dataset.id);
      const name = text('name'); const alias = text('alias').replace(/^@/, ''); const runtime = text('runtime');
      if (!name || !alias || !families[runtime]) return reject('请填写名称、别名与运行时。');
      if (!/^[\p{L}\p{N}_-]+$/u.test(alias)) return reject('别名仅使用文字、数字、下划线或连字符，不包含空格和 @。');
      const requestedNames = [name.toLocaleLowerCase(), alias.toLocaleLowerCase()];
      if (requestedNames.some(value => ['all', 'thread', '全体', '本帖', '全部'].includes(value))) return reject('名称或别名与群组路由保留词冲突。');
      if (state.members.some(item => item.id !== existing?.id && [item.name.toLocaleLowerCase(), String(item.alias).replace(/^@/, '').toLocaleLowerCase()].some(value => requestedNames.includes(value)))) return reject('名称或 @ 别名已被其他成员使用。');
      const enabled = data.has('enabled');
      if (!enabled && !state.members.some(item => item.id !== existing?.id && item.enabled !== false)) return reject('至少保留一位可路由成员。');
      let binding = text('binding');
      const selectedAccount = state.accounts.find(item => item.id === binding && item.family === runtime);
      const resetBinding = binding !== 'follow' && !selectedAccount;
      if (resetBinding) binding = 'follow';
      const value = { ...(existing || {}), id: existing?.id || api.uid('member'), name, alias, role: text('role'), runtime, model: text('model'), binding, enabled };
      if (existing) Object.assign(existing, value); else state.members.push(value);
      delete state.settings.memberEditor;
      return commit(state, api, resetBinding ? '成员已保存；不兼容的账户改为跟随新运行时默认。' : '成员已保存，后续执行使用新配置。');
    }
    if (form.id === 'settings-account-form') {
      const existing = state.accounts.find(item => item.id === form.dataset.id);
      const family = existing?.family || text('family'); const kind = existing?.kind || text('kind'); const name = text('name');
      if (!name || !families[family] || !['cli', 'api'].includes(kind)) return reject('请填写完整连接信息。');
      if (family === 'api' && kind === 'cli') return reject('兼容 API 使用 API 认证；请选择 API 密钥方式。');
      let endpoint = text('endpoint');
      if (kind === 'api') {
        try { const url = new URL(endpoint); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(); }
        catch { return reject('请填写 HTTP(S) Endpoint，不含凭据、查询参数或片段。'); }
      } else endpoint = '';
      const changedEndpoint = existing && existing.endpoint !== endpoint;
      const value = { ...(existing || {}), id: existing?.id || api.uid('account'), name, family, kind, endpoint, model: text('model'), status: changedEndpoint ? 'unverified' : existing?.status || 'unverified' };
      if (changedEndpoint) delete value.identity;
      if (existing) { delete existing.identity; Object.assign(existing, value); } else state.accounts.push(value);
      delete state.settings.accountEditor;
      return commit(state, api, '连接信息已保存；尚未验证真实身份与可用性。');
    }
    if (form.id.startsWith('settings-default-')) {
      const family = form.dataset.family; const next = text('account'); const account = state.accounts.find(item => item.id === next && item.family === family);
      if (!account) return reject('请选择已创建的同运行时账户。');
      if (state.defaults[family] === next) return reject('该账户已经是默认账户，无需切换。');
      state.settings.defaultPreview = { family, next, previous: state.defaults[family] || '', revision: state.settings.revision,
        followers: state.members.filter(item => item.runtime === family && item.binding === 'follow').map(item => item.name),
        overrides: state.members.filter(item => item.runtime === family && item.binding !== 'follow').map(item => item.name) };
      api.commit(); return true;
    }
    if (form.id === 'settings-workspace-form') {
      const path = text('path');
      if (!path.startsWith('/') || /[\r\n\0]/.test(path)) return reject('请填写以 / 开头的本地绝对目录路径。');
      state.settings.workspacePreview = { path }; api.commit(); return true;
    }
    if (form.id === 'settings-permission-form') {
      const sandbox = text('sandbox'); const approval = text('approval');
      if (!['read-only', 'workspace-write'].includes(sandbox) || !['on-request', 'untrusted'].includes(approval)) return reject('无效的演示权限选项。');
      state.settings.codexSandbox = sandbox; state.settings.codexApproval = approval;
      return commit(state, api, '演示权限策略已保存，真实执行权限尚未接入。');
    }
    return false;
  }
  window.ReplicaSettings = { render, handle, submit };
})();
