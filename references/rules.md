# 巡检规则手册（v5.0 GA — 已退役为指针）

**v5.0 GA 起，本手册自动从 `scripts/rules/<dim>/*.json` 生成。**

完整的规则定义、触发条件、说明文本、建议行动、SQL 模板请见：

➡️ **[`references/rules-auto.md`](./rules-auto.md)** （自动生成，55 条规则覆盖 6 个维度）

## 快速入口

| 我想…… | 去哪里 |
|---|---|
| 看所有规则及触发条件 | [`rules-auto.md`](./rules-auto.md) |
| 改规则阈值 | `mysql-healthcheck.config.json` 里写 `thresholds.<group>.<key>` |
| 禁用某条规则 | `mysql-healthcheck.config.json` 里写 `disabledRules: ["rule_id"]` |
| 修改某条规则的优先级 | `mysql-healthcheck.config.json` 里写 `priorities.<rule_id>: "P3"` |
| 新增一条规则 | 在 `scripts/rules/<dim>/<id>.json` 加文件；复杂的在 `scripts/rule-helpers/index.js` 加 handler；详见 [`scripts/rules/SCHEMA.md`](../scripts/rules/SCHEMA.md) |
| 重新生成本文档 | `npm run gen-rules-md --prefix scripts` |

## 与 v4.x 的差异

| 维度 | v4.x | v5.0 GA |
|---|---|---|
| 规则定义位置 | `scripts/extract.js` 里 ~52 个 `if/else` + `push({...})` | `scripts/rules/<dim>/<id>.json` 声明式 |
| 复杂规则 | 全部在 JS 里 | 在 `rule-helpers/` 注册 handler（仍是 JS，但隔离） |
| 表达式求值 | 直接 JS | 自实现迷你 AST，零 `eval` |
| 客户能否查看 | 仅能读 `references/rules.md` 手写文档 | 可直接读 JSON 文件 + 自动生成的 markdown |
| 客户能否定制 | 仅阈值（v4.8 起）| 阈值 + disabledRules + priorities + PR JSON 文件 |
| 单元测试 | 无 | `tests/rule_engine_test.js` 32 个测试 |

历史版本（v4.x）的规则文档已归档至 git 历史（commit 之前 `references/rules.md`）。如需翻看：`git log --all --oneline references/rules.md`。
