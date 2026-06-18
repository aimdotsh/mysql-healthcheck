#!/usr/bin/env node
/**
 * mysql-healthcheck CLI — pkg 二进制入口
 *
 * 用法：
 *   mysql-healthcheck <数据目录> [--project "项目名"] [--report-version 1.0]
 *
 * 内部路由（被自身调用时使用，用户无需关心）：
 *   mysql-healthcheck __extract__ <数据目录> [opts]
 *   mysql-healthcheck __render__  <data.json路径>
 *
 * 两段式：先 extract（txt → data.json），再 render（data.json → docx）。
 * pkg 不能把 node 子进程启动为 extract.js/render.js，
 * 因此改为重新 exec 自身并用 __extract__ / __render__ 标志路由。
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const mode = args[0];

// ─── 内部路由 ────────────────────────────────────────────────
if (mode === '__extract__') {
  // 把剩余参数交给 extract.js 的 CLI 解析（它读 process.argv[2]）
  process.argv = [process.argv[0], path.join(__dirname, 'extract.js'), ...args.slice(1)];
  require('./extract.js');
  return;
}

if (mode === '__render__') {
  process.argv = [process.argv[0], path.join(__dirname, 'render.js'), ...args.slice(1)];
  require('./render.js');
  return;
}

// ─── 正常构建模式（用户入口）────────────────────────────────
if (!mode || mode.startsWith('--')) {
  console.error('用法: mysql-healthcheck <数据目录> [--project "项目名"] [--report-version 1.0] [--out data.json] [--config <path>]');
  process.exit(1);
}

const dataDir = path.resolve(mode);
const rest = args.slice(1);

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
console.error('mysql-healthcheck 端到端构建');
console.error('═══════════════════════════════════════════');
console.error('数据目录: ' + dataDir);
console.error('');

// Step 1: extract
console.error('▶ Step 1: 解析 txt → data.json');
const [e1, a1] = spawnArgs(['__extract__', dataDir, ...rest]);
const r1 = spawnSync(e1, a1, { stdio: 'inherit' });
if (r1.status !== 0) {
  console.error('✗ extract 失败');
  process.exit(r1.status || 1);
}

// Step 2: render
console.error('');
console.error('▶ Step 2: 渲染 data.json → docx');
const [e2, a2] = spawnArgs(['__render__', dataJsonPath]);
const r2 = spawnSync(e2, a2, { stdio: 'inherit' });
if (r2.status !== 0) {
  console.error('✗ render 失败');
  process.exit(r2.status || 1);
}

console.error('');
console.error('═══════════════════════════════════════════');
console.error('✓ 构建完成');
console.error('═══════════════════════════════════════════');
