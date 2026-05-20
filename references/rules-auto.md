# 巡检规则手册（自动生成）

> **本文档由 `scripts/gen-rules-md.js` 从 `scripts/rules/*.json` 自动生成。请勿手动编辑。**
> 生成时间：2026-05-20　|　已迁移规则数：10

v5.0.0-alpha 阶段：仅已迁移到声明式 JSON 的规则在此列出。未迁移的规则仍由 `references/rules.md`（手写）覆盖。完整覆盖见 v5.0 GA。

---

## 总览

| 维度 | 规则数 |
|---|---|
| 可用性 (availability) | 2 |
| 持久化 (durability) | 5 |
| 性能 (performance) | 1 |
| 运维 (operations) | 2 |

## 可用性 (availability)

### `innodb_hll_high`

**InnoDB History List Length 偏高**

> undo 历史清理滞后，长事务/长查询阻塞 purge 线程；过大会影响读性能并占用大量回滚段。

| 字段 | 值 |
|---|---|
| 维度 | `availability` |
| Scope | `node` |
| 优先级（分级） | **P1 / P2** |
| 文件 | `scripts/rules/availability/innodb_hll_high.json` |

**触发（按顺序匹配，命中即停）**：

- P1：`node.innodb.historyListLength >= cfg.thresholds.innodb.hll_p1`
- P2：`node.innodb.historyListLength > cfg.thresholds.innodb.hll_warn`

**说明文本**：
> History List Length = {{node.innodb.historyListLength}}（超过 {{cfg.thresholds.innodb.hll_warn}} 预警线，undo 历史清理滞后）

**建议行动**：
> 排查长事务/长查询和 purge 线程压力；优先确认 PROCESSLIST 与 INNODB TRX 中是否存在长期未提交事务

**示例 SQL / 配置**：
```sql
SHOW ENGINE INNODB STATUS\G
SELECT * FROM information_schema.INNODB_TRX\G
SHOW FULL PROCESSLIST;
```

---

### `mem_high`

**内存使用率过高**

> OS 进入 swap 概率上升，MySQL 响应延迟显著增加。

| 字段 | 值 |
|---|---|
| 维度 | `availability` |
| Scope | `node` |
| 优先级 | **P1** |
| 文件 | `scripts/rules/availability/mem_high.json` |

**触发**：
```
node.memUsagePct > cfg.thresholds.memory.high_pct
```

**说明文本**：
> 内存使用率 {{node.memUsagePct}}% 偏高

**建议行动**：
> 关注业务负载与缓冲池配置，必要时扩容

---

## 持久化 (durability)

### `doublewrite_off`

**InnoDB doublewrite 关闭**

> 半页写（torn page）崩溃恢复时无法修复，性能收益 < 5% 但风险远大于收益。

| 字段 | 值 |
|---|---|
| 维度 | `durability` |
| Scope | `node` |
| 优先级 | **P1** |
| 文件 | `scripts/rules/durability/doublewrite_off.json` |

**触发**：
```
node.variables.innodb_doublewrite == 'OFF' || node.variables.innodb_doublewrite == '0'
```

**说明文本**：
> innodb_doublewrite = OFF — 半页写崩溃会导致页损坏且不可恢复（torn page），性能收益 < 5% 但风险远大于收益

**值对照**：
- 当前：`OFF`
- 推荐：`ON`

**建议行动**：
> 建议开启；仅在使用 ZFS 或支持原子写的存储（FusionIO 等）时才可考虑关闭

**示例 SQL / 配置**：
```sql
SET GLOBAL innodb_doublewrite = ON;
-- my.cnf:
innodb_doublewrite = 1
```

---

### `flush_log_weak`

**innodb_flush_log_at_trx_commit 弱化**

> 断电最多丢 1 秒事务。生产环境建议 1。

| 字段 | 值 |
|---|---|
| 维度 | `durability` |
| Scope | `node` |
| 优先级 | **P1** |
| 文件 | `scripts/rules/durability/flush_log_weak.json` |

**触发**：
```
node.variables.innodb_flush_log_at_trx_commit == '0'
```

**说明文本**：
> innodb_flush_log_at_trx_commit = 0（每秒一次刷盘，断电最多丢 1 秒事务）

**建议行动**：
> 生产环境建议改为 1；如对写性能敏感可设为 2（重启不丢，断电可能丢）

**示例 SQL / 配置**：
```sql
SET GLOBAL innodb_flush_log_at_trx_commit = 1;
-- 同时改 my.cnf 持久化
```

---

### `gtid_off`

**GTID 未启用**

> 无 GTID 时主从切换/迁移操作步骤复杂、错切位点风险高。

| 字段 | 值 |
|---|---|
| 维度 | `durability` |
| Scope | `node` |
| 优先级 | **P2** |
| 文件 | `scripts/rules/durability/gtid_off.json` |

**触发**：
```
node.variables.gtid_mode == 'OFF'
```

**说明文本**：
> gtid_mode = OFF（未启用 GTID）

**建议行动**：
> 建议规划升级到 GTID，简化故障切换与主从迁移

**示例 SQL / 配置**：
```sql
-- GTID 启用需顺序在所有节点滚动执行（不能同时）：
-- 1) SET GLOBAL gtid_mode = OFF_PERMISSIVE;
-- 2) SET GLOBAL enforce_gtid_consistency = WARN;
-- 3) SET GLOBAL enforce_gtid_consistency = ON;
-- 4) SET GLOBAL gtid_mode = ON_PERMISSIVE;
-- 5) 等所有节点 @@global.gtid_owned 为空
-- 6) SET GLOBAL gtid_mode = ON;
-- 7) my.cnf 加 gtid_mode=ON / enforce_gtid_consistency=ON
```

---

### `ibtmp1_no_max`

**innodb_temp_data_file_path 未设 :max: 上限**

> ibtmp1 无上限会无限增长直至打爆磁盘。

| 字段 | 值 |
|---|---|
| 维度 | `durability` |
| Scope | `node` |
| 优先级 | **P2** |
| 文件 | `scripts/rules/durability/ibtmp1_no_max.json` |

**触发**：
```
node.ibtmp1NoMax == true
```

**说明文本**：
> innodb_temp_data_file_path 未配置 :max: 上限（{{node.variables.innodb_temp_data_file_path}}）

**建议行动**：
> 建议加 :max:50G 上限，避免临时表无限增长打爆磁盘

**示例 SQL / 配置**：
```sql
-- my.cnf:
innodb_temp_data_file_path = ibtmp1:12M:autoextend:max:50G
```

---

### `sync_binlog_weak`

**sync_binlog 弱化**

> binlog 依赖 OS 刷盘，断电/崩溃可能丢失事件。

| 字段 | 值 |
|---|---|
| 维度 | `durability` |
| Scope | `node` |
| 优先级 | **P1** |
| 文件 | `scripts/rules/durability/sync_binlog_weak.json` |

**触发**：
```
node.variables.sync_binlog == '0'
```

**说明文本**：
> sync_binlog = 0（binlog 依赖 OS 刷盘，可能丢失事件）

**建议行动**：
> 主库建议设为 1（每事务刷盘）；高并发可考虑 100（每 100 事务）

**示例 SQL / 配置**：
```sql
SET GLOBAL sync_binlog = 1;
-- 同时改 my.cnf 持久化
```

---

## 性能 (performance)

### `long_query_time_loose`

**long_query_time 阈值过宽**

> 慢日志门槛过高时大量真实慢 SQL 会被漏掉。

| 字段 | 值 |
|---|---|
| 维度 | `performance` |
| Scope | `node` |
| 优先级 | **P3** |
| 文件 | `scripts/rules/performance/long_query_time_loose.json` |

**触发**：
```
node.variables.long_query_time >= cfg.thresholds.sql.long_query_time_loose
```

**说明文本**：
> long_query_time = {{node.variables.long_query_time}}（阈值过宽，应 < {{cfg.thresholds.sql.long_query_time_loose}}）

**建议行动**：
> 建议设为 1 秒以更敏感地捕获慢 SQL

---

## 运维 (operations)

### `performance_schema_off`

**performance_schema 关闭**

> 无法使用 sys.* TOP SQL；监控工具（PMM / Prometheus mysqld_exporter）缺核心指标。

| 字段 | 值 |
|---|---|
| 维度 | `operations` |
| Scope | `node` |
| 优先级 | **P2** |
| 文件 | `scripts/rules/operations/performance_schema_off.json` |

**触发**：
```
node.variables.performance_schema == 'OFF'
```

**说明文本**：
> performance_schema = OFF — 无法使用 sys.statement_analysis / events_statements_summary_by_digest 等做 TOP SQL；监控工具（PMM / Prometheus mysqld_exporter）会缺核心指标

**值对照**：
- 当前：`OFF`
- 推荐：`ON`

**建议行动**：
> 开启 P_S；约占 400-600 MB 内存，对 OLTP 影响 < 5%

**示例 SQL / 配置**：
```sql
-- my.cnf:
performance_schema = ON
# 重启 MySQL 生效
```

---

### `slow_log_off`

**慢日志未开启**

> 无法做 SQL 性能审计；推荐生产环境强制开启。

| 字段 | 值 |
|---|---|
| 维度 | `operations` |
| Scope | `node` |
| 优先级 | **P2** |
| 文件 | `scripts/rules/operations/slow_log_off.json` |

**触发**：
```
node.variables.slow_query_log == '0'
```

**说明文本**：
> slow_query_log = 0（慢日志未开启）

**建议行动**：
> 建议开启慢日志，便于性能审计

**示例 SQL / 配置**：
```sql
SET GLOBAL slow_query_log = 1;
SET GLOBAL long_query_time = 1;
```

---


## 配置化能力

每条规则均支持以下三层覆盖（沿用 v4.8 机制）：

1. **阈值覆盖**：在 `mysql-healthcheck.config.json` 写 `thresholds.<group>.<key>`
2. **禁用规则**：`disabledRules: ["rule_id_1", "rule_id_2"]`
3. **覆盖优先级**：`priorities: { "rule_id": "P3" }`

Schema 详见 [`scripts/rules/SCHEMA.md`](../scripts/rules/SCHEMA.md)。
