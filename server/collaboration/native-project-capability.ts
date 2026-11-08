import type { Carrier, RuntimeCapability } from '../../shared/collaboration.js';

/** Availability is for working in the user's original directory, independently of CLI installation or login. */
export function nativeProjectCapability(carrier: Carrier): NonNullable<RuntimeCapability['nativeProject']> {
  if (carrier !== 'codex-app-server' && carrier !== 'claude-cli') {
    const reason = '此运行时仅支持当前会话授权的平台工具。项目内原生执行面向 Codex 和 Claude Code。';
    return { api: { available: false, reason }, cli: { available: false, reason } };
  }
  const reason = process.platform === 'darwin'
    ? '本机尚未接入能在执行全程绑定原目录、停止时回收全部项目进程的隔离运行器。'
    : '当前系统尚未接入经过验证的项目隔离运行器。';
  return {
    api: { available: false, reason: reason + 'API 密钥与项目命令的隔离尚待验证。' },
    cli: { available: false, reason: reason + '官方登录凭据与项目命令的隔离尚待验证。' },
  };
}
