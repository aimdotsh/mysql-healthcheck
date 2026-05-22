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

## 执行流程（LLM 单次会话内完成）

### Step 1: 找数据

用 Glob 工具在用户给定目录搜 `MySQLHealthCheck_*.txt`：
- 找到 1+ 个 → 进入 Step 2
- 没找到 → 进入"模式 2"提示用户

### Step 2: 读规则与模板（三份必读）

按顺序读：

1. `references/parsing.md` — 知道 txt 里每段（hostname / variables / SLAVE STATUS / 等）数据格式
2. `references/rules.md` — 42 条规则定义（触发条件 + priority + 建议 + SQL）
3. `references/report-template.md` — 17 章报告框架

### Step 3: 读 .txt 数据

Read 全部 `MySQLHealthCheck_*.txt`。多节点集群把所有节点一起读。

### Step 4: 应用规则

对 42 条规则逐条判断是否触发：
- **节点级规则**（scope=node）逐节点判断
- **集群级规则**（scope=cluster，如 `param_inconsistent` / `slave_parallel_workers_zero`）跨节点判断
- 按 `priority` 分类：P0 关键 / P1 重要 / P2 建议 / P3 观察
- 计算 6 维度健康度评分（每命中扣分；最低分 50）

### Step 5: 集群拓扑识别

从 `SLAVE STATUS` + `slave IP is` + `Master_Server_Id` 推断：
- 单点 / 主从 / 一主多从 / DR 灾备
- 主库 IP / 从库列表 / 角色

### Step 6: 按模板生成 markdown 报告

严格按 `references/report-template.md` 的 17 章顺序填充：

- **第 1 章「执行摘要」** — LLM 综合数据后用自然语言写（不要照抄模板占位）
- **第 2-15 章** — 数据填表
- **第 16 章「行动计划」** — 按 P0→P3 排序，每条带规则 description / action / SQL
- **第 17 章「结论」** — 短结论 + 健康度评分总结

### Step 7: 写文件

用 Write 工具输出到：

```
<dataDir>/MySQL巡检报告_<YYYY-MM-DD>.md
```

如果用户指定了项目名：

```
<dataDir>/<项目名>_MySQL巡检报告_<YYYY-MM-DD>.md
```

### Step 8: 告知用户

简短反馈：报告位置 / 节点数 / P0-P3 计数 / 健康度评分。**不要把整份报告复述到对话框**（用户自己打开 .md 看）。

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
