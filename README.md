<h1 align="center">mysql-healthcheck</h1>

<p align="center">
  <strong>把 MySQL 巡检的原始数据，一键变成可直接递交客户的健康评估报告</strong>
</p>

<p align="center">
  <a href="#-快速开始">快速开始</a> ·
  <a href="#-报告长这样">报告长这样</a> ·
  <a href="#-架构">架构</a> ·
  <a href="#-作为-claude-code-skill-使用">Claude Skill</a> ·
  <a href="USAGE.md">详细文档</a>
</p>

<p align="center">
  <a href="https://github.com/aimdotsh/mysql-healthcheck/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/aimdotsh/mysql-healthcheck?style=flat-square&logo=github"></a>
  <a href="https://github.com/aimdotsh/mysql-healthcheck/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/aimdotsh/mysql-healthcheck?style=flat-square&logo=github"></a>
  <a href="https://github.com/aimdotsh/mysql-healthcheck/commits/main"><img alt="GitHub last commit" src="https://img.shields.io/github/last-commit/aimdotsh/mysql-healthcheck?style=flat-square&logo=github"></a>
  <img alt="Tests" src="https://img.shields.io/badge/tests-passing-43853d?style=flat-square&logo=githubactions&logoColor=white">
  <img alt="Version" src="https://img.shields.io/badge/version-v4.9-1F4E79?style=flat-square">
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A516-43853d?style=flat-square&logo=node.js">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey?style=flat-square">
  <img alt="MySQL" src="https://img.shields.io/badge/MySQL-5.6%20%7C%205.7%20%7C%208.0-4479A1?style=flat-square&logo=mysql&logoColor=white">
  <img alt="Output" src="https://img.shields.io/badge/output-.docx-2B579A?style=flat-square&logo=microsoftword&logoColor=white">
</p>

---

## 🤖 让 AI 智能体一句话装好

把这个仓库地址发给任意支持 shell 的 AI 智能体（**Claude Code / OpenClaw / Codex CLI / Cursor** 等）：

> 帮我安装 https://github.com/aimdotsh/mysql-healthcheck 这个 skill

智能体会自己阅读本 README 与 SKILL.md → 按你的操作系统选合适的命令 → clone + `install.sh` 一气呵成。

安装完成后直接对智能体说：

> 帮我生成 `/path/to/data-dir` 的 MySQL 巡检报告

智能体会自动识别 SKILL.md 中的 playbook，按 2 步流程跑完，把 docx 报告交给你。

---

## 💡 是什么

`mysql-healthcheck` 是一套**面向 DBA / 架构师 / 客户交付场景**的 MySQL 巡检报告自动化工具链：

- 用 **1 个 shell 脚本**在 MySQL 主机本地采集所有数据
- 用 **2 行 Node 命令**把原始数据转成 17 章商业可交付级 `.docx` 报告
- 内置**六维度健康度评分**、**根因关联推断**、**TOP SQL 治理**、**合规对照表**、**10 张嵌入图表**

适用于：月度例行巡检、上线前评估、故障后复盘、合规自查（等保/PCI/GDPR/SOX）。

---

## 📊 报告长这样

**17 章 + 执行摘要 + 自动目录**：

```
📄 封面
📋 执行摘要 ─────── 健康度仪表盘 + 六维度雷达图 + 关键事实速览（管理层 1 页看完）
📑 目录
├── 一、巡检摘要 ─── 集群级问题 + 节点级问题 + 根因关联分析
├── 二、服务器与拓扑概况 + MySQL 复制拓扑图 + 磁盘使用率柱状图
├── 三、连接与会话分析 + 连接使用率图 + Processlist 分布图
├── 四、数据库清单（跨节点差异检测）
├── 五、关键配置参数对比（差异 ✅/❌ 自动判断）
├── 六、性能指标分析 + Buffer Pool 命中率柱状图
├── 七、存储空间分析 + TOP10 大表柱状图（含归档表识别）
├── 八、临时表空间（ibtmp1）分析
├── 九、InnoDB 引擎状态
├── 十、事务与锁分析
├── 十一、用户权限审计（host=% 用户按危险等级分组）
├── 十二、主从复制状态
├── 十三、Schema 设计审计 ── 未用索引 / 冗余索引 / BLOB / 分区 / 自增列使用率
├── 十四、SQL 性能治理 ── TOP 20 慢 SQL + 慢日志样本 + 缺索引 SQL
├── 十五、备份与恢复评估 ── 备份工具 / cron / 产物 / RTO·RPO 推算
├── 十六、安全合规审计 ── 9 项检查 + 等保/PCI/GDPR/SOX 对照
└── 十七、巡检总结与行动计划 ── 每条 P0/P1/P2 附可执行 SQL
```

> **典型产物**：`<项目名>_MySQL健康巡检报告_v1.0.docx`（约 200 KB，含 10 张嵌入图表）

---

## ✨ 核心特性

| | |
|---|---|
| 🩺 **六维度健康度评分** | 可用性 / 安全性 / 性能 / 数据规范 / 持久化 / 运维 — 一个数字看健康，一张雷达看薄弱 |
| 🔗 **根因关联分析** | 自动识别 6 类典型关联（如「DR 磁盘高位 ↔ binlog 永不过期」），帮 DBA 找到症状背后的真因 |
| 📊 **10 张嵌入图表** | 健康度仪表 / 六维雷达 / 问题分布 / MySQL 拓扑 / 磁盘 / 连接 / Processlist / Buffer Pool / TOP10 大表 / 合规分布 |
| 🎯 **20+ 条巡检规则** | P0/P1/P2/P3 自动分级，跨节点同类问题智能聚合（35 项 → 27 项零重复） |
| 🛡️ **9 项安全合规检查** | 自动映射等保 2.0 / PCI DSS / GDPR / SOX，PASS/WARN/FAIL 一目了然 |
| 🔍 **TOP 20 慢 SQL 治理** | 直接从 performance_schema 抓 TOP SQL + 慢日志 tail 实际 SQL 样本 + 缺索引识别 |
| 💾 **备份能力评估** | 检测备份工具 / cron 调度 / 备份产物 / binlog 保留 → 推算 RTO·RPO |
| 🤖 **可作为 Claude Code Skill** | 配 YAML frontmatter，自然语言触发：「帮我生成 MySQL 巡检报告」 |
| 📦 **零外部服务依赖** | 纯本地运行，不上传任何数据；适合金融 / 政企 / 等保高安环境 |
| 🎨 **WPS / Word / LibreOffice 通用** | 显式列宽 + Microsoft YaHei，避免常见跨平台渲染问题 |

---

## 🚀 快速开始

### 前置要求

- macOS / Linux
- Node.js ≥ 16

### 1. 克隆 & 安装

```bash
git clone https://github.com/aimdotsh/mysql-healthcheck.git mysql-healthcheck
cd mysql-healthcheck
bash install.sh                    # 默认装到 ~/.claude/skills/
# 或：
bash install.sh --target workbuddy # 装到 ~/.workbuddy/skills/
bash install.sh --target ~/foo     # 自定义父目录
```

`install.sh` 会自动：
1. 检查 Node 版本（≥16）
2. 拷贝到 `~/.claude/skills/mysql-healthcheck/`（或指定目标）
3. 安装 npm 依赖（`docx` + `@resvg/resvg-js`）
4. 如目标已存在，自动备份为 `.bak.<时间戳>`

### 2. 在 MySQL 主机上采集数据

```bash
# 把 collectors/mysqlHealthCheckV3.0.sh 拷到 MySQL 主机本地运行
./mysqlHealthCheckV3.0.sh \
  --user dbadmin --password 'xxx' \
  --host 127.0.0.1 --port 3306 \
  --output-dir ./data
```

输出：`MySQLHealthCheck_<IP>_<时间戳>.txt`（每节点一份）

`mysqlHealthCheckV3.0.sh` 会在采集前先测试数据库登录，登录失败会直接退出，避免生成只有 OS 信息、DB 段全是报错的无效报告。脚本会自动从 `ps -ef` 中的 `mysqld` / `mariadbd` 进程解析 `--defaults-file`、`--basedir`、`--socket`、`--port`，优先使用实例自己的 `basedir/bin/mysql` 客户端，并通过临时 `--defaults-extra-file` 传递账号密码，避免密码出现在命令行。

常用方式：

```bash
# 仅测试自动发现和登录，不生成巡检文件
./mysqlHealthCheckV3.0.sh --test-login --non-interactive

# 推荐：让脚本自动发现 mysql 客户端、配置文件、socket 和端口
./mysqlHealthCheckV3.0.sh \
  --user dbadmin --password 'xxx' \
  --output-dir ./data \
  --non-interactive

# 多实例或非标准部署时，也可以显式指定
./mysqlHealthCheckV3.0.sh \
  --mysql-cmd /opt/mysql/bin/mysql \
  --defaults-file /opt/mysqldata1/data1/my3306.cnf \
  --socket /opt/mysqldata1/data1/mydata/mysql.sock \
  --user dbadmin --password 'xxx' \
  --output-dir ./data \
  --non-interactive

# 遇到旧实例 SSL 协议不兼容时，可显式禁用 SSL
./mysqlHealthCheckV3.0.sh \
  --user dbadmin --password 'xxx' \
  --ssl-mode DISABLED \
  --output-dir ./data \
  --non-interactive
```

### 3. 生成报告

```bash
cd ~/.workbuddy/skills/mysql-healthcheck/scripts

node extract.js <数据目录> --project "项目正式名"
node render.js  <数据目录>/data.json
```

完成。报告自动生成在数据目录下：`<项目名>_MySQL健康巡检报告_v1.0.docx`

---

## 🏗️ 架构

```mermaid
flowchart LR
    A[MySQL 主机] -->|采集| B(mysqlHealthCheckV3.0.sh)
    B -->|13 模块 / 单 txt 输出| C[MySQLHealthCheck_*.txt]
    C -->|解析 + 规则分析| D(extract.js)
    D -->|结构化 + 健康度评分| E[data.json]
    E -->|17 章渲染 + 10 张图表| F(render.js)
    F -->|商业可交付级| G[健康巡检报告.docx]

    style B fill:#1F4E79,color:#fff
    style D fill:#2E75B6,color:#fff
    style F fill:#2E75B6,color:#fff
    style G fill:#5CB85C,color:#fff
```

**三大组件**：

| 组件 | 角色 | 关键能力 |
|---|---|---|
| `collectors/mysqlHealthCheckV3.0.sh` | 采集端 | 13 个模块，统一 txt 输出（OS / DB / 慢日志 / 错误日志 / 备份 / 安全）|
| `scripts/extract.js` | 解析端 | 段落解析 + 20+ 规则 + 健康度评分 + 关联推断 + 备份评估 + 安全合规 |
| `scripts/render.js` | 渲染端 | 17 章 docx + 10 张嵌入图表（SVG→PNG）+ 占位符自检 |

---

## 🔍 自动检测规则完整清单

巡检规则按健康度的 **6 个维度** 分组。每条规则在报告里都会生成一条 issue（含优先级、节点、措施、SQL），并按 `disabledRules` / `priorities` 配置接管开关与优先级。

> **图例**：P0 = 紧急（立即修） · P1 = 重要（两周内） · P2 = 建议（一月内） · P3 = 观察 · 🆕 = v4.8 新增 · ⚙️ = 阈值可配置

### 🟥 可用性（availability）— 影响服务能否对外提供

| Rule ID | 优先级 | 含义 | 触发条件 | 配置键 |
|---|---|---|---|---|
| `mem_high` | P1 | 内存使用率偏高，可能拖累 buffer pool 或触发 Swap | 节点内存使用率 > 90% | ⚙️ `memory.high_pct` |
| `swap_used` | P1 | Swap 已被使用，数据库内存被换出会引发性能抖动 | Swap 已使用（free < total）| - |
| `disk_critical` | **P0** | 磁盘空间紧急，binlog/redo 写入可能直接失败 | 任一挂载点使用率 ≥ 90% | ⚙️ `disk.critical_pct` |
| `disk_high` | P1 | 磁盘已用偏高，需在本周内清理或扩容 | 任一挂载点使用率 ≥ 80% | ⚙️ `disk.high_pct` |
| `repl_thread_down` | **P0** | 复制线程异常，从库已不同步 | `Slave_IO_Running ≠ Yes` 或 `Slave_SQL_Running ≠ Yes` | - |
| `repl_delay_high` | P1 | 从库延迟过大，故障切换会丢数据 | `Seconds_Behind_Master > 300s` | ⚙️ `replication.delay_p1_seconds` |
| `repl_delay_low` | P2 | 从库延迟轻微但需关注趋势 | `Seconds_Behind_Master > 60s` | ⚙️ `replication.delay_p2_seconds` |
| 🆕 `bp_too_large` | P1 | InnoDB Buffer Pool 占内存过大，可能挤压 OS 触发 OOM | bp_size > 80% RAM | ⚙️ `innodb.bp_too_large_ratio` |
| 🆕 `max_connections_vs_memory` | P1/P2 | max_connections × 单连接峰值超过 RAM 30% 或 50%，可能 OOM | peak_mem 公式见下文 | ⚙️ `max_connections.peak_memory_ratio_warn` / `_p1` |

### 🟧 持久化（durability）— 数据不丢、可恢复

| Rule ID | 优先级 | 含义 | 触发条件 | 配置键 |
|---|---|---|---|---|
| `flush_log_weak` | P1 | redo log 仅每秒刷盘，主库 crash 可能丢 1 秒事务 | `innodb_flush_log_at_trx_commit = 0` | - |
| `sync_binlog_weak` | P1 | binlog 不强制 fsync，崩溃时从库与主库 binlog 漂移 | `sync_binlog = 0` | - |
| `gtid_off` | P2 | 未启用 GTID，故障切换需手工对位 | `gtid_mode = OFF` | - |
| `master_readonly` | P1/P3 | 主库被设为只读（无法写入）— standalone read-only 推断时降级 P3 | primary 节点 `read_only = 1` | - |
| `slave_writable` | P1 | 从库可写，存在数据漂移风险 | slave `read_only = 0` | - |
| `dr_writable` | P3 | 灾备节点可写（可能是切换设计预留），需人工确认 | DR 节点 `read_only = 0` | - |
| `self_ref_slave_residue` | P2 | SHOW SLAVE STATUS 残留指向本机（曾是从库未 RESET SLAVE ALL）| `Master_Host = 本机 IP/hostname` | - |
| `expire_logs_zero` | P1 | binlog 永不过期，磁盘会被撑爆 | `expire_logs_days = 0` | - |
| `expire_logs_long` | P3 | binlog 保留过长，磁盘成本上升 | `expire_logs_days > 30` | ⚙️ `binlog.expire_logs_max_days` |
| `swap_used` | P1 | 见可用性段 | - | - |
| `ibtmp1_oversize` | P2 | 临时表空间膨胀，可能撑爆磁盘 | ibtmp1 > 5 GB | ⚙️ `innodb.ibtmp1_max_gb` |
| `ibtmp1_no_max` | P2 | 临时表空间未配 `:max:` 上限 | `innodb_temp_data_file_path` 缺 `:max:` | - |
| 🆕 `doublewrite_off` | P1 | 半页写崩溃会导致页损坏不可恢复（torn page） | `innodb_doublewrite = OFF` | - |
| 🆕 `slave_skip_errors_set` | **P0** | 复制错误被静默跳过，从库与主库已经/将会数据不一致 | `slave_skip_errors ≠ OFF/NONE` | - |

### 🟨 性能（performance）— 吞吐、延迟、缓存命中

| Rule ID | 优先级 | 含义 | 触发条件 | 配置键 |
|---|---|---|---|---|
| `bp_hit_low` | P1 | Buffer Pool 命中率低，频繁磁盘 IO | hit_rate < 95% | ⚙️ `innodb.bp_hit_low_pct` |
| `bp_hit_sub99` | P3 | Buffer Pool 命中率未达 99% 推荐线 | hit_rate < 99% | ⚙️ `innodb.bp_hit_warn_pct` |
| `innodb_hll_high` | P1/P2 | History List Length 过高，undo 历史清理滞后；常伴长事务 | HLL > 10000（P1 当 > 50000）| ⚙️ `innodb.hll_warn` / `.hll_p1` |
| `long_running_session` | P2/P3 | 存在长时间运行的业务会话（>= 60s）| 非 sleep/复制线程会话 ≥ 60s | ⚙️ `session.long_running_seconds_p2` |
| `slow_query_abs_high` | P1 | 累计慢查询数量巨大（> 100 万），治理优先级最高 | `slow_queries > 1,000,000` | ⚙️ `sql.slow_query_abs_high` |
| `slow_query_abs_med` | P2 | 累计慢查询偏多 | `slow_queries > 100,000` | ⚙️ `sql.slow_query_abs_med` |
| `long_query_time_loose` | P3 | 慢查询阈值过宽，会漏掉本该被捕获的慢 SQL | `long_query_time ≥ 5` | ⚙️ `sql.long_query_time_loose` |
| `slave_parallel_workers_zero` | P1/P2 | 大数据量集群单线程应用 binlog，大事务会延迟堆积 | parallel_workers=0 且数据 ≥ 100 GB | ⚙️ `replication.parallel_workers_data_gb_p2` / `_p1` |
| 🆕 `bp_too_small` | P1/P2 | **用户的示例规则**：buffer pool 占 RAM 过低，工作集 cache miss | bp 占 RAM < 40%（P1 < 20%） | ⚙️ `innodb.bp_too_small_ratio` / `_p1_ratio` |
| 🆕 `redo_log_too_small` | P1/P2 | redo log 文件过小，频繁切换拉低写吞吐 + 放大恢复时间 | log_file_size < 512 MB 且数据 ≥ 50 GB | ⚙️ `innodb.redo_log_min_mb` 等 |
| 🆕 `flush_method_not_o_direct` | P2 | Linux 上 fsync 双重缓存浪费内存 | Linux 且 flush_method ≠ O_DIRECT | - |
| 🆕 `data_to_memory_ratio_high` | P1/P2 | 数据量远大于内存，工作集无法常驻 buffer pool | `dbSize / RAM > 10`（P1 > 50） | ⚙️ `data_memory.ratio_warn` / `_p1` |

### 🟦 数据规范（dataDesign）— 表结构、字符集、索引

| Rule ID | 优先级 | 含义 | 触发条件 | 配置键 |
|---|---|---|---|---|
| `no_pk_tables` | P2 | 业务表无主键，ROW 复制效率极低 + 无法 MTS 并行 | 至少 1 张业务表无主键 | - |
| `no_pk_tables_temp_only` | P3 | 仅临时/历史表无主键，确认无业务引用后可清理 | 全部无主键都是临时/字典表 | - |
| `non_utf8_tables` | P2 | 存在非 utf8 表，部分语种/emoji 无法存 | 至少 1 张 charset ≠ utf8 | - |
| `heavy_frag_tables` | P2 | 存在大表碎片，浪费磁盘且影响顺序扫描 | 碎片率 ≥ 70% 且碎片 ≥ 100 MB | ⚙️ `frag.rate` / `frag.min_mb` |
| `ghost_tables` | P2 | pt-osc / gh-ost 在线 DDL 残留 ghost 表（≥ 1 GB） | 单表 ≥ 1 GB 的 `_gho_*` / `_*_new` | - |
| `lct_zero_linux` | P3 | Linux 上大小写敏感（lower_case_table_names=0），跨平台风险 | Linux + LCT=0 | - |
| 🆕 `charset_not_utf8mb4` | P2 | utf8 实际是 utf8mb3，已 deprecated，无法存 4 字节字符（emoji） | `character_set_server` 非 utf8mb4 | - |
| 🆕 `sql_mode_missing_strict` | P2 | sql_mode 不严格，错误数据被静默截断（INT 越界写 0、字符串裁断） | sql_mode 缺 `STRICT_TRANS_TABLES` | - |
| 🆕 `auto_increment_exhausting` | P0/P1/P2 | 自增列接近耗尽，耗尽后 INSERT 会报 ER_AUTOINC_READ_FAILED | rate ≥ 0.7（≥ 0.9 升 P0）| ⚙️ `auto_increment.rate_p2` / `_p1` / `_p0` |

### 🟪 安全（security）— 账号、加密、远程访问

| Rule ID | 优先级 | 含义 | 触发条件 | 配置键 |
|---|---|---|---|---|
| `wildcard_critical` | **P0** | root / admin / dba / super 等管理员账号开放 host=% | host=% 用户名 ∈ {root, admin*, dba*, super*} | - |
| `wildcard_high` | P1 | 复制 / 备份账号开放 host=%，应限定到具体网段 | host=% 用户名 ∈ {repl*, backup*, dump*} | - |
| `wildcard_medium` | P2 | 业务账号开放 host=%，建议限定到内网网段 | host=% 业务账号（一行聚合所有用户）| - |
| `tls_weak_protocol` | P2 | TLS 协议含 TLSv1 / TLSv1.1，NIST 已废弃 | `tls_version` 含旧版本 | - |
| 🆕 `auth_plugin_native_on_80` | P2 | 8.0+ 默认 mysql_native_password（SHA1 派生），8.4 起 disabled | 8.0+ 且 plugin = `mysql_native_password` | - |

### ⚪ 运维（operations）— 备份、监控、版本生命周期

| Rule ID | 优先级 | 含义 | 触发条件 | 配置键 |
|---|---|---|---|---|
| `backup_capability` | P0/P1/P2 | 备份能力评估（工具、调度、最近备份时效） | 无备份工具/调度，或最近备份 > 180 天 | - |
| `slow_log_off` | P2 | 慢日志未开启，无法做 SQL 治理审计 | `slow_query_log = 0` | - |
| `os_version_eol` | P1/P2 | 操作系统已 EOL（CentOS 6/7/8、Ubuntu 18.04 等） | osEolStatus.status = eol | - |
| `mysql_version_eol` | P0/P1 | MySQL 主版本已 EOL（5.5/5.6/5.7） | 通过 MYSQL_EOL_TABLE 匹配 | - |
| `mysql_version_security` | P3 | MySQL 进入仅安全更新阶段（8.0 自 2026-04 起）| 同上 | - |
| `param_inconsistent` | P2 | 跨节点关键参数不一致（read_only、long_query_time 等） | 节点间核心参数有差异 | - |
| 🆕 `performance_schema_off` | P2 | P_S 关闭，失去 TOP SQL 与监控指标（PMM/exporter 缺核心指标）| `performance_schema = OFF` | - |

> 想看每条规则的实际 push() 代码与完整 SQL 模板，请阅读 [`references/rules.md`](references/rules.md) 或直接看 `scripts/extract.js` 的 `analyzeIssues()` 函数。

### 🧠 根因关联（v4.9 重写为数据驱动）

报告里除了单条 issue，还会自动生成跨规则的「根因关联」（Root-Cause Correlations），把多个孤立指标串成一条因果链。v4.9 共 16 条关联模式，全部用**多信号交叉验证 + 「已确认 / 已排除 / 需进一步排查」三态判定**，避免「可能 / 疑似」类弱推断。

举例 — 老版本会说"从库间 ibtmp1 大小差异显著，**通常源于**节点重启时间不同"（猜测）；v4.9 改为：
> 各从库 ibtmp1 占用差异显著：最小 12.00 MB（节点 A，uptime 275 天） · 最大 17.20 GB（节点 B，uptime 967 天），相差 1467× 。
> 交叉验证：
>   · **【已确认】** 节点间重启时间差 692 天（ibtmp1 重启会重置归零，长 uptime 节点累积更多）
>   · **【已排除】** 从库间 qps 接近（120 ~ 145，读业务相对均衡）

16 条关联速览：

| 类别 | 关联示例 |
|---|---|
| **磁盘归因** | C1 磁盘高位 → diskAttribution 拆出 binlog/慢日志/错误日志/ibtmp1 各占百分比；C10 慢日志膨胀因素；C11 错误日志暴涨；C15 节点间 binlog 增长速率差异 |
| **复制风险** | C7 复制延迟根因拆解（parallel_workers / 主从 qps 差）；C12 持久化弱 + 延迟 → RPO 量化；C13 从库可写 + 延迟 → 数据漂移 |
| **资源压力** | C8 Swap 压力级联（bp_size / qps / max_conn）；C6 内存低 → 用 uptime 区分冷启动 vs 资源浪费 |
| **生命周期** | C9 OS + MySQL 双重 EOL；C14 自增列耗尽 + 慢查询累积 |
| **安全 / 持久化** | C2 全集群持久化偏弱；C5 全集群 root@% |
| **临时表 / 工作集** | C3 主库慢查询 ↔ ibtmp1 强相关；C4 从库 ibtmp1 差异 — 用 uptime + qps 三态归因 |

完整 16 条关联与触发条件见 [`references/rules.md`](references/rules.md)。

---

## ⚙️ 配置巡检阈值（v4.8+）

### 三层配置优先级（从低到高）

```
① 内置默认  <  ② 采集目录同名文件  <  ③ CLI --config 参数
```

**① 内置默认**：`scripts/config/default-thresholds.json`（含全部 30+ 阈值 + 注释，零配置即可使用）。

**② 采集目录自动发现**：在数据目录放一份 `mysql-healthcheck.config.json`，extract 时自动 deep-merge — 适合「客户 A 用一份，客户 B 用另一份」场景：

```bash
# 目录布局
/data/customer-A/
  ├── MySQLHealthCheck_10.0.0.1_*.txt
  ├── MySQLHealthCheck_10.0.0.2_*.txt
  └── mysql-healthcheck.config.json     # ← 自动应用
```

**③ CLI 临时覆盖**：最高优先级，适合调试或一次性场景：

```bash
node scripts/extract.js <data-dir> --config /path/to/custom.json --out data.json
```

### 配置文件三个顶层段

```json
{
  "thresholds": {        // ① 调整阈值
    "disk": { "critical_pct": 85, "high_pct": 75 },
    "innodb": { "bp_too_small_ratio": 0.5, "hll_warn": 5000 },
    "sql":   { "long_query_time_loose": 2 }
  },
  "disabledRules": [     // ② 禁用规则（type 名见上文清单）
    "sql_mode_missing_strict",
    "auth_plugin_native_on_80"
  ],
  "priorities": {        // ③ 覆盖单条规则优先级
    "wildcard_medium": "P3",
    "long_query_time_loose": "P2"
  }
}
```

### 三种典型场景

#### 场景 A：金融 / 合规客户（阈值收紧）

```bash
# 直接用 strict 模板
node scripts/extract.js <data-dir> --config scripts/config/samples/strict.json
```

`strict.json` 把磁盘告警阈值改为 80/70、bp_hit 推荐 99%、long_query_time 上限 2s、binlog 保留 14 天等。

#### 场景 B：POC / 内部环境（噪声收敛）

```bash
node scripts/extract.js <data-dir> --config scripts/config/samples/lenient.json
```

`lenient.json` 阈值放宽 + 禁用 `sql_mode_missing_strict` / `charset_not_utf8mb4` / `auth_plugin_native_on_80` / `performance_schema_off` 等合规向规则。

#### 场景 C：单条阈值定制

只想把磁盘 90% 改为 95%：

```bash
echo '{"thresholds":{"disk":{"critical_pct":95,"high_pct":90}}}' \
  > /path/data/mysql-healthcheck.config.json
node scripts/extract.js /path/data
```

### 完整阈值键速查

| 分组 | 配置键 | 默认值 | 控制的规则 |
|---|---|---|---|
| **disk** | `critical_pct` / `high_pct` | 90 / 80 | `disk_critical` / `disk_high` |
| **memory** | `high_pct` | 90 | `mem_high` |
| **innodb** | `hll_warn` / `hll_p1` | 10000 / 50000 | `innodb_hll_high` |
| | `bp_hit_low_pct` / `bp_hit_warn_pct` | 95 / 99 | `bp_hit_low` / `bp_hit_sub99` |
| | `bp_too_small_ratio` / `_p1_ratio` | 0.4 / 0.2 | `bp_too_small` |
| | `bp_too_large_ratio` | 0.8 | `bp_too_large` |
| | `bp_too_small_min_mem_gb` | 4 | bp 规则跳过小机器 |
| | `ibtmp1_max_gb` | 5 | `ibtmp1_oversize` |
| | `redo_log_min_mb` / `_db_gb_busy` / `_db_gb_heavy` | 512 / 50 / 200 | `redo_log_too_small` |
| **session** | `long_running_seconds_p2` | 600 | `long_running_session` |
| **replication** | `delay_p1_seconds` / `delay_p2_seconds` | 300 / 60 | `repl_delay_high` / `repl_delay_low` |
| | `parallel_workers_data_gb_p2` / `_p1` | 100 / 500 | `slave_parallel_workers_zero` |
| **sql** | `slow_query_abs_high` / `_med` | 1000000 / 100000 | `slow_query_abs_*` |
| | `long_query_time_loose` | 5 | `long_query_time_loose` |
| **frag** | `rate` / `min_mb` | 0.7 / 100 | `heavy_frag_tables` |
| **binlog** | `expire_logs_max_days` | 30 | `expire_logs_long` |
| **max_connections** | `peak_memory_ratio_warn` / `_p1` | 0.3 / 0.5 | `max_connections_vs_memory` |
| **data_memory** | `ratio_warn` / `_p1` | 10 / 50 | `data_to_memory_ratio_high` |
| **auto_increment** | `rate_p2` / `_p1` / `_p0` | 0.7 / 0.8 / 0.9 | `auto_increment_exhausting` |

完整 JSON schema 与注释见 `scripts/config/default-thresholds.json`。

### 验证配置是否生效

extract 完成后 `data.json` 末尾包含 `hcConfig` 段，可直接查看实际应用的阈值：

```bash
node scripts/extract.js <data-dir> --config <my.json> --out /tmp/d.json
jq '.hcConfig.thresholds.disk' /tmp/d.json
# {"critical_pct": 85, "high_pct": 75}     ← 已应用
jq '.disabledRulesApplied' /tmp/d.json
# ["sql_mode_missing_strict"]              ← 已禁用
```

控制台也会即时打印 `阈值配置：cli:my.json 已合并到默认值之上` 和 `已禁用规则：sql_mode_missing_strict` 帮助调试。

---

## 🤖 作为 Claude Code Skill 使用

本项目带有标准 [Anthropic Claude Code Skill](https://docs.anthropic.com/) 的 YAML frontmatter，可被 Claude 自动识别和触发。

### 安装为 Claude Skill

```bash
# 把 mysql-healthcheck/ 整个目录放或链接到 ~/.claude/skills/
ln -s "$(pwd)/mysql-healthcheck" ~/.claude/skills/mysql-healthcheck
```

### 触发方式

在 Claude Code 对话里随便说一句：

> "帮我生成 `<数据目录>` 的 MySQL 巡检报告"
> "用这个目录做一份月度健康评估"
> "整理巡检数据，输出商业交付级 docx"
> "给这个集群做合规自查"

Claude 会自动加载本 skill 的 `SKILL.md` playbook，按 2 步流程完成生成。

---

## 📚 文档导航

| 文档 | 作用 | 读者 |
|---|---|---|
| [README.md](README.md) | 项目主页，5 分钟上手 | 所有人 |
| [USAGE.md](USAGE.md) | 完整使用指南（10 节 + FAQ + 排错） | DBA / 运维 |
| [SKILL.md](SKILL.md) | Claude Code Skill 协议规范 | Agent / Skill 开发者 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 | 升级前阅读 |
| [references/visual-spec.md](references/visual-spec.md) | 视觉规范（颜色 / 字体 / 列宽） | 改样式时 |
| [references/rules.md](references/rules.md) | 检测规则 + 健康度评分模型 | 改规则时 |
| [references/parsing.md](references/parsing.md) | 采集段名与解析字段映射 | 排查解析失败时 |
| [references/interview-guide.md](references/interview-guide.md) | 客户访谈表填写指引 | 巡检前访谈业务方 |

---

## 🗺️ Roadmap

- [ ] 上次巡检对比（diff 历史 data.json，输出趋势图）
- [ ] HTML 版本报告（除 docx 外多一种产物）
- [ ] 监控告警配置一键生成（Prometheus / Zabbix 模板）
- [ ] PostgreSQL / Oracle 巡检（同架构复用 extract+render 设计）
- [ ] 在线 SaaS 版本（上传 txt → 下载 docx，无需本地 Node 环境）

提交需求请开 issue。

---

## 🤝 贡献

- 🐛 **Bug / 需求**：到 [Issues](https://github.com/aimdotsh/mysql-healthcheck/issues) 反馈
- 🔧 **PR**：欢迎，目标分支 `main`
- 💬 **讨论**：到 [Discussions](https://github.com/aimdotsh/mysql-healthcheck/discussions)（启用后）

开发约定：

- 完成一项独立功能就 commit（不堆积），commit message 用 `feat: / fix: / docs: / chore: / refactor:` 前缀
- 新加检测规则：编辑 `scripts/extract.js` 的 `analyzeIssues()`，同步更新 [references/rules.md](references/rules.md)
- 新加章节：在 `scripts/render.js` 写 `chapterXxx(data)` 函数，加到 `buildDocument` 的 children
- 改样式：参考 [references/visual-spec.md](references/visual-spec.md)，保持配色一致

---

## 📄 License

[MIT](LICENSE) — 商业 / 内部使用均无需署名。

---

## 🙏 致谢

- 巡检思路参考了云和恩墨 DBA 团队多年现场实战经验
- 图表生成基于 [@resvg/resvg-js](https://github.com/yisibl/resvg-js)
- docx 渲染基于 [docx](https://github.com/dolanmiu/docx)

---

<p align="center">
  <sub>Made with ❤️ for DBAs who want to spend less time writing reports and more time fixing real issues.</sub>
</p>
