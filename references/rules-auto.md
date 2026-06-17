# 巡检规则手册（自动生成）

> **本文档由 `scripts/gen-rules-md.js` 从 `scripts/rules/*.json` 自动生成。请勿手动编辑。**
> 生成时间：2026-06-17　|　规则总数：50

v5.0 GA：所有 ~51 条巡检规则（节点级 + 集群级）全部以声明式 JSON 描述，由 `scripts/rule-engine.js` 加载并求值；复杂规则通过 `scripts/rule-helpers/index.js` 注册的 handler 计算。详细 schema 见 [`scripts/rules/SCHEMA.md`](../scripts/rules/SCHEMA.md)。

某条规则不适用于客户场景时，可在 `mysql-healthcheck.config.json` 加 `disabledRules: ["rule_id"]` 关闭；阈值类规则通过 `thresholds.<group>.<key>` 覆盖；任意规则可通过 `priorities.<rule_id>: "P3"` 改优先级。

---

## 总览

| 维度 | 规则数 |
|---|---|
| 可用性 (availability) | 10 |
| 持久化 (durability) | 13 |
| 性能 (performance) | 9 |
| 安全 (security) | 5 |
| 数据设计 (dataDesign) | 7 |
| 运维 (operations) | 6 |

## 可用性 (availability)

### `disks`

**磁盘使用率告警（含光驱/ISO/可移动介质识别）**

> 高使用率磁盘是 P0 故障源；但需识别光驱/安装 ISO 等设计性 100% 占用，避免误报。

| 字段 | 值 |
|---|---|
| 维度 | `availability` |
| Scope | `node` |
| Handler | `evalDisks` |
| 文件 | `scripts/rules/availability.json` |

**触发**：调用 helper `evalDisks`（详见 `scripts/rule-helpers/`）

---

### `innodb_hll`

**InnoDB History List Length 偏高**

> undo 历史清理滞后，长事务阻塞 purge；过大会拉低读性能并占用回滚段。

| 字段 | 值 |
|---|---|
| 维度 | `availability` |
| Scope | `node` |
| Handler | `evalInnodbHll` |
| 文件 | `scripts/rules/availability.json` |

**触发**：调用 helper `evalInnodbHll`（详见 `scripts/rule-helpers/`）

---

### `long_running_session`

**长时间运行会话**

> 可能阻塞 purge、消耗资源；需人工确认业务影响后再决定是否 KILL。

| 字段 | 值 |
|---|---|
| 维度 | `availability` |
| Scope | `node` |
| Handler | `evalLongRunningSession` |
| 文件 | `scripts/rules/availability.json` |

**触发**：调用 helper `evalLongRunningSession`（详见 `scripts/rule-helpers/`）

---

### `max_connections_vs_memory`

**max_connections × 单连接 buffer 超 RAM**

> 并发上来时所有连接都按峰值分配，可能触发 OOM。

| 字段 | 值 |
|---|---|
| 维度 | `availability` |
| Scope | `node` |
| Handler | `evalMaxConnectionsVsMemory` |
| 文件 | `scripts/rules/availability.json` |

**触发**：调用 helper `evalMaxConnectionsVsMemory`（详见 `scripts/rule-helpers/`）

---

### `mem_high`

**内存使用率过高**

> OS 进入 swap 概率上升，MySQL 响应延迟显著增加。

| 字段 | 值 |
|---|---|
| 维度 | `availability` |
| Scope | `node` |
| 优先级 | **P1** |
| 文件 | `scripts/rules/availability.json` |

**触发**：
```
node.memUsagePct > cfg.thresholds.memory.high_pct
```

**说明文本**：
> 内存使用率 {{node.memUsagePct}}% 偏高

**建议行动**：
> 关注业务负载与缓冲池配置，必要时扩容

---

### `os_version_eol`

**操作系统版本已停止维护**

> EOL 系统不再接收安全补丁，存在合规与安全风险。

| 字段 | 值 |
|---|---|
| 维度 | `availability` |
| Scope | `node` |
| Handler | `evalOsVersionEol` |
| 文件 | `scripts/rules/availability.json` |

**触发**：调用 helper `evalOsVersionEol`（详见 `scripts/rule-helpers/`）

---

### `replication`

**复制线程与延迟**

> thread_down 立即影响可用性；secondsBehindMaster 分级反映恢复 RPO 风险。

| 字段 | 值 |
|---|---|
| 维度 | `availability` |
| Scope | `node` |
| Handler | `evalReplication` |
| 文件 | `scripts/rules/availability.json` |

**触发**：调用 helper `evalReplication`（详见 `scripts/rule-helpers/`）

---

### `role_read_only`

**主从角色与 read_only 一致性**

> 主库错误置为只读 → 写入失败；从库可写 → 数据漂移；DR 灾备节点切换设计需识别区分。

| 字段 | 值 |
|---|---|
| 维度 | `availability` |
| Scope | `node` |
| Handler | `evalRoleReadOnly` |
| 文件 | `scripts/rules/availability.json` |

**触发**：调用 helper `evalRoleReadOnly`（详见 `scripts/rule-helpers/`）

---

### `slave_parallel_workers_zero`

**从库未启用并行复制 + 集群数据量大**

> 单线程应用 binlog 在大事务下会延迟积压。

| 字段 | 值 |
|---|---|
| 维度 | `availability` |
| Scope | `node` |
| Handler | `evalSlaveParallelWorkersZero` |
| 文件 | `scripts/rules/availability.json` |

**触发**：调用 helper `evalSlaveParallelWorkersZero`（详见 `scripts/rule-helpers/`）

---

### `swap_used`

**Swap 已被使用**

> OS 进入 swap，MySQL 响应延迟会显著拉长。关联 buffer_pool + 每连接 buffer × max_connections 计算内存预算，定位是否内存超配导致换出。

| 字段 | 值 |
|---|---|
| 维度 | `availability` |
| Scope | `node` |
| 优先级 | **P1** |
| Handler | `evalSwapUsed` |
| 文件 | `scripts/rules/availability.json` |

**触发**：调用 helper `evalSwapUsed`（详见 `scripts/rule-helpers/`）

---

## 持久化 (durability)

### `binlog_format_not_row`

**binlog_format 非 ROW**

> STATEMENT 模式在存储函数/触发器/UUID 等场景下会产生主从不一致；ROW 是并行复制和 GTID 的推荐格式。

| 字段 | 值 |
|---|---|
| 维度 | `durability` |
| Scope | `node` |
| 优先级 | **P2** |
| 文件 | `scripts/rules/durability.json` |

**触发**：
```
(node.variables.log_bin == 'ON' || node.variables.log_bin == '1') && node.variables.binlog_format != null && node.variables.binlog_format != 'ROW'
```

**说明文本**：
> binlog_format = {{node.variables.binlog_format}}（非 ROW），存储函数/触发器/UUID 等场景可能导致主从不一致；ROW 是并行复制和 GTID 的推荐格式

**值对照**：
- 当前：`{{node.variables.binlog_format}}`
- 推荐：`ROW`

**建议行动**：
> 切换为 ROW 格式；同时开启 binlog_row_image=FULL（默认值）

**示例 SQL / 配置**：
```sql
SET GLOBAL binlog_format = ROW;
-- my.cnf:
binlog_format = ROW
binlog_row_image = FULL
```

---

### `doublewrite_off`

**InnoDB doublewrite 关闭**

> 半页写（torn page）崩溃恢复时无法修复，性能收益 < 5% 但风险远大于收益。

| 字段 | 值 |
|---|---|
| 维度 | `durability` |
| Scope | `node` |
| 优先级 | **P1** |
| 文件 | `scripts/rules/durability.json` |

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

### `dual_master_write_conflict`

**双主写冲突**

> 双主双写同一主键导致复制 SQL 线程中止、两库数据已分叉。点名冲突表，给出选定权威端 + 重建复制 + 自增拆分的处置。

| 字段 | 值 |
|---|---|
| 维度 | `durability` |
| Scope | `node` |
| 优先级 | **P0** |
| Handler | `evalDualMasterWriteConflict` |
| 文件 | `scripts/rules/durability.json` |

**触发**：调用 helper `evalDualMasterWriteConflict`（详见 `scripts/rule-helpers/`）

---

### `expire_logs_long`

**expire_logs_days 保留过长**

> 保留过长会占用磁盘空间；评估业务回滚需求。

| 字段 | 值 |
|---|---|
| 维度 | `durability` |
| Scope | `node` |
| 优先级 | **P3** |
| 文件 | `scripts/rules/durability.json` |

**触发**：
```
node.variables.expire_logs_days != '0' && node.variables.expire_logs_days > cfg.thresholds.binlog.expire_logs_max_days
```

**说明文本**：
> expire_logs_days = {{node.variables.expire_logs_days}}（保留过长，> {{cfg.thresholds.binlog.expire_logs_max_days}} 天）

**建议行动**：
> 评估磁盘成本与回滚需求

---

### `expire_logs_zero`

**expire_logs_days = 0**

> binlog 永不过期，存在磁盘打爆风险。

| 字段 | 值 |
|---|---|
| 维度 | `durability` |
| Scope | `node` |
| 优先级 | **P1** |
| 文件 | `scripts/rules/durability.json` |

**触发**：
```
node.variables.expire_logs_days == '0'
```

**说明文本**：
> expire_logs_days = 0（binlog 永不过期，存在磁盘打爆风险）

**建议行动**：
> 建议改为 7-15 天；并尽快手工清理冗余 binlog

**示例 SQL / 配置**：
```sql
SET GLOBAL expire_logs_days = 7;
PURGE BINARY LOGS BEFORE NOW() - INTERVAL 7 DAY;
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
| 文件 | `scripts/rules/durability.json` |

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
| 文件 | `scripts/rules/durability.json` |

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
| 文件 | `scripts/rules/durability.json` |

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

### `ibtmp1_oversize`

**ibtmp1 超大**

> 临时表空间无上限，已增长到危险体积。追因落盘临时表 TOP SQL，并提示开启 performance_schema 精确定位元凶。

| 字段 | 值 |
|---|---|
| 维度 | `durability` |
| Scope | `node` |
| 优先级 | **P2** |
| Handler | `evalIbtmp1Oversize` |
| 文件 | `scripts/rules/durability.json` |

**触发**：调用 helper `evalIbtmp1Oversize`（详见 `scripts/rule-helpers/`）

---

### `log_bin_off`

**binlog 未开启**

> binlog 是 PITR 和主从复制的前提；关闭后崩溃只能全量恢复，无法做时间点恢复。

| 字段 | 值 |
|---|---|
| 维度 | `durability` |
| Scope | `node` |
| 优先级 | **P1** |
| 文件 | `scripts/rules/durability.json` |

**触发**：
```
node.variables.log_bin == 'OFF' || node.variables.log_bin == '0'
```

**说明文本**：
> log_bin = OFF — binlog 未开启，无法做 PITR（时间点恢复）且无法搭建主从复制

**值对照**：
- 当前：`OFF`
- 推荐：`ON`

**建议行动**：
> 开启 binlog；同时建议配合 expire_logs_days / binlog_expire_logs_seconds 设置保留期，避免磁盘打爆

**示例 SQL / 配置**：
```sql
-- my.cnf:
log_bin = mysql-bin
binlog_format = ROW
expire_logs_days = 7
# 重启 MySQL 生效
```

---

### `self_ref_slave_residue`

**self-referencing slave 残留**

> Master_Host 指向本机，通常是历史从库被提升为主后未 RESET SLAVE ALL。

| 字段 | 值 |
|---|---|
| 维度 | `durability` |
| Scope | `node` |
| 优先级 | **P2** |
| 文件 | `scripts/rules/durability.json` |

**触发**：
```
node.selfRefSlaveHost != null
```

**说明文本**：
> 节点 {{node.ip}} 存在 SHOW SLAVE STATUS 残留（Master_Host 指向自身 {{node.selfRefSlaveHost}}），通常是历史从库被提升为主后未执行 RESET SLAVE ALL

**建议行动**：
> 执行 STOP SLAVE; RESET SLAVE ALL; 清理残留复制元数据，避免 SHOW SLAVE STATUS 输出误导监控/巡检工具

**示例 SQL / 配置**：
```sql
STOP SLAVE;
RESET SLAVE ALL;
```

---

### `slave_skip_errors_set`

**slave_skip_errors 已设置**

> 复制错误被强制跳过，从库数据漂移；任何 binlog 错误都不会再暴露。

| 字段 | 值 |
|---|---|
| 维度 | `durability` |
| Scope | `node` |
| 优先级 | **P0** |
| 文件 | `scripts/rules/durability.json` |

**触发**：
```
node.slaveSkipErrorsSet == true
```

**说明文本**：
> slave_skip_errors = {{node.slaveSkipErrorsValue}} — 复制错误被强制跳过，从库已经/将会与主库数据不一致；任何 binlog 错误都不会再暴露

**值对照**：
- 当前：`{{node.slaveSkipErrorsValue}}`
- 推荐：`OFF`

**建议行动**：
> 建议尽快关闭；并用 pt-table-checksum / pt-table-sync 校验现有数据一致性

**示例 SQL / 配置**：
```sql
# slave_skip_errors 不能动态改，必须修改 my.cnf:
# 删除该行或改为：
slave_skip_errors = OFF
# 重启 slave 后校验数据：
pt-table-checksum --replicate=percona.checksums h=<primary>,u=<user>,p=<pwd>
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
| 文件 | `scripts/rules/durability.json` |

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

### `bp_hit`

**Buffer Pool 命中率分级**

> 命中率 < 95% 严重；< 99% 关注。

| 字段 | 值 |
|---|---|
| 维度 | `performance` |
| Scope | `node` |
| Handler | `evalBpHit` |
| 文件 | `scripts/rules/performance.json` |

**触发**：调用 helper `evalBpHit`（详见 `scripts/rule-helpers/`）

---

### `buffer_pool_size`

**InnoDB Buffer Pool 与 RAM 比例**

> 过小（< 40% RAM）→ 命中率低、IO 拖累；过大（> 80% RAM）→ OS/连接无余量，OOM/Swap 风险。

| 字段 | 值 |
|---|---|
| 维度 | `performance` |
| Scope | `node` |
| Handler | `evalBufferPoolSize` |
| 文件 | `scripts/rules/performance.json` |

**触发**：调用 helper `evalBufferPoolSize`（详见 `scripts/rule-helpers/`）

---

### `data_to_memory_ratio_high`

**数据集 vs RAM 比例过高**

> 工作集装不下 buffer pool，会持续磁盘 IO；架构层调整。

| 字段 | 值 |
|---|---|
| 维度 | `performance` |
| Scope | `node` |
| Handler | `evalDataToMemoryRatio` |
| 文件 | `scripts/rules/performance.json` |

**触发**：调用 helper `evalDataToMemoryRatio`（详见 `scripts/rule-helpers/`）

---

### `file_per_table_off`

**innodb_file_per_table 关闭**

> 共享表空间（ibdata）不可收缩；DROP TABLE 不释放空间；难以做表级备份/传输。

| 字段 | 值 |
|---|---|
| 维度 | `performance` |
| Scope | `node` |
| 优先级 | **P2** |
| 文件 | `scripts/rules/performance.json` |

**触发**：
```
node.variables.innodb_file_per_table == 'OFF' || node.variables.innodb_file_per_table == '0'
```

**说明文本**：
> innodb_file_per_table = OFF — 所有表共享 ibdata，DROP TABLE 不释放磁盘空间，且无法做表级传输/备份

**值对照**：
- 当前：`OFF`
- 推荐：`ON`

**建议行动**：
> 开启 innodb_file_per_table；存量表需要 OPTIMIZE TABLE 或 ALTER TABLE FORCE 才能迁移到独立表空间

**示例 SQL / 配置**：
```sql
SET GLOBAL innodb_file_per_table = ON;
-- my.cnf:
innodb_file_per_table = 1
```

---

### `flush_method_not_o_direct`

**Linux 下 innodb_flush_method 非 O_DIRECT**

> OS page cache + buffer pool 双重缓存，浪费内存并增加冗余 IO。

| 字段 | 值 |
|---|---|
| 维度 | `performance` |
| Scope | `node` |
| 优先级 | **P2** |
| 文件 | `scripts/rules/performance.json` |

**触发**：
```
node.flushMethodNotODirect == true
```

**说明文本**：
> innodb_flush_method = {{node.variables.innodb_flush_method}} — Linux 下默认 fsync 会同时占用 OS page cache 与 buffer pool（双重缓存），浪费内存并增加冗余 IO

**值对照**：
- 当前：`{{node.variables.innodb_flush_method}}`
- 推荐：`O_DIRECT`

**建议行动**：
> Linux 推荐 O_DIRECT；该参数不可动态修改，需重启 MySQL

**示例 SQL / 配置**：
```sql
-- my.cnf:
innodb_flush_method = O_DIRECT
# 重启 MySQL 生效
```

---

### `heavy_frag_tables`

**高碎片大表**

> 碎片≥70%+ 且 free≥100MB 的表，扫描成本浪费明显。

| 字段 | 值 |
|---|---|
| 维度 | `performance` |
| Scope | `node` |
| Handler | `evalHeavyFragTables` |
| 文件 | `scripts/rules/performance.json` |

**触发**：调用 helper `evalHeavyFragTables`（详见 `scripts/rule-helpers/`）

---

### `long_query_time_loose`

**long_query_time 阈值过宽**

> 慢日志门槛过高时大量真实慢 SQL 会被漏掉。

| 字段 | 值 |
|---|---|
| 维度 | `performance` |
| Scope | `node` |
| 优先级 | **P3** |
| 文件 | `scripts/rules/performance.json` |

**触发**：
```
node.variables.long_query_time >= cfg.thresholds.sql.long_query_time_loose
```

**说明文本**：
> long_query_time = {{node.variables.long_query_time}}（阈值过宽，应 < {{cfg.thresholds.sql.long_query_time_loose}}）

**建议行动**：
> 建议设为 1 秒以更敏感地捕获慢 SQL

---

### `redo_log_too_small`

**InnoDB redo log 偏小**

> 频繁切换拉低写吞吐 + 放大恢复时间。

| 字段 | 值 |
|---|---|
| 维度 | `performance` |
| Scope | `node` |
| Handler | `evalRedoLog` |
| 文件 | `scripts/rules/performance.json` |

**触发**：调用 helper `evalRedoLog`（详见 `scripts/rule-helpers/`）

---

### `slow_queries_abs`

**累计慢查询数量分级**

> 1M+ 次需立即治理；100K-1M 次需定期分析。

| 字段 | 值 |
|---|---|
| 维度 | `performance` |
| Scope | `node` |
| Handler | `evalSlowQueriesAbs` |
| 文件 | `scripts/rules/performance.json` |

**触发**：调用 helper `evalSlowQueriesAbs`（详见 `scripts/rule-helpers/`）

---

## 安全 (security)

### `auth_plugin_native_on_80`

**MySQL 8.0+ 默认 mysql_native_password**

> 派生 SHA1 已弃用；8.4 起默认 disabled。

| 字段 | 值 |
|---|---|
| 维度 | `security` |
| Scope | `node` |
| 优先级 | **P2** |
| 文件 | `scripts/rules/security.json` |

**触发**：
```
node.authPluginNativeOn80 == true
```

**说明文本**：
> MySQL 8.0+ 默认认证插件仍为 mysql_native_password — 该插件派生 SHA1，已被弃用；8.4 起 mysql_native_password 默认 disabled

**值对照**：
- 当前：`mysql_native_password`
- 推荐：`caching_sha2_password`

**建议行动**：
> 新账号默认走 caching_sha2_password；存量账号灰度迁移；客户端驱动需 ≥ Connector/J 8.0、PyMySQL 1.0+

**示例 SQL / 配置**：
```sql
-- my.cnf:
default_authentication_plugin = caching_sha2_password
-- 单账号迁移：
ALTER USER 'app'@'10.%' IDENTIFIED WITH caching_sha2_password BY '<pwd>';
```

---

### `tls_weak_protocol`

**TLS 配置含已废弃协议**

> TLSv1 / TLSv1.1 存在已知漏洞，仅应保留 TLSv1.2+。

| 字段 | 值 |
|---|---|
| 维度 | `security` |
| Scope | `node` |
| 优先级 | **P2** |
| 文件 | `scripts/rules/security.json` |

**触发**：
```
node.tlsWeakDetail != null
```

**说明文本**：
> TLS 配置包含已废弃协议：{{node.tlsWeakDetail}}

**建议行动**：
> 禁用 TLSv1/TLSv1.1，仅保留 TLSv1.2+；同时确认业务客户端驱动版本兼容

---

### `validate_password_off`

**密码强度校验插件未启用**

> 无 validate_password 时用户可设任意短/简单密码；配合弱密码检测规则效果更强。

| 字段 | 值 |
|---|---|
| 维度 | `security` |
| Scope | `node` |
| 优先级 | **P2** |
| 文件 | `scripts/rules/security.json` |

**触发**：
```
node.hasPasswordPolicy != true
```

**说明文本**：
> validate_password 插件未启用 — 用户可设置任意弱密码，与弱密码检测结果共同参考

**值对照**：
- 当前：`未启用`
- 推荐：`启用 validate_password（policy=MEDIUM）`

**建议行动**：
> 安装并启用 validate_password 插件，建议 policy=MEDIUM（8 字符 + 数字 + 大小写 + 特殊字符）

**示例 SQL / 配置**：
```sql
-- MySQL 5.7:
INSTALL PLUGIN validate_password SONAME 'validate_password.so';
SET GLOBAL validate_password_policy = MEDIUM;
SET GLOBAL validate_password_length = 8;
-- MySQL 8.0+:
INSTALL COMPONENT 'file://component_validate_password';
SET GLOBAL validate_password.policy = MEDIUM;
SET GLOBAL validate_password.length = 8;
```

---

### `weak_password`

**弱密码账号（库内字典比对，哈希不出库）**

> 常见弱密码账号是入侵突破口；仅检测 mysql_native_password，caching_sha2 加盐不可离线比对。

| 字段 | 值 |
|---|---|
| 维度 | `security` |
| Scope | `node` |
| Handler | `evalWeakPassword` |
| 文件 | `scripts/rules/security.json` |

**触发**：调用 helper `evalWeakPassword`（详见 `scripts/rule-helpers/`）

---

### `wildcard_users`

**host=% 用户安全分级**

> root/admin → P0；复制/备份/监控 → P1；业务用户 → P2。

| 字段 | 值 |
|---|---|
| 维度 | `security` |
| Scope | `node` |
| Handler | `evalWildcardUsers` |
| 文件 | `scripts/rules/security.json` |

**触发**：调用 helper `evalWildcardUsers`（详见 `scripts/rule-helpers/`）

---

## 数据设计 (dataDesign)

### `auto_increment_exhausting`

**自增列接近耗尽**

> INT UNSIGNED 上限 ~42 亿，耗尽后 INSERT 报错；建议提前扩 BIGINT。

| 字段 | 值 |
|---|---|
| 维度 | `dataDesign` |
| Scope | `node` |
| Handler | `evalAutoIncrementExhausting` |
| 文件 | `scripts/rules/dataDesign.json` |

**触发**：调用 helper `evalAutoIncrementExhausting`（详见 `scripts/rule-helpers/`）

---

### `charset_not_utf8mb4`

**character_set_server 非 utf8mb4**

> utf8 实际是 utf8mb3，已被 MySQL 标记 deprecated；无法存 emoji。

| 字段 | 值 |
|---|---|
| 维度 | `dataDesign` |
| Scope | `node` |
| 优先级 | **P2** |
| 文件 | `scripts/rules/dataDesign.json` |

**触发**：
```
node.charsetNotUtf8mb4 == true
```

**说明文本**：
> character_set_server = {{node.variables.character_set_server}}，无法存储 emoji / 4 字节字符；utf8 实际是 utf8mb3，已被 MySQL 标记为 deprecated

**值对照**：
- 当前：`{{node.variables.character_set_server}}`
- 推荐：`utf8mb4`

**建议行动**：
> 服务端 + 库 + 表 + 列四级都需要改；新建表前先改服务端默认，存量表用 CONVERT TO

**示例 SQL / 配置**：
```sql
-- my.cnf:
character_set_server = utf8mb4
collation_server = utf8mb4_0900_ai_ci  # MySQL 8.0
# collation_server = utf8mb4_general_ci  # MySQL 5.7
-- 库级转换：
ALTER DATABASE <dbname> CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
```

---

### `default_engine_not_innodb`

**default_storage_engine 非 InnoDB**

> 非 InnoDB 引擎（MyISAM/MEMORY 等）无事务/外键/崩溃恢复能力；误建非 InnoDB 表是常见数据丢失场景。

| 字段 | 值 |
|---|---|
| 维度 | `dataDesign` |
| Scope | `node` |
| 优先级 | **P2** |
| 文件 | `scripts/rules/dataDesign.json` |

**触发**：
```
node.variables.default_storage_engine != null && node.variables.default_storage_engine != 'InnoDB'
```

**说明文本**：
> default_storage_engine = {{node.variables.default_storage_engine}}（非 InnoDB）— 新建表将默认使用该引擎，无事务/崩溃恢复保障

**值对照**：
- 当前：`{{node.variables.default_storage_engine}}`
- 推荐：`InnoDB`

**建议行动**：
> 改为 InnoDB；并检查已有非 InnoDB 表是否需要迁移

**示例 SQL / 配置**：
```sql
SET GLOBAL default_storage_engine = InnoDB;
-- my.cnf:
default_storage_engine = InnoDB
```

---

### `ghost_tables`

**gh-ost / pt-osc 残留 ghost 表**

> 在线 DDL 未清理的中间表，占空间，确认无业务引用可 DROP。

| 字段 | 值 |
|---|---|
| 维度 | `dataDesign` |
| Scope | `node` |
| Handler | `evalGhostTables` |
| 文件 | `scripts/rules/dataDesign.json` |

**触发**：调用 helper `evalGhostTables`（详见 `scripts/rule-helpers/`）

---

### `no_pk_tables`

**无主键表**

> ROW 复制下全表扫描匹配，无法 MTS 并行；区分业务/临时降级。

| 字段 | 值 |
|---|---|
| 维度 | `dataDesign` |
| Scope | `node` |
| Handler | `evalNoPkTables` |
| 文件 | `scripts/rules/dataDesign.json` |

**触发**：调用 helper `evalNoPkTables`（详见 `scripts/rule-helpers/`）

---

### `non_utf8_tables`

**非 utf8/utf8mb4 表**

> 无法存储 emoji / 4 字节字符；统一字符集减少业务踩坑。

| 字段 | 值 |
|---|---|
| 维度 | `dataDesign` |
| Scope | `node` |
| Handler | `evalNonUtf8Tables` |
| 文件 | `scripts/rules/dataDesign.json` |

**触发**：调用 helper `evalNonUtf8Tables`（详见 `scripts/rule-helpers/`）

---

### `sql_mode_missing_strict`

**sql_mode 缺少 STRICT_TRANS_TABLES**

> 宽松模式下错误数据被静默截断（INT 越界写 0、字符串超长被裁），存在数据完整性风险。

| 字段 | 值 |
|---|---|
| 维度 | `dataDesign` |
| Scope | `node` |
| 优先级 | **P2** |
| 文件 | `scripts/rules/dataDesign.json` |

**触发**：
```
node.sqlModeMissingStrict == true
```

**说明文本**：
> sql_mode 未包含 STRICT_TRANS_TABLES — 错误数据会被静默截断（INT 越界写 0、字符串超长被裁），存在数据完整性风险

**值对照**：
- 当前：`{{node.sqlModeStr}}`
- 推荐：`加上 STRICT_TRANS_TABLES + NO_ENGINE_SUBSTITUTION`

**建议行动**：
> 评估业务影响（旧应用可能依赖宽松模式静默成功）后再切换；建议先在测试环境验证

**示例 SQL / 配置**：
```sql
SET GLOBAL sql_mode = CONCAT(@@sql_mode, ',STRICT_TRANS_TABLES');
-- 评估后持久化到 my.cnf:
sql_mode = STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO
```

---

## 运维 (operations)

### `lct_zero_linux`

**Linux 下 lower_case_table_names=0**

> 大小写敏感导致跨平台迁移容易报 ER_NO_SUCH_TABLE。

| 字段 | 值 |
|---|---|
| 维度 | `operations` |
| Scope | `node` |
| 优先级 | **P3** |
| 文件 | `scripts/rules/operations.json` |

**触发**：
```
node.lctZeroLinux == true
```

**说明文本**：
> lower_case_table_names = 0（Linux 下大小写敏感，存在跨平台迁移风险）

**建议行动**：
> 若需 Windows/macOS 兼容，建议设为 1（注意：MySQL 8.0 只能在 initdb 时设置）

---

### `mysql_version_eol`

**MySQL 版本接近/已 EOL**

> EOL 版本不再有安全补丁，应规划升级。

| 字段 | 值 |
|---|---|
| 维度 | `operations` |
| Scope | `node` |
| Handler | `evalMysqlVersionEol` |
| 文件 | `scripts/rules/operations.json` |

**触发**：调用 helper `evalMysqlVersionEol`（详见 `scripts/rule-helpers/`）

---

### `param_inconsistent`

**集群级参数不一致**

> 节点间关键参数差异会导致故障切换后行为不可预测。

| 字段 | 值 |
|---|---|
| 维度 | `operations` |
| Scope | `cluster` |
| Handler | `evalParamInconsistent` |
| 文件 | `scripts/rules/operations.json` |

**触发**：调用 helper `evalParamInconsistent`（详见 `scripts/rule-helpers/`）

---

### `performance_schema_off`

**performance_schema 关闭**

> 无法使用 sys.* TOP SQL；监控工具（PMM / Prometheus mysqld_exporter）缺核心指标。

| 字段 | 值 |
|---|---|
| 维度 | `operations` |
| Scope | `node` |
| 优先级 | **P2** |
| 文件 | `scripts/rules/operations.json` |

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

### `skip_name_resolve_off`

**skip_name_resolve 未开启**

> 每次新连接都做 DNS 反向解析，在 DNS 响应慢/不可达时导致连接超时甚至阻塞 MySQL 线程。

| 字段 | 值 |
|---|---|
| 维度 | `operations` |
| Scope | `node` |
| 优先级 | **P2** |
| 文件 | `scripts/rules/operations.json` |

**触发**：
```
node.variables.skip_name_resolve == 'OFF' || node.variables.skip_name_resolve == '0'
```

**说明文本**：
> skip_name_resolve = OFF — 新连接会做 DNS 反向解析，DNS 慢/不可达时连接超时，影响可用性

**值对照**：
- 当前：`OFF`
- 推荐：`ON`

**建议行动**：
> 开启 skip_name_resolve；注意：开启后 mysql.user 表的 host 列不能使用主机名（只能 IP 或 %），需检查现有授权

**示例 SQL / 配置**：
```sql
-- 注意：skip_name_resolve 不能动态修改，需重启
-- my.cnf:
skip_name_resolve = ON
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
| 文件 | `scripts/rules/operations.json` |

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
