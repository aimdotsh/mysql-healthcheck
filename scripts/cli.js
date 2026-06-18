#!/usr/bin/env node
/**
 * mysql-healthcheck CLI — pkg 二进制入口
 *
 * 用法：
 *   mysql-healthcheck <数据目录> [选项]
 *
 * 选项：
 *   --format <fmt>      输出格式，可选 docx|md|html|all，默认 all
 *   --project <名称>    项目名称
 *   --report-version    报告版本号
 *   --out <path>        data.json 输出路径（默认 <数据目录>/data.json）
 *   --config <path>     自定义阈值配置文件
 *
 * 内部路由（被自身调用时使用，用户无需关心）：
 *   mysql-healthcheck __extract__    <数据目录> [opts]
 *   mysql-healthcheck __render__     <data.json路径>
 *   mysql-healthcheck __render_md__  <data.json路径> [--out 报告.md]
 *   mysql-healthcheck __render_html__ <data.json路径> [--out 报告.html]
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const mode = args[0];

// ─── 内部路由 ────────────────────────────────────────────────
if (mode === '__extract__') {
  process.argv = [process.argv[0], path.join(__dirname, 'extract.js'), ...args.slice(1)];
  require('./extract.js');
  return;
}

if (mode === '__render__') {
  process.argv = [process.argv[0], path.join(__dirname, 'render.js'), ...args.slice(1)];
  require('./render.js');
  return;
}

if (mode === '__render_md__') {
  process.argv = [process.argv[0], path.join(__dirname, 'render-md.js'), ...args.slice(1)];
  require('./render-md.js');
  return;
}

if (mode === '__render_html__') {
  process.argv = [process.argv[0], path.join(__dirname, 'render-html.js'), ...args.slice(1)];
  require('./render-html.js');
  return;
}

// ─── 正常构建模式（用户入口）────────────────────────────────
if (!mode || mode.startsWith('--')) {
  console.error('用法: mysql-healthcheck <数据目录> [--format docx|md|html|all] [--project "项目名"] [--out data.json] [--config <path>]');
  process.exit(1);
}

const dataDir = path.resolve(mode);
const rest = args.slice(1);

// 解析 --format
let fmtIdx = rest.indexOf('--format');
let formats = ['all'];
if (fmtIdx !== -1 && rest[fmtIdx + 1]) {
  formats = rest[fmtIdx + 1].split(',').map(s => s.trim().toLowerCase());
  // 从 rest 中移除 --format <val>
  rest.splice(fmtIdx, 2);
}
const wantDocx = formats.includes('all') || formats.includes('docx');
const wantMd   = formats.includes('all') || formats.includes('md') || formats.includes('markdown');
const wantHtml = formats.includes('all') || formats.includes('html');

// 找 --out 位置，推断 data.json 路径
let dataJsonPath = path.join(dataDir, 'data.json');
const outIdx = rest.indexOf('--out');
if (outIdx !== -1 && rest[outIdx + 1]) {
  dataJsonPath = path.resolve(rest[outIdx + 1]);
}

// pkg 二进制：process.pkg 存在，直接 exec 自身即可路由
// node 开发环境：需要把 cli.js 路径也传进去
const isPkg = !!process.pkg;
const spawnArgs = (subArgs) =>
  isPkg
    ? [process.execPath, subArgs]
    : [process.execPath, [path.join(__dirname, 'cli.js'), ...subArgs]];

console.error('═══════════════════════════════════════════');
console.error('mysql-healthcheck 报告生成');
console.error('═══════════════════════════════════════════');
console.error('数据目录: ' + dataDir);
const fmtList = [wantDocx&&'docx', wantMd&&'md', wantHtml&&'html'].filter(Boolean).join(' + ');
console.error('输出格式: ' + fmtList);
console.error('');

// Step 1: extract
console.error('▶ Step 1: 解析 txt → data.json');
const [e1, a1] = spawnArgs(['__extract__', dataDir, ...rest]);
const r1 = spawnSync(e1, a1, { stdio: 'inherit' });
if (r1.status !== 0) {
  console.error('✗ extract 失败');
  process.exit(r1.status || 1);
}
console.error('');

// Step 2: docx
if (wantDocx) {
  console.error('▶ Step 2a: 渲染 data.json → docx');
  const [e2, a2] = spawnArgs(['__render__', dataJsonPath]);
  const r2 = spawnSync(e2, a2, { stdio: 'inherit' });
  if (r2.status !== 0) {
    console.error('✗ docx render 失败');
    if (!wantMd && !wantHtml) process.exit(r2.status || 1);
  }
  console.error('');
}

// Step 3: markdown
if (wantMd) {
  console.error('▶ Step 2b: 渲染 data.json → markdown');
  const [e3, a3] = spawnArgs(['__render_md__', dataJsonPath]);
  const r3 = spawnSync(e3, a3, { stdio: 'inherit' });
  if (r3.status !== 0) {
    console.error('✗ md render 失败');
    if (!wantHtml) process.exit(r3.status || 1);
  }
  console.error('');
}

// Step 4: html
if (wantHtml) {
  console.error('▶ Step 2c: 渲染 data.json → html');
  const [e4, a4] = spawnArgs(['__render_html__', dataJsonPath]);
  const r4 = spawnSync(e4, a4, { stdio: 'inherit' });
  if (r4.status !== 0) {
    console.error('✗ html render 失败');
    process.exit(r4.status || 1);
  }
  console.error('');
}

console.error('═══════════════════════════════════════════');
console.error('✓ 完成：' + fmtList);
console.error('═══════════════════════════════════════════');
