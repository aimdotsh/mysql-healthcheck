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
