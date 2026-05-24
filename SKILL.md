---
name: mysql-healthcheck
description: 为 MySQL 数据库集群生成 markdown 格式的巡检报告。当用户提供 MySQLHealthCheck_*.txt 采集数据或要求「分析 MySQL 巡检 / 月度巡检 / 健康评估 / 上线评估 / 故障复盘 / 合规自查」时使用。LLM 读 txt → 应用 42 条 DBA 规则 → 输出 17 章 markdown 报告。零依赖、纯文本、适合内网环境。
---

# MySQL 巡检 Skill（LLM-driven）

## 何时调用

满足任一条件即调用：

1. 用户提供一个目录，**内含** `MySQLHealthCheck_<IP>_<时间戳>.txt`
2. 用户提及：MySQL 巡检 / 月度巡检 / 数据库健康评估 / 体检 / 上线前评估 / 故障复盘 / 合规自查 / 商业交付级 MySQL 报告

**不要**用于：非 MySQL 数据库；纯只读数据查询任务（不生成报告）。

---

## 三种工作模式

### 模式 1：已有 .txt 数据（最常用）

用户给目录、目录里有 `MySQLHealthCheck_*.txt` → 直接分析输出报告。

### 模式 2：没 .txt → 提示用户采集

目录里没找到 .txt → 给出 collector 命令，让用户去 MySQL 主机上跑：

```bash
collectors/mysqlHealthCheckV3.0.sh \
  --user dbadmin --password 'xxx' \
  --host 127.0.0.1 --port 3306 \
  --output-dir ./reports
```

用户跑完拷 .txt 回来 → 进入模式 1。

### 模式 3：用户给了 MySQL 连接信息（可选）

用户说"分析 1.2.3.4:3306 / user / pass 的 MySQL"
→ **先问用户**是否允许通过 ssh + Bash 工具去主机本地跑 collector
→ 授权 → 用 Bash 跑 ssh + collector → 拉回 .txt → 进入模式 1
→ 不授权 → 退回模式 2

**模式 3 是可选**；首选是模式 1 / 2。

---

## 三种输出模式（用户可选）

| 模式 | 章节 | 预估耗时 | 用例 |
|---|---|---|---|
| **fast** | 3 章（执行摘要 + 行动计划 + 结论） | 5-7 min | 快速看风险 / 紧急排查 |
| **standard**（默认）| 重点 8-10 章（删除无数据章节） | 10-15 min | 日常巡检 |
| **full** | 完整 17 章 | 20-30 min | 月度交付 / 客户存档 |

用户没指定时默认 **standard**。用户说「快速」「fast」「紧急」时切 fast；说「完整」「详细」「正式交付」时切 full。

---

## 执行流程（LLM 单次会话内完成）

### Step 1: 找数据 + 检查 config

用 Glob 在用户给定目录搜 `MySQLHealthCheck_*.txt`：
- 找到 1+ 个 → 进入 Step 2
- 没找到 → 进入"模式 2"提示用户跑采集

同时检查 `<dataDir>/mysql-healthcheck.config.json`（可选），读取 disabledRules / thresholds / priorities。

### Step 2: 读规则速查矩阵（**先这个，节省 token**）

只读 `references/rules.md` **顶部的「规则速查矩阵」段**（约 50 行表格），**不要全文读**。这张表列了 42 条规则的 id + 触发信号速查。

记下"可能触发的规则候选名单"（凭表格里的"触发信号速查"列对 txt 头部信息做粗判，5-15 条最多）。

### Step 3: 读 .txt 数据（**选择性读**）

Read 全部 `MySQLHealthCheck_*.txt`，但**默认跳过这些大段**（除非候选规则需要）：

- `Slow query log tail`（可能 5000 行 / 100+ KB）— 只看 `slow_queries_abs` / `slow_log_off` / `long_query_time_loose` 需要；其它情况只扫头部 50 行 + 关键字搜 `ERROR`
- `Error log tail`（500 行）— 同上，只扫关键 ERROR 关键字
- `All processlist`（全量进程列表）— 只看 `long_running_session` 需要；统计性指标看 `Processlist info` 摘要段即可
- `All databases and size details`（大库可能上千行）— 看 `Top 10 Tables` 摘要段足够

LLM 应当用 Read 的 `offset` + `limit` 参数**分段读**大文件而非一次全读。

### Step 4: 读触发规则的详情

对 Step 2 标记的「候选规则」（5-15 条），到 `rules.md` 下半部对应 `### \`rule_id\`` 段读详情（description / action / sql / 阈值）。

**未触发的规则跳过详细段读取**。

### Step 5: 集群拓扑识别

从 `SLAVE STATUS` + `slave IP is` + `Master_Server_Id` 推断主从拓扑。脱敏场景（hostname 都是 masked-xxx）→ 退回 server_id 匹配。

### Step 6: 应用规则 + 计算评分

- 节点级规则逐节点判断
- 集群级规则跨节点判断
- 按 priority 分 P0/P1/P2/P3
- 计算 6 维度健康度评分（每命中扣分；最低分 50）

### Step 7: 读报告模板（**只读对应模式的章节**）

读 `references/report-template.md`，**根据模式跳读**：

- **fast 模式**：只读 第一章 / 第十六章 / 第十七章 + 「图表使用约定」
- **standard 模式**：读「图表使用约定」+ 必填章节（1/2/4/5/12/13/14/15/16/17）+ 跳过无数据章节
- **full 模式**：全读

### Step 8: 生成 markdown 报告（**严格遵守模板**）

> ⚠️ **关键约束 — LLM 必读必守**：
>
> 1. **章节编号 + 名称必须照搬 report-template.md**，不能自创、改名、合并、拆分。例如：
>    - ✅ 「第七章 数据库容量与对象」
>    - ❌ 「第 7 章 容量与存储」（改名）
>    - ❌ 「第 7 章 索引健康」（杜撰）
>    - ❌ 「第七章 数据库容量与对象 / 第八章 InnoDB 状态」（合并）
> 2. **17 章编号必须连续、不能产生 gap**：standard / fast 模式下，**所有 17 章都要写**，但可"精简章节"。客户看到「第四章 → 第六章」会困惑，所以**不能整章删除**。精简方式见下表的"精简策略"列。
> 3. **章节标题用中文数字**（一/二/三 ...），与模板一致；不要用阿拉伯数字
> 4. **不能自创新章节** — 如果数据触发了模板没覆盖的话题，放进 16 章「行动计划」或 16 章后加一个 16.4 小节，不要单独开新章
>
> 违反任一约束 → 输出不一致，客户对比两份报告会发现差异，对工具失去信任。

按模式生成（**17 章编号永远连续**，差别仅在内容详尽度）：

| 模式 | 必填章节（详细写）| 精简章节（仅 1-2 行说明）|
|---|---|---|
| **fast** | 第一章 / 第十六章 / 第十七章 | 第二至十五章 |
| **standard** | 第一/二/四/五/六/十二/十三/十四/十五/十六/十七章 | 第三/七/八/九/十/十一章 |
| **full** | 全 17 章 | 无（全部详细写）|

**精简章节的标准写法**（**保留章节标题** + **1-2 行说明**）：

```markdown
## 第七章 数据库容量与对象

本章无显著风险点（容量正常、无大碎片表、字符集统一）；如需详细数据请用 full 模式生成。
```

或当确实因模式精简：

```markdown
## 第三章 MySQL 版本与启动配置

> standard 模式下精简：核心版本信息见执行摘要；详细启动参数请用 full 模式。
```

**示例：standard 模式输出 17 章典型样本**：

```
第一章 执行摘要                  ← 必填，详细
第二章 操作系统与硬件             ← 必填，详细
第三章 MySQL 版本与启动配置       ← 精简，1-2 行
第四章 集群拓扑                  ← 必填，详细（含 mermaid 图）
第五章 关键参数与一致性           ← 必填，详细
第六章 性能指标分析               ← 必填，详细
第七章 数据库容量与对象           ← 精简，1-2 行（除非有大表/碎片/非 utf8）
第八章 InnoDB 状态与 ibtmp1       ← 精简，1-2 行（除非 HLL 高 / ibtmp1 超大）
第九章 引擎深度                   ← 精简，1-2 行（除非 BP 异常 / redo 偏小）
第十章 会话 + 锁 + 错误日志        ← 精简，1-2 行（除非有长会话 / 锁等待）
第十一章 用户与权限                ← 精简，1-2 行（除非有 host=% 用户）
第十二章 主从复制                  ← 必填，详细
第十三章 Schema 审计               ← 必填，详细
第十四章 SQL 治理                  ← 必填，详细
第十五章 备份评估                  ← 必填，详细
第十六章 行动计划                  ← 必填，详细
第十七章 结论                     ← 必填，详细
```

**关键判断逻辑**：精简章节里如果**实际有 P1/P2 问题**，应升级为详细写。规则触发表 → 哪个章节有触发就详细写。

**所有模式都必须包含**：
- 集群拓扑 mermaid 图（第 4 章 — 如有 standard / full 模式，或塞进 fast 的执行摘要）
- P0-P3 优先级 mermaid pie
- 6 维度健康度 ASCII 柱状图
- emoji 状态色 (🟢🟡🔴) 在节点对比表里

### Step 9: 写文件

```
<dataDir>/MySQL巡检报告_<YYYY-MM-DD>.md       # 标准命名
<dataDir>/<项目名>_MySQL巡检报告_<YYYY-MM-DD>.md  # 用户指定项目名时
```

### Step 10: 简短反馈

```
✓ 报告已生成：/path/to/MySQL巡检报告_2026-05-22.md
- 模式：standard
- 节点：4 个（一主3从）
- 问题：P0:1 / P1:4 / P2:6 / P3:1
- 健康度：78/100
```

**不要把整份报告复述到对话框**。

---

## 性能优化原则（**重要**）

LLM 应当主动遵守，每条都是优化点：

1. **先读速查矩阵，不要全读 rules.md** — Step 2 / Step 4 分两段读，未触发的规则跳过详情段
2. **大段日志（slow_query_log_tail / error_log_tail / all processlist）默认跳过** — 用关键字搜索或读前 50 行 + 后 50 行而非全读
3. **并行读多节点 txt** — 用一次 Read 工具调用读所有节点 txt，不要串行
4. **跳过"无数据"章节** — standard 模式下，章节实在没数据就别写「未发现」占位，整段省略（fast 模式总是省略）
5. **行动计划简洁化** — P2/P3 用表格而非段落；P0/P1 才详细列 description + action + sql
6. **避免长篇大论的"建议"段落** — 直接引用 rules.md 里的 action 字段，不要 LLM 自由发挥扩写
7. **生成过程中不要 stream 状态消息** — 安静干完最后报告位置即可

---

## 客户化配置（可选）

如果用户希望禁用某些规则、调整阈值，让其在数据目录放一份 `mysql-healthcheck.config.json`：

```json
{
  "disabledRules": ["backup_capability", "sql_mode_missing_strict"],
  "thresholds": { "disk": { "critical_pct": 85 } },
  "priorities": { "wildcard_medium": "P3" }
}
```

LLM 应当在 Step 2 之前检查该文件存在 → 应用配置：
- `disabledRules` 中的规则跳过判断
- `thresholds` 覆盖默认阈值（默认值见 `rules.md` 各规则的触发表达式）
- `priorities` 覆盖单条规则优先级
- 报告 16.3 附录里**透明披露**「本次报告已禁用以下规则：...」

---

## 输出契约

**严格**按模板的章节顺序，不要省略章节。每章如果没有数据，写「未发现 / 不适用 / 采集脚本未覆盖」即可。

报告里不要出现：
- 任何 `<占位符>` 残留
- 任何「这是模板」「请填充」字样
- node / npm / Docker 等技术细节（除非用户问起）

---

## 配套：采集脚本

如果用户问"怎么采集 txt"：

```bash
# 在 MySQL 主机上跑（需可访问 MySQL）
collectors/mysqlHealthCheckV3.0.sh --help

# 典型用法
collectors/mysqlHealthCheckV3.0.sh \
  --user dbadmin --password 'xxx' \
  --host 127.0.0.1 --port 3306 \
  --output-dir ./reports
```

需要权限：MySQL 用户至少有 `SELECT, PROCESS, REPLICATION CLIENT, SHOW DATABASES, SHOW VIEW, REPLICATION SLAVE` 权限。**不要用 root**，建专门只读账号 + host 限制到 127.0.0.1 / 跳板机。

---

## 子文档（按需阅读）

| 子文档 | 何时读 |
|---|---|
| `references/rules.md` | Step 2 必读 — 42 条规则定义 |
| `references/report-template.md` | Step 2 必读 — 17 章 markdown 框架 |
| `references/parsing.md` | Step 2 必读 — txt 段名与字段映射 |
| `references/interview-guide.md` | 用户希望加客户访谈信息时读 — 业务背景 / 容灾要求 / 项目命名 |
| `USAGE.md` | 用户希望看完整人类阅读使用说明 |

---

## 故障兜底

| 情况 | 处理 |
|---|---|
| .txt 文件特别大（> 200 KB / 节点）| 分章读：先读 hostname/variables/SLAVE STATUS 等关键段，按需读其它 |
| 某节点 txt 缺关键段 | 在报告里标注「该节点 XX 段缺失，跳过此项分析」，不报错退出 |
| 集群拓扑识别不出来 | 退回单节点模式，每个 .txt 当独立节点处理 |
| 客户访谈信息缺失 | 报告里相关章节填「访谈信息缺失，仅基于采集数据」标注 |

---

## 不在本 skill 范围

- **markdown → docx 转换** — 用独立的 `mysql-healthcheck-md2docx` skill（如果有）；或客户自己用 pandoc / Word 打开 markdown
- **批量 / 自动化 / Web UI** — 这些走 SaaS 分支（独立的 HTTP 服务部署）
- **实时监控 / 长期趋势** — 本 skill 是单次快照分析
