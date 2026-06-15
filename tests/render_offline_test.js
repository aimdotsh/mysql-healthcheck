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
const evil = toHtml([B.paragraph('<img onerror=x>')]);
assert.ok(evil.includes('&lt;img'), 'html must escape user content');
console.log('OK render_offline_test (core)');

// ── 章节级断言（端到端用真实 facts）──
const { requireFixtureOrSkip } = require('./fixture.js');
const DATA = requireFixtureOrSkip('render_offline_test');
const { buildFacts } = require('../tools/preprocess.js');
const { buildReportBlocks } = require('../tools/render-offline.js');
const facts = buildFacts(DATA, {});
const { blocks: chapterBlocks } = buildReportBlocks(facts);
const h2 = chapterBlocks.filter(b => b.t === 'heading' && b.level === 2).map(b => b.text);
for (const kw of ['执行摘要', '操作系统', '集群拓扑', '数据库容量', '结论']) {
  assert.ok(h2.some(h => h.includes(kw)), `missing chapter heading: ${kw}`);
}
assert.ok(chapterBlocks.some(b => b.t === 'chart'), 'expected at least one chart block');
// 渲染整份不报错，且 html 自包含
const mdAll = toMarkdown(chapterBlocks);
const htmlAll = toHtml(chapterBlocks, { title: 't' });
assert.ok(mdAll.length > 500 && htmlAll.startsWith('<!DOCTYPE html>'), 'renders both formats');
// 排除内联 SVG 的 xmlns 命名空间 URI（非网络引用），其余 http(s) 引用视为破坏自包含性
const htmlNoSvgNs = htmlAll.replace(/xmlns="https?:\/\/[^"]*"/g, '');
assert.ok(!/<script src=|https?:\/\//.test(htmlNoSvgNs), 'html self-contained');
console.log('OK render_offline_test (chapters)');

// ── 第十六章 行动计划断言 ──
const apH = chapterBlocks.filter(b => b.t === 'heading' && b.text.includes('行动计划'));
assert.strictEqual(apH.length, 1, 'must have exactly one 行动计划 chapter');
// 每个 issue 的 description 前 12 字都应出现在报告里（全覆盖）
const missing = facts.issues.filter(i => !mdAll.includes((i.description || '').slice(0, 12)));
assert.strictEqual(missing.length, 0, `action plan missing ${missing.length} issues: ${missing.slice(0, 3).map(i => i.type).join(',')}`);
// P0 段必须排在 P3 段之前
assert.ok(mdAll.indexOf('P0') < mdAll.lastIndexOf('P3'), 'P0 must come before P3');
console.log('OK render_offline_test (action plan)');
