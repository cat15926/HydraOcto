/** Configure local platform references after its credential environment is installed. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readSuppliedKeys, saveSuppliedEnvironment } from './runtime/key-file.js';
import type { CollaborationBootstrap, CollaborationAccount, Member } from '../shared/collaboration.js';

const action = process.argv[2];
const sourcePath = process.argv[3] ?? '/Users/ruhonglin/lhz/apikey.log';
if (action === 'environment') {
  await saveSuppliedEnvironment(sourcePath);
  console.log('Saved the two supplied credentials to ignored .env with mode 0600; values are not displayed.');
} else if (action === 'accounts') {
  const supplied = await readSuppliedKeys(sourcePath);
  const url = 'http://127.0.0.1:4310';
  const bootstrapResponse = await fetch(`${url}/api/collaboration/bootstrap`);
  if (!bootstrapResponse.ok) throw new Error('Local bootstrap unavailable.');
  const bootstrap = await bootstrapResponse.json() as CollaborationBootstrap;
  const backup = resolve('.local-data', 'configuration-backups'); await mkdir(backup, { recursive: true, mode: 0o700 });
  await writeFile(resolve(backup, `before-cli-api-${Date.now()}.json`), JSON.stringify({ members: bootstrap.members, accounts: bootstrap.accounts }, null, 2), { mode: 0o600 });
  const command = async (path: string, body: unknown): Promise<any> => {
    const response = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': bootstrap.csrfToken }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Local configuration request failed (HTTP ${response.status}).`);
    return response.json();
  };
  const accounts: CollaborationAccount[] = [
    { id: 'codex-deepseek-key', name: 'Codex CLI · DeepSeek V4.1 API', provider: 'codex', auth: 'api', apiKeyEnv: 'COLLAB_DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com' },
    { id: 'claude-glm-key', name: 'Claude Code · 智谱 GLM-5.3 API', provider: 'claude', auth: 'api', apiKeyEnv: 'COLLAB_GLM_API_KEY', baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
  ];
  for (const account of accounts) {
    const saved = await command('/api/accounts', account);
    if (!saved.account.configured) throw new Error('Credential reference is missing in the service environment; restart with the saved environment first.');
  }
  const changed: Member[] = [];
  try {
    for (const memberId of ['codex', 'claude']) {
      const original = bootstrap.members.find(m => m.id === memberId);
      if (!original) throw new Error('Default CLI member is missing.');
      const model = memberId === 'codex' ? (supplied.deepseek.requestedModel === 'deepseek-v4.1' ? 'deepseek-flash' : supplied.deepseek.requestedModel) : supplied.glm.requestedModel;
      const member: Member = { ...original, carrier: memberId === 'codex' ? 'codex-app-server' : 'claude-cli', accountId: memberId === 'codex' ? 'codex-deepseek-key' : 'claude-glm-key', model };
      await command('/api/members', member); changed.push(original);
    }
  } catch (error) {
    for (const original of changed.reverse()) await command('/api/members', original);
    throw error;
  }
  console.log(JSON.stringify({ configured: true, members: ['codex', 'claude'], authentication: 'api', globalCliConfigurationChanged: false }));
} else throw new Error('Expected environment or accounts action.');
