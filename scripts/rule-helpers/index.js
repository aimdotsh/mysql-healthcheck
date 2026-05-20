// rule-helpers/index.js — D/F 类复杂规则的 handler 注册表
//
// 当 rule JSON 里写 `"handler": "evalParamInconsistent"` 时，引擎会查这里。
// Handler 接口（详见 scripts/rules/SCHEMA.md §6）：
//
//   (ctx) → Array<{ priority?, match?, value? }>
//
// 其中 ctx = { nodes, node, cluster, cfg, rule }；返回的每个 patch 会被
// 引擎用 rule.descriptionTpl / actionTpl / sqlTpl 渲染为完整 issue 对象。
//
// v5.0.0-alpha：本文件仅是骨架，A/B 类规则不需要 handler。
//               D/F 类（如 param_inconsistent / max_connections_vs_memory /
//               auto_increment_exhausting）将在 v5.0.0-beta 阶段填入这里。

'use strict';

const helpers = {
  // 占位示例 — 真正实现在 v5.0.0-beta 起填入
  //
  // evalParamInconsistent: (ctx) => {
  //   const { nodes, cfg } = ctx;
  //   const keys = ['innodb_flush_log_at_trx_commit', 'sync_binlog', ...];
  //   const out = [];
  //   for (const k of keys) {
  //     const vals = new Set(nodes.map(n => n.variables?.[k]).filter(v => v != null));
  //     if (vals.size > 1) {
  //       out.push({
  //         priority: 'P2',
  //         match: { paramName: k, distinctValues: vals.size, values: [...vals].join(', ') },
  //       });
  //     }
  //   }
  //   return out;
  // },
};

module.exports = helpers;
