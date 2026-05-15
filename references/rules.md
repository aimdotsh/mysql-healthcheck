# 自动检测规则一览（extract.js 内置）

仅当用户问"为什么报了 X"或"想加新规则"时需要查阅。

## 节点级规则

| 规则 ID | 优先级 | 触发条件 | 说明 |
|---|---|---|---|
| `mem_high` | P1 | 内存使用率 `>90%` | |
| `swap_used` | P1 | Swap 已使用（Total != Free 且差额 >0.1）| |
| `os_version_eol` | P1/P2 | 操作系统发行版已 EOL（如 CentOS 6/7/8） | 聚合到集群级风险 |
| `disk_critical` | P0 | 任一挂载点使用率 `≥90%` | 含 SQL hint |
| `disk_high` | P1 | 任一挂载点使用率 `≥80%` | |
| `repl_thread_down` | P0 | `Slave_IO_Running != Yes` 或 `Slave_SQL_Running != Yes` | |
| `repl_delay_high` | P1 | `Seconds_Behind_Master > 300` | |
| `repl_delay_low` | P2 | `Seconds_Behind_Master > 60` | |
| `long_running_session` | P2/P3 | 非 Sleep/复制线程会话运行 `≥60s` | 需人工确认是否 KILL |
| `innodb_hll_high` | P2/P1 | History List Length `>10000` / `>=50000` | 关联长事务、长查询、purge 滞后 |
| `slow_query_abs_high` | P1 | 累计慢查询 `> 1,000,000` | 含 pt-query-digest hint |
| `slow_query_abs_med` | P2 | 累计慢查询 `> 100,000` | |
| `slow_log_off` | P2 | `slow_query_log = 0` | 含 SET GLOBAL hint |
| `long_query_time_loose` | P3 | `long_query_time ≥ 5` | |
| `ibtmp1_oversize` | P2 | ibtmp1 实际大小 `> 5 GB` | 含 my.cnf hint |
| `bp_hit_low` | P1 | Buffer Pool 命中率 `< 95%` | |
| `bp_hit_sub99` | P3 | Buffer Pool 命中率 `< 99%` | |
| `master_readonly` | P1 | 主库 `read_only = 1` | |
| `slave_writable` | P1 | 从库 `read_only = 0` | |
| `expire_logs_zero` | P1 | `expire_logs_days = 0`（永不过期）| 含 PURGE hint |
| `expire_logs_long` | P3 | `expire_logs_days > 30` | |

## 集群级规则（多节点同条聚合）

| 规则 ID | 优先级 | 触发条件 | 说明 |
|---|---|---|---|
| `no_pk_tables` | P2 | 任一节点存在无主键表 | 跨节点聚合，取最大数量 |
| `non_utf8_tables` | P2 | 任一节点存在非 utf8 表 | |
| `heavy_frag_tables` | P2 | 任一节点存在碎片率≥70% 且碎片≥100MB 的表 | 过滤小表噪声 |
| `flush_log_weak` | P1 | `innodb_flush_log_at_trx_commit = 0` | |
| `sync_binlog_weak` | P1 | `sync_binlog = 0` | |
| `gtid_off` | P2 | `gtid_mode = OFF` | 含 GTID 启用步骤 |
| `ibtmp1_no_max` | P2 | `innodb_temp_data_file_path` 未配 `:max:` | |
| `wildcard_critical` | P0 | host=% root / admin / dba / super 用户存在 | |
| `wildcard_high` | P1 | host=% repl / backup 用户存在 | |
| `wildcard_medium` | P2 | host=% 业务账号存在 | |
| `tls_weak_protocol` | P2 | `tls_version` 包含 TLSv1 / TLSv1.1 | 同时在合规清单标为 WARN |
| `lct_zero_linux` | P3 | Linux 上 `lower_case_table_names = 0` | |
| `param_inconsistent` | P2 | 关键参数跨节点不一致 | 列出涉及参数名 |

## 根因关联（correlations）

extract.js 的 `deriveCorrelations` 自动生成，6 类典型模式：

1. 节点磁盘高位 ↔ binlog 永不过期 / 保留过长
2. 全集群持久化偏弱（commit=0 + sync_binlog=0）
3. 主库慢查询累积 ↔ ibtmp1 增长
4. 从库间 ibtmp1 大小差异显著（重启时间不同）
5. 集群所有节点存在 root@%
6. 灾备节点内存利用率显著低于主库

## 安全合规检查项（assessSecurity）

9 项，每项输出 PASS / WARN / FAIL：

1. 强密码策略（validate_password 插件）
2. root 账号未开放 host=%
3. 审计日志已启用
4. TLS 传输加密
5. 强制 TLS 连接（require_secure_transport）
6. 数据 at-rest 加密（InnoDB tablespace encryption）
7. 无空密码账号
8. 认证插件（caching_sha2_password vs mysql_native_password）
9. 失败登录异常监控（host_cache）

## 健康度评分模型

6 维度，每维度起点 100 分：

| 维度 | 权重 | 主要扣分规则 |
|---|---|---|
| 可用性 (availability) | 25% | disk_*, repl_*, mem_high |
| 安全性 (security) | 15% | wildcard_*, empty_password, old_auth, 无加密/审计 |
| 性能 (performance) | 20% | slow_*, bp_hit_*, sql_* |
| 数据规范 (dataDesign) | 10% | no_pk, non_utf8, heavy_frag, unused/redundant_index, lct_ |
| 持久化 (durability) | 20% | flush_log_weak, sync_binlog_weak, gtid, ibtmp1, swap |
| 运维 (operations) | 10% | param_inconsistent, backup_missing, slow_log_off |

扣分系数：P0 = 18 / P1 = 7 / P2 = 3 / P3 = 1

总分 = 加权平均，0-100 范围。
