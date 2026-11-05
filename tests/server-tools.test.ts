import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ToolGateway } from '../server/tools.js';
import type { ToolCall } from '../shared/contracts.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-tools-'));
  const workspace = join(root, 'materials');
  const artifactDir = join(root, 'artifacts');
  const gateway = new ToolGateway({ workspace, artifactDir });
  await gateway.init();
  return { root, workspace, artifactDir, gateway, close: () => rm(root, { recursive: true, force: true }) };
}

test('工作区不自动写样本，拒绝目录越界、软链接和过大的文本', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await readdir(f.workspace), []);
    await writeFile(join(f.root, 'private.txt'), 'outside workspace');
    await symlink(join(f.root, 'private.txt'), join(f.workspace, 'leak.txt'));
    await mkdir(join(f.root, 'private-dir'));
    await symlink(join(f.root, 'private-dir'), join(f.workspace, 'leak-dir'));
    await writeFile(join(f.workspace, 'large.txt'), 'x'.repeat(65537));
    await writeFile(join(f.workspace, 'brief.txt'), '有效材料');
    const context = { taskId: 'test-task', artifacts: [] };
    await assert.rejects(f.gateway.executeRead('workspace_read', { path: '../private.txt' }, context), /相对路径/);
    await assert.rejects(f.gateway.executeRead('workspace_read', { path: 'leak.txt' }, context), /软链接/);
    await assert.rejects(f.gateway.executeRead('workspace_list', { path: 'leak-dir' }, context), /软链接/);
    await assert.rejects(f.gateway.executeRead('workspace_read', { path: 'large.txt' }, context), /大小限制/);
    assert.equal(await f.gateway.executeRead('workspace_read', { path: 'brief.txt' }, context), '有效材料');
    const list = JSON.parse(await f.gateway.executeRead('workspace_list', { path: '.' }, context));
    assert.ok(!list.entries.some((entry: { name: string }) => entry.name.startsWith('leak')));
  } finally { await f.close(); }
});

test('产物按操作身份去重，越任务读取和替换写入被拒绝', async () => {
  const f = await fixture();
  try {
    const call: ToolCall = { id: 'call-1', taskId: 'task-1', runId: 'run-1', stepId: 'step-1', name: 'artifact_write', args: { name: 'delivery.md', content: '# 交付内容' }, status: 'approved', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const artifact = f.gateway.writeArtifact(call);
    assert.deepEqual(f.gateway.writeArtifact(call), artifact);
    assert.equal((await readdir(f.artifactDir)).length, 1);
    assert.throws(() => f.gateway.writeArtifact({ ...call, args: { ...call.args, content: 'changed' } }), /不同的写入内容/);
    await assert.rejects(f.gateway.executeRead('artifact_read', { artifactId: artifact.id }, { taskId: 'another-task', artifacts: [artifact] }), /不属于当前任务/);
    assert.equal(await f.gateway.executeRead('artifact_read', { artifactId: artifact.id }, { taskId: 'task-1', artifacts: [artifact] }), '# 交付内容');
    assert.throws(() => f.gateway.writeArtifact({ ...call, id: 'unapproved', status: 'pending' }), /批准/);
    assert.throws(() => f.gateway.validate('artifact_write', { name: '../escape.txt', content: 'no' }), /文件名/);
  } finally { await f.close(); }
});

test('仅显式管理的工作区生成样本，工作区和产物目录不能重叠', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-managed-'));
  try {
    const workspace = join(root, 'workspace');
    await new ToolGateway({ workspace, artifactDir: join(root, 'artifacts'), seedDemo: true }).init();
    assert.deepEqual(await readdir(workspace), ['welcome.txt']);
    await assert.rejects(new ToolGateway({ workspace, artifactDir: join(workspace, 'nested') }).init(), /不得重叠/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
