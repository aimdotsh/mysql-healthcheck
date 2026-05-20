# Rule JSON Schema (v5.0)

本目录存放声明式巡检规则，由 `scripts/rule-engine.js` 加载并求值。

## 1. 设计原则

- **A/B/C/E 类规则纯 JSON**：threshold / 模板 / cfg 引用全部声明式
- **D/F 类复杂规则**：JSON 里填 `handler` 点名调用 `scripts/rule-helpers/` 下预注册的 JS 函数
- **零 `eval`**：表达式用自实现的迷你 AST 求值器（安全 + 可审计）
- **与 v4.8 三层配置兼容**：`{{cfg.thresholds.X.Y}}` 引用 hcConfig；`disabledRules` / `priorities` 覆盖机制保持不变

## 2. 文件组织

```
scripts/rules/
├── SCHEMA.md           ← 本文档
├── availability/
│   ├── mem_high.json
│   ├── swap_used.json
│   └── ...
├── performance/
│   ├── bp_hit_low.json
│   └── ...
├── durability/
├── security/
├── dataDesign/
└── operations/
```

**约定**：文件名 = 规则 `id` + `.json`；目录名 = 维度（dimension）。

## 3. JSON Schema

```jsonc
{
  // ===== 必填元数据 =====
  "id": "mem_high",                          // 唯一 ID，对应 issue.type
  "dimension": "availability",               // 6 个维度之一
  "scope": "node",                           // "node" | "cluster"
  "version": "5.0",                          // schema 版本

  // ===== 触发条件（三选一）=====

  // (A) 单阈值 — 最简形态
  "trigger": "node.memUsagePct > cfg.thresholds.memory.high_pct",
  "priority": "P1",

  // (B) 多档分级 — when 顺序求值，命中最早者
  "tiers": [
    { "when": "node.diskUsagePct >= cfg.thresholds.disk.critical_pct", "priority": "P0" },
    { "when": "node.diskUsagePct >= cfg.thresholds.disk.high_pct",     "priority": "P1" }
  ],

  // (F) Handler 转交 — 复杂逻辑（D/F 类）
  "handler": "evalParamInconsistent",        // 必须先在 rule-helpers/index.js 注册
  "priority": "P2",                          // 默认优先级，handler 可覆盖

  // ===== 输出模板（Mustache-lite）=====
  "groupKeyTpl": "mem_high:{{node.ip}}",     // 可选，issue 聚合 key
  "descriptionTpl": "节点 {{node.ip}} 内存使用率 {{node.memUsagePct}}% 超过阈值 {{cfg.thresholds.memory.high_pct}}%",
  "actionTpl": "排查内存占用大户，必要时扩容；检查 innodb_buffer_pool_size 设置是否过大",
  "sqlTpl": "SHOW VARIABLES LIKE 'innodb_buffer_pool%';",

  // ===== 可选字段 =====
  "currentValueTpl": "{{node.memUsagePct}}%",
  "recommendedValueTpl": "< {{cfg.thresholds.memory.high_pct}}%",
  "needsConfirmation": false,
  "nodeTpl": "{{node.ip}}",                  // 默认 = node.ip / node.hostname

  // ===== 文档元数据（用于 references/rules.md 生成）=====
  "title": "内存使用率过高",
  "rationale": "当 used / total > 90% 时，OS 进入 swap 概率上升，MySQL 响应延迟显著增加。",
  "references": [
    "https://dev.mysql.com/doc/refman/8.0/en/innodb-buffer-pool.html"
  ]
}
```

## 4. 表达式语言（trigger / when）

### 4.1 支持的运算符
- 比较：`>` `<` `>=` `<=` `==` `!=`
- 逻辑：`&&` `||` `!`
- 算术：`+` `-` `*` `/`
- 分组：`( )`

### 4.2 标识符路径
- `node.*`：当前节点对象（extract.js 解析出的 Node 结构）
- `cluster.*`：集群级数据（用于 cluster scope 规则）
- `cfg.*`：合并后的 hcConfig（含 thresholds / disabledRules / priorities）
- 字面量：数字、`'字符串'`、`true` / `false` / `null`

### 4.3 示例
```js
// 基础
node.memUsagePct > 90
node.variables.innodb_flush_log_at_trx_commit != '1'

// 引用 cfg 阈值
node.diskUsagePct >= cfg.thresholds.disk.critical_pct

// 多条件
node.swapUsed > 0 && node.memUsagePct > cfg.thresholds.memory.high_pct

// 嵌套字段
cluster.replicationDelay > cfg.thresholds.replication.delay_p1_seconds
```

### 4.4 **禁用** 的操作
- 函数调用（如 `Math.max(...)`） — 用 `handler` 转交
- 数组/对象字面量 — 复杂逻辑用 handler
- 三元 `? :` — 用 `tiers` 替代
- 副作用（赋值、自增） — 表达式纯求值

## 5. 模板渲染（`*Tpl` 字段）

Mustache-lite 语法：`{{path.to.value}}`

- 路径访问：`{{node.ip}}` → `192.168.1.10`
- 计算结果：模板里**不能**写表达式，只能引用变量。如需计算，先在 trigger / handler 里准备好
- **自动**可用变量：
  - `node.*` — 当前节点
  - `cfg.*` — 合并后配置
  - `match.*` — 触发时的中间结果（如 tiers 命中的 priority、handler 返回的 extras）
  - `value` — 触发值（如 memUsagePct 的 92.3）

## 6. Handler 接口（D/F 类）

```js
// scripts/rule-helpers/index.js
module.exports = {
  evalParamInconsistent: (ctx) => {
    // ctx = { nodes, node, cluster, cfg, rule }
    // 返回 0..N 个 issue patch（不带 type / dimension，由引擎补全）
    return [
      {
        priority: 'P2',
        match: { paramName: 'innodb_flush_log_at_trx_commit', distinctValues: 2 },
        // 引擎会用 rule.descriptionTpl 渲染并填入 match 上下文
      }
    ];
  },
};
```

Handler 职责仅是**计算 + 返回 patch 数组**；模板渲染、cfg/disabledRules/priorities 应用、字段补全都由引擎统一处理。

## 7. cfg / disabledRules / priorities 兼容性

引擎加载规则后：
1. 若 `cfg.disabledRules` 含 `rule.id` → **跳过该规则**（不参与求值）
2. 求值出 issue 后，若 `cfg.priorities[rule.id]` 存在 → 覆盖 priority
3. tiers 模式下，未命中任何 tier → 不产生 issue（与原 JS 行为一致）
4. `{{cfg.thresholds.X.Y}}` 模板插值 → 读合并后的值

## 8. 与原 JS 规则的迁移映射

| 原 push 字段 | 新 schema 字段 |
|---|---|
| `type` | `id` |
| `priority` | `priority` 或 `tiers[].priority` |
| `dimension` | `dimension` |
| `groupKey` | `groupKeyTpl`（支持插值） |
| `description` | `descriptionTpl` |
| `action` | `actionTpl` |
| `sql` | `sqlTpl` |
| `currentValue` | `currentValueTpl` |
| `recommendedValue` | `recommendedValueTpl` |
| `node` | `nodeTpl`（默认 `{{node.ip}}`） |
| `scope` | `scope` |
| `needsConfirmation` | `needsConfirmation` |

## 9. 规则 ID 命名约定

- snake_case
- 维度前缀 _不_ 写在 ID 里（目录已表达维度）
- 否定型用 `_off` / `_zero` / `_weak`（如 `slow_log_off`）
- 程度型用 `_high` / `_low` / `_too_small`（如 `mem_high`、`bp_too_small`）
- 复合型用 `_vs_` / `_too_X_Y`（如 `max_connections_vs_memory`）

## 10. 关于此 schema 的迭代

v5.0.0-alpha：覆盖 A/B 类（16 条简单规则），handler 字段保留但未启用
v5.0.0-beta：A/B/C/E 类（41 条）
v5.0.0：全部 52 条 + handler 机制 + references/rules.md 自动生成
