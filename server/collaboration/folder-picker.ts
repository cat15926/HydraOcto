// Trusted desktop bridge. No path, command or script is supplied by HTTP clients.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from '../store.js';

export type FolderPicker = (signal: AbortSignal) => Promise<string | null>;
const execute = promisify(execFile);
const macDialog = [
  'activate',
  'try',
  'return POSIX path of (choose folder with prompt "选择此会话使用的项目文件夹")',
  'on error number -128',
  'return ""',
  'end try',
].join('\n');

export const chooseProjectFolder: FolderPicker = async signal => {
  const mac = process.platform === 'darwin';
  if (!mac && process.platform !== 'linux') throw new AppError(503, '此系统尚未支持桌面文件夹选择。请在 macOS 或带有 Zenity 的 Linux 桌面上使用。');
  try {
    const { stdout } = await execute(mac ? '/usr/bin/osascript' : '/usr/bin/zenity',
      mac ? ['-e', macDialog] : ['--file-selection', '--directory', '--title=选择项目文件夹'],
      { signal, timeout: 180_000, maxBuffer: 16_384, encoding: 'utf8' });
    const path = stdout.replace(/\n$/, ''); // Remove the dialog's output delimiter only.
    return path || null;
  } catch (err) {
    if (signal.aborted) return null;
    const cause = err as { code?: string | number; killed?: boolean; stderr?: string };
    if (!mac && cause.code === 1 && !cause.stderr?.trim()) return null;
    throw new AppError(503, cause.killed ? '文件夹选择已超时，请重新选择。'
      : mac ? '未能打开系统文件夹选择器。请确认服务在已登录的 Mac 桌面运行，再重试。' : '未能打开系统文件夹选择器。请在图形桌面安装 Zenity 后重试。');
  }
};
