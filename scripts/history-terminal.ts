/** Terminal conversation with verifiable native history, independent of the platform chat database. */
import { createInterface } from 'node:readline/promises';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCollaborationRuntime } from '../server/collaboration/runtime.js';
import { HistoryRecording } from '../server/collaboration/history-recording.js';
import type { CollaborationBootstrap } from '../shared/collaboration.js';
const [memberId, project] = process.argv.slice(2);
if (!memberId || !project) throw new Error('用法：npm run history:terminal -- <成员 ID> <项目文件夹>');
const projectPath = realpathSync(project),
  url = 'http://127.0.0.1:' + (process.env.APP_PORT || '4310');
const response = await fetch(url + '/api/collaboration/bootstrap');
if (!response.ok) throw new Error('请先启动本地平台。');
const boot = (await response.json()) as CollaborationBootstrap;
const raw = boot.members.find((m) => m.id === memberId && m.enabled && !m.deletedAt);
const defaults = boot.defaults?.find((d) => d.carrier === raw?.carrier);
const member = raw && {
  ...raw,
  accountId: raw.accountBinding === 'follow' ? (defaults?.accountId ?? '') : raw.accountId,
  model: raw.modelBinding === 'follow' ? defaults?.model : raw.model,
  effort: raw.modelBinding === 'follow' ? defaults?.effort : raw.effort,
};
const account = boot.accounts.find((a) => a.id === member?.accountId && !a.deletedAt);
if (!member || !account) throw new Error('成员或账户不可用。');
const recorder = new HistoryRecording(
  createCollaborationRuntime(),
  member,
  account,
  projectPath,
  resolve(process.env.APP_DATA_DIR || '.local-data', 'history-receipts'),
);
const rl = createInterface({ input: process.stdin, output: process.stdout });
console.log('输入消息开始终端会话。输入 /exit 退出；有来源回执的对话可在平台中导入。');
try {
  while (true) {
    const prompt = await rl.question('你 > ');
    if (prompt === '/exit') break;
    if (prompt.trim()) console.log((await recorder.turn(prompt)).text);
  }
} finally {
  rl.close();
}
