# MySQL 数据库巡检报告生成技能（详细版 v3.0）

## 技能描述

基于自动化巡检工具采集的 `.txt`（raw 数据）和 `.html`（格式化输出），为生产环境 MySQL 集群生成**专业、漂亮、可交付**的 Word（.docx）格式月度巡检报告（13 章详细版）。

**v3.0 与早期版本的差异**：
- 数据/视图彻底分离 — `extract.js` 解析原始数据为 `data.json`，`render.js` 渲染 docx，互不干扰。
- 多节点表格按节点数自动展开，无需手工复制粘贴模板行。
- 内置 12+ 条自动巡检规则，按 P0/P1/P2/P3 分级输出问题清单与行动计划。
- 缺失数据时（如 ERROR LOG 未采集）章节自动降级显示「未采集到对应数据」，而非残留 `{占位}` 字符串。
- 渲染结束自动校验残留占位符，提前发现遗漏。

---

## 适用场景

- 用户提供某个项目（如「一卡通 Apple 集群」）的巡检数据目录。
- 表述类似：「生成 MySQL 巡检报告」、「写月度巡检」、「整理巡检数据」、「13 章详细版报告」。
- 输入目录至少包含 `MySQLHealthCheck_<IP>_<时间戳>.txt`。

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

- 默认输出文件名：`<项目名>_MySQL数据库巡检报告_详细版_v3.0.docx`，与 data.json 同目录。
- 渲染结束自动校验残留 `{xxx}` 占位符，命令行打印通过/警告。

### 可选：人工编辑 data.json

`extract.js` 已自动生成可用的数据。若需要**润色**：
- 调整 `project`（项目正式名）。
- 编辑 `issues[*].description` / `action`（让措辞更贴合业务上下文）。
- 在 `recommendations.longTerm` 中追加项目特有规划。
- `overallAssessment` 文本可直接覆盖。

不需要改的：节点信息、参数表、TOP10、用户列表等纯数据字段。

---

## 报告结构（13 章）

| 章节 | 标题 | 数据来源 |
|---|---|---|
| 一 | 巡检摘要 | 自动生成的 issues 汇总 |
| 二 | 服务器与拓扑概况 | hostname / mem info / CPU / disk mount |
| 三 | 连接与会话分析 | MySQL Variables + Processlist info |
| 四 | 数据库清单 | database CHARACTER |
| 五 | 关键配置参数对比 | MySQL Variables（21+ 参数横向对比 + 差异检测） |
| 六 | 性能指标分析 | Uptime / QPS / Slow / Buffer Pool |
| 七 | 存储空间分析 | DB TOTAL SIZE / Top 10 / fragment / no-pk / non-utf8 |
| 八 | 临时表空间（ibtmp1） | html innodb_sys_tablespaces + Variables |
| 九 | InnoDB 引擎状态 | Engine innodb status |
| 十 | 事务与锁分析 | Engine innodb status 内 TRANSACTIONS / DEADLOCK |
| 十一 | 用户权限审计 | user check |
| 十二 | 主从复制状态 | MySQL Replication Info + 复制相关 Variables |
| 十三 | 巡检总结与行动计划 | issues 按优先级汇总 → 行动计划 |

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

## 自动检测规则（v3.0 内置）

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
<项目名>_MySQL数据库巡检报告_详细版_v3.0.docx
```

例：`一卡通_MySQL数据库巡检报告_详细版_v3.0.docx`

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
~/.workbuddy/skills/mysql-inspection-report-detailed/
├── SKILL.md                 # 本文档
└── scripts/
    ├── package.json         # docx 依赖
    ├── extract.js           # 数据提取 + 规则分析
    ├── render.js            # docx 渲染
    └── assets/
        └── logo.png         # 页眉 logo（可替换）
```

---

## 与 8 章精简版的关系

`mysql-inspection-report`（8 章 v1.0）保留原状，适用于快速概览。本技能（13 章 v3.0）适用于深度技术审计。两者数据来源相同，但本版表达更详尽。

---

## 版本

- v3.0（当前）：数据/视图分离 + 自动分析 + 多节点自适应 + 占位符校验
- v2.0：13 章模板，硬编码占位
- v1.0：8 章精简版
