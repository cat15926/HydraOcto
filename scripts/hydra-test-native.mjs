import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';

// Test process only: copy carrier metadata, never a production conversation or a native history.
export async function isolatedClaude(configRoot, profile) {
  const db = new DatabaseSync(join(configRoot, '.local-data/platform.sqlite'), { readOnly: true });
  let selected, account;
  try {
    selected = JSON.parse(db.prepare('SELECT value FROM cc_members WHERE id=?').get('claude').value);
    account = JSON.parse(db.prepare('SELECT value FROM cc_accounts WHERE id=?').get(selected.accountId).value);
  } finally { db.close(); }
  assert(selected.enabled && selected.carrier === 'claude-cli' && account.auth === 'api' && !account.deletedAt);
  assert.equal(account.baseUrl, 'https://open.bigmodel.cn/api/anthropic');
  assert.equal(account.apiKeyEnv, 'COLLAB_GLM_API_KEY');
  const env = parseEnv(await readFile(join(configRoot, '.env'), 'utf8'));
  for (const name of [account.apiKeyEnv, 'COLLAB_CLAUDE_PATH']) if (!process.env[name] && env[name]) process.env[name] = env[name];
  assert(process.env[account.apiKeyEnv], 'No configured model credential');
  process.env.CLAUDE_CONFIG_DIR = profile;
  return { selected, account };
}
