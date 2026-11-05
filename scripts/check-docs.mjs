#!/usr/bin/env node
/** Local documentation checks only: no network requests, model calls or generated-file writes. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const slash = value => value.split(sep).join('/');
const inside = (root, path) => path === root || path.startsWith(root + sep);
const documentationExtensions = new Set(['.md', '.html', '.svg']);
const types = new Set(['guide', 'status', 'design', 'plan', 'release', 'research', 'archive']);
const statuses = new Set(['active', 'planned', 'frozen', 'superseded']);

function filesUnder(directory, includeHidden = false) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if ((!includeHidden && entry.name.startsWith('.')) || entry.isSymbolicLink()) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path, includeHidden) : entry.isFile() ? [path] : [];
  });
}

/** Preserve newlines so diagnostics continue to point at the source line. */
function withoutCode(text, markdown) {
  const blank = value => value.replace(/[^\n]/g, ' ');
  let result = text.replace(/<!--[^]*?-->/g, blank);
  if (markdown) {
    result = result.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[^]*?^ {0,3}\1[^\n]*(?:\n|$)/gm, blank);
    result = result.replace(/(`+)([^\n]*?)\1/g, blank);
  }
  return result.replace(/<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi, blank);
}

export function extractLinks(text, markdown = true) {
  const clean = withoutCode(text, markdown), links = [];
  const add = (target, index) => links.push({ target: target.replace(/^<|>$/g, ''), line: clean.slice(0, index).split('\n').length });
  if (markdown) {
    // Angle destinations support spaces; ordinary destinations support escaped parentheses.
    const inline = /!?\[(?:\\.|[^\]\\])*\]\(\s*(<[^>\n]+>|(?:\\.|[^\s)])+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\n]*?\)))?\s*\)/g;
    for (const match of clean.matchAll(inline)) add(match[1], match.index);
    // Check link definitions even when only a shortcut/reference is used in the body.
    for (const match of clean.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|\S+)/gm)) add(match[1], match.index);
  }
  for (const match of clean.matchAll(/\b(?:href|src|xlink:href)\s*=\s*(["'])(.*?)\1/gi)) add(match[2], match.index);
  return links;
}

function localDestination(value, source) {
  let target = value.trim().replace(/&amp;/g, '&').replace(/\\([ ()])/g, '$1');
  if (!target || target.startsWith('#') || target.startsWith('//') || /\$\{|\{\{/.test(target)) return undefined;
  // A Codex file link may end in :line; this is a locator, not a URL scheme.
  target = target.replace(/:\d+(?=[?#]|$)/, '');
  if (/^file:/i.test(target)) {
    try { return fileURLToPath(new URL(target)); } catch { return { error: '无效的本地 file URL' }; }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(target)) return undefined;
  target = target.split(/[?#]/, 1)[0];
  if (!target) return undefined;
  try { target = decodeURIComponent(target); } catch { return { error: '链接中的百分号编码无效' }; }
  return isAbsolute(target) ? resolve(target) : resolve(dirname(source), target);
}

function metadata(text) {
  const header = /^---\r?\n([^]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!header) return undefined;
  const result = {};
  for (const line of header[1].split(/\r?\n/)) {
    const match = /^([a-z]+):\s*(.*?)\s*$/.exec(line);
    if (match) result[match[1]] = match[2].replace(/^(["'])([^]*)\1$/, '$2');
  }
  return result;
}

const formalDocuments = new Map([
  ['implementation-guide.md', 'plan'],
  ['implementation-progress.md', 'status'],
]);

/** Repository mode is portable: an optional local research archive is never required by CI. */
export function checkDocumentation({ root = resolve(import.meta.dirname, '..'), archive = false, archiveRoot, checkScripts = true } = {}) {
  root = resolve(root);
  const docsRoot = archive
    ? resolve(archiveRoot || process.env.MULTI_AGENT_DOCS_DIR || join(dirname(root), 'Multi-Agent-Docs'))
    : join(root, 'docs');
  const docsFiles = filesUnder(docsRoot, !archive);
  const issues = [], graph = new Map(), checkedEvidence = new Map();
  let localLinks = 0;
  const report = (code, file, message, extra = {}) => issues.push({ code, file: slash(relative(root, file)), message, ...extra });
  const counts = visited => ({ documents: docsFiles.filter(path => extname(path) === '.md').length, files: docsFiles.length, localLinks, reachableFiles: docsFiles.filter(path => visited.has(path)).length, frozenEvidence: checkedEvidence.size });
  if (archive && (!existsSync(docsRoot) || !statSync(docsRoot).isDirectory())) {
    report('archive_missing', docsRoot, '本地资料库不存在。默认 docs:check 不需要该目录；检查资料库时请设置 MULTI_AGENT_DOCS_DIR 或提供同级 Multi-Agent-Docs。');
    return { ok: false, mode: 'archive', counts: counts(new Set()), issues };
  }
  const documentFiles = new Set((archive ? [
    ...docsFiles,
    ...filesUnder(join(root, 'prototypes')),
    ...filesUnder(join(root, 'scripts', 'research')),
  ] : [
    ...['README.md', 'AGENTS.md'].map(name => join(root, name)).filter(existsSync),
    ...docsFiles,
  ]).filter(path => documentationExtensions.has(extname(path))));

  if (!archive) {
    for (const [name] of formalDocuments) if (!existsSync(join(docsRoot, name))) report('formal_document_missing', join(docsRoot, name), '缺少正式实施指导或实施进度文档。');
    for (const file of docsFiles) if (!formalDocuments.has(slash(relative(docsRoot, file)))) report('unexpected_document', file, '代码仓 docs/ 只保留 implementation-guide.md 和 implementation-progress.md；研究、草案、图表及证据放到本地资料库。');
    // A symbolic link would make the apparently self-contained plan depend on a local archive.
    const scanLinks = directory => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) report('docs_symlink', path, '正式文档目录不能通过软链接引入仓外资料。');
        else if (entry.isDirectory()) scanLinks(path);
      }
    };
    scanLinks(docsRoot);
  }
  for (const file of docsFiles.filter(path => extname(path) === '.md')) {
    const fields = metadata(readFileSync(file, 'utf8'));
    if (!fields) { report('metadata_missing', file, '文档需要 YAML 元信息：type、status、scope、updated。'); continue; }
    for (const key of ['type', 'status', 'scope', 'updated']) if (!fields[key]?.trim()) report('metadata_field', file, `缺少有效的 ${key}。`);
    if (fields.type && !types.has(fields.type)) report('metadata_type', file, `未知文档类型：${fields.type}`);
    if (fields.status && !statuses.has(fields.status)) report('metadata_status', file, `未知文档状态：${fields.status}`);
    if (fields.updated && (!/^\d{4}-\d{2}-\d{2}$/.test(fields.updated) || !Number.isFinite(Date.parse(fields.updated)) || new Date(fields.updated).toISOString().slice(0, 10) !== fields.updated)) report('metadata_date', file, 'updated 必须为有效 YYYY-MM-DD 日期。');
    if (!archive && formalDocuments.has(slash(relative(docsRoot, file)))) {
      if (fields.type !== formalDocuments.get(slash(relative(docsRoot, file)))) report('formal_type', file, '实施指导使用 type=plan，实施进度使用 type=status。');
      if (fields.status !== 'active' || fields.approval !== 'confirmed') report('formal_unconfirmed', file, '代码仓正式文档需要 status=active、approval=confirmed；尚未确认的方案在本地资料库维护。');
    }
  }

  for (const file of documentFiles) {
    const edges = new Set(); graph.set(file, edges);
    for (const link of extractLinks(readFileSync(file, 'utf8'), extname(file) === '.md')) {
      const destination = localDestination(link.target, file);
      if (!destination) continue;
      if (typeof destination !== 'string') { report('link_encoding', file, destination.error, link); continue; }
      localLinks++;
      if (!archive && !inside(root, destination)) { report('repository_boundary', file, '代码仓正式文档不能依赖仓外本地链接；可用普通文本说明可选资料库位置。', link); continue; }
      if (!existsSync(destination)) { report('broken_link', file, `本地目标不存在：${link.target}`, link); continue; }
      if (statSync(destination).isDirectory()) {
        const index = ['README.md', 'index.md', 'index.html'].map(name => join(destination, name)).find(existsSync);
        if (index) edges.add(index);
      } else edges.add(destination);
    }
  }

  const entry = join(archive ? docsRoot : root, 'README.md'), visited = new Set();
  if (!existsSync(entry)) report('entry_missing', entry, archive ? '缺少资料库导航 README.md。' : '缺少项目 README.md。');
  const queue = [entry];
  while (queue.length) {
    const next = queue.pop();
    if (visited.has(next)) continue;
    visited.add(next);
    for (const target of graph.get(next) ?? []) if ((inside(root, target) || archive && inside(docsRoot, target)) && !visited.has(target)) queue.push(target);
  }
  for (const file of docsFiles) if (!visited.has(file)) report('unreachable', file, `无法从${archive ? '资料库' : '项目'} README.md 经实际链接找到此文件。`);

  const relocatedSources = new Set();
  if (archive) {
    for (const [name, oldManifest] of [['relocations.json', true], ['migration-manifest.json', false]]) {
      const manifestFile = join(docsRoot, name);
      if (!existsSync(manifestFile)) { report('manifest_missing', manifestFile, '缺少本地资料库迁移清单。'); continue; }
      try {
        const value = JSON.parse(readFileSync(manifestFile, 'utf8'));
        if (value.version !== 1 || !Array.isArray(value.files)) throw new Error('需要 version=1 与 files 数组');
        const seenFrom = new Set(), seenTo = new Set();
        for (const item of value.files) {
          if (!item || typeof item.from !== 'string' || typeof item.to !== 'string' || !/^docs\//.test(item.from) || (oldManifest && !/^docs\//.test(item.to)) || isAbsolute(item.to) || !/^[a-f\d]{64}$/.test(item.sha256Before) || !['document', 'evidence', 'generated', 'data'].includes(item.kind)) throw new Error('迁移条目需要合法 from/to/sha256Before/kind');
          const before = resolve(docsRoot, item.from.slice(5));
          const after = resolve(docsRoot, oldManifest ? item.to.slice(5) : item.to);
          if (!inside(docsRoot, before) || !inside(docsRoot, after) || seenFrom.has(item.from) || seenTo.has(after)) throw new Error('迁移路径越界或身份重复');
          seenFrom.add(item.from); seenTo.add(after); relocatedSources.add(item.from);
          if (!existsSync(after) || !statSync(after).isFile()) report('relocation_missing', manifestFile, `迁移目标丢失：${item.to}`);
          else if (item.kind === 'evidence') {
            if (checkedEvidence.has(after) && checkedEvidence.get(after) !== item.sha256Before) throw new Error(`两份迁移清单对冻结证据的摘要不一致：${item.to}`);
            checkedEvidence.set(after, item.sha256Before);
            const actual = createHash('sha256').update(readFileSync(after)).digest('hex');
            if (actual !== item.sha256Before) report('evidence_changed', after, '冻结证据与迁移前 SHA-256 不一致；请保留原始事实，另存新验证记录。');
          }
        }
      } catch (error) { report('manifest_invalid', manifestFile, `迁移清单不可读：${error.message}`); }
    }
    if (checkScripts) {
      for (const file of filesUnder(join(root, 'scripts')).filter(path => ['.mjs', '.js', '.ts', '.py', '.sh'].includes(extname(path)))) {
        if (file === fileURLToPath(import.meta.url)) continue;
        const lines = readFileSync(file, 'utf8').split(/\r?\n/);
        for (const source of relocatedSources) {
          const line = lines.findIndex(text => text.includes(source));
          if (line >= 0) report('stale_script_path', file, `脚本仍引用已迁出代码仓的路径 ${source}。`, { line: line + 1 });
        }
      }
    }
  }
  return { ok: issues.length === 0, mode: archive ? 'archive' : 'repository', counts: counts(visited), issues };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = checkDocumentation({ archive: process.argv.includes('--archive') });
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    for (const issue of result.issues) console.error(`${issue.file}${issue.line ? ':' + issue.line : ''} [${issue.code}] ${issue.message}`);
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.mode} docs: ${result.counts.documents} Markdown, ${result.counts.files} files, ${result.counts.localLinks} local links, ${result.counts.reachableFiles} reachable, ${result.counts.frozenEvidence} frozen evidence hashes, ${result.issues.length} issues.`);
  }
  if (!result.ok) process.exitCode = 1;
}
