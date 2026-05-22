# CHANGELOG（skill 分支）

> 本分支独立于 main / SaaS 分支，自有版本号。
> 规则定义同步自 SaaS 分支的 `scripts/rules/*.json`（v5.0.8 时点快照）。

---

## [1.0.0] - 2026-05-22

**首发 — 纯 LLM 驱动 + 零依赖**

从 SaaS 分支（v5.0.8）抽出的极简版本，只为「LLM 介入分析」场景设计。

### 核心特性

- ✅ **零外部依赖** — 没有 node / npm / docker / pip
- ✅ **纯文本资产** — git clone 即可使用，~500 KB
- ✅ **LLM 单步出报告** — LLM 读 .txt + 读规则 + 输出 markdown，单次会话内完成
- ✅ **三种工作模式** — 已有数据 / 提示采集 / 可选 ssh 自动采集
- ✅ **markdown 输出** — 不输出 docx；如需转 docx 用 pandoc 或独立 skill

### 仓库内容（10 个文件）

```
SKILL.md                       # LLM 协议（agent 入口）
README.md                      # 仓库介绍
USAGE.md                       # 人类阅读使用说明
CHANGELOG.md                   # 本文件
LICENSE
references/
├── rules.md                   # 42 条巡检规则定义
├── report-template.md         # 17 章 markdown 报告模板
├── parsing.md                 # txt 段名 / 字段映射
└── interview-guide.md         # 客户访谈表
collectors/
└── mysqlHealthCheckV3.0.sh    # 纯 bash 采集脚本
```

### 规则集（继承自 SaaS v5.0.8）

42 条规则按 6 维度分组：

| 维度 | 规则数 | 评分起点 |
|---|---|---|
| availability | 10 | 100 |
| durability | 10 | 100 |
| performance | 8 | 100 |
| security | 3 | 100 |
| dataDesign | 6 | 100 |
| operations | 5 | 100 |

健康度评分按优先级扣分（P0=18 / P1=7 / P2=3 / P3=1，最低分 50）。

### 与 SaaS 分支的差异

| 维度 | skill 1.0.0 | SaaS 5.0.8 |
|---|---|---|
| 输出 | markdown | docx |
| 引擎 | LLM | Node.js 规则引擎 |
| 依赖 | 0 | Node + docx + resvg + Docker（可选）|
| 部署 | git clone | git clone + npm install + 启服务 |
| 大小 | ~500 KB | ~10 MB |
| 自动 SSH 采集 | 可选（LLM Bash 工具） | 无 |
| 历史记录 | 无（每次独立分析） | 有（SaaS 端 history.js） |

### 不包含

明确**不在** skill 分支：

- `scripts/`（extract.js / render.js / rule-engine.js / handlers / JSON 规则）
- `saas/`（HTTP 服务 + Web UI + storage）
- `Dockerfile` / `docker-compose.yml` / `deploy/`
- `tests/`
- `install.sh`（git clone 即用，不需要安装）

这些都在 SaaS 分支保留，按需切换。

### 验证

- ✅ 用 `~/ai/skill/test/v3/desensitized/` 4 个脱敏 txt 实测：LLM 能识别 1 主 3 从拓扑、应用全部 42 条规则、输出完整 17 章 markdown
- ✅ rules.md / report-template.md / parsing.md 三份文档独立可读
- ✅ collector 脚本纯 bash 无外部依赖

---

## 未来计划

| 版本 | 内容 |
|---|---|
| 1.1.0 | 报告模板细调（根据实测反馈） |
| 1.2.0 | 客户访谈信息嵌入（让 LLM 自动结合 interview-guide.md） |
| 2.0.0 | 与 SaaS 分支规则演进对齐 |
