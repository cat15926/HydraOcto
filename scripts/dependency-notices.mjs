import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { docsArchiveRoot } from './docs-paths.mjs';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
const rows = [];
for (const [section, kind] of [['dependencies', '运行'], ['devDependencies', '开发和构建']]) {
  for (const name of Object.keys(pkg[section] ?? {}).sort()) {
    const installed = JSON.parse(readFileSync(resolve(root, 'node_modules', name, 'package.json'), 'utf8'));
    rows.push(`| ${name} | ${installed.version} | ${installed.license ?? '见包内许可'} | ${kind} |`);
  }
}
const transitive = Object.entries(lock.packages).filter(([path]) => path).map(([path, p]) => ({ path, version: p.version, license: p.license ?? null, development: !!p.dev, optional: !!p.optional, source: p.resolved })).sort((a, b) => a.path.localeCompare(b.path));
mkdirSync(resolve(docsArchiveRoot, 'licenses'), { recursive: true });
writeFileSync(resolve(docsArchiveRoot, 'licenses/dependency-inventory.json'), JSON.stringify({ lockfileVersion: lock.lockfileVersion, packages: transitive }, null, 2) + '\n');
for (const name of ['react', 'react-dom', 'scheduler']) {
  writeFileSync(resolve(docsArchiveRoot, 'licenses', `${name}.txt`), readFileSync(resolve(root, 'node_modules', name, 'LICENSE')));
}
writeFileSync(resolve(docsArchiveRoot, 'licenses/README.md'), `---
type: "guide"
status: "active"
scope: "本项目锁定的第三方依赖与许可"
updated: "${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())}"
---

# 基础依赖与许可记录

本项目的应用实现依据自己的规格编写。开发未导入 Clowder 的源码、数据库、测试、Prompt 或素材；研究笔记引用其行为和定位信息。以下是本项目单独安装的通用基础依赖，版本由 package-lock.json 固定。

## 直接依赖

| 包 | 版本 | 包声明的许可 | 用途 |
| --- | --- | --- | --- |
${rows.join('\n')}

许可字段读取自已安装包的 package.json；完整条款以依赖包所附文本为准。运行时代码相关许可保存在 [React](react.txt)、[React DOM](react-dom.txt) 和 [Scheduler](scheduler.txt)。构建工具的许可文本保留在各自安装包中。

## 传递依赖

[锁定依赖清单](dependency-inventory.json) 包含锁文件中各包的版本、来源、许可字段、开发依赖和可选依赖标记，包括其他平台的可选包。清单描述依赖来源，不表示每个包都会打包进浏览器。

在代码仓更新依赖后运行 \`node scripts/dependency-notices.mjs\` 重新生成本地资料库记录。默认资料库位于代码仓同级的 \`Multi-Agent-Docs/\`；\`MULTI_AGENT_DOCS_DIR\` 可指定其他本地目录。Node.js 是独立安装的运行环境，其许可见 [Node.js LICENSE](https://github.com/nodejs/node/blob/v24.18.0/LICENSE)。本仓库未替用户选择自有代码的对外发布许可证。
`);
