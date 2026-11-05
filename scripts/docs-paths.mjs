import { resolve } from 'node:path';

export const repositoryRoot = resolve(import.meta.dirname, '..');

/** Full research/release documentation is local and lives outside the code checkout. */
export function resolveDocsArchiveRoot(root = repositoryRoot, configured = process.env.MULTI_AGENT_DOCS_DIR) {
  return resolve(configured || resolve(root, '..', 'Multi-Agent-Docs'));
}

export const docsArchiveRoot = resolveDocsArchiveRoot();
