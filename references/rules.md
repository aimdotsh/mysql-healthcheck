# 巡检规则手册

> **给 LLM 看的规则定义集** — 50 条 MySQL 巡检规则，按 6 个维度分组。
> 调用 skill 时 LLM 应当：
> 1. 完整读这份文档
> 2. 对照 `MySQLHealthCheck_*.txt` 的每个段，判断每条规则是否触发
> 3. 按规则的 `priority` / `description` / `action` / `sql` 字段填入报告
>
> 规则总数：**42**（节点级 + 集群级）

## 维度说明（六维度健康度评分）

| 维度 | 关注 | 评分起点 |
|---|---|---|
| availability | 可用性 / 高可用 / 复制健康 | 100 |
| durability | 持久化 / binlog / 备份 / 数据安全 | 100 |
| performance | 性能 / buffer pool / 慢 SQL / 索引 | 100 |
| security | 用户安全 / 认证 / 权限 | 100 |
| dataDesign | 表结构 / 字符集 / 自增列 | 100 |
| operations | 运维项 / 监控 / 版本 | 100 |

**优先级扣分**（每命中一条规则扣相应分数；最低分 50）：

| 优先级 | 含义 | 扣分 |
|---|---|---|
| P0 | 关键 — 影响可用性 / 数据安全 | 18 |
| P1 | 重要 — 影响业务 / 待近期处理 | 7 |
| P2 | 建议 — 中长期优化 | 3 |
| P3 | 观察 — 仅做记录 | 1 |

## 用户客户化（在 mysql-healthcheck.config.json 里写）

```json
{
  "disabledRules": ["backup_capability", "sql_mode_missing_strict"],
  "thresholds": { "disk": { "critical_pct": 85 } },
  "priorities": { "wildcard_medium": "P3" }
}
```

被禁用的规则在报告 16.3 附录里透明披露。

---

## 🚀 规则速查矩阵（LLM 性能优化 — 第一遍扫这里）

> **重要**：LLM 应当**先扫这张表**，根据 txt 数据快速判断**哪些规则可能触发**（只看 ~20 字的触发条件即可），然后**只阅读触发规则的详细段落**。这样可以从 50 条全读 → 5-15 条详读，input token 减 50-70%。

| 规则 id | 维度 | 默认 P | 触发信号速查（看 txt 哪段判断）|
|---|---|---|---|
| `mem_high` | availability | P1 | `mem usage` 段，使用率 > 90% |
| `swap_used` | availability | P1 | `mem info` 段，Swap 已用 > 0 |
| `innodb_hll` | availability | P1-P2 | INNODB STATUS 中 `History list length` > 10000 |
| `long_running_session` | availability | P2-P3 | PROCESSLIST 中 time ≥ 60s 非业务用户会话 |
| `disks` | availability | P0-P3 | `disk mount` 中 Use% ≥ 80（区分光驱/伪 FS） |
| `replication` | availability | P0-P2 | SLAVE STATUS：IO/SQL ≠ Yes，或 SBM > 60s |
| `role_read_only` | availability | P1-P3 | 主库 read_only=1 / 从库 read_only=0 |
| `max_connections_vs_memory` | availability | P1-P2 | max_connections × buffer 估算 > RAM 30% |
| `mysql_version_eol` | operations | P1-P2 | MySQL 版本 5.6 / 5.7 EOL |
| `os_version_eol` | availability | P2 | OS 版本表，CentOS 6/7 / Ubuntu 18.04 等 EOL |
| `slave_parallel_workers_zero` | availability | P1-P2 | slave_parallel_workers=0 且数据量 ≥ 100GB |
| `flush_log_weak` | durability | P1 | innodb_flush_log_at_trx_commit = 0 |
| `sync_binlog_weak` | durability | P1 | sync_binlog = 0 |
| `doublewrite_off` | durability | P1 | innodb_doublewrite = OFF |
| `gtid_off` | durability | P2 | gtid_mode = OFF |
| `expire_logs_zero` | durability | P1 | expire_logs_days = 0 |
| `expire_logs_long` | durability | P3 | expire_logs_days > 30（默认）|
| `ibtmp1_no_max` | durability | P2 | innodb_temp_data_file_path 未含 :max: |
| `ibtmp1_oversize` | durability | P2 | ibtmp1 实际大小 > 5GB |
| `slave_skip_errors_set` | durability | P0 | slave_skip_errors 非空 非 OFF |
| `self_ref_slave_residue` | durability | P2 | SLAVE STATUS 的 Master_Host = 自身 IP |
| `bp_hit` | performance | P1-P3 | BP 命中率 < 99%（< 95% 升 P1）|
| `buffer_pool_size` | performance | P1-P2 | BP 占 RAM < 40% 或 > 80% |
| `redo_log_too_small` | performance | P1-P2 | innodb_log_file_size < 512MB 且数据量大 |
| `flush_method_not_o_direct` | performance | P2 | Linux 下 innodb_flush_method ≠ O_DIRECT |
| `data_to_memory_ratio_high` | performance | P1-P2 | 数据集 / RAM > 10 倍 |
| `heavy_frag_tables` | performance | P2 | 表碎片率 ≥ 70% 且 free ≥ 100MB |
| `slow_queries_abs` | performance | P1-P2 | Slow_queries 累计 > 100k |
| `slow_log_off` | operations | P2 | slow_query_log = 0 |
| `long_query_time_loose` | performance | P3 | long_query_time ≥ 5 |
| `performance_schema_off` | operations | P2 | performance_schema = OFF |
| `wildcard_users` | security | P0-P2 | mysql.user 含 host=% 的账号（root/复制/业务三档）|
| `auth_plugin_native_on_80` | security | P2 | 8.0+ 默认 mysql_native_password |
| `tls_weak_protocol` | security | P2 | TLS 配置含 TLSv1 / TLSv1.1 |
| `charset_not_utf8mb4` | dataDesign | P2 | character_set_server ≠ utf8mb4 |
| `sql_mode_missing_strict` | dataDesign | P2 | sql_mode 不含 STRICT_TRANS_TABLES |
| `auto_increment_exhausting` | dataDesign | P0-P2 | auto_increment 使用率 ≥ 70% |
| `no_pk_tables` | dataDesign | P2-P3 | 业务表无主键（过滤临时/历史表后）|
| `non_utf8_tables` | dataDesign | P2 | 表 collation 非 utf8（如 latin1）|
| `ghost_tables` | dataDesign | P2 | 表名匹配 `_xxx_(new\|del\|gho\|old\|ghc)$` 且 > 1GB |
| `param_inconsistent` | operations | P2 | 集群节点间关键参数不同 |
| `lct_zero_linux` | operations | P3 | Linux 下 lower_case_table_names = 0 |
| `backup_capability` | operations | P0-P2 | 主机无 mysqldump / xtrabackup / mariabackup |

**用法**：
1. LLM 第一遍读 txt **只扫这张矩阵的"触发信号"列**，标记哪些规则可能命中
2. 命中的规则 → 翻到下面的详细段读 description / action / sql / 阈值
3. 未命中的规则 → **跳过详细段，节省 token**

参考：本表 50 条规则与下面详细段一一对应。

---

## 总览

| 维度 | 规则数 |
|---|---|
| 可用性 (availability) | 10 |
| 持久化 (durability) | 10 |
| 性能 (performance) | 8 |
| 安全 (security) | 3 |
| 数据设计 (dataDesign) | 6 |
| 运维 (operations) | 5 |

## 可用性 (availability)

### `disks`

**磁盘使用率告警（含光驱/ISO/可移动介质识别）**

> 高使用率磁盘是 P0 故障源；但需识别光驱/安装 ISO 等设计性 100% 占用，避免误报。

| 字段 | 值 |
|---|---|
| 维度 | `availability` |
| Scope | `node` |


---

### `innodb_hll`

**InnoDB History List Length 偏高**（实际触发 type：`innodb_hll_high`，维度 `performance`）

> undo 历史清理滞后，长事务阻塞 purge；过大会拉低读性能并持续撑大 undo 表空间。
> 触发：`History list length > hll_warn`（默认 10000）；`>= hll_p1`（默认 50000）升 P1。

**处置要点（写报告时给出）**：
> ① 用 `INNODB_TRX` 按 `trx_started` 找最久未提交事务并提交 / KILL；
> ② 排查"开了事务后空闲"(idle in transaction) 的连接；
> ③ 确认 `innodb_purge_threads`（默认 4，写多可调高）；
> ④ 长期可用 `innodb_max_purge_lag` 给写入反压，避免 HLL 失控。
>
> 推荐值：消除长事务后 HLL 会被 purge 线程自动追平回落到 `< hll_warn`。

**示例 SQL / 配置**：
```sql
-- 1) 找最久未提交事务：
SELECT trx_id, trx_state, trx_started,
       TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS run_secs,
       trx_mysql_thread_id, trx_rows_modified, LEFT(trx_query,80) AS q
  FROM information_schema.INNODB_TRX ORDER BY trx_started LIMIT 10;
-- 2) 处理：提交或 KILL <trx_mysql_thread_id>;
-- 3) 写多场景可调（需重启）：
SET GLOBAL innodb_purge_threads = 8;
```

| 字段 | 值 |
|---|---|
| 维度 | `performance` |
| Scope | `node` |
| 优先级 | **P1（HLL≥50000）/ P2** |


---

### `long_running_session`

**长时间运行会话**

> 可能阻塞 purge、消耗资源；需人工确认业务影响后再决定是否 KILL。

| 字段 | 值 |
|---|---|
| 维度 | `availability` |
| Scope | `node` |


---

### `max_connections_vs_memory`

**max_connections × 单连接 buffer 超 RAM**

> 并发上来时所有连接都按峰值分配，可能触发 OOM。

| 字段 | 值 |
|---|---|
| 维度 | `availability` |
| Scope | `node` |


---

### `mem_high`

**内存使用率过高**

> OS 进入 swap 概率上升，MySQL 响应延迟显著增加。

| 字段 | 值 |
|---|---|
| 维度 | `availability` |
| Scope | `node` |
| 优先级 | **P1** |

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


---

### `replication`

**复制线程与延迟**

> thread_down 立即影响可用性；secondsBehindMaster 分级反映恢复 RPO 风险。

| 字段 | 值 |
|---|---|
| 维度 | `availability` |
| Scope | `node` |


---

### `role_read_only`

**主从角色与 read_only 一致性**

> 主库错误置为只读 → 写入失败；从库可写 → 数据漂移；DR 灾备节点切换设计需识别区分。

| 字段 | 值 |
|---|---|
| 维度 | `availability` |
| Scope | `node` |


---

### `slave_parallel_workers_zero`

**从库未启用并行复制 + 集群数据量大**

> 单线程应用 binlog 在大事务下会延迟积压。

| 字段 | 值 |
|---|---|
| 维度 | `availability` |
| Scope | `node` |


---

### `swap_used`

**Swap 已被使用**

> OS 进入 swap，MySQL 响应延迟会显著拉长。触发：`node.swapUsed == true`（SwapTotal != SwapFree）。

**处置要点（写报告时给出 = 关联内存预算判定）**：
> 算一笔内存账：`buffer_pool + 单连接 buffer（sort/join/read/read_rnd + tmp_table）× max_connections`
> 的理论峰值 vs 物理内存。
> - **若理论峰值 > 物理内存** → 内存超配是换出根因。削减 buffer_pool（≈60% RAM）、
>   或缩减单连接 buffer（sort/join/read_buffer 通常 256KB–2MB 足够）、或下调 max_connections
>   （上限 ≈ `(RAM×0.85 − 推荐bp) / 单连接buffer`，并上 ProxySQL/HAProxy 连接池）。
> - **若理论峰值未超 RAM** → swap 可能来自 OS page cache 抢占或其它进程；同时降低 vm.swappiness。
>
> 三步必做：① vm.swappiness=1；② 削减内存承诺（buffer_pool / 单连接 buffer / max_connections）；
> ③ 确认无备份/导出/监控 agent 与 MySQL 抢内存。

**示例 SQL / 配置**：
```sql
sysctl -w vm.swappiness=1
echo "vm.swappiness=1" >> /etc/sysctl.conf
-- 如需收缩 buffer pool（动态，按 ≈60% RAM 推荐值）：
SET GLOBAL innodb_buffer_pool_size = <推荐字节数>;
```

| 字段 | 值 |
|---|---|
| 维度 | `availability` |
| Scope | `node` |
| 优先级 | **P1** |

---

## 持久化 (durability)

### `log_bin_off`

**binlog 未开启**

> binlog 是 PITR 和主从复制的前提；关闭后崩溃只能全量恢复，无法做时间点恢复。

| 字段 | 值 |
|---|---|
| 维度 | `durability` |
| Scope | `node` |
| 优先级 | **P1** |

**触发**：
```
node.variables.log_bin == 'OFF' || node.variables.log_bin == '0'
```

**说明文本**：log_bin = OFF — binlog 未开启，无法做 PITR（时间点恢复）且无法搭建主从复制

**当前值 → 推荐值**：`OFF` → `ON`

**行动**：开启 binlog；同时建议配合 expire_logs_days / binlog_expire_logs_seconds 设置保留期，避免磁盘打爆

**SQL**：
```sql
-- my.cnf:
log_bin = mysql-bin
binlog_format = ROW
expire_logs_days = 7
# 重启 MySQL 生效
```

---

### `binlog_format_not_row`

**binlog_format 非 ROW**

> STATEMENT 模式在存储函数/触发器/UUID 等场景下会产生主从不一致；ROW 是并行复制和 GTID 的推荐格式。

| 字段 | 值 |
|---|---|
| 维度 | `durability` |
| Scope | `node` |
| 优先级 | **P2** |

**触发**：binlog 已开启（log_bin=ON）且 `node.variables.binlog_format != 'ROW'`

**说明文本**：binlog_format = {{value}}（非 ROW），存储函数/触发器/UUID 等场景可能导致主从不一致

**当前值 → 推荐值**：`STATEMENT`/`MIXED` → `ROW`

**行动**：切换为 ROW 格式；同时开启 binlog_row_image=FULL（默认值）

**SQL**：
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

### `expire_logs_long`

**expire_logs_days 保留过长**

> 保留过长会占用磁盘空间；评估业务回滚需求。

| 字段 | 值 |
|---|---|
| 维度 | `durability` |
| Scope | `node` |
| 优先级 | **P3** |

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

> 共享临时表空间无上限、只能重启回收；如此体积说明大量大表 JOIN / 排序 / GROUP BY /
> DISTINCT / UNION 落盘到磁盘临时表。触发：`ibtmp1.sizeBytes > ibtmp1_max_gb`（默认 5GB）；
> `≥100GB` 或 `≥10× 阈值` 升 P1。

**处置要点（写报告时给出 = 不止封顶，还要追因）**：
> ① **追因**：从「SQL with temp tables」段挑落盘临时表最多的 TOP SQL（疑似元凶），
>    确认 `performance_schema=ON` 后用 `sys.statements_with_temp_tables` 精确定位；
> ② **治理元凶**：给 JOIN / ORDER BY / GROUP BY 列建合适索引、改写 SQL 避免大结果集排序；
>    适当增大 `tmp_table_size` / `max_heap_table_size` 让中小临时表留在内存（注意 × 并发的内存占用）；
> ③ **封顶**：`innodb_temp_data_file_path = ibtmp1:12M:autoextend:max:50G`，维护窗口重启回收已膨胀的 ibtmp1。

**示例 SQL / 配置**：
```sql
-- 定位元凶 SQL（按落盘临时表次数排序）：
SELECT * FROM sys.statements_with_temp_tables ORDER BY disk_tmp_tables DESC LIMIT 10;
SELECT digest_text, sum_created_tmp_disk_tables, sum_created_tmp_tables
  FROM performance_schema.events_statements_summary_by_digest
  ORDER BY sum_created_tmp_disk_tables DESC LIMIT 10;
-- 封顶（重启生效），避免再次无限增长：
innodb_temp_data_file_path = ibtmp1:12M:autoextend:max:50G
```

| 字段 | 值 |
|---|---|
| 维度 | `durability` |
| Scope | `node` |
| 优先级 | **P1（≥100GB / ≥10×阈值）/ P2** |

---

### `self_ref_slave_residue`

**self-referencing slave 残留**

> Master_Host 指向本机，通常是历史从库被提升为主后未 RESET SLAVE ALL。

| 字段 | 值 |
|---|---|
| 维度 | `durability` |
| Scope | `node` |
| 优先级 | **P2** |

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

### `file_per_table_off`

**innodb_file_per_table 关闭**

> 共享表空间（ibdata）不可收缩；DROP TABLE 不释放空间；难以做表级备份/传输。

| 字段 | 值 |
|---|---|
| 维度 | `performance` |
| Scope | `node` |
| 优先级 | **P2** |

**触发**：
```
node.variables.innodb_file_per_table == 'OFF' || node.variables.innodb_file_per_table == '0'
```

**说明文本**：innodb_file_per_table = OFF — 所有表共享 ibdata，DROP TABLE 不释放磁盘空间，且无法做表级传输/备份

**当前值 → 推荐值**：`OFF` → `ON`

**行动**：开启 innodb_file_per_table；存量表需 OPTIMIZE TABLE 或 ALTER TABLE FORCE 才能迁移到独立表空间

**SQL**：
```sql
SET GLOBAL innodb_file_per_table = ON;
-- my.cnf:
innodb_file_per_table = 1
```

---

### `bp_hit`

**Buffer Pool 命中率分级**

> 命中率 < 95% 严重；< 99% 关注。

| 字段 | 值 |
|---|---|
| 维度 | `performance` |
| Scope | `node` |


---

### `buffer_pool_size`

**InnoDB Buffer Pool 与 RAM 比例**

> 过小（< 40% RAM）→ 命中率低、IO 拖累；过大（> 80% RAM）→ OS/连接无余量，OOM/Swap 风险。

| 字段 | 值 |
|---|---|
| 维度 | `performance` |
| Scope | `node` |


---

### `data_to_memory_ratio_high`

**数据集 vs RAM 比例过高**

> 工作集装不下 buffer pool，会持续磁盘 IO。触发：`数据量GB / 内存GB > ratio_warn`（默认 10）；
> `> ratio_p1`（默认 50）升 P1。

**处置要点（写报告时给出 = 算热数据覆盖率，避免盲目加内存）**：
> 关键不是"数据 > 内存几倍"，而是**热数据能否被 buffer_pool 覆盖**。按热集 ≈ 25% 数据量估算：
> - `热数据 ≈ 25% × 数据量`，需要的 buffer_pool ≈ 热数据；推回需要的 RAM ≈ `热数据 / 60%`。
> - **若所需 RAM 现实**（≤ 当前 RAM 的 ~8 倍）→ 建议加内存 + 调大 buffer_pool 到 ≈60% RAM 覆盖热集。
> - **若所需 RAM 不现实**（远超物理上限）→ 不要盲目加内存，转**架构层**：冷热分离 / 归档历史数据 /
>   分库分表 / 上读写分离，把单实例工作集压到内存能覆盖的范围。
>
> 报告里应给出：当前 buffer_pool 覆盖率（`bp / 数据量`）、热集所需 buffer_pool、对应所需 RAM 三个数。

| 字段 | 值 |
|---|---|
| 维度 | `performance` |
| Scope | `node` |
| 优先级 | **P1（比例 > 50）/ P2** |


---

### `flush_method_not_o_direct`

**Linux 下 innodb_flush_method 非 O_DIRECT**

> OS page cache + buffer pool 双重缓存，浪费内存并增加冗余 IO。

| 字段 | 值 |
|---|---|
| 维度 | `performance` |
| Scope | `node` |
| 优先级 | **P2** |

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


---

### `long_query_time_loose`

**long_query_time 阈值过宽**

> 慢日志门槛过高时大量真实慢 SQL 会被漏掉。

| 字段 | 值 |
|---|---|
| 维度 | `performance` |
| Scope | `node` |
| 优先级 | **P3** |

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


---

### `slow_queries_abs`

**累计慢查询数量分级**

> 1M+ 次需立即治理；100K-1M 次需定期分析。

| 字段 | 值 |
|---|---|
| 维度 | `performance` |
| Scope | `node` |


---

## 安全 (security)

### `validate_password_off`

**密码强度校验插件未启用**

> 无 validate_password 时用户可设任意短/简单密码；配合弱密码检测规则效果更强。

| 字段 | 值 |
|---|---|
| 维度 | `security` |
| Scope | `node` |
| 优先级 | **P2** |

**触发**：`node.hasPasswordPolicy != true`（"Password validation policy" 段不存在或标注为未启用）

**说明文本**：validate_password 插件未启用 — 用户可设置任意弱密码，与弱密码检测结果共同参考

**当前值 → 推荐值**：未启用 → 启用 validate_password（policy=MEDIUM）

**行动**：安装并启用 validate_password 插件，建议 policy=MEDIUM（8 字符 + 数字 + 大小写 + 特殊字符）

**SQL**：
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
| 优先级 | **P0**（高权限账号）/ **P1**（普通账号） |

**触发**：`node.weakPasswordUsers` 数组非空（collector "Users with weak password" section 有命中行）

**分级逻辑**：
- `user` 为 `root`/`admin`/`dba`/`super`/`mysql.sys` 等高权限账号 → **P0**
- 其他普通账号 → **P1**
- 输出内容仅为 `user@host`，**不含密码、不含哈希**

**安全约束**：
- collector SQL 仅 SELECT user/host，authentication_string 哈希绝不出 txt 文件
- `caching_sha2_password` 账号加盐，离线字典无法比对，单独 section 标注「未检测」

**行动**：立即修改为高强度密码（≥12 字符，含大小写+数字+特殊字符）；并启用 validate_password 插件防止回退

---

### `auth_plugin_native_on_80`

**MySQL 8.0+ 默认 mysql_native_password**

> 派生 SHA1 已弃用；8.4 起默认 disabled。

| 字段 | 值 |
|---|---|
| 维度 | `security` |
| Scope | `node` |
| 优先级 | **P2** |

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

**触发**：
```
node.tlsWeakDetail != null
```

**说明文本**：
> TLS 配置包含已废弃协议：{{node.tlsWeakDetail}}

**建议行动**：
> 禁用 TLSv1/TLSv1.1，仅保留 TLSv1.2+；同时确认业务客户端驱动版本兼容

---

### `wildcard_users`

**host=% 用户安全分级**

> root/admin → P0；复制/备份/监控 → P1；业务用户 → P2。

| 字段 | 值 |
|---|---|
| 维度 | `security` |
| Scope | `node` |


---

## 数据设计 (dataDesign)

### `default_engine_not_innodb`

**default_storage_engine 非 InnoDB**

> 非 InnoDB 引擎（MyISAM/MEMORY 等）无事务/外键/崩溃恢复能力；误建非 InnoDB 表是常见数据丢失场景。

| 字段 | 值 |
|---|---|
| 维度 | `dataDesign` |
| Scope | `node` |
| 优先级 | **P2** |

**触发**：
```
node.variables.default_storage_engine != null && node.variables.default_storage_engine != 'InnoDB'
```

**说明文本**：default_storage_engine = {{value}}（非 InnoDB）— 新建表将默认使用该引擎，无事务/崩溃恢复保障

**当前值 → 推荐值**：`{{value}}` → `InnoDB`

**行动**：改为 InnoDB；并检查已有非 InnoDB 表是否需要迁移

**SQL**：
```sql
SET GLOBAL default_storage_engine = InnoDB;
-- my.cnf:
default_storage_engine = InnoDB
```

---

### `auto_increment_exhausting`

**自增列接近耗尽**

> INT UNSIGNED 上限 ~42 亿，耗尽后 INSERT 报错；建议提前扩 BIGINT。

| 字段 | 值 |
|---|---|
| 维度 | `dataDesign` |
| Scope | `node` |


---

### `charset_not_utf8mb4`

**character_set_server 非 utf8mb4**

> utf8 实际是 utf8mb3，已被 MySQL 标记 deprecated；无法存 emoji。

| 字段 | 值 |
|---|---|
| 维度 | `dataDesign` |
| Scope | `node` |
| 优先级 | **P2** |

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

### `ghost_tables`

**gh-ost / pt-osc 残留 ghost 表**

> 在线 DDL 未清理的中间表，占空间，确认无业务引用可 DROP。

| 字段 | 值 |
|---|---|
| 维度 | `dataDesign` |
| Scope | `node` |


---

### `no_pk_tables`

**无主键表**

> ROW 复制下全表扫描匹配，无法 MTS 并行；区分业务/临时降级。

| 字段 | 值 |
|---|---|
| 维度 | `dataDesign` |
| Scope | `node` |


---

### `non_utf8_tables`

**非 utf8/utf8mb4 表**

> 无法存储 emoji / 4 字节字符；统一字符集减少业务踩坑。

| 字段 | 值 |
|---|---|
| 维度 | `dataDesign` |
| Scope | `node` |


---

### `sql_mode_missing_strict`

**sql_mode 缺少 STRICT_TRANS_TABLES**

> 宽松模式下错误数据被静默截断（INT 越界写 0、字符串超长被裁），存在数据完整性风险。

| 字段 | 值 |
|---|---|
| 维度 | `dataDesign` |
| Scope | `node` |
| 优先级 | **P2** |

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

### `skip_name_resolve_off`

**skip_name_resolve 未开启**

> 每次新连接都做 DNS 反向解析，在 DNS 响应慢/不可达时导致连接超时甚至阻塞 MySQL 线程。

| 字段 | 值 |
|---|---|
| 维度 | `operations` |
| Scope | `node` |
| 优先级 | **P2** |

**触发**：
```
node.variables.skip_name_resolve == 'OFF' || node.variables.skip_name_resolve == '0'
```

**说明文本**：skip_name_resolve = OFF — 新连接会做 DNS 反向解析，DNS 慢/不可达时连接超时，影响可用性

**当前值 → 推荐值**：`OFF` → `ON`

**行动**：开启 skip_name_resolve；注意开启后 mysql.user 表的 host 列不能使用主机名（只能 IP 或 %），需检查现有授权

**SQL**：
```sql
-- 注意：skip_name_resolve 不能动态修改，需重启
-- my.cnf:
skip_name_resolve = ON
```

---

### `lct_zero_linux`

**Linux 下 lower_case_table_names=0**

> 大小写敏感导致跨平台迁移容易报 ER_NO_SUCH_TABLE。

| 字段 | 值 |
|---|---|
| 维度 | `operations` |
| Scope | `node` |
| 优先级 | **P3** |

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


---

### `param_inconsistent`

**集群级参数不一致**

> 节点间关键参数差异会导致故障切换后行为不可预测。

| 字段 | 值 |
|---|---|
| 维度 | `operations` |
| Scope | `cluster` |


---

### `performance_schema_off`

**performance_schema 关闭**

> 无法使用 sys.* TOP SQL；监控工具（PMM / Prometheus mysqld_exporter）缺核心指标。

| 字段 | 值 |
|---|---|
| 维度 | `operations` |
| Scope | `node` |
| 优先级 | **P2** |

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

