#!/usr/bin/env node
/**
 * mysql-healthcheck 端到端构建脚本
 *
 * 用法：
 *   npm run build -- <数据目录> --project "项目名" [--report-version 1.0]
 *   或：node build.js <数据目录> --project "项目名"
 *
 * 等价于：
 *   node extract.js <数据目录> --project "项目名"
 *   node render.js <数据目录>/data.json
 *
 * 解决 Codex 反馈 #1：之前 `build` 是 `extract.js && render.js`
 * 串联，参数无法转发给两端，导致 `npm run build -- ...` 失败。
 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith('--')) {
  console.error('用法: npm run build -- <数据目录> --project "项目名" [--report-version 1.0]');
  console.error('     或 node build.js <数据目录> ...');
  process.exit(1);
}

// 找出数据目录（第一个非选项参数）
const dataDir = path.resolve(args[0]);
const rest = args.slice(1);

console.error('═══════════════════════════════════════════');
console.error('mysql-healthcheck 端到端构建');
console.error('═══════════════════════════════════════════');
console.error('数据目录: ' + dataDir);
console.error('');

// Step 1: extract
console.error('▶ Step 1: 解析 txt → data.json');
const r1 = spawnSync('node', [path.join(__dirname, 'extract.js'), dataDir, ...rest], {
  stdio: 'inherit',
});
if (r1.status !== 0) {
  console.error('✗ extract 失败');
  process.exit(r1.status || 1);
}

// 期望 data.json 在数据目录下（除非用户用了 --out）
let dataJsonPath = path.join(dataDir, 'data.json');
const outIdx = rest.indexOf('--out');
if (outIdx !== -1 && rest[outIdx + 1]) {
  dataJsonPath = path.resolve(rest[outIdx + 1]);
}

// Step 2: render
console.error('');
console.error('▶ Step 2: 渲染 data.json → docx');
const r2 = spawnSync('node', [path.join(__dirname, 'render.js'), dataJsonPath], {
  stdio: 'inherit',
});
if (r2.status !== 0) {
  console.error('✗ render 失败');
  process.exit(r2.status || 1);
}

console.error('');
console.error('═══════════════════════════════════════════');
console.error('✓ 构建完成');
console.error('═══════════════════════════════════════════');
