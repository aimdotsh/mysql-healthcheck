# 离线 / 无 LLM / 无 node 巡检报告生成器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 skill 分支新增一个纯 Node 内置模块的渲染器 + CLI + pkg 二进制，让无外网、无 node 的 RHEL 7.9 客户能本机离线生成 md+html 巡检报告，全程不依赖 LLM、不动任何规则逻辑。

**Architecture:** 复用现有零依赖分析管线（`preprocess.js` + 规则引擎 → facts 对象）。新增 `render-offline.js`（block 模型 + `toMarkdown`/`toHtml` 双序列化器）、`charts.js`（从 SaaS 移植，删除 resvg，只留纯 SVG 构造器）、`report.js`（CLI 入口 = preprocess→render）。用 `pkg --target node16-linux-x64` 把整套 JS 打成单文件二进制（自带 Node 16 运行时，兼容 glibc 2.17）。

**Tech Stack:** Node.js（仅内置 `fs`/`path`）、`pkg`（仅构建端 devDependency）、GitHub Actions、纯 Node `assert` 测试。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `tools/preprocess.js` | txt→facts；导出 `buildFacts(dir,opts)`，CLI 行为不变 | 改 |
| `tools/rule-engine.js` | 规则加载在 pkg 快照下也能工作（已知文件名兜底） | 改 |
| `tools/charts.js` | 纯 SVG 图表构造器（gauge/pie/hbar/vbar/radar/topology） | 新增（移植删 resvg） |
| `tools/render-offline.js` | facts→{markdown,html}：block 模型 + 双序列化 + 17 章构造器 | 新增 |
| `tools/report.js` | CLI 入口：preprocess→render→写 md+html；二进制入口 | 新增 |
| `package.json` | 仅构建端：bin + pkg 配置 + devDep pkg | 新增 |
| `.github/workflows/release-binary.yml` | tag→pkg→Release | 新增 |
| `.gitignore` | 忽略二进制产物 | 改 |
| `tests/buildfacts_test.js` | 验证 buildFacts 导出 | 新增 |
| `tests/render_offline_test.js` | 验证 block 序列化 + 端到端 | 新增 |
| `SKILL.md` / `README.md` / `CHANGELOG.md` / `VERSION` | 文档 + 版本 1.0.9→1.1.0 | 改 |

**测试约定（零依赖）：** 每个测试文件是独立的 `node tests/xxx.js` 脚本，用内置 `assert`；失败 `throw`，成功打印 `OK`。无需测试框架。

**测试数据 fixture 解析（公开仓库，不提交客户数据）：** 脱敏集 **不入仓**。所有需要数据的测试通过共享辅助 `tests/fixture.js` 解析 fixture 目录，顺序为：`process.env.HC_TEST_DATA` → 已知本地路径 `/Users/liups/ai/skill/test/v3/desensitized` → 都不存在则打印 `SKIP ...` 并 `process.exit(0)`（CI/他人机器优雅跳过，不报错）。基线（本地有 fixture 时）：**49 issues (P0:5 P1:11 P2:28 P3:5)**、healthScore.total=88、4 节点。

`tests/fixture.js`（Task 1 创建）：
```js
'use strict';
const fs = require('fs');
function fixtureDir() {
  const candidates = [process.env.HC_TEST_DATA, '/Users/liups/ai/skill/test/v3/desensitized'].filter(Boolean);
  for (const c of candidates) { try { if (fs.statSync(c).isDirectory()) return c; } catch (_) {} }
  return null;
}
function requireFixtureOrSkip(testName) {
  const dir = fixtureDir();
  if (!dir) { console.log(`SKIP ${testName}: no fixture (set HC_TEST_DATA to a desensitized data dir)`); process.exit(0); }
  return dir;
}
module.exports = { fixtureDir, requireFixtureOrSkip };
```
凡示例里出现 `'/Users/liups/ai/skill/test/v3/desensitized'` 字面量的测试，一律改为 `const DATA = require('./fixture.js').requireFixtureOrSkip('<test 名>');`。

---

## Task 1: 重构 preprocess.js 导出 `buildFacts`（前置）

`report.js` 与二进制必须在进程内调用预处理（二进制里没有 node 可 spawn 子进程）。当前 `preprocess.js` 是纯 CLI：顶层解析 `process.argv`、`main()` 末尾 `writeFileSync` 后无返回值、文件末尾裸调 `main()`。本任务把它改成「可 require 调用 + CLI 仍可用」，**输出字节不变**。

**Files:**
- Modify: `tools/preprocess.js`（顶层 21-42、119-122；`main()` 1609 起；末尾 2921）
- Test: `tests/buildfacts_test.js`

- [ ] **Step 1: 写失败测试**

Create `tests/buildfacts_test.js`:

```js
'use strict';
const assert = require('assert');
const path = require('path');
const { buildFacts } = require('../tools/preprocess.js');

const DATA = '/Users/liups/ai/skill/test/v3/desensitized';
const facts = buildFacts(DATA, {});

assert.strictEqual(facts.nodes.length, 4, 'expected 4 nodes');
assert.strictEqual(facts.issues.length, 49, `expected 49 issues, got ${facts.issues.length}`);
const byP = p => facts.issues.filter(i => i.priority === p).length;
assert.deepStrictEqual([byP('P0'), byP('P1'), byP('P2'), byP('P3')], [5, 11, 28, 5], 'priority distribution drift');
assert.strictEqual(facts.healthScore.total, 88, 'healthScore drift');
console.log('OK buildfacts_test');
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /Users/liups/ai/skill/mysql-healthcheck && node tests/buildfacts_test.js`
Expected: 抛错 —— `buildFacts is not a function`（且 require 时 CLI 顶层代码会因 `process.argv` 无目录而 `process.exit(1)`）。

- [ ] **Step 3: 把顶层 CLI 代码（行 21-42）整段删除**

删除 `tools/preprocess.js` 第 21-42 行（`const args = process.argv.slice(2);` 一直到 `: path.join(dataDir, 'data.json');`）。这些逻辑稍后移进文件末尾的 CLI guard。

- [ ] **Step 4: 把模块级 const（行 119-122）改成 let 声明**

将：
```js
const hcConfig = loadHcConfig(dataDir, opts.config);
const T = hcConfig.thresholds || {};
const DISABLED_RULES = new Set(hcConfig.disabledRules || []);
const PRIORITY_OVERRIDES = hcConfig.priorities || {};
```
改为：
```js
// 由 buildFacts() 在运行时赋值（保持模块级，使既有 ~46 处引用无需改动）
let hcConfig, T, DISABLED_RULES, PRIORITY_OVERRIDES, dataDir;
```

- [ ] **Step 5: 把 `function main()` 改名为 `buildFacts` 并在头部赋值全局、末尾 return**

把 `function main() {`（行 1609）改为：
```js
function buildFacts(inputDir, opts = {}) {
  dataDir = path.resolve(inputDir);
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    throw new Error(`目录不存在或不是目录：${dataDir}`);
  }
  hcConfig = loadHcConfig(dataDir, opts.config);
  T = hcConfig.thresholds || {};
  DISABLED_RULES = new Set(hcConfig.disabledRules || []);
  PRIORITY_OVERRIDES = hcConfig.priorities || {};
  const allFiles = fs.readdirSync(dataDir);
```
（即在原 `const allFiles = fs.readdirSync(dataDir);` 之前插入上面的赋值块。）

把原「无 txt 文件」分支里的 `console.error(...); process.exit(1)`（约行 1629-1632）改为 `throw new Error(...)`，把同样的中文提示作为 Error message（避免 require 调用时整个进程退出）。

把 `main()` 结尾的 `fs.writeFileSync(outPath, ...)` 到函数结束的整段（行 1755-1766）替换为：
```js
  return out;
}
```

- [ ] **Step 6: 把末尾 `main();` 换成 CLI guard + 导出**

把文件最后一行 `main();`（行 2921）替换为：
```js
if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args[0] || args[0].startsWith('--')) {
    console.error('用法: node preprocess.js <数据目录> [--project "项目名"] [--report-version 1.0] [--out data.json] [--config <path>]');
    process.exit(1);
  }
  const cliOpts = { project: null, reportVersion: '1.0', out: null, config: null };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--project') cliOpts.project = args[++i];
    else if (args[i] === '--report-version') cliOpts.reportVersion = args[++i];
    else if (args[i] === '--out') cliOpts.out = args[++i];
    else if (args[i] === '--config') cliOpts.config = args[++i];
  }
  const inDir = path.resolve(args[0]);
  const outPath = cliOpts.out ? path.resolve(cliOpts.out) : path.join(inDir, 'data.json');
  const facts = buildFacts(inDir, cliOpts);
  fs.writeFileSync(outPath, JSON.stringify(facts, null, 2));
  const iss = facts.issues;
  console.error(`\n数据已写入 ${outPath}`);
  console.error(`  - 节点：${facts.nodes.length} 个`);
  console.error(`  - 自动检出问题：${iss.length} 项 (P0:${iss.filter(i=>i.priority==='P0').length}, P1:${iss.filter(i=>i.priority==='P1').length}, P2:${iss.filter(i=>i.priority==='P2').length}, P3:${iss.filter(i=>i.priority==='P3').length})`);
  const srcs = facts.hcConfig && facts.hcConfig.sources;
  if (srcs && srcs.length > 1) {
    console.error(`  - 阈值配置：${srcs.filter(s=>s.source!=='default').map(s=>`${s.source}:${path.basename(s.path)}`).join(', ')} 已合并到默认值之上`);
  }
  if (facts.disabledRulesApplied && facts.disabledRulesApplied.length) {
    console.error(`  - 已禁用规则：${facts.disabledRulesApplied.join(', ')}`);
  }
}

module.exports = { buildFacts, loadHcConfig };
```

- [ ] **Step 7: 运行新测试 + 回归 CLI**

Run: `node tests/buildfacts_test.js`
Expected: `OK buildfacts_test`

Run CLI 回归（确认 CLI 输出不变）: `node tools/preprocess.js /Users/liups/ai/skill/test/v3/desensitized --out /tmp/cli.json && jq '.issues|length' /tmp/cli.json`
Expected: `49`，且 stderr 仍打印「节点：4 个 / 自动检出问题：49 项 ...」。

- [ ] **Step 8: Commit**

```bash
cd /Users/liups/ai/skill/mysql-healthcheck
git add tools/preprocess.js tests/buildfacts_test.js
git commit -m "refactor(preprocess): 导出 buildFacts() 供进程内调用，CLI 行为不变

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: 规则加载在 pkg 快照下可用（已知文件名兜底）

`rule-engine.js` 的 `loadRulesFromDir` 用 `fs.readdirSync(rulesDir)` 枚举规则文件。pkg 打包后快照文件系统对 `readdirSync` 支持不可靠（`readFileSync` 可靠）。加一个「已知 6 个维度文件名」兜底：`readdirSync` 失败或返回空时，回退到固定列表，仍用 `readFileSync` 读内容。CLI/Node 环境行为完全不变。

**Files:**
- Modify: `tools/rule-engine.js:243-277`（`loadRulesFromDir`）
- Test: 复用 `tests/buildfacts_test.js`（已断言 49 issues），新增一个最小直跑断言

- [ ] **Step 1: 改 `loadRulesFromDir`，加兜底文件列表**

把 `tools/rule-engine.js` 中 `loadRulesFromDir` 里这段：
```js
  if (!fs.existsSync(rulesDir)) return rules;
  const files = fs.readdirSync(rulesDir, { withFileTypes: true })
    .filter(d => d.isFile() && d.name.endsWith('.json'))
    .map(d => d.name)
    .sort();
```
替换为：
```js
  // pkg 快照下 readdirSync 可能失败/返空 → 回退到已知维度文件名（readFileSync 在快照下可靠）
  const KNOWN_RULE_FILES = [
    'availability.json', 'dataDesign.json', 'durability.json',
    'operations.json', 'performance.json', 'security.json',
  ];
  let files = [];
  try {
    if (fs.existsSync(rulesDir)) {
      files = fs.readdirSync(rulesDir, { withFileTypes: true })
        .filter(d => d.isFile() && d.name.endsWith('.json'))
        .map(d => d.name)
        .sort();
    }
  } catch (_) { /* 快照下 readdirSync 不可用，走兜底 */ }
  if (files.length === 0) {
    files = KNOWN_RULE_FILES.filter(f => {
      try { fs.accessSync(path.join(rulesDir, f)); return true; } catch (_) { return false; }
    });
  }
```

- [ ] **Step 2: 运行回归测试确认未破坏 Node 路径**

Run: `node tests/buildfacts_test.js`
Expected: `OK buildfacts_test`（仍 49 issues —— 证明兜底逻辑在普通 Node 下不改变结果）

- [ ] **Step 3: Commit**

```bash
git add tools/rule-engine.js
git commit -m "fix(rule-engine): 规则加载在 pkg 快照下用已知文件名兜底

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: 移植 charts.js（删除 resvg）

从 SaaS 分支取 `scripts/lib/charts.js`，删掉只为 docx 栅格化用的 resvg 部分，得到零依赖纯 SVG 构造器。

**Files:**
- Create: `tools/charts.js`
- Test: `tests/charts_test.js`

- [ ] **Step 1: 写失败测试**

Create `tests/charts_test.js`:

```js
'use strict';
const assert = require('assert');
const charts = require('../tools/charts.js');

for (const fn of ['gauge', 'pie', 'hbar', 'vbar', 'radar', 'topology']) {
  assert.strictEqual(typeof charts[fn], 'function', `missing chart builder: ${fn}`);
}
const svg = charts.gauge(88, '健康度');
assert.ok(svg.trim().startsWith('<svg'), 'gauge must return inline <svg> string');
assert.ok(!/resvg|asPng|require\('@resvg/.test(svg), 'no resvg in output');
assert.strictEqual(charts.svgToPng, undefined, 'svgToPng must be removed');
console.log('OK charts_test');
```

- [ ] **Step 2: 运行确认失败**

Run: `node tests/charts_test.js`
Expected: FAIL —— `Cannot find module '../tools/charts.js'`

- [ ] **Step 3: 拷贝源文件**

Run: `git show SaaS:scripts/lib/charts.js > tools/charts.js`

- [ ] **Step 4: 删除 resvg 相关代码**

在 `tools/charts.js` 中：
1. 删除 `loadResvg` 函数（文件顶部，含 `node_modules/@resvg/resvg-js` 与 `'@resvg/resvg-js'` 的 require try 块，约 6-15 行）。
2. 删除 `svgToPng` 函数（约 364-377 行，含 `const resvg = loadResvg();` ... `return r.render().asPng();`）。
3. 在 `module.exports = { ... }` 中删除 `svgToPng,` 一项。
4. 确认文件顶部除 `const path = require('path');` 外无其它 require（`path` 若移除 loadResvg 后已不再使用，则一并删除该 require 行）。

- [ ] **Step 5: 运行测试确认通过**

Run: `node tests/charts_test.js`
Expected: `OK charts_test`

确认零外部依赖：
Run: `grep -nE "require\(" tools/charts.js`
Expected: 无输出，或仅 `require('path')`（若仍被某构造器使用）。

- [ ] **Step 6: Commit**

```bash
git add tools/charts.js tests/charts_test.js
git commit -m "feat(charts): 移植纯 SVG 图表构造器（删除 resvg，零依赖）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: render-offline 核心 —— block 模型 + 双序列化器

只做渲染原语（block → md / html），不含任何章节内容。

**Files:**
- Create: `tools/render-offline.js`
- Test: `tests/render_offline_test.js`

- [ ] **Step 1: 写失败测试**

Create `tests/render_offline_test.js`:

```js
'use strict';
const assert = require('assert');
const { toMarkdown, toHtml, B } = require('../tools/render-offline.js');

const blocks = [
  B.heading(1, '巡检报告'),
  B.paragraph('共 4 个节点。'),
  B.table(['节点', '角色'], [['10.10.10.2', '主库'], ['10.10.10.3', '从库']]),
  B.list(['第一条', '第二条']),
  B.callout('warn', '存在 5 个 P0 问题'),
  B.codeblock('sql', 'SET GLOBAL x = 1;'),
];

const md = toMarkdown(blocks);
assert.ok(md.includes('# 巡检报告'), 'md heading');
assert.ok(md.includes('| 节点 | 角色 |'), 'md table header');
assert.ok(md.includes('- 第一条'), 'md list');
assert.ok(md.includes('```sql'), 'md codeblock');

const html = toHtml(blocks, { title: '巡检报告' });
assert.ok(html.startsWith('<!DOCTYPE html>'), 'html doctype');
assert.ok(/<style>[\s\S]*<\/style>/.test(html), 'inline css');
assert.ok(html.includes('<th>节点</th>'), 'html table');
assert.ok(!/<script src=|https?:\/\//.test(html), 'html must be self-contained (no external refs)');
// XSS/转义：尖括号内容必须被转义
const evil = toHtml([B.paragraph('<img onerror=x>')]);
assert.ok(evil.includes('&lt;img'), 'html must escape user content');
console.log('OK render_offline_test (core)');
```

- [ ] **Step 2: 运行确认失败**

Run: `node tests/render_offline_test.js`
Expected: FAIL —— `Cannot find module '../tools/render-offline.js'`

- [ ] **Step 3: 实现 block 工厂 + 双序列化器**

Create `tools/render-offline.js`:

```js
'use strict';
// 离线渲染器：facts → { markdown, html }。零外部依赖（不 require 任何 npm 包）。
const charts = require('./charts.js');

// ── block 工厂 ───────────────────────────────────────────────
const B = {
  heading: (level, text) => ({ t: 'heading', level, text }),
  paragraph: (text) => ({ t: 'paragraph', text }),
  table: (headers, rows) => ({ t: 'table', headers, rows }),
  list: (items, ordered = false) => ({ t: 'list', items, ordered }),
  callout: (kind, text) => ({ t: 'callout', kind, text }), // kind: info|warn|crit|ok
  codeblock: (lang, code) => ({ t: 'codeblock', lang, code }),
  chart: (svg, caption, tableFallback) => ({ t: 'chart', svg, caption, tableFallback }),
};

// ── 转义 ─────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function mdCell(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, '<br/>'); }

// ── Markdown 序列化 ──────────────────────────────────────────
function toMarkdown(blocks) {
  const out = [];
  for (const b of blocks) {
    switch (b.t) {
      case 'heading': out.push('#'.repeat(b.level) + ' ' + b.text, ''); break;
      case 'paragraph': out.push(b.text, ''); break;
      case 'table': {
        if (!b.rows.length) { out.push('_（无数据）_', ''); break; }
        out.push('| ' + b.headers.map(mdCell).join(' | ') + ' |');
        out.push('| ' + b.headers.map(() => '---').join(' | ') + ' |');
        for (const r of b.rows) out.push('| ' + r.map(mdCell).join(' | ') + ' |');
        out.push('');
        break;
      }
      case 'list':
        b.items.forEach((it, i) => out.push((b.ordered ? `${i + 1}. ` : '- ') + it));
        out.push('');
        break;
      case 'callout': {
        const tag = { info: 'ℹ️', warn: '⚠️', crit: '🔴', ok: '✅' }[b.kind] || 'ℹ️';
        out.push(`> ${tag} ${b.text}`, '');
        break;
      }
      case 'codeblock': out.push('```' + (b.lang || ''), b.code, '```', ''); break;
      case 'chart':
        // markdown 不内联 SVG：用表格兜底 + 标题
        if (b.caption) out.push(`**${b.caption}**`, '');
        if (b.tableFallback) out.push(...toMarkdown([b.tableFallback]).split('\n'));
        break;
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ── HTML 序列化 ──────────────────────────────────────────────
const CSS = `
body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;line-height:1.6;color:#222;max-width:1000px;margin:0 auto;padding:24px}
h1,h2,h3{color:#1a3a5c;border-bottom:1px solid #e0e6ed;padding-bottom:4px}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:14px}
th,td{border:1px solid #d0d7de;padding:6px 10px;text-align:left}
th{background:#f1f5f9}
tr:nth-child(even){background:#fafbfc}
pre{background:#f6f8fa;padding:12px;border-radius:6px;overflow:auto}
code{font-family:"SF Mono",Consolas,monospace}
.callout{padding:10px 14px;border-radius:6px;margin:12px 0}
.callout.info{background:#eef6ff;border-left:4px solid #3b82f6}
.callout.warn{background:#fff7ed;border-left:4px solid #f59e0b}
.callout.crit{background:#fef2f2;border-left:4px solid #ef4444}
.callout.ok{background:#f0fdf4;border-left:4px solid #22c55e}
.chart{margin:16px 0;text-align:center}
.chart figcaption{font-size:13px;color:#555;margin-top:4px}
`;

function htmlBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    switch (b.t) {
      case 'heading': out.push(`<h${b.level}>${esc(b.text)}</h${b.level}>`); break;
      case 'paragraph': out.push(`<p>${esc(b.text)}</p>`); break;
      case 'table': {
        if (!b.rows.length) { out.push('<p><em>（无数据）</em></p>'); break; }
        const head = b.headers.map(h => `<th>${esc(h)}</th>`).join('');
        const body = b.rows.map(r => '<tr>' + r.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>').join('');
        out.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
        break;
      }
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        out.push(`<${tag}>` + b.items.map(i => `<li>${esc(i)}</li>`).join('') + `</${tag}>`);
        break;
      }
      case 'callout': out.push(`<div class="callout ${esc(b.kind)}">${esc(b.text)}</div>`); break;
      case 'codeblock': out.push(`<pre><code>${esc(b.code)}</code></pre>`); break;
      case 'chart':
        // SVG 由我们自己的 charts.js 生成，可信，直接内联
        out.push(`<figure class="chart">${b.svg || ''}${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ''}</figure>`);
        break;
    }
  }
  return out.join('\n');
}

function toHtml(blocks, opts = {}) {
  const title = esc(opts.title || 'MySQL 巡检报告');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${CSS}</style></head>
<body>
${htmlBlocks(blocks)}
</body></html>
`;
}

module.exports = { B, toMarkdown, toHtml };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/render_offline_test.js`
Expected: `OK render_offline_test (core)`

- [ ] **Step 5: Commit**

```bash
git add tools/render-offline.js tests/render_offline_test.js
git commit -m "feat(render): block 模型 + toMarkdown/toHtml 双序列化器（零依赖）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: report.js CLI + 端到端最小报告

先打通 preprocess→render→落盘，报告暂时只含标题 + 执行摘要骨架（章节在 Task 6/7 补全）。

**Files:**
- Create: `tools/report.js`
- Modify: `tools/render-offline.js`（新增 `renderReport(facts)` 占位，返回标题 + 概览）
- Test: `tests/report_e2e_test.js`

- [ ] **Step 1: 写失败测试**

Create `tests/report_e2e_test.js`:

```js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT = '/tmp/report-e2e';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

execFileSync('node', [
  path.join(__dirname, '..', 'tools', 'report.js'),
  '/Users/liups/ai/skill/test/v3/desensitized',
  '--out-dir', OUT,
], { stdio: 'inherit' });

const files = fs.readdirSync(OUT);
const md = files.find(f => f.endsWith('.md'));
const html = files.find(f => f.endsWith('.html'));
assert.ok(md, 'expected a .md output');
assert.ok(html, 'expected a .html output');

const htmlContent = fs.readFileSync(path.join(OUT, html), 'utf8');
assert.ok(htmlContent.startsWith('<!DOCTYPE html>'), 'self-contained html');
assert.ok(!/<script src=|https?:\/\//.test(htmlContent), 'no external refs');
console.log('OK report_e2e_test');
```

- [ ] **Step 2: 运行确认失败**

Run: `node tests/report_e2e_test.js`
Expected: FAIL —— `Cannot find module '.../tools/report.js'`

- [ ] **Step 3: 在 render-offline.js 新增 `renderReport(facts)`（占位骨架）**

在 `tools/render-offline.js` 的 `module.exports` 之前加：
```js
// 顶层：把 facts 渲染成 block 数组（章节构造器在后续任务里逐个补全并 push 进来）
function buildReportBlocks(facts) {
  const blocks = [];
  const title = `${facts.project || 'MySQL'} 巡检报告`;
  blocks.push(B.heading(1, title));
  blocks.push(B.paragraph(`巡检日期：${facts.inspectionDate || facts.reportDate || '-'}　节点数：${facts.nodes.length}　健康度：${facts.healthScore?.total ?? '-'}/100`));
  // TODO(Task 6/7)：在此依次 push 第一~十七章
  return { title, blocks };
}

function renderReport(facts) {
  const { title, blocks } = buildReportBlocks(facts);
  return { title, markdown: toMarkdown(blocks), html: toHtml(blocks, { title }) };
}
```
并把 `module.exports` 改为：
```js
module.exports = { B, toMarkdown, toHtml, buildReportBlocks, renderReport };
```
（注：此处 TODO 是任务交接标记，Task 6/7 会替换为真实章节代码；交付前不得残留。）

- [ ] **Step 4: 实现 report.js**

Create `tools/report.js`:

```js
#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { buildFacts } = require('./preprocess.js');
const { renderReport } = require('./render-offline.js');

function parseArgs(argv) {
  const a = argv.slice(2);
  if (!a[0] || a[0].startsWith('--')) {
    console.error('用法: report <数据目录> [--out-dir <目录>] [--format md|html|both] [--project "名"] [--config <path>] [--emit-facts]');
    process.exit(1);
  }
  const opts = { dataDir: path.resolve(a[0]), outDir: null, format: 'both', project: null, config: null, emitFacts: false };
  for (let i = 1; i < a.length; i++) {
    if (a[i] === '--out-dir') opts.outDir = a[++i];
    else if (a[i] === '--format') opts.format = a[++i];
    else if (a[i] === '--project') opts.project = a[++i];
    else if (a[i] === '--config') opts.config = a[++i];
    else if (a[i] === '--emit-facts') opts.emitFacts = true;
  }
  opts.outDir = opts.outDir ? path.resolve(opts.outDir) : opts.dataDir;
  return opts;
}

function dateStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function main() {
  const opts = parseArgs(process.argv);
  const facts = buildFacts(opts.dataDir, { project: opts.project, config: opts.config });
  if (opts.emitFacts) fs.writeFileSync(path.join(opts.outDir, 'facts.json'), JSON.stringify(facts, null, 2));
  const { markdown, html } = renderReport(facts);
  const base = `MySQL巡检报告_${dateStamp()}`;
  const written = [];
  if (opts.format === 'md' || opts.format === 'both') {
    const p = path.join(opts.outDir, base + '.md'); fs.writeFileSync(p, markdown); written.push(p);
  }
  if (opts.format === 'html' || opts.format === 'both') {
    const p = path.join(opts.outDir, base + '.html'); fs.writeFileSync(p, html); written.push(p);
  }
  console.error(`报告已生成（节点 ${facts.nodes.length} / 问题 ${facts.issues.length} / 健康度 ${facts.healthScore?.total}）：`);
  written.forEach(p => console.error('  - ' + p));
}

main();
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node tests/report_e2e_test.js`
Expected: `OK report_e2e_test`

- [ ] **Step 6: Commit**

```bash
git add tools/report.js tools/render-offline.js tests/report_e2e_test.js
git commit -m "feat(report): CLI 入口 preprocess→render→md+html 端到端打通

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: 章节构造器（数据章 + 图表）

把 17 章逐章实现为 `buildReportBlocks` 内的 push 序列。**唯一权威契约是 `references/report-template.md`**：每章的标题、小节、表格列、数据来源都在其中写明。本任务给两个**完整 exemplar**（第一章执行摘要 = 文字+图表；第七章容量 = 表格），其余章节按同样模式 + 下方字段映射表实现。

**Files:**
- Modify: `tools/render-offline.js`（`buildReportBlocks`）
- Test: `tests/render_offline_test.js`（追加章节断言）

**facts 字段速查（已实测自脱敏集）：**
- 顶层：`project` `inspectionDate` `reportDate` `healthScore.{total,dimensions}` `issues[]` `nodes[]` `cluster` `backupAssessment` `securityAssessment` `overallAssessment` `correlations` `recommendations` `paramJudgments` `disabledRulesApplied`。
- `nodes[]`：`ip` `label` `role` `hostname` `osRelease` `osKernel` `cpuCores` `cpuModel` `memTotal` `memGB` `memUsagePct` `disks` `mysqlVersion` `uptimeText` `variables` `dbTotalSizeGB` `topTables` `topIndexes` `innodb` `bpHitDisplay` `replication` `users` `slowQueries` `qps` `threadsConnected` `processlist` `noPkTables` `nonUtf8Tables` `fragTables` `routines` `autoIncrementUsage` `blobColumns` `topSqlByAvg` `topSqlByLatency` `sqlWithTmp` `backupTools` `backupDirs` 等（完整见 Task 起始处 `jq '.nodes[0]|keys'`）。
- `issues[]`：`type` `priority(P0-P3)` `description` `node` `action` `sql` `currentValue?` `recommendedValue?` `scope` `dimension?` `groupKey`。

**每章字段映射（标题严格对应 report-template.md）：**

| 章 | 标题 | builder 取数 | block 序列 |
|---|---|---|---|
| 1 | 执行摘要 | healthScore, issues 统计, overallAssessment | 见 exemplar A |
| 2 | 操作系统与硬件 | nodes[].{osRelease,osKernel,cpuCores,cpuModel,memTotal,disks} | heading(2) + table(节点/OS/内核/CPU/内存/磁盘) |
| 3 | MySQL 版本与启动配置 | nodes[].{mysqlVersion,uptimeText,variables 关键项} | heading(2)+table(节点/版本/uptime/datadir/...) |
| 4 | 集群拓扑 | cluster.topology, nodes[].role | heading(2)+chart(charts.topology(...))+table(节点/角色/主机) |
| 5 | 关键参数与一致性 | paramJudgments, nodes[].variables | heading(2)+table(参数/各节点值/判断) |
| 6 | 性能指标分析 | nodes[].{qps,threadsConnected,bpHitDisplay,slowQueries} | heading(2)+table+chart(charts.hbar 命中率) |
| 7 | 数据库容量与对象 | nodes[].{dbTotalSizeGB,topTables,topIndexes} | 见 exemplar B |
| 8 | InnoDB 状态与 ibtmp1 | nodes[].{innodb,ibtmp1} | heading(2)+table |
| 9 | 引擎深度 | nodes[].{innodb,bpHitDisplay} + redo/锁 | heading(2)+table+chart(charts.vbar BP) |
| 10 | 会话+锁+错误日志 | nodes[].{processlist,innodbLockWaits,errorLogAnalysis,longSessTop} | heading(2)+table |
| 11 | 用户与权限 | nodes[].users + securityAssessment | heading(2)+table |
| 12 | 主从复制 | nodes[].replication | heading(2)+table |
| 13 | Schema 审计 | nodes[].{noPkTables,nonUtf8Tables,fragTables,routines,autoIncrementUsage,blobColumns} | heading(2)+多个 table |
| 14 | SQL 治理 | nodes[].{topSqlByAvg,topSqlByLatency,sqlNoGoodIndex,sqlWithTmp} | heading(2)+table |
| 15 | 备份评估 | backupAssessment | heading(2)+table+callout |
| 16 | 行动计划 | issues（按 P0→P3） | 见 exemplar C（Task 7） |
| 17 | 结论 | healthScore, overallAssessment, recommendations | heading(2)+radar 图+list |

- [ ] **Step 1: 在 render_offline_test.js 追加章节断言**

在 `tests/render_offline_test.js` 末尾（`console.log` 之前）追加：
```js
// ── 章节级断言（端到端用真实 facts）──
const { buildFacts } = require('../tools/preprocess.js');
const { buildReportBlocks } = require('../tools/render-offline.js');
const facts = buildFacts('/Users/liups/ai/skill/test/v3/desensitized', {});
const { blocks } = buildReportBlocks(facts);
const headings = blocks.filter(b => b.t === 'heading' && b.level === 2).map(b => b.text);
for (const kw of ['执行摘要', '操作系统', '集群拓扑', '数据库容量', '行动计划', '结论']) {
  assert.ok(headings.some(h => h.includes(kw)), `missing chapter heading: ${kw}`);
}
// 行动计划必须覆盖全部 49 个问题（按 P0→P3）
const md2 = toMarkdown(blocks);
assert.ok(md2.includes('History list length') || facts.issues.length === 49, 'sanity');
let p0 = facts.issues.filter(i => i.priority === 'P0').length;
assert.ok((md2.match(/P0/g) || []).length >= p0, 'action plan should list P0 issues');
// 至少 1 张内联 SVG（拓扑/雷达）
assert.ok(blocks.some(b => b.t === 'chart'), 'expected at least one chart block');
console.log('OK render_offline_test (chapters)');
```

- [ ] **Step 2: 运行确认失败**

Run: `node tests/render_offline_test.js`
Expected: FAIL —— `missing chapter heading: 操作系统`（当前只有标题+概览）

- [ ] **Step 3: 实现 exemplar A —— 第一章执行摘要**

在 `buildReportBlocks` 的 `// TODO` 处替换为（先放第一章，后续 step 继续追加）：
```js
  const hs = facts.healthScore || { total: 0, dimensions: {} };
  const cnt = p => facts.issues.filter(i => i.priority === p).length;
  // ── 第一章 执行摘要 ──
  blocks.push(B.heading(2, '第一章 执行摘要'));
  blocks.push(B.chart(charts.gauge(hs.total, '综合健康度'), `综合健康度 ${hs.total}/100`));
  blocks.push(B.paragraph(`本次巡检覆盖 ${facts.nodes.length} 个节点，共检出 ${facts.issues.length} 项问题：` +
    `P0 ${cnt('P0')} 项、P1 ${cnt('P1')} 项、P2 ${cnt('P2')} 项、P3 ${cnt('P3')} 项。`));
  if (cnt('P0') > 0) blocks.push(B.callout('crit', `存在 ${cnt('P0')} 项 P0 高危问题，需优先处置（详见第十六章行动计划）。`));
  if (facts.overallAssessment) blocks.push(B.paragraph(String(facts.overallAssessment).slice(0, 600)));
  blocks.push(B.table(['维度', '得分'],
    Object.entries(hs.dimensions || {}).map(([k, v]) => [k, `${v}/100`])));
```

- [ ] **Step 4: 实现 exemplar B —— 第七章容量（表格章范式）**

在上一步之后、`return` 之前追加（其余数据章 2-6、8-15 照此范式：一个 `heading(2)` + 一/多个 `table`，列名取自 report-template.md，单元格取自 facts 字段，空数据交给序列化器显示「无数据」）：
```js
  // ── 第七章 数据库容量与对象 ──（表格章范式）
  blocks.push(B.heading(2, '第七章 数据库容量与对象'));
  blocks.push(B.table(['节点', '数据总量(GB)', '表数', 'TOP表'],
    facts.nodes.map(n => [
      n.label || n.ip,
      n.dbTotalSizeGB ?? '-',
      (n.topTables || []).length || '-',
      (n.topTables || []).slice(0, 1).map(t => `${t.db || ''}.${t.table || t.name || ''}`).join('') || '-',
    ])));
  for (const n of facts.nodes) {
    if (!(n.topTables || []).length) continue;
    blocks.push(B.heading(3, `${n.label || n.ip} · TOP 10 大表`));
    blocks.push(B.table(['库', '表', '行数', '数据', '索引', '总大小'],
      n.topTables.slice(0, 10).map(t => [
        t.db || '-', t.table || t.name || '-', t.rows ?? '-',
        t.dataSize ?? t.data ?? '-', t.indexSize ?? t.index ?? '-', t.totalSize ?? t.total ?? '-',
      ])));
  }
```

- [ ] **Step 5: 实现其余数据章（2-6、8-15）**

按 Step 4 范式 + 上方「每章字段映射」表，依次在 `return` 之前 push 第二~六、八~十五章。每章：`B.heading(2, '第N章 <报告模板里的标题>')` + 对应 `B.table(...)`（多节点时一行一节点，或每节点一个子表用 `B.heading(3,...)`）。第四章额外 `B.chart(charts.topology(facts.cluster?.topology || facts.nodes), '集群拓扑')`；第六/九章可加 `B.chart(charts.hbar/vbar(...), '...')`。字段名严格用 facts 实测键名（见速查）；不确定的列用可选链 + `?? '-'` 兜底，**不得留 TODO**。

逐章实现后立即 `node tests/render_offline_test.js` 跑一次，逐步消除 `missing chapter heading` 断言。

- [ ] **Step 6: 实现第十七章结论 + 雷达图**

`return` 之前追加：
```js
  // ── 第十七章 结论 ──
  blocks.push(B.heading(2, '第十七章 结论'));
  blocks.push(B.chart(charts.radar(hs.dimensions || {}), '六维健康度雷达'));
  if (Array.isArray(facts.recommendations) && facts.recommendations.length) {
    blocks.push(B.list(facts.recommendations.map(r => typeof r === 'string' ? r : (r.text || r.action || JSON.stringify(r)))));
  }
```
（第十六章行动计划放在 Task 7。）

- [ ] **Step 7: 运行测试**

Run: `node tests/render_offline_test.js`
Expected: `OK render_offline_test (chapters)`（行动计划断言可能仍弱 —— Task 7 补全）

- [ ] **Step 8: Commit**

```bash
git add tools/render-offline.js tests/render_offline_test.js
git commit -m "feat(render): 实现第一~十五、十七章构造器（表格+图表，数据来自 facts）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: 第十六章 行动计划（exemplar C，逻辑最重）

按 P0→P3 排序列出全部 issues，带 `currentValue → recommendedValue` 与可执行 SQL，覆盖 49 个问题。

**Files:**
- Modify: `tools/render-offline.js`（`buildReportBlocks`，在第十六章位置）
- Test: `tests/render_offline_test.js`（强化行动计划断言）

- [ ] **Step 1: 强化测试断言**

把 `tests/render_offline_test.js` 中行动计划相关断言替换为：
```js
const actionIdx = blocks.findIndex(b => b.t === 'heading' && b.text.includes('行动计划'));
assert.ok(actionIdx >= 0, 'must have 行动计划 chapter');
// 全部 49 个问题的 description 都应出现在 markdown 中
const mdFull = toMarkdown(blocks);
let missing = facts.issues.filter(i => !mdFull.includes((i.description || '').slice(0, 12)));
assert.strictEqual(missing.length, 0, `action plan missing ${missing.length} issues`);
// P0 必须排在 P3 之前
assert.ok(mdFull.indexOf('P0') < mdFull.lastIndexOf('P3'), 'P0 before P3');
```

- [ ] **Step 2: 运行确认失败**

Run: `node tests/render_offline_test.js`
Expected: FAIL —— `action plan missing N issues`

- [ ] **Step 3: 实现第十六章**

在 `buildReportBlocks` 中第十五章之后、第十七章之前插入：
```js
  // ── 第十六章 行动计划 ──
  blocks.push(B.heading(2, '第十六章 行动计划'));
  const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const sorted = [...facts.issues].sort((a, b) =>
    (order[a.priority] ?? 9) - (order[b.priority] ?? 9) || (a.seq || 0) - (b.seq || 0));
  for (const pr of ['P0', 'P1', 'P2', 'P3']) {
    const group = sorted.filter(i => i.priority === pr);
    if (!group.length) continue;
    const kind = pr === 'P0' ? 'crit' : pr === 'P1' ? 'warn' : 'info';
    blocks.push(B.heading(3, `${pr} 优先级（${group.length} 项）`));
    group.forEach((i, idx) => {
      blocks.push(B.callout(kind, `[${pr}] ${i.node ? i.node + '：' : ''}${i.description || ''}`));
      if (i.currentValue && i.recommendedValue) {
        blocks.push(B.paragraph(`✦ 当前值：${i.currentValue}　→　推荐值：${i.recommendedValue}`));
      }
      if (i.action) blocks.push(B.paragraph(`处置：${i.action}`));
      if (i.sql) blocks.push(B.codeblock('sql', i.sql));
    });
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node tests/render_offline_test.js`
Expected: `OK render_offline_test (chapters)`（且行动计划断言全过）

- [ ] **Step 5: 端到端 + 自包含校验**

Run: `node tools/report.js /Users/liups/ai/skill/test/v3/desensitized --out-dir /tmp/rpt && node tests/report_e2e_test.js`
Expected: `OK report_e2e_test`

Run（人工抽查 html 章节齐全 + 内联 SVG）:
`grep -c '<h2>' /tmp/rpt/*.html && grep -c '<svg' /tmp/rpt/*.html`
Expected: `<h2>` ≥ 17；`<svg` ≥ 2。

- [ ] **Step 6: 移除占位 TODO 并确认无残留**

Run: `grep -n "TODO" tools/render-offline.js`
Expected: 无输出（Task 5 的 TODO 注释必须已被真实章节替换）。

- [ ] **Step 7: Commit**

```bash
git add tools/render-offline.js tests/render_offline_test.js
git commit -m "feat(render): 第十六章行动计划（P0→P3，覆盖全部问题 + 推荐值 + SQL）

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: 打包配置（package.json + pkg + .gitignore）

**Files:**
- Create: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: 创建 package.json（仅构建端用）**

Create `package.json`:

```json
{
  "name": "mysql-healthcheck-offline",
  "version": "1.1.0",
  "private": true,
  "description": "离线/无 LLM MySQL 巡检报告生成器（md+html），可打包为单文件二进制",
  "bin": { "mysql-healthcheck": "tools/report.js" },
  "scripts": {
    "report": "node tools/report.js",
    "test": "node tests/buildfacts_test.js && node tests/charts_test.js && node tests/render_offline_test.js && node tests/report_e2e_test.js",
    "build:bin": "pkg . --targets node16-linux-x64 --output dist/mysql-healthcheck-linux-x64"
  },
  "pkg": {
    "scripts": ["tools/**/*.js"],
    "assets": ["tools/rules/*.json", "tools/config/*.json"],
    "targets": ["node16-linux-x64"],
    "outputPath": "dist"
  },
  "devDependencies": { "pkg": "^5.8.1" },
  "engines": { "node": ">=16" }
}
```

- [ ] **Step 2: 忽略构建产物**

在 `.gitignore` 的「打包产物」段追加：
```
# pkg 二进制产物
dist/
mysql-healthcheck-linux-x64
node_modules/
package-lock.json
```
（`node_modules/` 可能已被忽略；重复无害。）

- [ ] **Step 3: 跑全量测试套件**

Run: `cd /Users/liups/ai/skill/mysql-healthcheck && npm test`
Expected: 4 个测试全部打印 `OK ...`。
（注：`npm test` 不需要联网 —— 仅本地 node 跑测试；pkg 只在 build:bin 时才用。）

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore
git commit -m "build: package.json + pkg(node16-linux-x64) 配置；忽略二进制产物

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: 本地构建二进制 + 冒烟（关键：验证规则在快照下加载）

**Files:** 无（构建/验证）

- [ ] **Step 1: 安装 pkg（构建端，需联网一次）**

Run: `cd /Users/liups/ai/skill/mysql-healthcheck && npm install`
Expected: 安装 `pkg` 到 devDependencies（约数十 MB），无报错。

- [ ] **Step 2: 构建 linux-x64 二进制**

Run: `npm run build:bin`
Expected: 生成 `dist/mysql-healthcheck-linux-x64`（pkg 首次会下载 node16-linux-x64 base，需联网）。

- [ ] **Step 3: 在 linux-x64 跑二进制冒烟（若开发机为 mac，用 docker）**

Run（mac 上用 docker 验证 glibc 2.17 + 规则加载）:
```bash
docker run --rm -v "$PWD":/w -v /Users/liups/ai/skill/test/v3/desensitized:/data \
  centos:7 /w/dist/mysql-healthcheck-linux-x64 /data --out-dir /tmp 2>&1 | tail -5
```
Expected: 打印「报告已生成（节点 4 / 问题 49 / 健康度 88）」。
**关键判据：问题数必须 = 49** —— 证明 `rules/*.json` 在 pkg 快照里被正确加载（Task 2 兜底生效）。若为 0，说明 assets 未打进快照，需检查 `pkg.assets` glob 与 `KNOWN_RULE_FILES` 兜底。

- [ ] **Step 4: 比对二进制输出与 node 输出一致**

Run:
```bash
node tools/report.js /Users/liups/ai/skill/test/v3/desensitized --out-dir /tmp/node-out
docker run --rm -v "$PWD":/w -v /Users/liups/ai/skill/test/v3/desensitized:/data centos:7 \
  /w/dist/mysql-healthcheck-linux-x64 /data --out-dir /data 2>/dev/null
diff <(sed 's/[0-9]\{8\}//' /tmp/node-out/*.md) <(sed 's/[0-9]\{8\}//' /Users/liups/ai/skill/test/v3/desensitized/*.md) && echo "BINARY == NODE"
```
Expected: `BINARY == NODE`（忽略文件名里的日期戳，正文一致）。

清理：`rm -f /Users/liups/ai/skill/test/v3/desensitized/MySQL巡检报告_*.md /Users/liups/ai/skill/test/v3/desensitized/MySQL巡检报告_*.html`（不要把生成物留进测试集）。

- [ ] **Step 5: 无提交**（二进制与 dist 已忽略；本任务仅验证）

---

## Task 10: CI 发布 workflow（tag → 二进制 → Release）

**Files:**
- Create: `.github/workflows/release-binary.yml`

- [ ] **Step 1: 创建 workflow**

Create `.github/workflows/release-binary.yml`:

```yaml
name: release-binary
on:
  push:
    tags: ['offline-v*']
permissions:
  contents: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '18' }
      - run: npm install
      - run: npm test   # 数据相关测试无 fixture 时优雅 SKIP（exit 0），CI 仍绿
      - run: npm run build:bin
      - name: Release
        uses: softprops/action-gh-release@v2
        with:
          files: dist/mysql-healthcheck-linux-x64
```

注：脱敏 fixture 不入仓（公开仓库不放客户数据）。CI 的 `npm test` 中，依赖数据的测试因无 `HC_TEST_DATA`/本地路径而优雅 SKIP；不含数据的测试（charts/render 核心/转义）仍真实执行。二进制「问题数=49」的硬校验在 Task 9 本地用 docker 完成。如需 CI 也做数据级冒烟，后续可在 CI secret/runner 上挂 `HC_TEST_DATA`（不在本计划范围）。

- [ ] **Step 2: 校验 YAML 语法**

Run: `cd /Users/liups/ai/skill/mysql-healthcheck && python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release-binary.yml')); print('yaml ok')" 2>/dev/null || node -e "require('fs').readFileSync('.github/workflows/release-binary.yml','utf8'); console.log('file ok')"`
Expected: `yaml ok` 或 `file ok`。

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release-binary.yml
git commit -m "ci: tag(offline-v*) 触发 pkg 构建并发布 linux-x64 二进制

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 11: 文档 + 版本

**Files:**
- Modify: `SKILL.md`、`CHANGELOG.md`、`VERSION`、`README.md`

- [ ] **Step 1: VERSION 升到 1.1.0**

把 `VERSION` 内容改为 `1.1.0`。

- [ ] **Step 2: SKILL.md 增加离线模式说明**

在 SKILL.md 的 Step 0 决策树**之后**追加一段「模式三：完全离线 / 无 LLM」：
```markdown
### 模式三：完全离线 / 无 LLM（无网客户，数据不出场）

当客户现场无外网、数据不能带出、且不能用 LLM 时：

- **有 node**：`node tools/report.js <数据目录>` → 直接出 `MySQL巡检报告_<日期>.md` + `.html`，
  规则判定与报告全部由本地确定性代码生成，**全程无 LLM**。
- **无 node**（如 RHEL 7.9 默认无 node）：使用预编译二进制
  `./mysql-healthcheck-linux-x64 <数据目录>`（自带 Node 16 运行时，兼容 glibc 2.17，零安装）。

二进制由 CI 在 push `offline-v*` tag 时构建并发布到 Release，不入仓。
现场交付包 = `collectors/mysqlHealthCheckV3.0.sh`（采集）+ 二进制（出报告）。
```

- [ ] **Step 3: CHANGELOG 增加 1.1.0 条目**

在 `CHANGELOG.md` 顶部（`## [1.0.9]` 之前）插入：
```markdown
## [1.1.0] - 2026-06-15

**离线 / 无 LLM / 无 node 出报告：新增 Node 渲染器 + 单文件二进制**

面向无外网、RHEL 7.9、无 node 的隔离客户：复用现有零依赖规则管线，新增纯内置模块渲染器，
本机直接生成 md + html 巡检报告，全程不依赖 LLM、不依赖 docx/resvg。

- 新增 `tools/render-offline.js`：block 模型 + `toMarkdown`/`toHtml` 双序列化器（同源不漂移）。
- 新增 `tools/charts.js`：从 SaaS 移植的纯 SVG 图表构造器（删除 resvg，HTML 内联 SVG）。
- 新增 `tools/report.js`：CLI 入口 `report <目录>` = preprocess→render→md+html。
- `tools/preprocess.js` 导出 `buildFacts()`（CLI 行为不变），供进程内/二进制调用。
- `pkg --target node16-linux-x64` 打成单文件二进制（自带运行时，兼容 glibc 2.17）；CI tag 触发发布。
- 规则逻辑零改动，问题判定与既有 facts 完全一致（脱敏集 49 项）。
```

- [ ] **Step 4: README 增加一节**

在 `README.md` 适当位置加「离线出报告（无 node）」小节，指向 `tools/report.js` 与二进制用法（2-3 行 + 上面的两条命令）。

- [ ] **Step 5: 全量测试再跑一遍**

Run: `npm test`
Expected: 4 个 `OK`。

- [ ] **Step 6: Commit**

```bash
git add SKILL.md CHANGELOG.md VERSION README.md
git commit -m "docs: 1.1.0 — 离线/无 LLM/无 node 出报告模式 + 二进制用法

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 12: 收尾验证 + 推送

- [ ] **Step 1: 全量测试 + 端到端**

Run:
```bash
cd /Users/liups/ai/skill/mysql-healthcheck && npm test && \
node tools/report.js /Users/liups/ai/skill/test/v3/desensitized --out-dir /tmp/final && \
echo "h2=$(grep -c '<h2>' /tmp/final/*.html) svg=$(grep -c '<svg' /tmp/final/*.html) issues=$(grep -c '✦\|处置：' /tmp/final/*.md)"
```
Expected: 全 `OK`；`h2` ≥ 17；`svg` ≥ 2。

- [ ] **Step 2: 确认无生成物/二进制混入暂存**

Run: `git status --short`
Expected: 无 `dist/`、无 `*.md`/`*.html` 报告产物、无 `node_modules/`、无二进制。

- [ ] **Step 3: 推送 skill 分支**

Run: `git push origin skill`
Expected: 推送成功。
**注意：不要 sync-to-workbuddy（dist 镜像 SaaS，勿覆盖）。**

- [ ] **Step 4（可选）: 发首个二进制 Release**

如需立即发布：`git tag offline-v1.1.0 && git push origin offline-v1.1.0`，CI 自动构建并挂二进制到 Release。

---

## Self-Review 记录

- **Spec 覆盖**：渲染器(Task4-7)/charts(3)/report.js(5)/二进制(8-10)/Python备选(spec §9 明确不做)/测试(每任务)/文档版本(11) 均有任务对应。✅
- **占位扫描**：唯一 TODO 在 Task5 Step3（交接标记），Task7 Step6 显式 `grep TODO` 校验已清除。✅
- **类型一致**：`B.*` 工厂、`toMarkdown`/`toHtml`/`buildReportBlocks`/`renderReport`/`buildFacts` 命名在各任务间一致。✅
- **关键风险**：pkg 快照规则加载 → Task2 兜底 + Task9 Step3「问题数=49」硬校验双保险。glibc 2.17 → Task9 用 centos:7 docker 实测。✅
