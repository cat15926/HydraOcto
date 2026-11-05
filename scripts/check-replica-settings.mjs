import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the actual offline settings module. No DOM library, network or CLI calls.
const source = readFileSync(new URL('../prototypes/continuous-collaboration/settings.js', import.meta.url), 'utf8');
const results = [];
function check(name, actual, expected) {
  if (arguments.length < 3) expected = true;
  assert.deepEqual(actual, expected, name);
  results.push(name);
}
function fixture() {
  const sandbox = {
    window: {},
    URL,
    FormData: class {
      constructor(form) { this.values = form.values; }
      get(name) { return this.values[name] ?? null; }
      has(name) { return Object.hasOwn(this.values, name); }
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'settings.js' });
  const settings = sandbox.window.ReplicaSettings;
  const state = {
    members: [
      { id: 'lin', name: '林', alias: 'lin', role: '方案复核', runtime: 'claude', model: '', binding: 'follow', enabled: true },
      { id: 'xu', name: '序', alias: 'xu', role: '实现', runtime: 'codex', model: '', binding: 'follow', enabled: true },
      { id: 'zhi', name: '知', alias: 'zhi', role: '分析', runtime: 'codex', model: '', binding: 'c2', enabled: true },
    ],
    accounts: [
      { id: 'c1', name: 'Codex 账户一', family: 'codex', kind: 'cli', status: 'unverified' },
      { id: 'c2', name: 'Codex 账户二', family: 'codex', kind: 'cli', status: 'unverified' },
      { id: 'l1', name: 'Claude 账户', family: 'claude', kind: 'cli', status: 'unverified' },
      { id: 'a1', name: 'API 账户', family: 'api', kind: 'api', status: 'unverified', endpoint: 'https://example.invalid/v1' },
    ],
    defaults: { codex: 'c1', claude: 'l1', api: 'a1' },
    workspace: { path: '/tmp/old-project', connected: true, revision: 1 },
    threads: [{ id: 'thread-1', messages: [{ sender: 'lin', body: '已发表的历史' }], runs: [{ id: 'run-1', status: 'running', snapshot: { member: 'xu', account: 'c1', workspace: '/tmp/old-project' } }] }],
  };
  const messages = [];
  let serial = 0;
  let commits = 0;
  const api = { uid: kind => `${kind}-${++serial}`, commit: () => commits++, render() {}, notify: text => messages.push(text) };
  return {
    settings, state, messages,
    commits: () => commits,
    action: (name, id = '') => settings.handle(`settings-${name}`, { dataset: { id } }, state, api),
    submit: (id, values = {}, dataset = {}) => settings.submit({ id: `settings-${id}`, values, dataset }, state, api),
    rawAction: (name) => settings.handle(name, { dataset: {} }, state, api),
    rawSubmit: (id) => settings.submit({ id }, state, api),
    render: view => settings.render(state, view),
  };
}
const memberInput = overrides => ({ name: '研', alias: 'yan', role: '研究任务', runtime: 'api', model: 'example-model', binding: 'follow', enabled: 'on', ...overrides });

{
  const f = fixture();
  check('Module exposes three callable interfaces', ['render', 'handle', 'submit'].every(name => typeof f.settings[name] === 'function'));
  check('Other application actions are not intercepted', f.rawAction('thread-new'), false);
  check('Other application forms are not intercepted', f.rawSubmit('composer'), false);
  check('Unknown settings action is not claimed', f.action('unimplemented'), false);
  check('Unknown view has no content', f.render('unknown'), '');
  check('Members view communicates simulation boundary', f.render('members').includes('不会启动 CLI'));
  check('Accounts view distinguishes unknown quota from zero', f.render('accounts').includes('未知 · 不等于零'));
  check('Workspace view states permissions are not granted', f.render('workspace').includes('不会授予文件系统权限'));
}
{
  const f = fixture();
  f.action('member-new');
  check('New-member action opens a real form', f.render('members').includes('id="settings-member-form"'));
  f.submit('member-form', memberInput());
  const added = f.state.members.at(-1);
  check('Member creation adds persistent configuration', [f.state.members.length, added.name, added.alias, added.runtime, added.model], [4, '研', 'yan', 'api', 'example-model']);
  check('Successful save closes member editor', f.state.settings.memberEditor, undefined);
  f.submit('member-form', memberInput({ name: '研改', alias: 'yan2', role: '新的职责', runtime: 'claude', binding: 'l1' }), { id: added.id });
  check('Editing preserves member identity and updates fields', [f.state.members.length, added.id, added.name, added.role, added.binding], [4, 'member-1', '研改', '新的职责', 'l1']);
  f.submit('member-form', memberInput({ name: '研改', alias: 'yan2', runtime: 'codex', binding: 'l1' }), { id: added.id });
  check('Runtime change resets incompatible explicit account', [added.runtime, added.binding], ['codex', 'follow']);
  f.submit('member-form', memberInput({ name: '另一位', alias: 'other', runtime: 'api', binding: 'c1' }));
  check('New member cannot retain a cross-family account', f.state.members.at(-1).binding, 'follow');
  f.action('member-toggle', added.id);
  check('Enabled member can be disabled', added.enabled, false);
  f.action('member-toggle', added.id);
  check('Disabled member can be re-enabled', added.enabled, true);
  f.action('member-delete', added.id);
  check('Unused member can be deleted', f.state.members.some(item => item.id === added.id), false);
  f.action('member-delete', 'lin');
  check('Deleting a member with history retains identity and disables routing', [f.state.members.some(item => item.id === 'lin'), f.state.members.find(item => item.id === 'lin').enabled], [true, false]);
  f.state.members = [f.state.members.find(item => item.id === 'xu')];
  f.action('member-toggle', 'xu');
  check('Last routable member cannot be disabled', f.state.members[0].enabled, true);
  f.action('member-delete', 'xu');
  check('Last routable member cannot be deleted', f.state.members.length, 1);
  const disabledInput = memberInput({ name: '序', alias: 'xu', runtime: 'codex' });
  delete disabledInput.enabled;
  f.submit('member-form', disabledInput, { id: 'xu' });
  check('Edit form cannot bypass last-enabled-member guard', f.state.members[0].enabled, true);
}
{
  const f = fixture();
  for (const [label, overrides] of [
    ['duplicate name', { name: '序' }],
    ['duplicate alias ignoring case', { alias: 'XU' }],
    ['name colliding with another alias', { name: 'xu' }],
    ['alias colliding with another name', { alias: '林' }],
    ['reserved all alias', { alias: 'all' }],
    ['reserved group name', { name: '本帖' }],
    ['alias containing whitespace', { alias: 'two words' }],
    ['unknown runtime', { runtime: 'unsupported' }],
  ]) {
    f.submit('member-form', memberInput(overrides));
    check(`Member rejects ${label}`, f.state.members.length, 3);
  }
  f.submit('member-form', memberInput({ alias: '@yan' }));
  check('Leading @ normalizes to stored alias', f.state.members.at(-1).alias, 'yan');
  f.state.members.at(-1).role = '<img src=x onerror="alert(1)">';
  f.state.members.at(-1).name = '<script>unsafe</script>';
  const html = f.render('members');
  check('Member content is HTML escaped', html.includes('&lt;script&gt;unsafe&lt;/script&gt;') && html.includes('&lt;img src=x'));
  check('Untrusted member content does not create raw HTML', !html.includes('<script>unsafe') && !html.includes('<img src=x'));
}
{
  const f = fixture();
  const runBefore = JSON.stringify(f.state.threads[0].runs[0]);
  f.submit('default-codex', { account: 'c2' }, { family: 'codex' });
  check('Default-account preview does not change the binding', f.state.defaults.codex, 'c1');
  check('Preview identifies default followers separately from overrides', [Array.from(f.state.settings.defaultPreview.followers), Array.from(f.state.settings.defaultPreview.overrides)], [['序'], ['知']]);
  f.action('default-apply');
  check('Applying preview changes default account', f.state.defaults.codex, 'c2');
  check('Explicit member override remains unchanged', f.state.members.find(item => item.id === 'zhi').binding, 'c2');
  check('Account switch preserves active-run snapshot', JSON.stringify(f.state.threads[0].runs[0]), runBefore);
  f.submit('default-codex', { account: 'c1' }, { family: 'codex' });
  f.action('runtime-probe', 'codex');
  f.action('default-apply');
  check('Stale preview cannot apply after configuration changed', f.state.defaults.codex, 'c2');
  check('Stale preview asks to preview again', f.messages.at(-1).includes('重新预览'));
  f.submit('default-codex', { account: 'c1' }, { family: 'codex' });
  f.action('default-cancel');
  check('Cancel preview retains current default', [f.state.settings.defaultPreview, f.state.defaults.codex], [undefined, 'c2']);
  f.submit('default-codex', { account: 'l1' }, { family: 'codex' });
  check('Cross-family default-account selection is rejected', f.state.settings.defaultPreview, undefined);
  f.submit('default-codex', { account: 'c1' }, { family: 'codex' });
  f.state.defaults.codex = 'a1';
  f.action('default-apply');
  check('Changed current default invalidates preview even without revision update', f.state.defaults.codex, 'a1');
}
{
  const f = fixture();
  const account = f.state.accounts.find(item => item.id === 'c2');
  f.action('login-start', 'c2');
  check('Opening login workflow does not imply authentication', [account.status, f.state.settings.loginAccount], ['unverified', 'c2']);
  check('Login workflow visibly labels the completion as simulated', f.render('accounts').includes('模拟登录完成'));
  f.action('login-cancel');
  check('Canceling login clears workflow without authenticating', [account.status, f.state.settings.loginAccount], ['unverified', undefined]);
  f.action('login-complete', 'c2');
  check('Completion cannot bypass login workflow', account.status, 'unverified');
  f.action('login-start', 'c2');
  f.action('login-complete', 'c2');
  check('Explicit simulated completion records only simulated identity', [account.status, account.identity], ['simulated', '本地演示身份 · 未经真实验证']);
  f.action('account-disconnect', 'c2');
  check('Disconnect clears simulated identity', [account.status, account.identity], ['unverified', undefined]);
  f.action('api-check', 'a1');
  check('API connectivity check marks simulation rather than real verification', f.state.accounts.find(item => item.id === 'a1').identity, 'API 演示身份 · 未发送请求');
  f.action('account-delete', 'c1');
  check('Default account cannot be deleted', f.state.accounts.length, 4);
  f.action('account-delete', 'c2');
  check('Explicitly bound account cannot be deleted', f.state.accounts.length, 4);
  f.state.members.find(item => item.id === 'zhi').binding = 'follow';
  f.state.threads[0].runs[0].snapshot.account = 'c2';
  f.action('account-delete', 'c2');
  check('Unbound account still in an active run cannot be deleted', f.state.accounts.length, 4);
  f.state.threads[0].runs[0].status = 'completed';
  f.action('account-delete', 'c2');
  check('Unbound account is deletable after active run ends', f.state.accounts.some(item => item.id === 'c2'), false);
}
{
  const f = fixture();
  const accountInput = overrides => ({ name: '测试连接', family: 'api', kind: 'api', endpoint: 'https://example.invalid/v2', model: 'example-model', ...overrides });
  for (const endpoint of ['https://user:secret@example.invalid/v1', 'https://example.invalid/v1?token=secret', 'https://example.invalid/v1#secret', 'file:///tmp/key', '']) {
    f.submit('account-form', accountInput({ endpoint }));
    check(`Endpoint rejects credentials, unsupported schemes or missing URL: ${endpoint || '(empty)'}`, f.state.accounts.length, 4);
  }
  f.submit('account-form', accountInput({ kind: 'cli' }));
  check('Generic API family cannot use CLI login', f.state.accounts.length, 4);
  f.submit('account-form', accountInput());
  const added = f.state.accounts.at(-1);
  check('API connection saves metadata without credential fields', Object.keys(added).sort(), ['endpoint', 'family', 'id', 'kind', 'model', 'name', 'status'].sort());
  check('New API connection is unverified', added.status, 'unverified');
  f.action('api-check', added.id);
  f.submit('account-form', accountInput({ endpoint: 'https://example.invalid/v3' }), { id: added.id });
  check('Changing Endpoint invalidates old simulated identity', [added.status, added.identity, added.endpoint], ['unverified', undefined, 'https://example.invalid/v3']);
  f.submit('account-form', accountInput({ name: '本机 Codex', family: 'codex', kind: 'cli', endpoint: 'https://unused.invalid' }));
  check('CLI connection does not retain an API endpoint', f.state.accounts.at(-1).endpoint, '');
  f.action('runtime-probe', 'claude');
  check('Runtime probe is explicitly stored as simulation', f.state.settings.runtimeProbe.claude, true);
  f.submit('permission-form', { sandbox: 'read-only', approval: 'untrusted' });
  check('Permission editor stores allowed choices', [f.state.settings.codexSandbox, f.state.settings.codexApproval], ['read-only', 'untrusted']);
  f.submit('permission-form', { sandbox: 'no-sandbox', approval: 'always' });
  check('Permission editor rejects unsupported choices', [f.state.settings.codexSandbox, f.state.settings.codexApproval], ['read-only', 'untrusted']);
}
{
  const f = fixture();
  const runsBefore = JSON.stringify(f.state.threads[0].runs);
  f.submit('workspace-form', { path: 'relative/path' });
  check('Workspace requires absolute path metadata', f.state.settings.workspacePreview, undefined);
  f.submit('workspace-form', { path: '/tmp/project\ninjected' });
  check('Workspace rejects control separators', f.state.settings.workspacePreview, undefined);
  f.submit('workspace-form', { path: '/tmp/new-project' });
  check('Workspace preview preserves existing connection', [f.state.workspace.path, f.state.workspace.revision], ['/tmp/old-project', 1]);
  f.action('workspace-cancel');
  check('Cancel workspace preview leaves old connection', [f.state.settings.workspacePreview, f.state.workspace.path], [undefined, '/tmp/old-project']);
  f.submit('workspace-form', { path: '/tmp/new-project' });
  f.action('workspace-apply');
  check('Workspace apply records a new simulated identity revision', [f.state.workspace.path, f.state.workspace.connected, f.state.workspace.revision], ['/tmp/new-project', true, 2]);
  check('Workspace switch preserves existing execution snapshots', JSON.stringify(f.state.threads[0].runs), runsBefore);
  f.action('workspace-disconnect');
  check('Workspace disconnect keeps identity metadata and increments revision', [f.state.workspace.path, f.state.workspace.connected, f.state.workspace.revision], ['/tmp/new-project', false, 3]);
  check('Workflow changes invoke parent persistence/render callback', f.commits() > 0);
}
console.log(JSON.stringify({ kind: 'replica-settings-state-validation', checks: results.length, passed: results.length, boundaries: 'Offline settings interfaces only; no browser, model, credential, directory or provider verification.', results }, null, 2));
