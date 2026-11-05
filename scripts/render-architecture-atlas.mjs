/** Render local documentation-archive architecture diagrams with Mermaid + Chrome.
 * Only tooling dependencies are reused. No upstream business source is bundled.
 * Usage: node scripts/render-architecture-atlas.mjs [puppeteer-core ESM] [mermaid.min.js]
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { docsArchiveRoot } from './docs-paths.mjs';

const documentPath = join(docsArchiveRoot, 'design/continuous-collaboration-architecture.md');
const output = join(docsArchiveRoot, 'design/architecture');
const puppeteerPath = resolve(process.argv[2] || '/Users/ruhonglin/lhz/clowder-ai-latest/packages/api/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js');
const mermaidPath = resolve(process.argv[3] || '/Users/ruhonglin/lhz/clowder-ai-latest/node_modules/.pnpm/mermaid@11.15.0/node_modules/mermaid/dist/mermaid.min.js');
const browserPath = process.env.ARCHITECTURE_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const source = await readFile(documentPath, 'utf8');
const sourceHash = createHash('sha256').update(source).digest('hex');
await Promise.all([access(puppeteerPath), access(mermaidPath), access(browserPath)]);
await mkdir(output, { recursive: true });
const diagrams = [];
let heading = null;
let code = null;
for (const line of source.split(/\r?\n/)) {
  const title = /^###\s+图\s*(\d+)\s*[·・:：.\-]\s*(.+)$/.exec(line);
  if (title) heading = { id: title[1].padStart(2, '0'), title: title[2].trim() };
  if (line.trim() === '```mermaid') {
    assert.ok(heading, 'Each Mermaid block needs a preceding ### 图 N · 标题 heading');
    assert.equal(code, null, 'Mermaid fences cannot nest');
    code = [];
  } else if (line.trim() === '```' && code) {
    diagrams.push({ ...heading, code: code.join('\n').trim() });
    code = null;
    heading = null;
  } else if (code) code.push(line);
}
assert.equal(code, null, 'Unclosed Mermaid fence');
assert.ok(diagrams.length, 'No architecture Mermaid diagrams found');
assert.equal(new Set(diagrams.map(diagram => diagram.id)).size, diagrams.length, 'Duplicate diagram numbers');
let mermaidVersion = 'unknown';
try { mermaidVersion = JSON.parse(await readFile(join(dirname(mermaidPath), '../package.json'), 'utf8')).version; } catch {}
const { default: puppeteer } = await import(pathToFileURL(puppeteerPath).href);
const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: true,
  args: ['--no-first-run', '--disable-background-networking'],
});
const errors = [];
const checks = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(String(error.message)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setContent('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff;}#mount{display:inline-block;padding:16px;background:#fff}svg{display:block;max-width:none!important}</style><div id="mount"></div>');
  await page.addScriptTag({ path: mermaidPath });
  await page.evaluate(() => {
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      theme: 'base',
      fontFamily: '"PingFang SC", "Microsoft YaHei", Arial, sans-serif',
      themeVariables: {
        fontFamily: '"PingFang SC", "Microsoft YaHei", Arial, sans-serif',
        fontSize: '16px',
        primaryColor: '#e8f3ed', primaryTextColor: '#1d3b32', primaryBorderColor: '#75a18b',
        secondaryColor: '#eaf0f8', secondaryTextColor: '#29415e', secondaryBorderColor: '#8da4bf',
        tertiaryColor: '#fff7e4', tertiaryBorderColor: '#baa365',
        lineColor: '#667c72', textColor: '#243e34', mainBkg: '#ffffff',
        clusterBkg: '#f7faf7', clusterBorder: '#b7c9bd',
        actorBkg: '#eaf2ec', actorBorder: '#7d9f8a', actorTextColor: '#243e34',
        signalColor: '#516a5e', signalTextColor: '#243e34',
        noteBkgColor: '#fff7e4', noteBorderColor: '#d7c58c', noteTextColor: '#6b5c32',
      },
      flowchart: { htmlLabels: false, curve: 'basis', useMaxWidth: false, padding: 18, wrappingWidth: 300, nodeSpacing: 45, rankSpacing: 65 },
      sequence: { useMaxWidth: false, showSequenceNumbers: true, actorMargin: 32, messageMargin: 35, wrap: true },
      er: { useMaxWidth: false, fontSize: 16, entityPadding: 18, nodeSpacing: 100, rankSpacing: 100 },
    });
  });
  for (const diagram of diagrams) {
    const rendered = await page.evaluate(async ({ id, code, title }) => {
      document.querySelector('#mount').replaceChildren();
      await window.mermaid.parse(code);
      const { svg } = await window.mermaid.render('architecture-' + id, code);
      const mount = document.querySelector('#mount');
      mount.innerHTML = svg;
      const node = mount.querySelector('svg');
      await document.fonts.ready;
      if (!node || node.querySelector('foreignObject')) throw new Error('Missing SVG or unsupported foreignObject in ' + id);
      // Mermaid's ER layout may place a long relation label beneath an entity.
      // Move only such labels to another clear point on their own unchanged path.
      // This affects presentation; entities, edges and cardinalities remain intact.
      let relocatedLabels = 0;
      if (/^erDiagram\b/.test(code)) {
        const entities = [...node.querySelectorAll('.node')];
        const labels = [...node.querySelectorAll('.edgeLabel')];
        const overlap = (a, b) => a.left < b.right + 5 && a.right > b.left - 5 && a.top < b.bottom + 5 && a.bottom > b.top - 5;
        const obstructed = label => {
          const bounds = label.getBoundingClientRect();
          return entities.some(entity => overlap(bounds, entity.getBoundingClientRect())) || labels.some(other => other !== label && overlap(bounds, other.getBoundingClientRect()));
        };
        for (const label of labels) {
          if (!obstructed(label)) continue;
          const edgeId = label.querySelector('[data-id]')?.getAttribute('data-id');
          const path = [...node.querySelectorAll('path[data-edge]')].find(edge => edge.getAttribute('data-id') === edgeId);
          if (!path) throw new Error('Cannot resolve ER label path in ' + id);
          const original = label.getAttribute('transform');
          const length = path.getTotalLength();
          let placed = false;
          for (const fraction of [.35, .65, .25, .75, .15, .85, .45, .55, .05, .95]) {
            const point = path.getPointAtLength(length * fraction);
            const position = new DOMPoint(point.x, point.y).matrixTransform(path.getCTM()).matrixTransform(label.parentNode.getCTM().inverse());
            label.setAttribute('transform', `translate(${position.x}, ${position.y})`);
            if (!obstructed(label)) { placed = true; relocatedLabels++; break; }
          }
          if (!placed) {
            label.setAttribute('transform', original);
            throw new Error('ER relation label still overlaps an entity or label: ' + label.textContent);
          }
        }
      }
      const box = node.viewBox.baseVal;
      if (!box.width || !box.height) throw new Error('Missing diagram dimensions in ' + id);
      const bounds=node.getBBox();
      const left=Math.min(box.x,bounds.x),top=Math.min(box.y,bounds.y);
      const width=Math.ceil(Math.max(box.x+box.width,bounds.x+bounds.width)-left);
      const height=Math.ceil(Math.max(box.y+box.height,bounds.y+bounds.height)-top);
      node.setAttribute('viewBox', [left,top,width,height].join(' '));
      node.setAttribute('width', String(width)); node.setAttribute('height', String(height));
      node.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      node.removeAttribute('style');
      node.style.background = '#ffffff';
      node.style.maxWidth = 'none';
      node.setAttribute('role', 'img');
      const description = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      description.textContent = '图 ' + Number(id) + ' · ' + title;
      description.id = 'diagram-title-' + id;
      node.prepend(description); node.setAttribute('aria-labelledby', description.id);
      return { svg: new XMLSerializer().serializeToString(node), width, height, textCount: node.querySelectorAll('text').length, relocatedLabels };
    }, diagram);
    check(`${diagram.id}: SVG has positive dimensions and text`, rendered.width > 0 && rendered.height > 0 && rendered.textCount > 0);
    Object.assign(diagram, rendered);
    await writeFile(join(output, diagram.id + '.mmd'), diagram.code + '\n');
    await writeFile(join(output, diagram.id + '.svg'), diagram.svg + '\n');
    const svgElement = await page.$('#mount svg');
    await svgElement.screenshot({ path: join(output, diagram.id + '.png'), captureBeyondViewport: true });
    const png = await readFile(join(output, diagram.id + '.png'));
    check(`${diagram.id}: PNG contains full SVG canvas`, png.readUInt32BE(16) === diagram.width && png.readUInt32BE(20) === diagram.height);
    console.log(`Rendered ${diagram.id}: ${diagram.width} × ${diagram.height} · ${diagram.title}`);
  }
  const html = buildAtlas(diagrams, sourceHash, escape);
  await writeFile(join(output, 'index.html'), html);
  await page.goto(pathToFileURL(join(output, 'index.html')).href);
  await page.waitForFunction(() => Boolean(document.querySelector('.diagram:not([hidden]) svg')));
  check('All diagrams embedded in offline atlas', await page.$$eval('.diagram', nodes => nodes.length) === diagrams.length);
  for (const diagram of diagrams) {
    await page.select('#diagram-select', diagram.id);
    check(`${diagram.id}: selectable by title`, await page.$eval('.diagram:not([hidden])', node => node.dataset.id) === diagram.id);
  }
  await page.select('#diagram-select', diagrams[0].id);
  await page.click('#actual');
  const beforeZoom = await page.$eval('.diagram:not([hidden]) svg', node => node.getBoundingClientRect().width);
  await page.click('#zoom-in');
  const afterZoom = await page.$eval('.diagram:not([hidden]) svg', node => node.getBoundingClientRect().width);
  check('Zoom controls change SVG displayed width', afterZoom > beforeZoom);
  await page.click('#zoom-out');
  check('Zoom-out reduces SVG displayed width', await page.$eval('.diagram:not([hidden]) svg', node => node.getBoundingClientRect().width) < afterZoom);
  await page.click('#fit');
  await page.click('#source-toggle');
  check('Source viewer shows current Mermaid', await page.$eval('#source-code', node => node.textContent.includes('flowchart') || node.textContent.includes('sequenceDiagram') || node.textContent.includes('erDiagram')));
  check('SVG download contains current diagram', await page.$eval('#download-svg', node => node.download.endsWith('.svg') && node.href.startsWith('blob:')));
  check('Download blob contains a complete standalone SVG', await page.$eval('#download-svg', async node => {
    const svg = new DOMParser().parseFromString(await (await fetch(node.href)).text(), 'image/svg+xml');
    return svg.documentElement.tagName === 'svg' && !svg.querySelector('parsererror') && svg.querySelectorAll('text').length > 0;
  }));
  await page.click('#source-toggle');
  await page.screenshot({ path: join(output, 'atlas-desktop.png'), fullPage: true });
  await page.setViewport({ width: 390, height: 844 });
  await page.click('#actual');
  check('390px 100% diagram overflows only inside its viewport', await page.evaluate(() => {
    const viewport = document.querySelector('.diagram:not([hidden]) .viewport');
    return viewport.scrollWidth > viewport.clientWidth && document.documentElement.scrollWidth <= innerWidth + 1;
  }));
  await page.click('#fit');
  check('390px viewport has no document-wide horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(output, 'atlas-mobile.png'), fullPage: true });
  await page.emulateMediaType('print');
  check('Print stylesheet exposes every diagram', await page.$$eval('.diagram', nodes => nodes.every(node => getComputedStyle(node).display !== 'none')));
  await page.emulateMediaType('screen');
  await page.evaluate(() => { window.print = () => { window.printRequested = true; }; });
  await page.click('#print');
  check('Print button requests browser printing', await page.evaluate(() => window.printRequested === true));
  check('No browser console or JavaScript errors', errors.length === 0);
  check('Manifest source hash still matches input document', createHash('sha256').update(await readFile(documentPath)).digest('hex') === sourceHash);
  const manifest = {
    kind: 'architecture-diagram-render-validation', date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()),
    documentBase: 'archive_root', document: 'design/continuous-collaboration-architecture.md', documentSha256: sourceHash,
    renderer: { mermaidVersion, librarySource: 'Local installed open-source Mermaid tooling; no upstream application code copied', htmlLabels: false },
    boundary: 'Rendering and atlas interaction checks only; diagram semantics are reviewed separately. No production runtime or model validation.',
    diagramCount: diagrams.length,
    diagrams: diagrams.map(({ id, title, width, height, textCount, relocatedLabels }) => ({ id, title, width, height, textCount, relocatedLabels, source: id + '.mmd', svg: id + '.svg', png: id + '.png' })),
    checks, errors,
  };
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`PASS: ${diagrams.length} diagrams, ${checks.length} render/UI checks. ${output}`);
} finally { await browser.close(); }

function buildAtlas(diagrams, hash, esc) {
  const data = JSON.stringify(diagrams.map(({ id, title, code, svg, width, height }) => ({ id, title, code, svg, width, height }))).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>持续协作平台 · 架构图谱与 Clowder 对照</title>
<style>
:root{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#233e33;background:#f2f5f1;font-size:14px}*{box-sizing:border-box}body{margin:0}button,select,a{font:inherit}button,select,.download{border:1px solid #ccdad0;border-radius:8px;padding:9px 12px;background:white;color:#2e5343;cursor:pointer}button:hover,.download:hover{background:#edf5ec}button:focus-visible,a:focus-visible,select:focus-visible{outline:2px solid #2e7b58;outline-offset:3px}.page{max-width:1680px;padding:32px;margin:auto}.eyebrow{color:#6b8d78;letter-spacing:2px;font-size:11px}h1{font-weight:600;font-size:28px;letter-spacing:-.5px;margin:11px 0}header p{color:#718276;line-height:1.8;max-width:1000px}.notice{padding:14px 17px;border:1px solid #dedbbd;background:#fbfaef;border-radius:10px;color:#78724c;font-size:12px;line-height:1.8;margin:21px 0}.toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:18px 0}.toolbar select{min-width:260px;max-width:650px;flex:1}.toolbar button{white-space:nowrap}.download{text-decoration:none;display:inline-block}#scale{color:#879489;font-size:11px;min-width:55px;text-align:center}.diagram{margin:0;background:white;border:1px solid #d7e2d8;border-radius:12px;overflow:hidden}.figure-heading{display:flex;gap:16px;align-items:center;padding:18px 22px;border-bottom:1px solid #e4ebe3}.figure-heading span{font-size:12px;color:#789381;white-space:nowrap}.figure-heading h2{font-size:17px;font-weight:600;margin:0;line-height:1.5}.viewport{overflow:auto;max-width:100%;height:min(74vh,1000px);min-height:340px;padding:22px;background:white}.viewport svg{display:block;flex-shrink:0;max-width:none!important;transform-origin:0 0;margin:0 auto}.figure-foot{border-top:1px solid #e4ebe3;padding:12px 22px;color:#89968b;font-size:11px;line-height:1.7}.source-panel{background:#f7faf5;border:1px solid #d7e2d8;border-radius:10px;padding:18px;margin-top:16px}.source-panel h3{font-size:14px;margin-top:0}pre{margin:0;overflow:auto;font-size:12px;line-height:1.7;max-height:420px;white-space:pre}footer{font-size:11px;color:#8a988e;line-height:1.9;margin-top:22px;overflow-wrap:anywhere}footer a{color:#587d64}.print-note{display:none}[hidden]{display:none!important}
@media(max-width:700px){.page{padding:18px 12px}h1{font-size:23px}.toolbar select{flex-basis:100%;width:100%;min-width:0}.toolbar button,.download{padding:8px 9px;font-size:12px}.figure-heading{padding:14px;gap:9px}.figure-heading h2{font-size:14px}.viewport{padding:8px;height:60vh;min-height:300px}.figure-foot{padding:11px 14px}header p{font-size:12px}.notice{font-size:11px}}
@media print{@page{size:A3 landscape;margin:12mm}body{background:white}.page{padding:0;max-width:none}.toolbar,.notice,header p,.source-panel,footer{display:none!important}header{break-after:avoid}h1{font-size:20px}.diagram,.diagram[hidden]{display:block!important;border:0;border-radius:0;break-before:page;break-inside:avoid;margin:0}.diagram:first-of-type{break-before:auto}.figure-heading{padding:0 0 6mm}.figure-heading h2{font-size:16px}.viewport{height:auto;min-height:0;overflow:visible;padding:0;display:flex;justify-content:center}.viewport svg{width:auto!important;height:auto!important;max-width:100%!important;max-height:225mm!important;margin:0 auto}.figure-foot{border:0;padding:4mm 0;font-size:9px}.print-note{display:block;font-size:10px;color:#666}}
</style></head><body><div class="page"><header><div class="eyebrow">ARCHITECTURE ATLAS · 0.6</div><h1>持续协作平台：架构图谱与 Clowder 对照</h1><p>以当前实施指导为目标架构，以固定提交 c238b40a 为 Clowder 源码基线。选择视图逐层阅读；图中的模块、持久边界、调用方向和状态含义以配套报告为准。</p></header><div class="notice">本平台图表示待实施设计，Clowder 图表示已核实的源码结构。逻辑模块不代表独立微服务，模拟原型不代表这些组件已投入运行。PNG / SVG 可单独保存；打印会输出全部图。</div><div class="toolbar"><label for="diagram-select" class="sr-label">视图</label><select id="diagram-select" aria-label="选择架构视图">${diagrams.map(d => `<option value="${d.id}">图 ${Number(d.id)} · ${esc(d.title)}</option>`).join('')}</select><button id="zoom-out" aria-label="缩小">−</button><span id="scale" aria-live="polite"></span><button id="zoom-in" aria-label="放大">＋</button><button id="fit">适配</button><button id="actual">100%</button><button id="source-toggle" aria-expanded="false">查看源码</button><a id="download-svg" class="download" download>下载 SVG</a><button id="print">打印全部</button></div><div class="figures">${diagrams.map((d, i) => `<section class="diagram" data-id="${d.id}" ${i ? 'hidden' : ''}><div class="figure-heading"><span>FIG ${d.id}</span><h2>${esc(d.title)}</h2></div><div class="viewport" tabindex="0" aria-label="图 ${Number(d.id)} 可滚动架构图">${d.svg}</div><div class="figure-foot">${d.width} × ${d.height} · 放大后可在图内滚动；图源：${d.id}.mmd · 对照说明请阅读实施架构报告。</div></section>`).join('')}</div><section id="source-panel" class="source-panel" hidden><h3>可编辑 Mermaid 源码</h3><pre id="source-code"></pre></section><footer><a href="../continuous-collaboration-architecture.md">架构报告与对照说明</a> · <a href="../continuous-collaboration-implementation-report.md">实施指导 0.6</a> · 2026-11-02<br>源稿 SHA-256：${hash}<br>本页可离线查看，不请求外部资源。渲染工具：Mermaid；应用架构内容为独立分析。</footer></div><script id="diagram-data" type="application/json">${data}</script><script>
'use strict';
const data=JSON.parse(document.getElementById('diagram-data').textContent);let current=data[0],zoom=1,fitMode=true,downloadUrl;
const selected=()=>document.querySelector('.diagram[data-id="'+current.id+'"]');
function applyZoom(){const svg=selected().querySelector('svg');svg.style.width=(current.width*zoom)+'px';svg.style.height=(current.height*zoom)+'px';document.getElementById('scale').textContent=Math.round(zoom*100)+'%';}
function fit(){fitMode=true;const viewport=selected().querySelector('.viewport'),style=getComputedStyle(viewport),w=viewport.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),h=viewport.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);zoom=Math.min(1,w/current.width,h/current.height);applyZoom();viewport.scrollTo(0,0);}
function select(id){current=data.find(d=>d.id===id)||data[0];document.querySelectorAll('.diagram').forEach(n=>n.hidden=n.dataset.id!==current.id);document.getElementById('source-code').textContent=current.code;if(downloadUrl)URL.revokeObjectURL(downloadUrl);downloadUrl=URL.createObjectURL(new Blob([current.svg],{type:'image/svg+xml;charset=utf-8'}));const a=document.getElementById('download-svg');a.href=downloadUrl;a.download=current.id+'-'+current.title+'.svg';fit();}
document.getElementById('diagram-select').addEventListener('change',e=>select(e.target.value));
document.getElementById('zoom-in').addEventListener('click',()=>{fitMode=false;zoom=Math.min(4,zoom*1.25);applyZoom();});
document.getElementById('zoom-out').addEventListener('click',()=>{fitMode=false;zoom=Math.max(.08,zoom/1.25);applyZoom();});
document.getElementById('actual').addEventListener('click',()=>{fitMode=false;zoom=1;applyZoom();});
document.getElementById('fit').addEventListener('click',fit);
document.getElementById('source-toggle').addEventListener('click',()=>{const p=document.getElementById('source-panel');p.hidden=!p.hidden;document.getElementById('source-toggle').setAttribute('aria-expanded',String(!p.hidden));});
document.getElementById('print').addEventListener('click',()=>window.print());
window.addEventListener('resize',()=>{if(fitMode)fit();});select(current.id);
</script></body></html>`;
}
