#!/usr/bin/env node
// gen-rules-md.js — 从 scripts/rules/*.json 生成可读的规则手册
//
// 用法：
//   node scripts/gen-rules-md.js [--out references/rules-auto.md]
//
// v5.0 GA：全部 ~51 条规则均以 JSON 描述，本脚本是规则手册的唯一来源。
// references/rules.md 退役为指针，跳转到本脚本产出的 references/rules-auto.md。

'use strict';

const fs = require('fs');
const path = require('path');
const { _loadRulesFromDir } = require('./rule-engine.js');

// ─── 解析 CLI ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let outPath = path.resolve(__dirname, '..', 'references', 'rules-auto.md');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outPath = path.resolve(args[++i]);
}

const rulesDir = path.join(__dirname, 'rules');
const rules = _loadRulesFromDir(rulesDir);

// ─── 按 dimension 分组 ────────────────────────────────────────────────
const byDim = new Map();
for (const r of rules) {
  const d = r.dimension || 'unknown';
  if (!byDim.has(d)) byDim.set(d, []);
  byDim.get(d).push(r);
}
for (const arr of byDim.values()) arr.sort((a, b) => a.id.localeCompare(b.id));

const DIM_ORDER = ['availability', 'durability', 'performance', 'security', 'dataDesign', 'operations'];
const DIM_LABEL = {
  availability: '可用性 (availability)',
  durability:   '持久化 (durability)',
  performance:  '性能 (performance)',
  security:     '安全 (security)',
  dataDesign:   '数据设计 (dataDesign)',
  operations:   '运维 (operations)',
};

// ─── 渲染 markdown ────────────────────────────────────────────────────
const out = [];
const now = new Date().toISOString().slice(0, 10);
const total = rules.length;

out.push(`# 巡检规则手册（自动生成）`);
out.push('');
out.push(`> **本文档由 \`scripts/gen-rules-md.js\` 从 \`scripts/rules/*.json\` 自动生成。请勿手动编辑。**`);
out.push(`> 生成时间：${now}　|　规则总数：${total}`);
out.push('');
out.push(`v5.0 GA：所有 ~51 条巡检规则（节点级 + 集群级）全部以声明式 JSON 描述，由 \`scripts/rule-engine.js\` 加载并求值；复杂规则通过 \`scripts/rule-helpers/index.js\` 注册的 handler 计算。详细 schema 见 [\`scripts/rules/SCHEMA.md\`](../scripts/rules/SCHEMA.md)。`);
out.push('');
out.push(`某条规则不适用于客户场景时，可在 \`mysql-healthcheck.config.json\` 加 \`disabledRules: ["rule_id"]\` 关闭；阈值类规则通过 \`thresholds.<group>.<key>\` 覆盖；任意规则可通过 \`priorities.<rule_id>: "P3"\` 改优先级。`);
out.push('');
out.push('---');
out.push('');

// 总览表
out.push('## 总览');
out.push('');
out.push('| 维度 | 规则数 |');
out.push('|---|---|');
for (const d of DIM_ORDER) {
  const arr = byDim.get(d);
  if (arr && arr.length) out.push(`| ${DIM_LABEL[d]} | ${arr.length} |`);
}
out.push('');

// 按维度详列
for (const d of DIM_ORDER) {
  const arr = byDim.get(d);
  if (!arr || !arr.length) continue;
  out.push(`## ${DIM_LABEL[d]}`);
  out.push('');
  for (const r of arr) {
    out.push(`### \`${r.id}\``);
    out.push('');
    if (r.title) out.push(`**${r.title}**`);
    out.push('');
    if (r.rationale) {
      out.push(`> ${r.rationale}`);
      out.push('');
    }
    // 元数据表
    out.push('| 字段 | 值 |');
    out.push('|---|---|');
    out.push(`| 维度 | \`${r.dimension}\` |`);
    out.push(`| Scope | \`${r.scope}\` |`);
    if (r.priority) out.push(`| 优先级 | **${r.priority}** |`);
    if (r.tiers) {
      const prios = r.tiers.map(t => t.priority).join(' / ');
      out.push(`| 优先级（分级） | **${prios}** |`);
    }
    if (r.handler) out.push(`| Handler | \`${r.handler}\` |`);
    out.push(`| 文件 | \`${path.relative(path.join(__dirname, '..'), r._sourceFile)}\` |`);
    out.push('');

    // 触发条件
    if (r.trigger) {
      out.push('**触发**：');
      out.push('```');
      out.push(r.trigger);
      out.push('```');
      out.push('');
    } else if (r.tiers) {
      out.push('**触发（按顺序匹配，命中即停）**：');
      out.push('');
      for (const t of r.tiers) {
        out.push(`- ${t.priority}：\`${t.when}\``);
      }
      out.push('');
    } else if (r.handler) {
      out.push(`**触发**：调用 helper \`${r.handler}\`（详见 \`scripts/rule-helpers/\`）`);
      out.push('');
    }

    // 描述 / 行动 / SQL 模板
    if (r.descriptionTpl) {
      out.push('**说明文本**：');
      out.push('> ' + r.descriptionTpl.replace(/\n/g, '\n> '));
      out.push('');
    }
    if (r.currentValueTpl || r.recommendedValueTpl) {
      out.push('**值对照**：');
      if (r.currentValueTpl) out.push(`- 当前：\`${r.currentValueTpl}\``);
      if (r.recommendedValueTpl) out.push(`- 推荐：\`${r.recommendedValueTpl}\``);
      out.push('');
    }
    if (r.actionTpl) {
      out.push('**建议行动**：');
      out.push(`> ${r.actionTpl}`);
      out.push('');
    }
    if (r.sqlTpl) {
      out.push('**示例 SQL / 配置**：');
      out.push('```sql');
      out.push(r.sqlTpl);
      out.push('```');
      out.push('');
    }
    if (r.references && r.references.length) {
      out.push('**参考**：');
      for (const ref of r.references) out.push(`- ${ref}`);
      out.push('');
    }
    out.push('---');
    out.push('');
  }
}

out.push('');
out.push('## 配置化能力');
out.push('');
out.push('每条规则均支持以下三层覆盖（沿用 v4.8 机制）：');
out.push('');
out.push('1. **阈值覆盖**：在 `mysql-healthcheck.config.json` 写 `thresholds.<group>.<key>`');
out.push('2. **禁用规则**：`disabledRules: ["rule_id_1", "rule_id_2"]`');
out.push('3. **覆盖优先级**：`priorities: { "rule_id": "P3" }`');
out.push('');
out.push('Schema 详见 [`scripts/rules/SCHEMA.md`](../scripts/rules/SCHEMA.md)。');
out.push('');

fs.writeFileSync(outPath, out.join('\n'));
console.log(`✓ 生成 ${outPath}（${total} 条规则）`);
