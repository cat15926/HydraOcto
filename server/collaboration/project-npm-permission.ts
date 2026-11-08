import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { ProjectNpmTestHooks, WorkspaceGrant } from '../../shared/collaboration.js';
import { AppError } from '../store.js';
import type { CollaborationStore } from './store.js';
import { projectFileDigest } from './project-file-read.js';

const allowDownload = '允许此次下载';

export function projectNpmPermission(store: CollaborationStore, id: string, callId: string, argv: string[],
  signal: AbortSignal, verify: () => WorkspaceGrant) {
  let declined = false;
  let asked = false;
  function record(state: string, detail: Record<string, unknown> = {}) {
    store.recordEvidence(id, {kind:'tool', detail:{origin:'project_npm', callId, argv, state, ...detail}});
  }
  const hooks: ProjectNpmTestHooks = {
    onPhase(phase) {
      verify();
      record(phase);
    },
    async authorizeDownload({lockSha256, packages}) {
      if (asked || !/^[a-f0-9]{64}$/.test(lockSha256) || !Array.isArray(packages) || !packages.length ||
          packages.some(pkg => typeof pkg !== 'string' || !pkg.length || pkg.length > 512 || /[\x00-\x1f\x7f]/.test(pkg))) {
        throw new AppError(409, '依赖下载范围无效，请重新检查项目。');
      }
      asked = true;
      const grant = verify();
      async function verifyLock() {
        const lock = await projectFileDigest(verify(), 'package-lock.json', signal);
        verify();
        if (lock.sha256 !== lockSha256) throw new AppError(409, '锁文件已变化，请使用当前版本重新测试。');
      }
      await verifyLock();
      const previous = store.interactions.list(grant.conversationId).some(i => i.invocationId === id &&
        i.transport === 'project-npm' && i.payload.lockSha256 === lockSha256 &&
        (['declined','expired','cancelled'].includes(i.state) || (i.state === 'answered' && i.answers?.download !== allowDownload)));
      if (previous) {
        declined = true;
        record('denied');
        throw new AppError(403, '本次执行的依赖下载未获授权。');
      }
      const registry = 'https://registry.npmjs.org';
      const payload = {lockSha256, packages, registry, project:basename(grant.path), grantRevision:grant.revision};
      const question = '为「' + basename(grant.path) + '」的这次测试，从 npm 官方仓库下载锁定的 ' + packages.length + ' 个依赖？';
      record('awaiting_download', {lockSha256, count:packages.length});
      const decision = await store.interactions.wait(id, {
        providerRequestId:createHash('sha256').update(callId).digest('hex'), kind:'question', operation:'npm_download',
        questions:[{id:'download', question, options:[allowDownload]}], payload
      }, 'project-npm', signal);
      if (decision.state !== 'answered' || decision.answers?.download !== allowDownload) {
        declined = true;
        record('denied');
        throw new AppError(403, '此次依赖下载未获授权。项目测试尚未运行。');
      }
      await verifyLock();
    }
  };
  return {hooks, record, get declined() { return declined; }};
}
