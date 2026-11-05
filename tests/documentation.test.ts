import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkDocumentation } from '../scripts/check-docs.mjs';

const header = (type = 'plan') => `---\ntype: "${type}"\nstatus: "active"\napproval: "confirmed"\nscope: "synthetic fixture"\nupdated: "2026-11-04"\n---\n`;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'documentation-split-'));
  const root = join(parent, 'Multi-Agent'), archiveRoot = join(parent, 'Multi-Agent-Docs');
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'README.md'), '[Guide](docs/implementation-guide.md) · [Progress](docs/implementation-progress.md)');
  await writeFile(join(root, 'AGENTS.md'), '[Readme](README.md)');
  await writeFile(join(root, 'docs/implementation-guide.md'), header() + '# Guide\n\n[Readme](../README.md:1)\n[Progress][progress]\n\n[progress]: implementation-progress.md\n');
  await writeFile(join(root, 'docs/implementation-progress.md'), header('status') + '# Progress\n\n[Guide](implementation-guide.md)\n');
  return { root, archiveRoot, check: (archive = false) => checkDocumentation({ root, archive, archiveRoot }), close: () => rm(parent, { recursive: true, force: true }) };
}
async function archiveFixture(f: Awaited<ReturnType<typeof fixture>>) {
  await mkdir(join(f.archiveRoot, 'releases'), { recursive: true });
  const data = '{"passed":true,"source":"docs/old-name.md"}\n';
  const overview = header('guide') + '# Archive\n\n[Code](../Multi-Agent/README.md) · [Result](releases/result.json) · [Old map](relocations.json) · [Migration](migration-manifest.json)\n';
  await writeFile(join(f.archiveRoot, 'README.md'), overview);
  await writeFile(join(f.archiveRoot, 'releases/result.json'), data);
  await writeFile(join(f.archiveRoot, 'relocations.json'), JSON.stringify({ version: 1, date: '2026-11-04', files: [{ from: 'docs/old-name.json', to: 'docs/releases/result.json', kind: 'evidence', sha256Before: sha(data) }] }));
  await writeFile(join(f.archiveRoot, 'migration-manifest.json'), JSON.stringify({ version: 1, date: '2026-11-04', files: [
    { from: 'docs/README.md', to: 'README.md', kind: 'document', sha256Before: sha(overview) },
    { from: 'docs/releases/result.json', to: 'releases/result.json', kind: 'evidence', sha256Before: sha(data) },
  ] }));
  return data;
}

test('documentation: confirmed repository guide/progress work without an archive and ignore local research material', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'prototypes'));
    await writeFile(join(f.root, 'prototypes/README.md'), '[Optional research](../../Multi-Agent-Docs/not-available.md)');
    const result = f.check();
    assert.deepEqual(result.issues, []);
    assert.equal(result.mode, 'repository');
    assert.equal(result.counts.files, 2); assert.equal(result.counts.reachableFiles, 2); assert.equal(result.counts.frozenEvidence, 0);
    const archived = f.check(true); assert.equal(archived.ok, false);
    assert.deepEqual(archived.issues.map(issue => issue.code), ['archive_missing']);
  } finally { await f.close(); }
});

test('documentation: drafts, extra attachments and symlinked archive content cannot enter the official docs directory', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'docs/draft.md'), header('plan') + '# Draft');
    await writeFile(join(f.root, 'docs/.hidden-result.json'), '{}');
    await symlink(join(f.archiveRoot, 'README.md'), join(f.root, 'docs/archive.md'));
    const issues = f.check().issues;
    assert.equal(issues.filter(issue => issue.code === 'unexpected_document').length, 2);
    assert.ok(issues.some(issue => issue.code === 'docs_symlink'));
    await writeFile(join(f.root, 'docs/implementation-guide.md'), header().replace('status: "active"', 'status: "planned"').replace('approval: "confirmed"', 'approval: "draft"') + '# Pending\n');
    assert.ok(f.check().issues.some(issue => issue.code === 'formal_unconfirmed'));
  } finally { await f.close(); }
});

test('documentation: formal metadata and dates are checked, without treating age as staleness', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'docs/implementation-guide.md'), '# Missing fields\n');
    assert.ok(f.check().issues.some(issue => issue.code === 'metadata_missing'));
    await writeFile(join(f.root, 'docs/implementation-guide.md'), header().replace('2026-11-04', '2026-02-30') + '# Invalid date\n');
    assert.ok(f.check().issues.some(issue => issue.code === 'metadata_date'));
    await writeFile(join(f.root, 'docs/implementation-guide.md'), header().replace('2026-11-04', '2020-01-01') + '# Old approved scope\n');
    assert.equal(f.check().ok, true);
  } finally { await f.close(); }
});

test('documentation: local missing links and mandatory external files fail while URLs and fenced examples are not fetched', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'docs/implementation-guide.md'), header() + '# Guide\n\n![lost](missing.png)\n<img src="lost.svg">\n[Required archive](../../Multi-Agent-Docs/README.md)\n[Site](https://example.invalid/unavailable)\n```md\n[Example](not-a-file.md)\n```\n');
    const issues = f.check().issues;
    assert.equal(issues.filter(issue => issue.code === 'broken_link').length, 2);
    assert.equal(issues.filter(issue => issue.code === 'repository_boundary').length, 1);
    assert.ok(issues.filter(issue => issue.code === 'broken_link').every(issue => issue.line > 0));
  } finally { await f.close(); }
});

test('documentation: optional archive validates both migration maps without rewriting old paths or double counting evidence', async () => {
  const f = await fixture();
  try {
    const data = await archiveFixture(f);
    assert.equal(f.check().ok, true);
    const result = f.check(true);
    assert.deepEqual(result.issues, []);
    assert.equal(result.mode, 'archive'); assert.equal(result.counts.files, 4);
    assert.equal(result.counts.reachableFiles, 4); assert.equal(result.counts.frozenEvidence, 1);
    assert.equal(await readFile(join(f.archiveRoot, 'releases/result.json'), 'utf8'), data);
    await writeFile(join(f.archiveRoot, 'releases/unindexed.json'), '{}');
    assert.ok(f.check(true).issues.some(issue => issue.code === 'unreachable'));
  } finally { await f.close(); }
});

test('documentation: archive rejects changed or missing frozen evidence, absent maps and scripts pointing at migrated paths', async () => {
  const f = await fixture();
  try {
    await archiveFixture(f);
    await writeFile(join(f.archiveRoot, 'releases/result.json'), '{"passed":false}\n');
    await mkdir(join(f.root, 'scripts'));
    await writeFile(join(f.root, 'scripts/generate.mjs'), "const output = 'docs/releases/result.json';\n");
    let codes = f.check(true).issues.map(issue => issue.code);
    assert.ok(codes.includes('evidence_changed')); assert.ok(codes.includes('stale_script_path'));
    await rm(join(f.archiveRoot, 'releases/result.json'));
    codes = f.check(true).issues.map(issue => issue.code);
    assert.ok(codes.includes('relocation_missing')); assert.ok(codes.includes('broken_link'));
    await rm(join(f.archiveRoot, 'migration-manifest.json'));
    assert.ok(f.check(true).issues.some(issue => issue.code === 'manifest_missing'));
    assert.equal(f.check().ok, true, 'External archive failure must not break the portable repository check.');
  } finally { await f.close(); }
});

test('documentation: archive migration targets cannot escape its root and plans must remain reachable from repository README', async () => {
  const f = await fixture();
  try {
    await archiveFixture(f);
    const path = join(f.archiveRoot, 'migration-manifest.json');
    const manifest = JSON.parse(await readFile(path, 'utf8')); manifest.files[0].to = '../Multi-Agent/README.md';
    await writeFile(path, JSON.stringify(manifest));
    assert.ok(f.check(true).issues.some(issue => issue.code === 'manifest_invalid'));
    await writeFile(join(f.root, 'README.md'), '# Project with missing documentation entry');
    assert.equal(f.check().issues.filter(issue => issue.code === 'unreachable').length, 2);
  } finally { await f.close(); }
});
