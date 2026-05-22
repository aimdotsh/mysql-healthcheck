# CHANGELOG（skill 分支）

> 本分支独立于 main / SaaS 分支，自有版本号。
> 规则定义同步自 SaaS 分支的 `scripts/rules/*.json`（v5.0.8 时点快照）。

---

## [1.0.1] - 2026-05-22

**报告模板加 Mermaid + ASCII 图表指引 — 视觉化不再"全是表格"**

### 改动

`references/report-template.md` 新增「图表使用约定」段，并在 5 个关键章节加具体示例：

- **第一章 1.1** ASCII 柱状图（6 维度健康度评分，每格 10 分）
- **第一章 1.2** Mermaid pie（P0-P3 优先级分布）
- **第四章 4.1** Mermaid graph（集群拓扑：一主 N 从 / 单节点 / MGR 三种形态）
- **第六章 6.3** ASCII 柱状图（节点 BP 命中率对比 + emoji 🟢🟡🔴 状态色）
- **第六章 6.4** ASCII 柱状图（节点内存使用率对比）
- **第十一章 11.1** Mermaid pie（host=% 用户危险等级分布）
- **第十六章 16.1** ASCII 柱状图（P0/P1/P2/P3 项数对比）
- **第十七章 17.2** 大号 ASCII 健康度评分卡 + 结论档位（良好 / 关注 / 关键）

模板从 606 → 783 行（+186 行）；其中 6 个 mermaid 块 + 34 行 ASCII 柱状图样例。

### LLM 指导

模板顶部「图表使用约定」明确告诉 LLM：
1. 用 mermaid（GitHub/Obsidian/VS Code 都渲染）画拓扑 / 饼图
2. 用 ASCII `█░` 画分数 / 排名（每行 10 字符对应百分位映射）
3. 表格用 emoji 🟢🟡🔴 标状态
4. 不要尝试用 `<svg>` / 引用本地图片文件 / 写"图表见原始数据"占位

### 视觉效果对比

| 项 | 1.0.0 | 1.0.1 |
|---|---|---|
| 拓扑图 | 纯文字 ASCII tree | Mermaid graph（自动渲染）|
| 健康度评分 | 数字表格 | ASCII 柱状图 + 表格 |
| 优先级分布 | 数字表格 | Mermaid pie + 表格 |
| 节点对比 | 数字表格 | ASCII 柱状图 + 表格 + emoji |

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
