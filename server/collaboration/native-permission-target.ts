function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function label(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return;
  if (value.length > 420 || /[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value)) return '目标过长或含有不可显示的字符';
  return value;
}

// Display information only. Approval adapters bind decisions to the original native request.
export function nativePermissionTarget(operation: string, params: unknown): string | undefined {
  const p = record(params);
  const input = record(p.input);
  const network = record(p.networkApprovalContext);
  if (typeof network.host === 'string' && /^[a-zA-Z0-9.:[\]-]{1,250}$/.test(network.host)) {
    const protocol = ['https','http','socks5Tcp','socks5Udp'].includes(String(network.protocol)) ? network.protocol : 'network';
    return String(protocol) + '://' + network.host;
  }
  const tool = operation.startsWith('can_use_tool') ? p.tool_name ?? operation.split('/')[1] : undefined;
  if (tool === 'WebFetch' && typeof input.url === 'string') {
    try {
      const url = new URL(input.url);
      if (url.protocol === 'http:' || url.protocol === 'https:') return label(url.origin);
    } catch { /* A malformed URL cannot identify a host. */ }
    return '网络目标不明确';
  }
  if (operation === 'item/permissions/requestApproval') {
    const permissions = record(p.permissions);
    const files = record(permissions.fileSystem);
    const values: string[] = [];
    if (record(permissions.network).enabled === true) values.push('网络访问（未限定主机）');
    for (const [field, action] of [['read','读取'],['write','写入']] as const) {
      const paths = files[field];
      if (Array.isArray(paths)) for (const path of paths) values.push(action + ' ' + (label(path) ?? '未指定路径'));
    }
    if (Array.isArray(files.entries)) for (const entry of files.entries) {
      const item = record(entry), path = record(item.path);
      values.push([label(item.access), label(path.path) ?? label(path.pattern) ?? '特殊目录范围'].filter(Boolean).join(' '));
    }
    return values.length ? label(values.join(' · ')) : undefined;
  }
  return label(p.command) ?? label(input.command) ?? label(p.grantRoot) ?? label(input.file_path) ?? label(p.target) ?? label(tool);
}

export function nativePermissionAlternative(operation: string, target?: string) {
  if (operation.includes('Web') || /^(?:https?|network|socks5(?:Tcp|Udp)):\/\/|未限定主机/u.test(target ?? '')) {
    return '此连接已被拒绝。需要查资料时，可在工作台「项目与成员」选择已登记的只读资料源，再请成员查询。';
  }
  if (operation.includes('commandExecution')) {
    return '当前项目不能为此命令启动原生沙箱。可以请成员使用平台环境查询检查当前目录或 Git、Node.js 版本；项目测试可从会话发起。';
  }
  if (operation.includes('Bash')) {
    return '此命令超出当前可批准的范围。需要检查项目时，可以在会话中请成员运行测试、类型检查或构建。';
  }
  return '此请求超出当前可批准的范围。可以请成员指定单个项目文件，或使用项目评审工具读取文件。';
}
