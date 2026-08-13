#!/usr/bin/env node
/**
 * 用法：
 *   node ai-review.js data.json --config mysql-healthcheck.llm.json
 *   node ai-review.js data.json --prepare [--out ai-review-input.json]
 *   node ai-review.js data.json --apply ai-review-result.json
 */
'use strict';

const fs = require('fs');
const path = require('path');
const llm = require('./lib/llm-review');

const args = process.argv.slice(2);
if (!args[0] || args[0].startsWith('--')) {
  console.error('用法: node ai-review.js <data.json> [--config <llm.json>] [--out <path>] [--prepare | --apply <result.json>]');
  process.exit(1);
}

const dataPath = path.resolve(args[0]);
let configPath = null;
let outPath = null;
let prepare = false;
let applyPath = null;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--config') configPath = args[++i];
  else if (args[i] === '--out') outPath = args[++i];
  else if (args[i] === '--prepare') prepare = true;
  else if (args[i] === '--apply') applyPath = args[++i];
}

if (!fs.existsSync(dataPath)) {
  console.error(`错误：data.json 不存在：${dataPath}`);
  process.exit(1);
}

const autoConfig = path.join(path.dirname(dataPath), 'mysql-healthcheck.llm.json');
if (!configPath && fs.existsSync(autoConfig)) configPath = autoConfig;

async function main() {
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  if (prepare) {
    const cfg = llm.loadConfig(configPath, { enabled: true });
    const snapshot = llm.buildInspectionSnapshot(data, cfg);
    const payload = {
      instructions: '请按 references/ai-review.md 的输出契约审查 snapshot，并把纯 JSON 结果保存后用 --apply 写回。',
      snapshot,
    };
    const text = JSON.stringify(payload, null, 2);
    if (outPath) {
      fs.writeFileSync(path.resolve(outPath), text);
      console.error(`✓ 智能体巡检输入已写入：${path.resolve(outPath)}`);
    } else {
      process.stdout.write(text + '\n');
    }
    return;
  }

  if (applyPath) {
    const cfg = llm.loadConfig(configPath, { enabled: true });
    const raw = JSON.parse(fs.readFileSync(path.resolve(applyPath), 'utf8'));
    data.aiAssessment = llm.normalizeReview(raw, { provider: 'agent', model: raw.model || 'agent' }, cfg);
    const target = outPath ? path.resolve(outPath) : dataPath;
    fs.writeFileSync(target, JSON.stringify(data, null, 2));
    console.error(`✓ 智能体辅助研判已写入：${target}（${data.aiAssessment.findings.length} 条）`);
    return;
  }

  if (!configPath) throw new Error(`未找到大模型配置。请传 --config，或在 ${path.dirname(dataPath)} 放 mysql-healthcheck.llm.json`);
  const cfg = llm.loadConfig(configPath);
  const result = await llm.reviewDataFile(dataPath, cfg, outPath);
  console.error(`✓ 大模型辅助研判完成：${result.target}（${result.review.findings.length} 条）`);
}

main().catch(err => {
  console.error('✗ 大模型辅助研判失败：' + err.message);
  process.exit(2);
});
