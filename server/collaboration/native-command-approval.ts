import type { NativeCommandApproval } from '../../shared/collaboration.js';

const cwd = '/mnt/project';
const probes = ['pwd', '/bin/pwd', 'node --version', 'git --version'];
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function claudeCommandApproval(input: unknown): NativeCommandApproval | undefined {
  if (!object(input) || typeof input.command !== 'string' || !probes.includes(input.command)) return;
  if (Object.keys(input).some(key=>!['command','description','timeout','run_in_background','dangerouslyDisableSandbox'].includes(key)) ||
      (input.run_in_background !== undefined && input.run_in_background !== false) ||
      (input.dangerouslyDisableSandbox !== undefined && input.dangerouslyDisableSandbox !== false) ||
      (input.timeout !== undefined && !(typeof input.timeout === 'number' && Number.isSafeInteger(input.timeout) && input.timeout > 0 && input.timeout <= 120000))) return;
  return {command:input.command,cwd};
}

export function validNativeCommand(command: NativeCommandApproval, transport: string) {
  return transport === 'claude' && command.cwd === cwd && probes.includes(command.command);
}

export const managedEnvironmentCommands = ['pwd','git --version','node --version'] as const;
export function managedProbeArgv(command: unknown): string[] {
  if (command === 'pwd') return ['/bin/pwd'];
  if (command === 'git --version') return ['/usr/bin/git','--version'];
  if (command === 'node --version') return ['node','--version'];
  throw new Error('项目环境查询仅支持显示当前目录或查询 Git、Node.js 版本。');
}
export function isManagedProbeArgv(argv: readonly string[]) {
  return managedEnvironmentCommands.some(command => {
    const expected = managedProbeArgv(command);
    return expected.length === argv.length && expected.every((part,index)=>part === argv[index]);
  });
}
