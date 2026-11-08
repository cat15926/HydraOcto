// Trusted desktop bridge. No path, command or script is supplied by HTTP clients.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from '../store.js';

export type FolderPicker = (signal: AbortSignal, purpose?: 'project' | 'export') => Promise<string | null>;
const execute = promisify(execFile);
const macDialog = (prompt: string) => [
  'activate',
  'try',
  'return POSIX path of (choose folder with prompt "' + prompt + '")',
  'on error number -128',
  'return ""',
  'end try',
].join('\n');

export const chooseProjectFolder: FolderPicker = async (signal,purpose) => {
  const mac = process.platform === 'darwin';
  if (!mac && process.platform !== 'linux') throw new AppError(503, '此系统尚未支持桌面文件夹选择。请在 macOS 或带有 Zenity 的 Linux 桌面上使用。');
  const prompt=purpose==='export' ? '选择项目外的保存文件夹，下一步核对并确认导出' : '选择此会话使用的项目文件夹';
  try {
    const { stdout } = await execute(mac ? '/usr/bin/osascript' : '/usr/bin/zenity',
      mac ? ['-e', macDialog(prompt)] : ['--file-selection', '--directory', '--title='+prompt],
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

export type ProjectFilePicker = (project:string,signal:AbortSignal)=>Promise<string|null>;
export const chooseInspectionFile: ProjectFilePicker = async (project,signal) => {
  const mac = process.platform==='darwin';
  if (!mac && process.platform!=='linux') throw new AppError(503,'当前系统无法打开文件选择器。');
  const script = [
    'on run argv','activate','try',
    'return POSIX path of (choose file with prompt "选择要核对的项目文件" default location (POSIX file (item 1 of argv)))',
    'on error number -128','return ""','end try','end run',
  ].join('\n');
  try {
    const args=mac ? ['-e',script,'--',project] : ['--file-selection','--title=选择要核对的项目文件','--filename='+project+'/'];
    const {stdout}=await execute(mac?'/usr/bin/osascript':'/usr/bin/zenity',args,{signal,timeout:180000,maxBuffer:16384,encoding:'utf8'});
    return stdout.replace(/\n$/,'') || null;
  } catch (e) {
    const cause=e as {code?:string|number;stderr?:string};
    if (signal.aborted || !mac && cause.code===1 && !cause.stderr?.trim()) return null;
    throw new AppError(503,'无法打开系统文件选择器，请在运行服务的桌面上重试。');
  }
};
