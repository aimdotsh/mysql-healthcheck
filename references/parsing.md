# txt 数据段名清单（LLM 解析速查）

> 给 LLM 看的「采集 txt 段名 → 报告章节」映射表。
> LLM 在分析 `MySQLHealthCheck_*.txt` 时按这里的索引找数据。

## 段标记格式

txt 文件中所有段都以以下标记开头：

```
----->>>---->>>  [NN] 段名
```

或兼容旧格式（无 `[NN]` 前缀）：

```
----->>>---->>>  段名
```

LLM 用 grep / 正则识别段开始即可。

## V3.0 采集脚本输出的 13 个模块

| 模块 | 段名（关键字） | 包含字段 |
|---|---|---|
| 01 主机 | hostname / os release / os kernal / ip info / mem info / mem usage / CPU model / CPU cores / NUMA info / Top Info / ntp Info / resource limit / swap method / io scheduler / io usage / disk mount / mount options / kernel params / network connections / my.cnf detail / mysqld process / mysqld process limits | hostname / OS 版本 / 内存 / CPU / 磁盘 / Swap / 系统参数 |
| 02 实例 | MySQL Database Version / Version details / Plugins info / Database basic info | 版本 / 编译平台 / 插件 / 启动时间 |
| 03 变量 | MySQL Variables / Important variables / Performance schema sizing | SHOW VARIABLES 全集 |
| 04 复制 | MySQL Replication Info / Master status / Binary logs / GTID sets / Semi sync variables / Semi sync status / Replication threads / Replication group members / Replication connection status | SLAVE STATUS / MASTER STATUS / GTID / 半同步 / MGR |
| 05 容量 | DB TOTAL SIZE / All databases and size details / Database objects summary / Top 10 Tables / Top 10 Index Size / Tables fragment rate > 30% / Not utf8 table / BLOB info / PARTITIONS table / NOT BASE TABLE / ROUTINES OBJECTS / database CHARACTER / DATA_TYPE / auto_increment usage / NO PRIMARY KEY TABLES / Not innodb table / All engines / innodb_tablespaces | 大表 / 大索引 / 字符集 / 大字段 / 分区 / 存储过程 / 自增 / 无主键 / 引擎 / ibtmp1 |
| 06 用户 | user check / All users / password check / current connection user and host / host connections stats / failed login attempts / login info by user+host / login info by db+user+host | mysql.user 全表 / 密码状态 / 登录失败 |
| 07 锁 | Processlist info / All processlist / Sleep threads / Threads info / Open tables in use / INNODB LOCKS / INNODB LOCK WAITS / INNODB TRX / LOCK DETAILS / Metadata locks / Lock status counters | 会话 / 锁等待 / 事务 / 元数据锁 |
| 08 InnoDB | Engine innodb status / InnoDB key metrics / InnoDB buffer pool stats | SHOW ENGINE INNODB STATUS / HLL / BP 状态 |
| 09 SQL 性能 | Performance status / TOP 20 SQL by total latency / TOP 20 SQL by exec count / TOP 20 SQL by avg latency / SQL with full scan / SQL with temp tables / SQL with disk sort / SQL no good index / SQL errors and warnings / Schema unused indexes / Schema redundant indexes / Index low cardinality | sys 库 + performance_schema |
| 10 日志 | Slow query log status / Slow query log tail / Error log status / Error log tail | 慢日志末尾 5000 行 + error log 末尾 500 行 |
| 11 备份 | Backup tools available / Crontab for mysql user / Crontab for root / System cron files for backup / Backup directory inspection / Binlog directory | mysqldump / xtrabackup / mariabackup 工具检测 + crontab + 备份目录 |
| 12 安全 | Audit plugin status / TLS / SSL configuration / TLS / SSL status / Password validation policy / InnoDB encryption status / Keyring plugin / Users with empty password / Users with old auth plugin / Global SQL_MODE / Audit log files | 审计插件 / TLS 状态 / 空密码用户 / 老认证插件 / sql_mode |
| 13 访谈 | interview template | 客户访谈模板（业务背景 / 容灾 / 项目名 等，详见 `interview-guide.md`） |

## 数据流向（skill 分支视角）

```
txt 文件（collector 输出）
  └─ LLM 直接读
       ├─ 按段名提取数据（hostname / SLAVE STATUS / TOP SQL / ...）
       ├─ 应用 references/rules.md 里 42 条规则
       ├─ 推断集群拓扑（主从 / DR / 多主）
       ├─ 计算 6 维度健康度评分
       └─ 按 references/report-template.md 输出 17 章 markdown
            └─ MySQL巡检报告_<日期>.md
```

## 段名不匹配时的处理（LLM 视角）

MySQL 版本差异可能导致段名变体（如 8.0+ 的 `Replication group members` 在 5.7 不存在）。LLM 看到段缺失时：

1. 不要报错退出
2. 在对应报告章节标注「{段名} 未采集 / 该 MySQL 版本不适用」
3. 继续分析其它段

## 字段使用指南（按报告章节分组）

LLM 在写每章时知道去哪个段拿数据：

| 报告章节 | 主要数据段 |
|---|---|
| 第二章 OS / 硬件 | 01 主机 |
| 第三章 MySQL 版本 | 02 实例 |
| 第四章 集群拓扑 | 04 复制（推断主从）+ 文件名里的 IP |
| 第五章 参数 | 03 变量 |
| 第六章 性能指标 | 03 变量 + 08 InnoDB + 09 SQL 性能 |
| 第七章 容量 | 05 容量 |
| 第八章 InnoDB | 08 InnoDB |
| 第九章 引擎深度 | 08 InnoDB + 07 锁 |
| 第十章 会话 + 锁 + error log | 07 锁 + 10 日志 |
| 第十一章 用户 | 06 用户 |
| 第十二章 复制 | 04 复制 |
| 第十三章 Schema 审计 | 05 容量（无主键 / 非 utf8 / 大字段 / 自增 / 分区） + 09 SQL 性能（unused/redundant indexes） |
| 第十四章 SQL 治理 | 09 SQL 性能 + 10 日志 |
| 第十五章 备份 | 11 备份 |
| 第十六章 行动计划 | 综合所有 |
| 第十七章 结论 | 综合所有 |

## 多节点集群

文件命名约定：`MySQLHealthCheck_<IP>_<时间戳>.txt`

LLM 读所有 txt → 按 IP 区分各节点 → 用以下信号识别拓扑：

1. **主库**：没有 `Master_Host:` 字段（SLAVE STATUS 为空）
2. **从库**：`Master_Host:` 指向某个 IP（或 hostname）
3. **灾备节点**：hostname 含 `dr-` / `dr_` / `drdb` 前缀，或 `read_only=0` 但 hostname/IP 异常
4. **脱敏场景**：所有 hostname 都是同一占位字符串（如 `masked-hostname`）→ 用 `Master_Server_Id` 匹配主库 `server_id` 兜底识别

## 采集时间提取

报告封面用：

```
采集时间: 2026-05-22 10:30:38
```

从 txt 顶部「采集时间：YYYY-MM-DD HH:MM:SS」行抓即可。
