#!/usr/bin/env node
// Research runner: import the separately checked-out upstream sources; never vendor them.
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '../../..');
const upstream = resolve(process.argv[2] ?? join(project, '../clowder-ai-latest'));
const output = resolve(process.argv[3] ?? process.env.VALIDATION_OUTPUT_DIR ?? join(project, '.local-data/validation/clowder-simulation'));
if (Number(process.versions.node.split('.')[0]) < 24) {
  throw new Error('Use Node.js >=24, matching the upstream runtime requirement.');
}
const temporary = await mkdtemp(join(tmpdir(), 'clowder-research-'));
try {
  const status = execFileSync('git', ['-C', upstream, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (status) throw new Error('Use a clean upstream checkout before compiling or executing research.');
  const shared = JSON.parse(await readFile(join(upstream, 'packages/shared/package.json'), 'utf8'));
  // The upstream barrel re-exports types without `type`; esbuild alone cannot erase them.
  // Compile the current shared source with its own TypeScript, entirely outside the checkout.
  const sharedOutput = join(temporary, 'shared');
  const compile = spawnSync(process.execPath, [
    join(upstream, 'node_modules/typescript/lib/tsc.js'),
    '--project', join(upstream, 'packages/shared/tsconfig.json'),
    '--outDir', sharedOutput, '--declaration', 'false', '--declarationMap', 'false', '--sourceMap', 'false',
  ], { cwd: upstream, stdio: 'inherit' });
  if (compile.error) throw compile.error;
  if (compile.status !== 0) throw new Error(`Current-source shared compilation failed: ${compile.status}`);
  await writeFile(join(sharedOutput, 'package.json'), JSON.stringify({ type: 'module' }));
  await symlink(join(upstream, 'packages/shared/node_modules'), join(sharedOutput, 'node_modules'), 'dir');
  const paths = {};
  for (const [key, entry] of Object.entries(shared.exports)) {
    const target = typeof entry === 'string' ? entry : entry.import;
    const alias = key === '.' ? '@cat-cafe/shared' : '@cat-cafe/shared/' + key.slice(2);
    paths[alias] = [join(sharedOutput, target.replace('./dist/', ''))];
  }
  const configPath = join(temporary, 'tsconfig.json');
  await writeFile(configPath, JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', paths,
  } }, null, 2));
  const result = spawnSync(process.execPath, [
    '--import', join(project, 'node_modules/tsx/dist/loader.mjs'),
    join(here, 'run.ts'), upstream, output,
  ], {
    cwd: project, stdio: 'inherit',
    env: { ...process.env, TSX_TSCONFIG_PATH: configPath, TSX_DISABLE_CACHE: '1' },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
