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
