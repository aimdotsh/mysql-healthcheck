'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { requireFixtureOrSkip } = require('./fixture.js');

const DATA = requireFixtureOrSkip('report_e2e_test'); // skips (exit 0) if no fixture
const ROOT = '/tmp/report-e2e';
fs.rmSync(ROOT, { recursive: true, force: true });
const OUT = path.join(ROOT, 'nested', 'out'); // intentionally NOT pre-created — report.js must create it

execFileSync('node', [
  path.join(__dirname, '..', 'tools', 'report.js'),
  DATA,
  '--out-dir', OUT,
], { stdio: 'inherit' });

const files = fs.readdirSync(OUT);
const md = files.find(f => f.endsWith('.md'));
const html = files.find(f => f.endsWith('.html'));
assert.ok(md, 'expected a .md output');
assert.ok(html, 'expected a .html output');

const htmlContent = fs.readFileSync(path.join(OUT, html), 'utf8');
assert.ok(htmlContent.startsWith('<!DOCTYPE html>'), 'self-contained html');
// 排除内联 SVG 的 xmlns 命名空间 URI（非网络引用），其余 http(s) 引用视为破坏自包含性
const htmlNoSvgNs = htmlContent.replace(/xmlns="https?:\/\/[^"]*"/g, '');
assert.ok(!/<script src=|https?:\/\//.test(htmlNoSvgNs), 'no external refs');
console.log('OK report_e2e_test');
