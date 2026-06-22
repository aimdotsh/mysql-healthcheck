#!/usr/bin/env node
/**
 * mysql-healthcheck CLI
 *
 * 用法：
 *   mysql-healthcheck <数据目录> [选项]
 *
 * 选项：
 *   --format <fmt>   输出格式 docx|md|html|all，默认 all
 *   --project <名>   项目名称
 *   --out <path>     data.json 输出路径
 *   --config <path>  自定义阈值配置文件
 *
 * 架构说明：
 *   - pkg 二进制模式：直接 require() 各模块（spawnSync 在 pkg 中 argv 路由失效）
 *   - node 开发模式：spawnSync 子进程，通过 __extract__ / __render__ 路由
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const isPkg = !!process.pkg;

// ─── node 开发模式：内部路由 ─────────────────────────────────
// pkg 模式不走这里（pkg 模式下直接 require，不 spawn）
if (!isPkg) {
  const subMode = process.argv[2];
  const subArgs = process.argv.slice(3);
  if (subMode === '__extract__') {
    process.argv = [process.argv[0], path.join(__dirname, 'extract.js'), ...subArgs];
    require('./extract.js'); return;
  }
  if (subMode === '__render__') {
    process.argv = [process.argv[0], path.join(__dirname, 'render.js'), ...subArgs];
    require('./render.js'); return;
  }
  if (subMode === '__render_md__') {
    process.argv = [process.argv[0], path.join(__dirname, 'render-md.js'), ...subArgs];
    require('./render-md.js'); return;
  }
  if (subMode === '__render_html__') {
    process.argv = [process.argv[0], path.join(__dirname, 'render-html.js'), ...subArgs];
    require('./render-html.js'); return;
  }
}

// ─── 用户 CLI 参数解析 ────────────────────────────────────────
const args = process.argv.slice(2);
const mode = args[0];

if (!mode || mode.startsWith('--')) {
  console.error('用法: mysql-healthcheck <数据目录> [--format docx|md|html|all] [--project "项目名"] [--out data.json] [--config <path>]');
  process.exit(1);
}

const dataDir = path.resolve(mode);
const rest = [...args.slice(1)];

// 解析 --format（从 rest 中提取，避免传给 extract）
let fmtIdx = rest.indexOf('--format');
let formats = ['all'];
if (fmtIdx !== -1 && rest[fmtIdx + 1]) {
  formats = rest[fmtIdx + 1].split(',').map(s => s.trim().toLowerCase());
  rest.splice(fmtIdx, 2);
}
const wantDocx = formats.includes('all') || formats.includes('docx');
const wantMd   = formats.includes('all') || formats.includes('md') || formats.includes('markdown');
const wantHtml = formats.includes('all') || formats.includes('html');

// 推断 data.json 路径
let dataJsonPath = path.join(dataDir, 'data.json');
const outIdx = rest.indexOf('--out');
if (outIdx !== -1 && rest[outIdx + 1]) {
  dataJsonPath = path.resolve(rest[outIdx + 1]);
}

const fmtList = [wantDocx && 'docx', wantMd && 'md', wantHtml && 'html'].filter(Boolean).join(' + ');

console.error('═══════════════════════════════════════════');
console.error('mysql-healthcheck 报告生成');
console.error('═══════════════════════════════════════════');
console.error('数据目录: ' + dataDir);
console.error('输出格式: ' + fmtList);
console.error('');

// ─── pkg 模式：在当前进程内 require 模块 ─────────────────────
// 原因：pkg 二进制中 spawnSync 子进程时，argv[1] 被 pkg bootstrap
// 当作入口模块路径 require，导致 "Cannot find module '__extract__'" 错误。
// 解决：直接 require()，临时替换 process.argv，拦截 process.exit。
function runInProcess(scriptRel, stepArgs) {
  const origArgv = process.argv.slice();
  const origExit = process.exit;
  let code = 0;

  process.argv = [origArgv[0], path.join(__dirname, scriptRel), ...stepArgs];
  process.exit = function(c) {
    code = (c == null) ? 0 : Number(c);
    const e = new Error('__process_exit__');
    e.__isExit = true;
    throw e;
  };

  try {
    require(scriptRel);
  } catch (e) {
    if (!e.__isExit) {
      console.error(e.stack || e.message);
      code = 1;
    }
  }

  process.argv = origArgv;
  process.exit = origExit;
  return code;
}

// ─── node 模式：spawnSync 子进程 ──────────────────────────────
function runSpawn(nodeMode, stepArgs) {
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, 'cli.js'), nodeMode, ...stepArgs],
    { stdio: 'inherit' }
  );
  return r.status;
}

function runStep(scriptRel, nodeMode, stepArgs) {
  return isPkg
    ? runInProcess(scriptRel, stepArgs)
    : runSpawn(nodeMode, stepArgs);
}

// ─── Step 1: extract ─────────────────────────────────────────
console.error('▶ Step 1: 解析 txt → data.json');
const s1 = runStep('./extract.js', '__extract__', [dataDir, ...rest]);
if (s1 !== 0) { console.error('✗ extract 失败'); process.exit(s1 || 1); }
console.error('');

// ─── Step 2a: docx ───────────────────────────────────────────
if (wantDocx) {
  console.error('▶ Step 2a: 渲染 data.json → docx');
  const s2 = runStep('./render.js', '__render__', [dataJsonPath]);
  if (s2 !== 0) console.error('✗ docx 失败（继续其他格式）');
  console.error('');
}

// ─── Step 2b: markdown ───────────────────────────────────────
if (wantMd) {
  console.error('▶ Step 2b: 渲染 data.json → markdown');
  const s3 = runStep('./render-md.js', '__render_md__', [dataJsonPath]);
  if (s3 !== 0) console.error('✗ md 失败（继续其他格式）');
  console.error('');
}

// ─── Step 2c: html ───────────────────────────────────────────
if (wantHtml) {
  console.error('▶ Step 2c: 渲染 data.json → html');
  const s4 = runStep('./render-html.js', '__render_html__', [dataJsonPath]);
  if (s4 !== 0) console.error('✗ html 失败');
  console.error('');
}

console.error('═══════════════════════════════════════════');
console.error('✓ 完成：' + fmtList);
console.error('═══════════════════════════════════════════');
