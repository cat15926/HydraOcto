import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { runTaskScenarios } from './task-scenarios.js';
import { runActionWaitScenarios } from './action-wait-scenarios.js';
import { runMessageScenarios } from './message-scenarios.js';
import { runProjectionScenarios } from './projection-scenarios.js';

const [upstream, output] = process.argv.slice(2).map(p => resolve(p));
assert(upstream && output, 'provide upstream source and output paths');
const git = (...args: string[]) => execFileSync('git', ['-C', upstream, ...args], { encoding: 'utf8' }).trim();
const commit = git('rev-parse', 'HEAD');
const dirtyBefore = git('status', '--porcelain');
assert.equal(dirtyBefore, '', 'Use a clean upstream checkout so the commit identifies the evaluated sources.');
const started = new Date().toISOString();
// Sequential suites: injected clocks/IDs in an individual suite must not leak across suites.
const suites = [];
for (const [name, run] of [
  ['task', runTaskScenarios], ['action-wait', runActionWaitScenarios],
  ['message', runMessageScenarios], ['projection', runProjectionScenarios],
] as const) {
  const suite = await run(upstream);
  suites.push(suite);
  console.log(`${name}: ${suite.scenarios.length} scenarios, ${suite.scenarios.reduce((n, s) => n + s.steps.length, 0)} steps PASS`);
}
assert.equal(git('status', '--porcelain'), dirtyBefore, 'Research must leave upstream unchanged.');
const scenarios = suites.flatMap(s => s.scenarios);
const references = suites.flatMap(s => s.sources);
const sourceManifest = [];
for (const path of [...new Set(references.map(s => s.path))].sort()) {
  const content = await readFile(join(upstream, path));
  sourceManifest.push({ path, sha256: createHash('sha256').update(content).digest('hex') });
}
const trace = {
  format: 'clowder-source-simulation/v1', started, finished: new Date().toISOString(),
  baseline: { commit, commitTime: git('show', '-s', '--format=%cI', 'HEAD'), upstreamRoot: upstream,
    cleanBefore: true, cleanAfter: true, remoteLatestVerified: false },
  runtime: { node: process.version, loading: 'API src/*.ts via tsx; @cat-cafe/shared compiled from current source using upstream tsc into a fresh temporary directory; no existing upstream dist used for shared or tested API modules' },
  boundary: 'Synthetic inputs executed against upstream source. No real model, Redis, network service, OS process teardown or production chat data.',
  totals: { scenarios: scenarios.length, steps: scenarios.reduce((n, s) => n + s.steps.length, 0),
    checkedStatements: scenarios.reduce((n, s) => n + s.steps.reduce((m, step) => m + step.checks.length, 0), 0) },
  scenarios, references, sourceManifest,
};
await mkdir(output, { recursive: true });
await writeFile(join(output, 'trace.json'), JSON.stringify(trace,
  (_key, value) => value === undefined ? { $js: 'undefined' } : value, 2) + '\n');
console.log(JSON.stringify({ output: join(output, 'trace.json'), ...trace.totals, commit }));
