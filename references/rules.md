# 自动检测规则完整参考（v4.8）

仅当用户问"为什么报了 X"或"想加新规则"时需要查阅。

> README 里有按维度分组的速查表（更易扫读）；本文档保留每条规则的实现细节与对应代码路径。

---

## 一、节点级规则

每条规则在 `scripts/extract.js` 的 `analyzeIssues()` 函数内通过 `push({...})` 提交。规则携带：
`type`（唯一 id）/ `priority`（P0-P3）/ `groupKey`（聚合键）/ `description`（中文）/ `node`（节点标签）/ `action`（措施文本）/ `sql`（可选 SQL）/ `scope`（'node' / 'cluster'）。

v4.8 新增字段（仅在 12 条 senior-DBA 规则上）：`currentValue` / `recommendedValue` / `dimension`。

### 资源 & 系统

| 规则 ID | 优先级 | 触发条件 | 配置键 |
|---|---|---|---|
| `mem_high` | P1 | 节点内存使用率 > 90% | `memory.high_pct` |
| `swap_used` | P1 | Swap 已被使用（free < total） | - |
| `os_version_eol` | P1/P2 | 操作系统发行版已 EOL | - |
| `disk_critical` | **P0** | 任一挂载点使用率 ≥ 90% | `disk.critical_pct` |
| `disk_high` | P1 | 任一挂载点使用率 ≥ 80% | `disk.high_pct` |

### 复制

| 规则 ID | 优先级 | 触发条件 | 配置键 |
|---|---|---|---|
| `repl_thread_down` | **P0** | `Slave_IO_Running ≠ Yes` 或 `Slave_SQL_Running ≠ Yes` | - |
| `repl_delay_high` | P1 | `Seconds_Behind_Master > 300` | `replication.delay_p1_seconds` |
| `repl_delay_low` | P2 | `Seconds_Behind_Master > 60` | `replication.delay_p2_seconds` |
| `slave_parallel_workers_zero` | P1/P2 | 从库 parallel_workers=0 且集群数据 ≥ 100 GB | `replication.parallel_workers_data_gb_p2` / `_p1` |
| `master_readonly` | P1/P3 | 主库 `read_only=1`；standalone read-only 推断降级 P3 | - |
| `slave_writable` | P1 | 从库 `read_only=0` | - |
| `dr_writable` | P3 | DR 节点 `read_only=0`（切换设计预留）| - |
| `self_ref_slave_residue` | P2 | SHOW SLAVE STATUS Master_Host 指向本机自身 | - |

### 会话 & 事务

| 规则 ID | 优先级 | 触发条件 | 配置键 |
|---|---|---|---|
| `long_running_session` | P2/P3 | 业务会话运行 ≥ 60s（P2 当 ≥ 600s） | `session.long_running_seconds_p2` |
| `innodb_hll_high` | P1/P2 | History List Length > 10000（P1 当 ≥ 50000） | `innodb.hll_warn` / `.hll_p1` |

### 慢查询 & SQL

| 规则 ID | 优先级 | 触发条件 | 配置键 |
|---|---|---|---|
| `slow_query_abs_high` | P1 | 累计慢查询 > 1,000,000 | `sql.slow_query_abs_high` |
| `slow_query_abs_med` | P2 | 累计慢查询 > 100,000 | `sql.slow_query_abs_med` |
| `slow_log_off` | P2 | `slow_query_log = 0` | - |
| `long_query_time_loose` | P3 | `long_query_time ≥ 5s` | `sql.long_query_time_loose` |

### Buffer Pool & 临时表

| 规则 ID | 优先级 | 触发条件 | 配置键 |
|---|---|---|---|
| `bp_hit_low` | P1 | 命中率 < 95% | `innodb.bp_hit_low_pct` |
| `bp_hit_sub99` | P3 | 命中率 < 99%（≥ 95%）| `innodb.bp_hit_warn_pct` |
| `ibtmp1_oversize` | P2 | ibtmp1 > 5 GB | `innodb.ibtmp1_max_gb` |

### Binlog & 持久化

| 规则 ID | 优先级 | 触发条件 | 配置键 |
|---|---|---|---|
| `expire_logs_zero` | P1 | `expire_logs_days = 0`（永不过期） | - |
| `expire_logs_long` | P3 | `expire_logs_days > 30` | `binlog.expire_logs_max_days` |

---

## 二、集群级规则（多节点同条聚合）

| 规则 ID | 优先级 | 触发条件 | 配置键 |
|---|---|---|---|
| `no_pk_tables` | P2 | 任一节点存在业务表无主键 | - |
| `no_pk_tables_temp_only` | P3 | 全部无主键都是临时/字典表 | - |
| `non_utf8_tables` | P2 | 任一节点存在非 utf8 表 | - |
| `heavy_frag_tables` | P2 | 任一节点存在碎片率 ≥ 70% 且 ≥ 100 MB 的表 | `frag.rate` / `frag.min_mb` |
| `ghost_tables` | P2 | 单表 ≥ 1 GB 的 `_gho_*` / `_*_new` 残留 | - |
| `flush_log_weak` | P1 | `innodb_flush_log_at_trx_commit = 0` | - |
| `sync_binlog_weak` | P1 | `sync_binlog = 0` | - |
| `gtid_off` | P2 | `gtid_mode = OFF` | - |
| `ibtmp1_no_max` | P2 | `innodb_temp_data_file_path` 未配 `:max:` | - |
| `wildcard_critical` | **P0** | root / admin / dba / super 类账号开放 host=% | - |
| `wildcard_high` | P1 | repl / backup 类账号开放 host=% | - |
| `wildcard_medium` | P2 | 业务账号开放 host=%（按 (node, level, reason) 聚合）| - |
| `tls_weak_protocol` | P2 | `tls_version` 含 TLSv1 / TLSv1.1 | - |
| `lct_zero_linux` | P3 | Linux 上 `lower_case_table_names = 0` | - |
| `param_inconsistent` | P2 | 关键参数跨节点不一致 | - |
| `backup_capability` | P0/P1/P2 | 备份能力评估（工具/调度/最近备份时效） | - |
| `mysql_version_eol` | P0/P1 | MySQL 主版本 EOL（5.5/5.6/5.7）| - |
| `mysql_version_security` | P3 | MySQL 进入仅安全更新阶段（8.0 自 2026-04） | - |

---

## 三、v4.8 新增：senior-DBA 参数推荐规则（12 条）

每条都携带 `currentValue` / `recommendedValue` / `dimension`，render 端会渲染彩色「✦ 当前值 → 推荐值」对照行。

| 规则 ID | 优先级 | 触发条件 | dimension | 推荐值算法 |
|---|---|---|---|---|
| `bp_too_small` | P1/P2 | bp_size 占 RAM < 40%（P1 < 20%），且 RAM ≥ 4 GB | performance | `clamp(RAM × 0.6, 1 GB, RAM - reserveGB)`；reserveGB 按 RAM 1/2/4 |
| `bp_too_large` | P1 | bp_size 占 RAM > 80% | availability | 同上 60% 推荐 |
| `redo_log_too_small` | P1/P2 | `innodb_log_file_size < 512 MB` 且 db ≥ 50 GB（或 qps > 200）| performance | db ≥ 200GB → 2GB；≥ 50GB → 1GB；else 512MB |
| `flush_method_not_o_direct` | P2 | Linux 且 `innodb_flush_method ∉ {O_DIRECT, O_DIRECT_NO_FSYNC}` | performance | `O_DIRECT` |
| `doublewrite_off` | P1 | `innodb_doublewrite = OFF` | durability | `ON` |
| `charset_not_utf8mb4` | P2 | `character_set_server` 非 utf8mb4 | dataDesign | `utf8mb4` + 对应 collation |
| `sql_mode_missing_strict` | P2 | sql_mode 缺 `STRICT_TRANS_TABLES` / `STRICT_ALL_TABLES` | dataDesign | 加上 `STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION` |
| `auth_plugin_native_on_80` | P2 | MySQL ≥ 8.0 且默认插件 = `mysql_native_password` | security | `caching_sha2_password` |
| `performance_schema_off` | P2 | `performance_schema = OFF` | operations | `ON` |
| `max_connections_vs_memory` | P1/P2 | max_conn × 单连接峰值 > 30% RAM（P1 > 50%） | availability | `floor(RAM × 0.3 / perConnMB)` 或缩 buffer |
| `slave_skip_errors_set` | **P0** | `slave_skip_errors` / `replica_skip_errors` 非空且 ≠ OFF/NONE | durability | `OFF` |
| `auto_increment_exhausting` | P0/P1/P2 | `autoIncrementUsage` 中 rate ≥ 0.7（≥ 0.8 P1，≥ 0.9 P0） | dataDesign | `BIGINT UNSIGNED` |
| `data_to_memory_ratio_high` | P1/P2 | `dbSize / RAM > 10`（P1 > 50）| performance | 扩容 RAM 到 `dbSize / 5` 或冷热分离 |

### 单连接峰值内存公式（用于 max_connections_vs_memory）

```
perConnMB = sort_buffer + join_buffer + read_buffer + read_rnd_buffer + tmp_table_size
peakMB    = perConnMB × max_connections
peakRatio = peakMB / (RAM in MB)
```

trigger：`peakRatio > 0.3` → P2，`peakRatio > 0.5` → P1。

### Buffer Pool 推荐值公式（用于 bp_too_small / bp_too_large）

```js
function recommendBufferPoolMB(memGB) {
  const reserveGB = memGB <= 4 ? 1 : memGB <= 16 ? 2 : 4;
  return Math.round(Math.max(1, Math.min(memGB * 0.6, memGB - reserveGB)) * 1024);
}
```

- RAM ≤ 4 GB：保留 1 GB 给 OS
- 4 < RAM ≤ 16 GB：保留 2 GB
- RAM > 16 GB：保留 4 GB
- 推荐值 = `min(RAM × 60%, RAM - reserve)`

---

## 四、根因关联（correlations）

extract.js 的 `deriveCorrelations` 自动生成。**v4.9 重写**为数据驱动模式：每条关联引用具体数值（uptime / qps / 磁盘归因 / RPO 秒数），模糊措辞「可能/疑似」改为「已确认 / 已排除 / 需进一步排查」三态。

### 数据驱动原则

1. **多信号交叉验证**：单一指标不下结论，至少两个独立信号支撑
2. **明确数值**：不说"差异较大"，要说"275 天 vs 967 天，差 692 天"
3. **列出排除项**：当主因不能 100% 确认时，列出已排除的因素帮助 DBA 收窄排查范围
4. **可执行 SQL**：每条关联尽量附带处置 SQL 或命令

### 现有 16 条关联模式

| 编号 | 名称 | 触发条件 | 关键交叉信号 |
|---|---|---|---|
| C1 | 节点磁盘高位 — 主因拆解 | 磁盘 ≥ 80% + `n.diskAttribution` | binlog / 慢日志 / 错误日志 / ibtmp1 各占百分比，定位主因 |
| C2 | 全集群持久化强度偏低 | 全部节点 `flush_log=0 + sync_binlog=0` | 节点数 + RPO 估算 |
| C3 | 主库慢查询 ↔ ibtmp1 强相关 | 主库 slowQueries > 1M + ibtmp1 > 5 GB | 慢查询占总查询比率 |
| C4 | 从库间 ibtmp1 大小差异 | 多从库 ibtmp1 差 > 4× | `uptimeSec` 差 + qps 差 → 3 种归因分支 |
| C5 | 集群全节点 root@% | 全节点都有 root@% | - |
| C6 | 从库 / DR 内存利用率显著低 | mem 比主库低 30%+ | `uptimeSec` 区分冷启动 vs 工作集偏小 |
| C7 | 复制延迟根因拆解 | secondsBehindMaster > 60s | parallel_workers / 主从 qps / binlog_format |
| C8 | Swap 压力级联 | swap_used > 0 | bp_size / qps / max_connections 三因素 |
| C9 | OS + MySQL 双重 EOL | osEolStatus=eol + MySQL 5.x | 联合迁移路径 |
| C10 | 慢日志膨胀因素 | slowLogSizeBytes > 1 GB | `log_queries_not_using_indexes` / `long_query_time` / 慢查询总数 |
| C11 | 错误日志暴涨 | errorLogSizeBytes > 100 MB | errorLogAnalysis.errorCount + warningCount |
| C12 | 持久化弱 + 高复制延迟 → RPO 量化 | (commit=0+sync_binlog=0) + 延迟 > 60s | RPO ≈ delay + 1 秒 |
| C13 | 从库可写 + 复制延迟 → 数据漂移 | slave read_only=0 + delay > 60s | - |
| C14 | 自增列耗尽 + 慢查询累积 | autoIncrement.rate ≥ 0.7 + slowQueries > 100k | - |
| C15 | 节点间 binlog 增长速率差异 | binlogDir size 差 > 5× | 用 `uptimeSec` 折算每日增量 |

---

## 五、安全合规检查项（assessSecurity）

> v4.7.2 起第十六章「安全合规审计」已从渲染移除，但 `assessSecurity` 计算逻辑保留在 data.json 内供调试 / 未来开启用。`compliance_fail_*` 不再升级到 issues。

9 项检查，每项输出 PASS / WARN / FAIL / UNKNOWN：

1. 强密码策略（validate_password 插件）
2. root 账号未开放 host=%
3. 审计日志已启用
4. TLS 传输加密
5. 强制 TLS 连接（require_secure_transport）
6. 数据 at-rest 加密（InnoDB tablespace encryption）
7. 无空密码账号
8. 认证插件（caching_sha2_password vs mysql_native_password）
9. 失败登录异常监控（host_cache）

真正的安全风险（root@%、弱口令、复制账号 wildcard）由 `wildcard_critical` / `wildcard_high` / `wildcard_medium` 等节点级规则独立捕获，不会遗漏。

---

## 六、健康度评分模型

6 维度，每维度起点 100 分：

| 维度 | 权重 | 主要扣分规则 |
|---|---|---|
| 可用性 (availability) | 25% | disk_*, repl_*, mem_high, bp_too_large, max_connections_vs_memory |
| 安全性 (security) | 15% | wildcard_*, tls_weak, auth_plugin_native_on_80 |
| 性能 (performance) | 20% | slow_*, bp_hit_*, hll, long_running_session, bp_too_small, redo_log_too_small, flush_method_not_o_direct, data_to_memory_ratio_high |
| 数据规范 (dataDesign) | 10% | no_pk_*, non_utf8, heavy_frag, charset_not_utf8mb4, sql_mode_missing_strict, auto_increment_exhausting, lct_zero_linux |
| 持久化 (durability) | 20% | flush_log_weak, sync_binlog_weak, gtid_off, ibtmp1_*, expire_logs_zero, master_readonly, slave_writable, doublewrite_off, slave_skip_errors_set |
| 运维 (operations) | 10% | param_inconsistent, slow_log_off, backup_capability, mysql_version_*, os_version_eol, performance_schema_off |

扣分系数：P0 = 18 / P1 = 7 / P2 = 3 / P3 = 1

v4.8 起 issue 可显式携带 `dimension` 字段直接命中对应维度；旧规则未带 dimension 则回退到 type 正则匹配。

总分 = 加权平均，0-100 范围。

---

## 七、规则配置接管（v4.8）

三层 deep-merge：`内置默认 < 采集目录同名 < CLI --config`。具体使用见 [README 配置巡检阈值](../README.md#%EF%B8%8F-%E9%85%8D%E7%BD%AE%E5%B7%A1%E6%A3%80%E9%98%88%E5%80%BCv48)。

配置文件三个顶层段：

- **`thresholds`**：调整数值阈值（见上文每条规则的「配置键」列）
- **`disabledRules`**：禁用规则（数组，元素是 rule type 字符串）
- **`priorities`**：覆盖单条规则优先级（对象，key 是 type，value 是 'P0'/'P1'/'P2'/'P3'）

`push()` 内部统一接管：
- 命中 `disabledRules` → 跳过
- 命中 `priorities` → 覆盖 priority
- 现有 ~30 条 push 调用零改动

`promoteAssessmentIssues` 的 `extras` 也走相同接管（backup / security 规则均支持）。
