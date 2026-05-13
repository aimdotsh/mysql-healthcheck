# MySQL 数据库巡检报告生成技能 v4.0

## 技能描述

将巡检脚本采集的原始数据，自动转化为可直接递交客户的 MySQL 数据库**健康评估报告**。

报告涵盖执行摘要、自动目录与 17 章专题分析；内置**六维度健康度评分模型**（可用性 / 安全性 / 性能 / 数据规范 / 持久化 / 运维）、跨节点 issue 聚合、根因关联推断、TOP 20 慢 SQL 治理建议、备份能力评估、安全合规对照表（等保 2.0 / PCI DSS / GDPR / SOX）；以图表替代纯表格，每条 P0/P1/P2 整改建议附可直接执行的 SQL 片段。

**适用场景**：月度例行巡检、上线前健康评估、故障后复盘审计、合规与容量规划。

### v4.0 关键能力

- **数据—视图分离**：`extract.js` 解析原始 txt 为结构化 `data.json`，`render.js` 渲染 docx，可独立替换、便于二次开发。
- **采集脚本一体化**：`collectors/mysqlHealthCheckV3.0.sh` 单脚本输出统一 txt，含慢日志 / 错误日志 / 备份信息 / 安全配置等专业巡检维度。
- **多节点自适应**：N 节点自动展开为 N 行，跨节点同类问题自动聚合，避免重复条目堆积。
- **20+ 条自动巡检规则**：按 P0/P1/P2/P3 输出分级问题清单与配套行动计划。
- **9 项安全合规检查**：自动判定 PASS / WARN / FAIL，并映射到主流合规框架。
- **7 类专业图表**：仪表盘 / 雷达图 / 饼图 / 横向柱 / 纵向柱 / 集群对比 / 合规结果分布。
- **占位符自检与降级渲染**：缺失数据时章节优雅降级，渲染结束自动校验未替换片段。

---

## 适用场景

**典型触发**：用户提供某个项目（如「一卡通 Apple 集群」）的巡检数据目录，要求生成本月/上月巡检报告。

**用户表述识别**：
- 「生成 MySQL 巡检报告」/「整理巡检数据」/「写月度巡检」
- 「出一份健康评估」/「做一次 MySQL 体检」
- 「v4.0 报告」/「商业交付级巡检」/「17 章详细版」
- 「客户递交版报告」/「上线前评估」/「故障复盘报告」
- 「合规自查」（等保 / PCI / GDPR / SOX）

**业务场景**：
- 月度例行巡检（DBA 团队节奏性输出）
- 上线前 / 大促前健康评估
- 故障后 / 性能事件复盘
- 合规审计与容量规划

**输入约定**：数据目录至少包含 `MySQLHealthCheck_<IP>_<时间戳>.txt`（由 `collectors/mysqlHealthCheckV3.0.sh` 采集）；每节点一份。

---

## 输入约定

### 必需文件
- `MySQLHealthCheck_<IP>_<时间戳>.txt` —— 由 `mysqlHealthCheckV*.sh` 采集的原始 raw 数据。
- 每个节点一份。文件名中的 IP / 时间戳用于识别节点与巡检日期。

### 可选文件
- `<IP>_<项目>_<角色>-<日期>.html` —— html 巡检报告，用于补充 ibtmp1 精确大小。

### 真实段落标记（txt 中由 `----->>>---->>>` 引导）

| 段名 | 用途 |
|---|---|
| `hostname` / `os kernal` / `ip info` | 主机基础 |
| `mem info` / `mem usage` | 内存 |
| `CPU cores` / `CPU usage` / `Top Info` | CPU |
| `disk mount` / `dist type` / `io usage` | 磁盘 |
| `resource limit` / `swap method` / `io scheduler` | OS 参数 |
| `my.cnf detail` / `ps detail` | MySQL 启动配置 |
| `MySQL Database Version` | 版本、Uptime、QPS、慢查询累计 |
| `MySQL Replication Info` | 复制状态（含 SHOW SLAVE STATUS） |
| `MySQL Variables` | 关键配置参数 |
| `Engine innodb status` | InnoDB 状态、活跃事务、最近死锁 |
| `Processlist info` | 当前会话 |
| `user check` | 用户列表 |
| `database CHARACTER` | 库字符集 |
| `DB TOTAL SIZE` / `Top 10 Tables` | 容量与 TOP10 |
| `Tables fragment rate > 30%` | 碎片表 |
| `Not utf8 table` / `NO PRIMARY KEY TABLES` | 数据规范 |

**注意**：本采集脚本**不输出**独立的 `ERROR LOG` / `BINARY LOGS` 段，错误日志与 binlog 详情如需进入报告，应由用户单独提供或留空。

---

## 工作流程（2 步）

### Step 1：提取数据

```bash
cd ~/.workbuddy/skills/mysql-inspection-report-detailed/scripts
npm install               # 首次需要，安装 docx
node extract.js <数据目录> --project "项目名称" --out data.json
```

- 自动识别全部 `MySQLHealthCheck_*.txt`，按 IP 聚合 txt + html。
- 自动从文件名推断巡检日期、项目名、角色（主/从）。
- 自动跑 12+ 条规则生成 `issues` 数组（P0~P3 分级）+ `recommendations` 行动计划。
- 在数据目录下输出 `data.json`（可手工编辑后再渲染）。

### Step 2：渲染报告

```bash
node render.js <data.json> --out <输出.docx>
```

- 默认输出文件名：`<项目名>_MySQL数据库巡检报告_详细版_v4.0.docx`，与 data.json 同目录。
- 渲染结束自动校验残留 `{xxx}` 占位符，命令行打印通过/警告。

### 可选：人工编辑 data.json

`extract.js` 已自动生成可用的数据。若需要**润色**：
- 调整 `project`（项目正式名）。
- 编辑 `issues[*].description` / `action`（让措辞更贴合业务上下文）。
- 在 `recommendations.longTerm` 中追加项目特有规划。
- `overallAssessment` 文本可直接覆盖。

不需要改的：节点信息、参数表、TOP10、用户列表等纯数据字段。

---

## 报告结构（17 章 + 执行摘要 + 自动目录）

### 报告前置部分
| 位置 | 内容 | 数据来源 |
|---|---|---|
| 封面 | 项目名 / 巡检日期 / 拓扑摘要 / 版本号 | 元数据 |
| 执行摘要 | 6 维度健康度评分 + 雷达图 + 关键事实速览 | `healthScore` + `cluster` |
| 目录 | 自动目录（TOC field，Word/WPS 打开后右键更新可显示页码）| 渲染时插入 |

### 17 章详细分析
| 章节 | 标题 | 数据来源 |
|---|---|---|
| 一 | 巡检摘要 | issues 集群级 + 节点级 + 根因关联分析 |
| 二 | 服务器与拓扑概况 | hostname / mem / CPU / disk + 磁盘使用率柱状图 |
| 三 | 连接与会话分析 | Variables + Processlist（过滤 system user / 从库复制线程） |
| 四 | 数据库清单 | database CHARACTER + 跨节点差异检测 |
| 五 | 关键配置参数对比 | Variables（21+ 参数）+ 差异自动 ✅/❌ 判断 |
| 六 | 性能指标分析 | Uptime / QPS / Slow / Buffer Pool（含命中率柱状图）|
| 七 | 存储空间分析 | TOP10（含归档表识别 + 横向柱状图）/ 高碎片 / 无主键 / 非 utf8 |
| 八 | 临时表空间（ibtmp1）分析 | innodb_sys_tablespaces + Variables |
| 九 | InnoDB 引擎状态 | Engine innodb status + key metrics + buffer pool stats |
| 十 | 事务与锁分析 | innodb_trx / lock_waits / 最近死锁 |
| 十一 | 用户权限审计 | user check + host=% 用户**按危险等级分组** |
| 十二 | 主从复制状态 | Replication Info + 复制参数 + 复制风险评估 |
| **十三** | **Schema 设计审计** | 未使用索引 / 冗余索引 / 大字段 / 分区表 / 自增列使用率 / 存储过程 |
| **十四** | **SQL 性能治理** | TOP 20 SQL by latency + 慢日志样本 + 全表扫描 SQL + 临时表 SQL |
| **十五** | **备份与恢复评估** | 备份工具 / cron / 备份产物 / binlog 保留 / RTO·RPO 推算 |
| **十六** | **安全合规审计** | 9 项检查 + TLS 详情 + 等保 2.0 / PCI / GDPR / SOX 框架对照 |
| 十七 | 巡检总结与行动计划 | issues 按优先级汇总 + 每条带 SQL 整改片段 + 长期规划 |

加粗 4 章为 v4.0 新增。

---

## 视觉规范

- **纸张**：A4，上下 1440 DXA / 左 1800 DXA / 右 1440 DXA。
- **字体**：Microsoft YaHei（微软雅黑），正文 11pt。
- **配色**：
  - H1 章节标题 16pt 粗体 `#1F4E79`
  - H2 二级 13pt 粗体 `#2E75B6`
  - H3 三级 12pt 粗体 `#2F5496`
  - 表格标题行 `#1F4E79` 蓝底白字，表头行 `#2E75B6` 蓝底白字，正文行交替 `#EAF3FB` 浅蓝
- **页眉**：项目名 + IP 列表（含 logo），下方灰色分隔线。
- **页脚**：居中页码「第 X 页」。
- **优先级配色**：P0 `#FFCCCC` / P1 `#FFE4B5` / P2 `#FFFACD` / P3 默认白。
- **封面**：项目名 + 副标题 + 巡检/报告日期 + 拓扑摘要 + 版本号 + 蓝色水平线 + 分页符。
- **禁用**：所有「撰写人 / ENMO DBA 团队」之类署名。

---

## 自动检测规则（v4.0 内置）

| 规则 | 优先级 | 触发条件 |
|---|---|---|
| 内存使用率高 | P1 | `>90%` |
| Swap 已启用 | P1 | `swap_used > 0` |
| 磁盘紧急 | P0 | 使用率 `≥90%` |
| 磁盘关注 | P1 | 使用率 `≥80%` |
| 复制线程异常 | P0 | `IO!=Yes` 或 `SQL!=Yes` |
| 延迟严重 | P1 | `Seconds_Behind > 300` |
| 延迟一般 | P2 | `Seconds_Behind > 60` |
| 无主键表 | P2 | 存在任意 |
| 非 utf8 表 | P2 | 存在任意 |
| 高碎片表 | P2 | 任意表碎片率 `≥70%` |
| 慢查询占比高 | P2 | `slow/total > 0.1%` |
| ibtmp1 偏大 | P2 | `>5GB` |
| 持久化弱 | P1 | `innodb_flush_log_at_trx_commit=0` 或 `sync_binlog=0` |
| GTID 未开 | P2 | `gtid_mode=OFF` |
| 主库 read_only=1 | P1 | 角色为主库但只读 |
| 从库 read_only=0 | P1 | 角色为从库但可写 |
| 高权限 host=% | P1 | root 等账号允许 `%` 主机 |
| Buffer Pool 命中率低 | P2 | `<95%` |
| 节点参数不一致 | P2 | 关键参数跨节点差异 |
| binlog 过期天数过长 | P3 | `>30 天` |

---

## 输出命名

```
<项目名>_MySQL数据库巡检报告_详细版_v4.0.docx
```

例：`一卡通_MySQL数据库巡检报告_详细版_v4.0.docx`

输出路径默认在 `data.json` 同目录，可用 `--out` 自定义。

---

## 验证清单

完成生成后建议人工检查：

1. **占位符**：render.js 末尾应输出 `✓ 占位符校验通过`。
2. **章节完整**：用 LibreOffice / Word 打开，确认 13 个章节全部存在、无空段。
3. **表格行数**：每个多节点表格行数等于节点数；TOP10 表显示真实 SQL 库表名。
4. **拓扑判断**：第二章「集群拓扑」描述符合实际（一主N从 / 单节点 等）。
5. **问题清单**：第一章与第十三章的问题描述具体（含数值、节点 IP），而非泛泛之词。
6. **页眉页脚**：每页有页眉（项目名 + IP）+ 居中页码。

---

## 常见问题

### Q: extract.js 报错某段未找到？
**A:** 查看 txt 中真实段名是否为 `----->>>---->>> XXX` 格式。如果采集脚本版本不同（段名变化），需修改 `extract.js` 中 `getSection(content, 'XXX')` 的关键字。

### Q: data.json 中某个节点字段缺失？
**A:** 对应段在 txt 中不存在或为空。`render.js` 会优雅降级为 `-`，不会报错。

### Q: 表格在 Word 中显示溢出 / 字体方框？
**A:** Word 字体必须装 Microsoft YaHei；缺字体时用 WPS / LibreOffice 打开通常正常。

### Q: ibtmp1 大小来自哪里？
**A:** 优先从 html 的 `innodb_sys_tablespaces` 表的 `total_extents × extent_size` 计算。若无 html，则字段为 `-`。

### Q: 如何加一条新的检测规则？
**A:** 编辑 `scripts/extract.js` 的 `analyzeIssues(nodes)` 函数，添加 `add('P1', '描述', nodeLabel, '建议')` 即可。

### Q: 如何加一个章节？
**A:** 在 `scripts/render.js` 写一个 `chapterXxx(data)` 返回 `Paragraph[]`/`Table[]`，然后在 `buildDocument` 的 `children` 数组里加入 `...chapterXxx(data)`。

---

## 文件清单

```
mysql-inspection-report/                            # 发行包根目录
├── README.md                                       # 5 分钟上手指南
├── USAGE.md                                        # 详细使用文档（10 节，含 FAQ）
├── SKILL.md                                        # 本文档（技能规范）
├── CHANGELOG.md                                    # 版本变更记录
├── install.sh                                      # 一键安装脚本
├── .gitignore
│
├── collectors/                                     # 采集端
│   └── mysqlHealthCheckV3.0.sh                     # 统一 sh 采集脚本（单 txt 输出）
│
└── scripts/                                        # 处理端（Node.js）
    ├── package.json                                # 依赖声明（docx + @resvg/resvg-js）
    ├── extract.js                                  # 解析 txt → data.json + 自动规则分析
    ├── render.js                                   # 渲染 data.json → docx
    ├── lib/
    │   └── charts.js                               # SVG 图表生成器（gauge/pie/hbar/vbar/radar）
    └── assets/
        └── logo.png                                # 页眉 logo（可替换）
```

**模块职责**：

| 文件 | 职责 |
|---|---|
| `collectors/mysqlHealthCheckV3.0.sh` | 在 MySQL 主机本地运行，输出统一 txt（含 OS / DB / 慢日志 / 备份信息） |
| `scripts/extract.js` | 解析 txt → 结构化 JSON，含健康度评分、规则分析、关联推断 |
| `scripts/render.js` | 渲染 JSON → docx，含 17 章 + 图表嵌入 + 占位符校验 |
| `scripts/lib/charts.js` | 纯 SVG 图表生成 + resvg PNG 转换，跨平台无 native 编译 |

---

## 版本演进

| 版本 | 主要变更 |
|---|---|
| **v4.0（当前）** | **17 章商业可交付级**：执行摘要 + 自动目录 + Schema 审计 + SQL 治理 + 备份评估 + 安全合规 + 7 类图表 + 健康度评分 + V3.0 单脚本统一采集 |
| v3.1 | 跨节点 issue 聚合 + 根因关联分析 + 行动计划 SQL 片段 + 参数差异 ✅/❌ 自动判断 |
| v3.0 | 数据/视图分离首版（extract.js + render.js）+ 20+ 自动规则 + 多节点自适应 + 占位符自检 |
| v2.0 | 13 章模板，硬编码占位（已废弃） |
| v1.0 | 8 章精简版（`mysql-inspection-report` 仍保留，适用于快速概览） |
