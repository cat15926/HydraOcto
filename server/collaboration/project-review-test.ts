import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProjectNpmTestHooks, WorkspaceGrant } from '../../shared/collaboration.js';
import { acquireProjectVm } from './project-vm-mount.js';
import type { ProjectVm } from './project-vm.js';
import { verifyWorkspace } from './workbench.js';
import { MissingProjectScript, supportedProjectNpmCheck } from './project-review-tools.js';

export interface ProjectReviewTestRequest {
  vm: ProjectVm;
  grant: WorkspaceGrant;
  argv: string[];
  signal: AbortSignal;
  verifyAuthorization: () => void;
  privateRoots?: readonly string[];
  hasActiveWriter?: () => boolean;
  borrowedLease?: { vm: ProjectVm; release(confirmed: boolean): Promise<void> };
  npm?: ProjectNpmTestHooks;
  projectNpmChecks?: true;
}

export interface ProjectReviewTestResult {
  argv: string[];
  exitCode: number;
  output: string;
  truncated: boolean;
  snapshotSha256: string;
  treeExited: true;
}

function guestScript(npm: boolean) {
  // This relative asset is included in isolated builds and the deployed server.
  const runner = readFileSync(new URL('../../scripts/runtime/project-review-test.py', import.meta.url), 'utf8');
  if (!npm) return runner;
  return readFileSync(new URL('../../scripts/runtime/project-npm.py', import.meta.url), 'utf8') + '\n' + runner;
}

async function waitForLease(request: ProjectReviewTestRequest) {
  // A dispatched peer may start reading while the writer still owns the VM.
  // Keep waiting for our own live writer. An unowned disk lock needs independent exit evidence.
  const deadline = Date.now() + 600_000;
  let unknownSince: number | undefined;
  let reportedWaiting = false;
  for (;;) {
    request.signal.throwIfAborted();
    request.verifyAuthorization();
    if (request.hasActiveWriter?.()) {
      unknownSince = undefined;
      if (!reportedWaiting) { request.npm?.onPhase('waiting_for_project'); reportedWaiting = true; }
      if (Date.now() >= deadline) throw new Error('等待当前项目执行退出超时，请查看原执行状态。');
    } else {
      try { return await acquireProjectVm(request.vm, request.grant, request.signal, request.privateRoots); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== '项目虚拟机正在使用或上次退出待核查。') throw error;
        unknownSince ??= Date.now();
        if (Date.now() - unknownSince >= 30_000 || Date.now() >= deadline) throw error;
      }
    }
    await delay(400, undefined, { signal: request.signal });
  }
}

export async function runProjectReviewTest(request: ProjectReviewTestRequest): Promise<ProjectReviewTestResult> {
  const { argv, signal, grant } = request;
  if (!Array.isArray(argv) || !argv.length || argv.length > 64 || argv.some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
      !argv[0].trim() || Buffer.byteLength(JSON.stringify(argv)) > 12 * 1024)
    throw new Error('请输入一条测试命令及其参数。');

  function verify() {
    signal.throwIfAborted();
    request.verifyAuthorization();
    verifyWorkspace(grant);
  }
  verify();
  const npm = request.npm;
  if (npm && !supportedProjectNpmCheck(argv, request.projectNpmChecks === true))
    throw new Error('此 npm 检查命令超出本次执行范围。');
  const script = guestScript(Boolean(npm));
  const lease = request.borrowedLease ?? await waitForLease(request);
  let commandSent = false, confirmed = false;
  try {
    verify();
    const vm = lease.vm;
    const args = ['shell','--workdir=/','--shell=/bin/sh','--preserve-env=false','--reconnect=false', vm.instance, '--',
      '/usr/bin/python3', '-I', '-c', script, vm.bootId, vm.guestDevice, vm.guestInode, vm.runnerSha256];
    return await new Promise<ProjectReviewTestResult>((resolve, reject) => {
      const child = spawn(vm.lima, args, { cwd: '/', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homedir(), LIMA_HOME: vm.limaHome }, stdio: 'pipe' });
      child.stderr.resume();
      let error: Error | undefined;
      let buffer = '', snapshotSha256 = '', terminal = false;
      let result: ProjectReviewTestResult | undefined;
      let skipped: MissingProjectScript | undefined;
      let requestedDownload = false, downloadPending = false, testing = false;
      let killTimer: NodeJS.Timeout | undefined;
      const stop = (cause: unknown) => {
        if (error) return;
        error = cause instanceof Error ? cause : new Error('评审测试已停止。');
        child.stdin.end(); // The guest treats EOF as cancellation and reaps its PID namespace.
        killTimer = setTimeout(() => child.kill('SIGKILL'), 7500);
      };
      const abort = () => stop(signal.reason ?? new Error('评审测试已取消。'));
      const poll = setInterval(() => { try { verify(); } catch (cause) { stop(cause); } }, 250);
      const deadline = setTimeout(() => stop(new Error('评审测试超时。')), npm ? 600_000 : 65_000);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      child.on('error', stop);
      child.stdin.on('error', stop);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (part: string) => {
        try {
          buffer += part;
          if (buffer.length > (npm ? 512_000 : 150_000)) throw new Error();
          let end: number;
          while ((end = buffer.indexOf('\n')) !== -1) {
            const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
            if (terminal) throw new Error();
            if (frame.state === 'ready' && !snapshotSha256 && typeof frame.snapshotSha256 === 'string' && /^[0-9a-f]{64}$/.test(frame.snapshotSha256)) {
              snapshotSha256 = frame.snapshotSha256;
              if (error) continue;
              verify();
              commandSent = true;
              if (npm) npm.onPhase('preparing');
              child.stdin.write(JSON.stringify(npm ? { mode: 'npm', argv, projectNpmChecks:request.projectNpmChecks } : argv) + '\n');
            } else if (frame.state === 'download' && npm && commandSent && !requestedDownload && !testing &&
                typeof frame.lockSha256 === 'string' && /^[0-9a-f]{64}$/.test(frame.lockSha256) &&
                Array.isArray(frame.packages) && frame.packages.length > 0 && frame.packages.length <= 1024 &&
                frame.packages.every((pkg: unknown) => typeof pkg === 'string' && /^[a-zA-Z0-9.@_+/-]{1,300}$/.test(pkg))) {
              requestedDownload = downloadPending = true;
              if (error) continue;
              verify();
              const lockSha256 = frame.lockSha256;
              void npm.authorizeDownload({ lockSha256, packages: frame.packages }).then(() => {
                if (terminal || error) return;
                verify();
                downloadPending = false;
                child.stdin.write(JSON.stringify({allow: lockSha256}) + '\n');
              }).catch(stop);
            } else if (frame.state === 'skipped' && npm && request.projectNpmChecks && commandSent && !requestedDownload &&
                !testing && frame.script === (argv[1] === 'test' ? 'test' : argv[2])) {
              terminal = true;
              skipped = new MissingProjectScript(frame.script, snapshotSha256);
            } else if (frame.state === 'testing' && npm && commandSent && !testing && !downloadPending) {
              testing = true;
              if (!error) { verify(); npm.onPhase('testing'); }
            } else if (frame.state === 'exited' && commandSent && (!npm || testing) && Number.isInteger(frame.exitCode) &&
                typeof frame.output === 'string' && frame.output.length <= 16_384 && typeof frame.truncated === 'boolean') {
              terminal = true;
              result = { argv: [...argv], exitCode: frame.exitCode, output: frame.output, truncated: frame.truncated, snapshotSha256, treeExited: true };
            } else if (frame.state === 'failed' && typeof frame.reason === 'string' && frame.reason.length <= 128) {
              terminal = true;
              stop(new Error('评审测试未完成：' + frame.reason));
            } else throw new Error();
          }
        } catch (cause) { stop(cause instanceof Error && cause.message ? cause : new Error('评审虚拟机返回了无效的回执。')); }
      });
      child.on('close', code => {
        clearTimeout(killTimer); clearTimeout(deadline); clearInterval(poll);
        signal.removeEventListener('abort', abort);
        confirmed = terminal && code === 0 && buffer.length === 0;
        if (commandSent && !confirmed) return reject(new Error('测试进程退出尚未确认，请先核查该虚拟机。'));
        try {
          if (error) throw error;
          verify();
          if (confirmed && skipped) throw skipped;
          if (!confirmed || !result) throw new Error('无法确认评审测试结果。');
          resolve(result);
        } catch (cause) { reject(cause); }
      });
    });
  } finally {
    // A transport loss after the command was sent leaves the original lease for operator inspection.
    await lease.release(!commandSent || confirmed);
  }
}
