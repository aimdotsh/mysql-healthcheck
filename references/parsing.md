# 数据段名清单（extract.js 解析依赖）

仅当 extract.js 解析失败、需要排查段名不匹配时查阅。

## 段标记格式

txt 文件中所有段都以以下标记开头：
```
----->>>---->>>  [NN] 段名
```
或兼容旧格式（无 `[NN]` 前缀）：
```
----->>>---->>>  段名
```

`extract.js` 的 `getSection()` 函数同时识别两种格式（去除 `[NN]` 前缀后比较）。

## V3.0 采集脚本输出的 13 个模块

| 模块 | 段名 | 主要字段 |
|---|---|---|
| 01 | hostname / os release / os kernal / ip info / mem info / mem usage / CPU model / CPU cores / NUMA info / Top Info / ntp Info / resource limit / swap method / io scheduler / io usage / disk mount / mount options / dist type / kernel params / network connections / my.cnf detail / mysqld process / mysqld process limits | 主机基础信息 |
| 02 | MySQL Database Version / Version details / Plugins info / Database basic info | 实例基础 |
| 03 | MySQL Variables / Important variables / Performance schema sizing | 变量配置 |
| 04 | MySQL Replication Info / Master status / Binary logs / GTID sets / Semi sync variables / Semi sync status / Replication threads / Replication group members / Replication connection status | 复制状态 |
| 05 | DB TOTAL SIZE / All databases and size details / Database objects summary / Top 10 Tables / Top 10 Index Size / Tables fragment rate > 30% / Not utf8 table / BLOB info / PARTITIONS table / NOT BASE TABLE / ROUTINES OBJECTS / database CHARACTER / DATA_TYPE / auto_increment usage / NO PRIMARY KEY TABLES / Not innodb table / All engines / innodb_tablespaces | 存储与对象 |
| 06 | user check / All users / password check / current connection user and host / host connections stats / failed login attempts / login info by user+host / login info by db+user+host | 用户与权限 |
| 07 | Processlist info / All processlist / Sleep threads / Threads info / Open tables in use / INNODB LOCKS / INNODB LOCK WAITS / INNODB TRX / LOCK DETAILS / Metadata locks / Lock status counters | 会话与锁 |
| 08 | Engine innodb status / InnoDB key metrics / InnoDB buffer pool stats | InnoDB |
| 09 | Performance status / TOP 20 SQL by total latency / TOP 20 SQL by exec count / TOP 20 SQL by avg latency / SQL with full scan / SQL with temp tables / SQL with disk sort / SQL no good index / SQL errors and warnings / Schema unused indexes / Schema redundant indexes / Index low cardinality | SQL 性能 |
| 10 | Slow query log status / Slow query log tail / Error log status / Error log tail | 日志 |
| 11 | Backup tools available / Crontab for mysql user / Crontab for root / System cron files for backup / Backup directory inspection / Binlog directory | 备份 |
| 12 | Audit plugin status / TLS / SSL configuration / TLS / SSL status / Password validation policy / InnoDB encryption status / Keyring plugin / Users with empty password / Users with old auth plugin / Global SQL_MODE / Audit log files | 安全 |
| 13 | interview template | 客户访谈占位 |

## 数据流向

```
txt 文件
  └─ extract.js (getSection / parseMysqlTable / parseReplication / parseInnodbStatus / analyzeSlowLog / analyzeErrorLog / parseBackupDirs)
       └─ data.json
            ├─ nodes[]          : 各节点解析结果
            ├─ healthScore      : 6 维度评分
            ├─ issues[]         : 自动检测问题（聚合后）
            ├─ correlations[]   : 根因关联
            ├─ paramJudgments[] : 参数差异 ✅/❌
            ├─ backupAssessment : 备份能力评估
            ├─ securityAssessment : 安全合规检查
            └─ recommendations  : 行动计划
                 └─ render.js (chapterXxx() × 17)
                      └─ docx
```

## 段名不匹配时的修复

如果 V3.0 采集脚本因 MySQL 版本不同输出了不同段名，需要：

1. 打开 txt 找实际段名
2. 编辑 `extract.js` 中对应 `getSection(content, '段名')` 调用，把关键字改成实际段名
3. 重跑

## 字段映射（已采集但容易忽略的）

| extract.js 字段 | 来源段 | 渲染章节 |
|---|---|---|
| `node.blobColumns` | `BLOB info` | 十三章 |
| `node.osRelease` / `node.osEolStatus` | `os release` | 二章 / 问题清单 |
| `node.swapUsed` / `node.swapUsagePct` | `mem info` | 二章 |
| `node.partitionTables` | `PARTITIONS table` | 十三章 |
| `node.routines` | `ROUTINES OBJECTS` | 十三章 |
| `node.ibtmp1` / `node.ibtmp1CollectionStatus` | `innodb_tablespaces` | 八章 |
| `node.innodbLocks` / `node.innodbLockWaits` / `node.metadataLocks` / `node.lockStatusCounters` | `INNODB LOCKS` / `INNODB LOCK WAITS` / `Metadata locks` / `Lock status counters` | 十章 |
| `node.unusedIndexes` | `Schema unused indexes` | 十三章 |
| `node.redundantIndexes` | `Schema redundant indexes` | 十三章 |
| `node.autoIncrementUsage` | `auto_increment usage` | 十三章 |
| `node.topSqlByLatency` | `TOP 20 SQL by total latency` | 十四章 |
| `node.slowLogAnalysis` | `Slow query log tail` | 十四章 |
| `node.errorLogAnalysis` | `Error log tail` | 十三章 / 总结 |
| `node.backupTools` | `Backup tools available` | 十五章 |
| `node.backupDirs` | `Backup directory inspection` | 十五章 |
| `node.tlsConfig` / `node.tlsStatus` | `TLS / SSL ...` | 十六章 |
| `node.hasInnodbEncryption` | `InnoDB encryption status` | 十六章 |
| `node.failedLogins` | `failed login attempts` | 十六章 |
