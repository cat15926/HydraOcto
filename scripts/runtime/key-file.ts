import { readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface SuppliedKey { key: string; requestedModel: string }
/** Parse the explicitly supplied local credential file; never print its contents. */
export async function readSuppliedKeys(path: string): Promise<{ deepseek: SuppliedKey; glm: SuppliedKey }> {
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const result: Partial<Record<'deepseek' | 'glm', Partial<SuppliedKey>>> = {};
  let section: 'deepseek' | 'glm' | undefined;
  let awaitingKey = false;
  for (const line of lines) {
    if (/^deepseek\s*[:：]$/i.test(line)) { section = 'deepseek'; result[section] ??= {}; awaitingKey = false; continue; }
    if (/^(智普|智谱|zhipu|glm)\s*[:：]$/i.test(line)) { section = 'glm'; result[section] ??= {}; awaitingKey = false; continue; }
    if (!section) throw new Error('Credential file has an unknown provider section.');
    if (/^apikey\s*[:：]\s*$/i.test(line)) { awaitingKey = true; continue; }
    if (awaitingKey) {
      if (!/^[A-Za-z0-9_.-]{20,300}$/.test(line)) throw new Error('Credential entry has an unsupported format.');
      result[section]!.key = line; awaitingKey = false; continue;
    }
    const model = /^(?:模型|model)\s*[:：]\s*([a-zA-Z0-9_.:/-]+)$/.exec(line);
    if (model) { result[section]!.requestedModel = model[1]!; continue; }
    throw new Error('Credential file has an unsupported field.');
  }
  if (!result.deepseek?.key || !result.deepseek.requestedModel || !result.glm?.key || !result.glm.requestedModel) throw new Error('Both provider credentials and explicit models are required.');
  return result as { deepseek: SuppliedKey; glm: SuppliedKey };
}
export async function loadSuppliedKeys(path: string) {
  const supplied = await readSuppliedKeys(path);
  process.env.COLLAB_DEEPSEEK_API_KEY = supplied.deepseek.key;
  process.env.COLLAB_GLM_API_KEY = supplied.glm.key;
  return supplied;
}
/** Persist only the two task-specific references in the ignored local environment file. */
export async function saveSuppliedEnvironment(path: string, destination = resolve('.env')): Promise<void> {
  const supplied = await readSuppliedKeys(path);
  let previous = ''; try { previous = await readFile(destination, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const retained = previous.split(/\r?\n/).filter(line => !/^\s*(?:export\s+)?COLLAB_(?:DEEPSEEK|GLM)_API_KEY\s*=/.test(line)).join('\n').trimEnd();
  const content = `${retained}${retained ? '\n' : ''}COLLAB_DEEPSEEK_API_KEY=${supplied.deepseek.key}\nCOLLAB_GLM_API_KEY=${supplied.glm.key}\n`;
  await writeFile(destination, content, { mode: 0o600 }); await chmod(destination, 0o600);
}
