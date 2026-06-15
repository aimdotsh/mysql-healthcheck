# mysql-healthcheck（skill 分支）

> **轻量 LLM 驱动版本** — LLM 读 `MySQLHealthCheck_*.txt` → 应用 42 条 DBA 规则 → 生成 17 章 markdown 报告。
>
> 零外部依赖、纯文本、~500 KB。适合内网客户、私有化 LLM 场景。

## 维护者：怎么发新版本

`push tag` 自动触发 GitHub Action 发布到 [Releases](https://github.com/aimdotsh/mysql-healthcheck/releases) 页：

```bash
# 1. 改版本相关文件
echo "1.0.7" > VERSION                       # 改 VERSION
sed -i '' 's/^version: .*/version: 1.0.7/' SKILL.md  # 改 SKILL.md frontmatter
# 在 CHANGELOG.md 顶部加上 "## [1.0.7] - YYYY-MM-DD" 条目

git add -A && git commit -m "release: v1.0.7"
git push origin skill

# 2. 打 tag 触发 release
git tag skill-1.0.7
git push origin skill-1.0.7

# 3. 等 ~1 分钟，GitHub Action 自动：
#    - 校验 VERSION / SKILL.md / CHANGELOG 一致
#    - 打包 zip（排除 .git / .github / .DS_Store）
#    - 从 CHANGELOG 抽取该版本变更说明
#    - 发布到 Releases 页，标记 latest
```

Action 校验失败的常见原因：
- VERSION 文件与 tag 不匹配（tag 必须是 `skill-` + VERSION 内容）
- CHANGELOG.md 顶部没有该版本的 `## [X.Y.Z]` 条目

详见 `.github/workflows/release.yml`。

也可以在 GitHub UI 手动触发：仓库 → Actions → "Release skill" → "Run workflow"。

## 怎么查当前装的是哪个版本

任何 3 处都能查：

```bash
# 方式 1：VERSION 文件（最直接）
cat VERSION
# → 1.0.6

# 方式 2：SKILL.md frontmatter
head -3 SKILL.md
# → version: 1.0.6

# 方式 3：CHANGELOG 顶部条目
head -10 CHANGELOG.md | grep -E "^## \[" | head -1
# → ## [1.0.6] - 2026-05-24
```

或者更简单：跑完一份巡检报告，看 markdown 报告头的「巡检版本：v1.0.6」字段。

## 仓库内容

```
mysql-healthcheck/
├── SKILL.md                       # LLM 协议（agent 入口，必读）
├── README.md                      # 本文件
├── USAGE.md                       # 人类阅读使用说明
├── CHANGELOG.md                   # 版本变更
├── LICENSE
├── references/
│   ├── rules.md                   # 42 条巡检规则定义（按 6 维度分组）
│   ├── report-template.md         # 17 章 markdown 报告模板
│   ├── parsing.md                 # txt 采集数据的段名 / 字段映射
│   └── interview-guide.md         # 客户访谈表（业务背景填充）
└── collectors/
    └── mysqlHealthCheckV3.0.sh    # 纯 bash 采集脚本（在 MySQL 主机上跑）
```

## 安装

```bash
git clone -b skill https://github.com/aimdotsh/mysql-healthcheck.git
```

完事。**没有 `npm install`、没有 Docker、没有依赖检查**。

把目录放到 LLM 能读的位置即可（如 Claude Code 的 `~/.claude/skills/` 或 `~/.workbuddy/skills/`，按你 LLM 平台的 skill 加载约定）。

## 快速上手

### 用法 A：已有采集数据

```
你: 请分析 ~/data/mysql-inspect-2026Q2 下的 MySQL 巡检
LLM: （自动）
  1. Glob 找到 MySQLHealthCheck_*.txt
  2. Read references/rules.md + report-template.md + parsing.md
  3. Read 全部 .txt
  4. 应用 42 条规则
  5. Write ~/data/mysql-inspect-2026Q2/MySQL巡检报告_2026-05-22.md
```

### 用法 B：还没采集数据

```
你: 请帮我巡检 192.168.1.100 的 MySQL
LLM: 需要先在 MySQL 主机上跑采集脚本。请执行：

     scp collectors/mysqlHealthCheckV3.0.sh dba@192.168.1.100:~/
     ssh dba@192.168.1.100
     ./mysqlHealthCheckV3.0.sh --user dbadmin --password 'xxx' \\
       --host 127.0.0.1 --port 3306 --output-dir ./reports

     跑完把 reports/MySQLHealthCheck_*.txt 拷贝到本地某目录，
     再告诉我目录路径，我继续分析。
```

### 用法 C：用 ssh 让 LLM 直接采集（可选）

```
你: 请帮我巡检 192.168.1.100 的 MySQL，ssh 用户 root 密钥已配
LLM: 我需要通过 Bash 工具 ssh 到 192.168.1.100 跑 collector，是否授权？
你: 可以
LLM: （ssh 跑 collector → 拉回 .txt → 自动分析输出报告）
```

### 用法 D：完全离线 / 无 LLM 出报告（无网客户）

无外网、数据不能带出、且不能用 LLM 的客户（如 RHEL 7.9），用确定性代码本机直接出 md+html：

```bash
# 有 node（开发 / 其它客户）：
node tools/report.js <数据目录>            # 生成 MySQL巡检报告_<日期>.md + .html

# 无 node（RHEL 7.9 默认无 node）：用预编译二进制，零安装
./mysql-healthcheck-linux-x64 <数据目录>   # 同样输出 md + html
```

- 全程**不调用任何大模型**；HTML 自包含（内联 CSS + SVG 图表），浏览器直接打开/打印 PDF。
- 二进制由 CI 在 push `offline-v*` tag 时构建（pkg / node16-linux-x64，自带运行时，兼容 glibc 2.17），发布在 Releases 页，不入仓。
- 常用参数：`--out-dir <目录>`、`--format md|html|both`（默认 both）、`--project "名称"`、`--config <path>`、`--emit-facts`。

📖 **二进制完整使用说明 + 详细参数表见 [docs/binary-usage.md](docs/binary-usage.md)**（获取 / 参数 / 输出 / 配置 / 排错 / 安全合规）。

## 输出样例

```markdown
# MySQL 健康巡检报告

**项目**：示例集群
**巡检日期**：2026-05-22
**拓扑**：一主 3 从（异步复制）

## 第一章 执行摘要

本次巡检覆盖 4 个节点（master01db 主库 + slave01db/slave02db/drdb01 从库），
共检出 12 项问题（P0: 1 / P1: 4 / P2: 6 / P3: 1），健康度评分 78/100...

## 第二章 操作系统与硬件
...（共 17 章）

## 第十六章 行动计划

### P0（关键，建议优先处置）
1. **从库 slave01db 复制线程异常**（repl_thread_down）
   - 影响：从库已停止同步
   - 行动：查 Last_IO_Error / Last_SQL_Error；必要时 STOP SLAVE; 处理后 START SLAVE
   - SQL：`SHOW SLAVE STATUS\G`
...
```

## 与 SaaS 分支的关系

本仓库有两个并存分支：

| 分支 | 特点 | 适合 |
|---|---|---|
| **skill**（本分支）| ~500 KB，零依赖，LLM 单步出 markdown | 客户内网 / 私有化 LLM / 单次巡检 |
| **SaaS** | ~10 MB，Node + Docker，HTTP 服务 / 自动 docx | 服务化 / 批量自动巡检 / 团队协作 |

两个分支共享同一套规则知识（42 条），但实现方式完全不同：
- skill 分支：LLM 读 markdown 规则 + 应用 + 输出 markdown
- SaaS 分支：node 引擎读 JSON 规则 + 评估 + 输出 docx

## 客户化配置

在数据目录放 `mysql-healthcheck.config.json`：

```json
{
  "disabledRules": ["backup_capability"],
  "thresholds": { "disk": { "critical_pct": 85 } },
  "priorities": { "wildcard_medium": "P3" }
}
```

LLM 自动检测 + 应用。规则 id 在 `references/rules.md` 里查。

## 文档导航

| 场景 | 看哪个 |
|---|---|
| 想理解工作流程 | `SKILL.md`（LLM 协议）|
| 想给 LLM 用 | LLM 自动读 SKILL.md，无需人工干预 |
| 想看 42 条规则细节 | `references/rules.md` |
| 想看报告章节结构 | `references/report-template.md` |
| 想了解 txt 数据格式 | `references/parsing.md` |
| 想加业务背景信息 | `references/interview-guide.md` |
| 想自己跑采集 | `collectors/mysqlHealthCheckV3.0.sh --help` |
| 完整使用说明 | `USAGE.md` |

## License

见 `LICENSE` 文件。
