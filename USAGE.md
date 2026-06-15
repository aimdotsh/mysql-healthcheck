# 使用说明（人类视角）

本文档面向**人类用户** — 想了解这个 skill 怎么用 / 输入输出是什么 / 怎么排错的话看这里。如果你是 LLM agent，直接看 `SKILL.md`。

## 0. 这个 skill 是干什么的

把 MySQL 巡检从「人工 / 脚本生成」改成「LLM 介入分析」。

**输入**：MySQLHealthCheck_<IP>_<时间戳>.txt × N 个节点（用配套 `collectors/mysqlHealthCheckV3.0.sh` 采集）
**输出**：`MySQL巡检报告_<日期>.md` — 17 章商业可交付格式

## 1. 安装

```bash
git clone -b skill https://github.com/aimdotsh/mysql-healthcheck.git
```

把目录放到你的 LLM 加载 skill 的位置（Claude Code 是 `~/.claude/skills/`，workbuddy 是 `~/.workbuddy/skills/`）。

**没有 npm install / pip install / docker pull**。`git clone` 完就能用。

## 2. 四种工作模式

### 模式 1：已有 .txt（标准流程）

1. 客户 / 你 / 同事在 MySQL 主机本地跑 `collectors/mysqlHealthCheckV3.0.sh`
2. 把生成的 `MySQLHealthCheck_*.txt` 拷到你工作目录某处
3. 跟 LLM 说："请分析 /path/to/data 下的 MySQL 巡检"
4. LLM 自动读、分析、写 markdown 报告

### 模式 2：还没采集

1. 跟 LLM 说："请帮我巡检 X 数据库" 但没数据
2. LLM 给你一段 collector 命令，让你去 MySQL 主机上跑
3. 跑完拿回 .txt → 走模式 1

### 模式 3：让 LLM 自动通过 ssh 采集（可选）

1. 跟 LLM 说："请帮我巡检 192.168.1.100，ssh 已配好"
2. LLM 问你"是否允许通过 ssh 跑 collector"
3. 你同意 → LLM 自动跑、拉回 .txt、分析
4. 你拒绝 → 退回模式 2

### 模式 4：二进制离线出报告（无 LLM / 无 node / 无外网）

面向无外网、无 node、数据不能带出的隔离客户（如 RHEL 7.9）。用确定性代码本机直接出 md+html，**全程不调用大模型**：

```bash
# 无 node：用预编译二进制（零安装，自带运行时，兼容 glibc 2.17）
./mysql-healthcheck-linux-x64 /path/to/data --project "客户A 生产集群"

# 有 node：等价命令
node tools/report.js /path/to/data --project "客户A 生产集群"
```

规则判定、17 章报告、行动计划（P0→P3 + 推荐值 + SQL）全部由本地代码生成；HTML 自包含可直接浏览器打开/打印 PDF。
👉 **完整参数表、获取方式、排错、安全合规见 [docs/binary-usage.md](docs/binary-usage.md)。**

## 3. 采集数据

```bash
# 在 MySQL 主机上（不是 LLM 主机）
chmod +x collectors/mysqlHealthCheckV3.0.sh

# 交互式（推荐）
./collectors/mysqlHealthCheckV3.0.sh

# 命令行参数（适合 CI / 自动化）
./collectors/mysqlHealthCheckV3.0.sh \
  --user dbadmin --password 'xxx' \
  --host 127.0.0.1 --port 3306 \
  --output-dir ./reports
```

更多参数：`--help`

### MySQL 账号权限

只读权限即可：

```sql
CREATE USER 'dbadmin'@'127.0.0.1' IDENTIFIED BY '复杂密码';
GRANT SELECT, PROCESS, REPLICATION CLIENT, SHOW DATABASES,
      SHOW VIEW, REPLICATION SLAVE
   ON *.* TO 'dbadmin'@'127.0.0.1';
FLUSH PRIVILEGES;
```

**不要用 root**。专门建只读账号、host 限制到 127.0.0.1 / 跳板机是规范。

### 多节点集群

每个节点（主 + 从 + 灾备）都跑一遍 collector，把所有 .txt 放在一个目录：

```
~/data/mysql-inspect-2026Q2/
├── MySQLHealthCheck_192.168.1.10_202605221030.txt    # 主库
├── MySQLHealthCheck_192.168.1.11_202605221031.txt    # 从库 1
├── MySQLHealthCheck_192.168.1.12_202605221032.txt    # 从库 2
└── MySQLHealthCheck_192.168.1.20_202605221033.txt    # DR 灾备
```

LLM 会自动识别拓扑（主从关系 / DR 标记 / 集群类型）。

## 4. 报告内容（17 章）

| 章 | 内容 |
|---|---|
| 1 | 执行摘要（LLM 综合数据后用自然语言写） |
| 2 | 操作系统与硬件 |
| 3 | MySQL 版本与启动配置 |
| 4 | 集群拓扑 |
| 5 | 关键参数与一致性 |
| 6 | 性能指标（QPS / TPS / 命中率 / 等）|
| 7 | 数据库容量与对象 |
| 8 | InnoDB 状态 + ibtmp1 |
| 9 | 引擎深度（Buffer Pool / Redo / 锁等待）|
| 10 | 会话 + 锁 + 错误日志摘要 |
| 11 | 用户与权限 |
| 12 | 主从复制 |
| 13 | Schema 审计（无主键 / 冗余索引 / 未使用索引 / 大字段 / 自增列 / 等）|
| 14 | SQL 治理（慢 SQL / 全表扫描 / 临时表）|
| 15 | 备份评估 |
| 16 | 行动计划（按 P0→P3 排序）|
| 17 | 结论 + 健康度评分（6 维度） |

## 5. 客户化（禁用规则 / 调整阈值）

在数据目录放 `mysql-healthcheck.config.json`：

```json
{
  "disabledRules": [
    "backup_capability",
    "sql_mode_missing_strict"
  ],
  "thresholds": {
    "disk": { "critical_pct": 85 },
    "innodb": { "bp_too_small_ratio": 0.3 }
  },
  "priorities": {
    "wildcard_medium": "P3"
  }
}
```

**禁用的规则在报告 16.3 附录里透明披露**，防止「漏报」误会。

可配规则 id 见 `references/rules.md` 各规则的标题。

## 6. 排错

| 现象 | 原因 / 处理 |
|---|---|
| LLM 没找到 .txt | 检查目录路径，确认文件名是 `MySQLHealthCheck_<IP>_*.txt` |
| LLM 说"采集脚本未覆盖" | collector 版本太老或某些 SQL 权限不够，看 `references/parsing.md` 找具体段 |
| 输出报告章节有遗漏 | 提醒 LLM：「请严格按 references/report-template.md 的 17 章顺序输出，不要省略」|
| 某节点 hostname 都是 masked-hostname | 客户脱敏了，LLM 会按 `Master_Server_Id` 兜底识别主从（v5.0.2+ 修复） |
| LLM 把规则触发条件复述到报告 | 应当报告问题的现象 + 建议，不是规则的代码表达式。提醒 LLM 按 description / action 字段填 |

## 7. 与 SaaS 分支的差异

| 维度 | skill 分支（本仓库）| SaaS 分支 |
|---|---|---|
| 输出格式 | markdown | docx（Word）|
| 运行方式 | LLM 在 chat 里跑 | HTTP API + Web UI |
| 依赖 | 无 | Node 16+ / npm / docx 包 / 可选 Docker |
| 安装 | git clone | git clone + npm install + 启服务 |
| 适合场景 | 客户内网 / 私有化 LLM / 单次巡检 | 服务化 / 团队协作 / 批量自动化 |
| 规则源 | `references/rules.md`（LLM 读） | `scripts/rules/*.json`（引擎读） |

需要 docx 输出 → 走 SaaS 分支；或用 pandoc 把 markdown 转 docx：

```bash
pandoc MySQL巡检报告_2026-05-22.md -o MySQL巡检报告_2026-05-22.docx
```

## 8. 进阶：手工编辑后重生成

LLM 第一次出的 markdown 可能某些章节措辞需要调整。两种做法：

**A. 直接编辑 .md** — markdown 是普通文本，用任意编辑器改。

**B. 反馈给 LLM** — 跟 LLM 说：
> "请把第 16 章的『从库延迟』那条改为 P1，并加上一句『建议在维护窗口排查』"
LLM 会重新生成对应章节，其它章节不动。

## 9. 客户访谈信息（可选）

如果你和客户沟通后获得了业务背景（项目正式名、容灾要求、业务负载特征等），可以让 LLM 把这些信息体现在报告里：

```
你: 巡检前先记一下，这个集群叫"客户A 订单库"，4 节点跨同城双机房，
    业务高峰每天 21:00-23:00，没有异地备份要求
LLM: 收到，会把这些信息体现在执行摘要、容灾评估、业务时段评估等章节
```

完整可填字段见 `references/interview-guide.md`。

## 10. 版本与更新

- 本分支版本：见 `CHANGELOG.md`
- 规则更新：定期同步自 SaaS 分支的规则演进
- skill 协议变动：见 `SKILL.md` 顶部 description 字段

更新方式：

```bash
cd /path/to/skill
git pull origin skill
```
