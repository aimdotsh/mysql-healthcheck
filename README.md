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
  <img alt="Version" src="https://img.shields.io/badge/version-v4.1-1F4E79?style=flat-square">
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A516-43853d?style=flat-square&logo=node.js">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey?style=flat-square">
  <img alt="MySQL" src="https://img.shields.io/badge/MySQL-5.6%20%7C%205.7%20%7C%208.0-4479A1?style=flat-square&logo=mysql&logoColor=white">
  <img alt="Output" src="https://img.shields.io/badge/output-.docx-2B579A?style=flat-square&logo=microsoftword&logoColor=white">
</p>

---

## 🤖 给 AI 智能体的远程安装指令

> 把下面这段**整段复制**发给任意支持 shell 的 AI 智能体（Claude Code / OpenClaw / Codex CLI / Cursor 等），它就会自动装好这个 skill。

````
请帮我安装 mysql-healthcheck 这个 skill：

```bash
git clone https://github.com/aimdotsh/mysql-healthcheck.git /tmp/mysql-healthcheck-src && \
  bash /tmp/mysql-healthcheck-src/install.sh && \
  rm -rf /tmp/mysql-healthcheck-src
```

安装完成后回复"已就绪"。
````

安装完成后，对智能体说：

> 帮我生成 `/path/to/your/data-dir` 的 MySQL 巡检报告

智能体会自动识别本 skill 的 `SKILL.md` playbook，按 2 步流程跑完，最终把 docx 报告交给你。

`install.sh` 默认装到 `~/.claude/skills/mysql-healthcheck/`（Claude Code 标准位置）。可用 `--target workbuddy` 装到 workbuddy 目录，或 `--target ~/foo` 自定义父目录。

---

## 💡 是什么

`mysql-healthcheck` 是一套**面向 DBA / 架构师 / 客户交付场景**的 MySQL 巡检报告自动化工具链：

- 用 **1 个 shell 脚本**在 MySQL 主机本地采集所有数据
- 用 **2 行 Node 命令**把原始数据转成 17 章商业可交付级 `.docx` 报告
- 内置**六维度健康度评分**、**根因关联推断**、**TOP SQL 治理**、**合规对照表**、**7 类专业图表**

适用于：月度例行巡检、上线前评估、故障后复盘、合规自查（等保/PCI/GDPR/SOX）。

---

## 📊 报告长这样

**17 章 + 执行摘要 + 自动目录**：

```
📄 封面
📋 执行摘要 ─────── 健康度仪表盘 + 六维度雷达图 + 关键事实速览（管理层 1 页看完）
📑 目录
├── 一、巡检摘要 ─── 集群级问题 + 节点级问题 + 根因关联分析
├── 二、服务器与拓扑概况 + 磁盘使用率柱状图
├── 三、连接与会话分析（过滤复制线程噪声）
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

> **典型产物**：`<项目名>_MySQL健康巡检报告_v1.0.docx`（~160 KB，含 8 张嵌入图表）

---

## ✨ 核心特性

| | |
|---|---|
| 🩺 **六维度健康度评分** | 可用性 / 安全性 / 性能 / 数据规范 / 持久化 / 运维 — 一个数字看健康，一张雷达看薄弱 |
| 🔗 **根因关联分析** | 自动识别 6 类典型关联（如「DR 磁盘高位 ↔ binlog 永不过期」），帮 DBA 找到症状背后的真因 |
| 📊 **7 类专业图表** | 仪表 / 雷达 / 饼图 / 横向柱 / 纵向柱 / 集群对比 / 合规分布 — 替代纯文字 / 表格的乏味 |
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
    E -->|17 章渲染 + 8 张图表| F(render.js)
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
| `scripts/render.js` | 渲染端 | 17 章 docx + 嵌入图表（SVG→PNG）+ 占位符自检 |

---

## 🔍 自动检测规则速览

| 类别 | 规则示例 | 优先级 |
|---|---|---|
| **可用性** | 磁盘 ≥80% / 复制线程异常 / 内存 >90% / Swap 已启用 | P0~P1 |
| **持久化** | `sync_binlog=0` / `innodb_flush_log_at_trx_commit=0` / GTID 未启用 | P1~P2 |
| **性能** | Buffer Pool 命中率 <99% / 慢查询累计 >100万 / ibtmp1 >5GB | P1~P2 |
| **数据规范** | 无主键表 / 非 utf8 表 / 高碎片表（≥70% 且 ≥100MB） | P2 |
| **安全** | root@% / 复制账号开放 % / 空密码账号 / 未启用审计 | P0~P1 |
| **运维** | 节点参数不一致 / 慢日志未开 / 备份工具缺失 | P1~P2 |

> 完整 30+ 规则与阈值见 [`references/rules.md`](references/rules.md)；详细健康度评分模型也在那里。

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
