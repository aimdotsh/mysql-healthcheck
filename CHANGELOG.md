# CHANGELOG

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [4.1.0] - 2026-05-14

**重命名与版本号解耦**。

### ⚠️ 重命名（Breaking）

| 项 | 旧 | 新 |
|---|---|---|
| skill 名称 | `mysql-inspection-report` | `mysql-healthcheck` |
| GitHub 仓库 / 发行包 | `mysql-inspection-report` | `mysql-healthcheck` |
| 安装目录 | `~/.workbuddy/skills/mysql-inspection-report/` | `~/.workbuddy/skills/mysql-healthcheck/` |
| Claude Code skill | `~/.claude/skills/mysql-inspection-report/` | `~/.claude/skills/mysql-healthcheck/` |
| package.json name | `mysql-inspection-report-detailed` | `mysql-healthcheck` |

新名字与采集脚本 `mysqlHealthCheckV3.0.sh` 命名一脉相承，整个工具链统一。

### 🆕 报告版本与工具版本解耦

之前 docx 封面和文件名沿用 skill 版本号（v4.0），容易混淆「工具版本」与「报告版本」。从 v4.1 起：

- **报告版本**（写在 docx 文件名和封面）默认 `v1.0`，每次给客户递交一份就是 v1.0；如果同一份报告反复修订，可改为 v1.1 / v1.2
- **工具版本**（v4.1）仅写在 docx 元数据（`creator` 字段）和 README/CHANGELOG
- `extract.js` 新增 `--report-version` 参数；`data.json` 新增 `reportVersion` 字段

### 🎨 docx 文案调整

- 封面主标题：「MySQL 数据库巡检报告（详细版）」→ **「MySQL 数据库健康巡检报告」**
- 文件名：`<项目>_MySQL数据库巡检报告_详细版_v4.0.docx` → **`<项目>_MySQL健康巡检报告_v1.0.docx`**
- 封面版本行：`版本：v4.0` → **`报告版本：v<reportVersion>`**

### 🐛 修复

- 清理所有「8 章精简版」相关描述，仅保留单一主线（v4.1）

---

## [4.0.0] - 2026-05-13

**商业可交付级**升级。结构从 13 章扩展到 **17 章**，增加图表、目录、执行摘要、健康度评分等高级 DBA 报告必备元素。

### 🆕 新增章节

- **执行摘要页**（面向管理层一页式摘要）：6 维度健康度评分 + 关键事实速览
- **目录页（TOC）**：自动生成可点击目录
- **十三、Schema 设计审计**：未使用索引 / 冗余索引 / 大字段分布 / 分区表 / 自增列使用率 / 存储过程清单（这些数据原本已采集但 v3.x 未渲染）
- **十四、SQL 性能治理**：TOP 20 慢 SQL（performance_schema.events_statements_summary_by_digest）+ 慢日志样本 + 全表扫描 SQL + 临时表 SQL
- **十五、备份与恢复评估**：备份工具检测 / cron 调度 / 备份产物 / RTO·RPO 推算
- **十六、安全合规审计**：9 项自动检查 + 等保 2.0 / PCI DSS / GDPR / SOX 框架对照
- **十七、巡检总结与行动计划**：原十三章重命名

### 🎨 新增图表（替代纯文字 / 表格）

- 健康度仪表（圆环式 Gauge）
- 6 维度雷达图（可用性 / 安全性 / 性能 / 数据规范 / 持久化 / 运维）
- 问题优先级分布饼图
- 磁盘使用率横向柱状图
- Buffer Pool 命中率纵向柱状图
- TOP 10 大表横向柱状图（含归档表着色）
- 安全合规结果饼图

### 🔧 内部架构

- `scripts/lib/charts.js` —— 纯 SVG 图表生成器（gauge / pie / hbar / vbar / radar）
- `@resvg/resvg-js` —— SVG → PNG 转换（预编译二进制，跨平台无需 native 编译）
- `extract.js` 新增字段：`healthScore`（六维度评分）/ `backupAssessment` / `securityAssessment` / `topSqlByLatency` / `unusedIndexes` / `redundantIndexes` / `autoIncrementUsage` / `slowLogAnalysis` / `errorLogAnalysis` 等

### 📥 采集脚本升级（V3.0）

新增 `collectors/mysqlHealthCheckV3.0.sh`（替代旧的 V2.0 + html SQL）：

- **单脚本，单 txt 输出**（不再生成 html，统一格式便于解析）
- 段名规范：`----->>>---->>>  [NN] 段名`（13 个模块）
- 支持命令行参数 + 非交互式批量运行
- **新增采集**：
  - 慢日志 tail（默认 5000 行）
  - 错误日志 tail（默认 1000 行）
  - TOP 20 SQL by latency / exec count / avg latency
  - 备份工具检测 / crontab 扫描 / 备份目录扫描
  - TLS / SSL 配置与状态
  - InnoDB 加密状态
  - 审计插件状态
  - 密码策略
  - 失败登录次数
  - CPU 型号、NUMA 信息、内核参数、网络连接数
  - InnoDB key metrics + buffer pool stats（per pool）
  - 客户访谈占位段

### 🐛 修复

- CPU 型号字段不再显示 `-`（V3 采集脚本读取 `/proc/cpuinfo`）
- 数据库列表 / 用户清单错取 IP 最小节点（已修复为取主库）
- v3.1 → v4.0 版本号全局更新

---

## [3.1.0] - 2026-05-13

基于 v3.0 报告的实战使用反馈，对**分析深度**、**问题聚合**、**用户体验**做了系统性提升。

### 🆕 新增

- **跨节点 issue 聚合**：同一条问题影响多个节点时自动合并为一行（如「sync_binlog=0 — 全部节点」），不再 N 个节点重复列 N 次。
- **根因关联分析（correlations）**：自动识别 6 类典型关联，第一章新增「1.3 根因关联分析」段：
  - DR 节点磁盘高位 ↔ binlog 永不过期
  - 全集群持久化偏弱（commit=0 + sync_binlog=0）
  - 主库慢查询累积 ↔ ibtmp1 增长
  - 从库间 ibtmp1 大小差异显著
  - 集群所有节点 root@%
  - DR 节点内存利用率显著低于主库
- **参数差异自动判断**：5.2 章用 ✅/❌ 表格替代纯枚举，自动标注每项差异是否合理（server_id 不同 ✅，expire_logs_days 不同 ❌）。
- **host=% 用户按危险等级分组**：第十一章新增「11.2 host=% 用户分级」表，按致命/高危/中危/低危分类，避免一锅炖。
- **行动计划带 SQL 示例**：第十三章每条 P0/P1/P2 后附现成 SQL 命令，可复制即执行。
- **历史归档表识别**：第七章 TOP10 自动标注带日期后缀的归档表（`tbl_xxx_20240606`），并提示归档可释放空间。
- **跨节点库差异检测**：第四章自动比较主从节点的数据库列表，发现增减。
- **慢查询按绝对值分级**：累计 >100 万 → P1，>10 万 → P2（原版本按比例容易低估）。
- **新规则**：
  - `expire_logs_days = 0`（永不过期）→ P1
  - `slow_query_log = 0` → P2
  - `ibtmp1` 配置缺 `:max:` 上限 → P2
  - `lower_case_table_names = 0`（Linux 跨平台风险）→ P3

### 🐛 修复

- **第十一章用户清单**：以前取的是 IP 最小的节点（DR 灾备），现取**主库**节点。第四章数据库清单同样修复。
- **第三章长会话误报**：以前会把从库 `system user` 的复制线程（运行时长上千万秒）当成长会话；现已过滤 `system user` 与 `Waiting for master / Queueing master event / Slave has read all` 状态。
- **第七章碎片表噪声**：以前列出 22 张含几 MB 临时表的高碎片表；现仅保留碎片空间 ≥100MB 且碎片率 ≥70% 的表。
- **行动计划重复**：以前同一条问题（如 sync_binlog=0）在 4 个节点上各列 1 次，共重复 15+ 次。现自动去重。
- **持久化建议措辞**：从库报告的 `innodb_flush_log_at_trx_commit=0` 不再写"若为主库建议改为 1"（措辞自相矛盾）。

### 🎨 改进

- 第一章新增「1.1 集群级问题 / 1.2 节点级问题」分组，结构更清晰。
- 整体评估在 P0 紧急存在时显示「存在紧急风险，需立即处理」。
- 第七章新增「合计可释放空间」提示与「大表推荐 pt-online-schema-change」说明。

### 📊 数据指标

以一个 4 节点集群为例：
- 问题总数：35 → **27**
- 重复条目：12 → **0**
- 自动关联：0 → **6 条**
- 行动计划带 SQL：0 → **几乎全部 P0/P1/P2**

---

## [3.0.0] - 2026-05-13

首个数据驱动版本（核心架构）。

### 新增

- **数据/视图分离**：`extract.js` 解析原始 txt/html 为 `data.json`，`render.js` 渲染 docx，互不耦合。
- **多节点表格自动展开**：4 节点就 4 行，无需手工复制粘贴模板。
- **20+ 条自动巡检规则**：内存、磁盘、复制延迟、配置一致性等。
- **占位符残留自检**：渲染结束自动解压 docx 检查 `{xxx}` 残留。
- **列宽智能加权**：按列内容类型分配权重（序号 0.5 / 描述 2.2 / 节点 IP 1.1），避免 WPS/Word 表格列宽混乱。
- **数值规范化**：`innodb_buffer_pool_size_in_mb` 等字段自动去除尾零（`40960.00000000` → `40960`）。
- **server_id 修正**：从 my.cnf 多行赋值中按 MySQL 行为取最后一行。
- 一键安装脚本 `install.sh`。

### 修复

- A4 内容宽度计算错误（9200 DXA 改为 8640 DXA）。
- 各表格列宽未显式声明，WPS 中表格挤窄。

---

## 早期版本（已废弃）

- v2.0：13 章硬编码 docx 模板，全部占位需手工替换 —— 已被 v3.0 数据驱动方案完全替代
