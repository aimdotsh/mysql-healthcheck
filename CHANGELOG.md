# CHANGELOG（skill 分支）

> 本分支独立于 main / SaaS 分支，自有版本号。
> 规则定义同步自 SaaS 分支的 `scripts/rules/*.json`（v5.0.8 时点快照）。

---

## [1.0.9] - 2026-06-02

**同步 4 条报告质量增强规则（与 ykt v2.0 / SaaS v5.0.8 一致）+ 修复缺失的默认阈值配置**

### 改动

#### 1. 4 条规则升级为"带追因 + 推荐值 + 可执行 SQL"（混合模式 / 快路径）

把 ykt/SaaS 分支已落地的 4 条规则增强同步到 `tools/rule-helpers/index.js`，让 node 快路径
产出的 `facts.json` 直接带 `currentValue → recommendedValue + sql`，LLM 总结时无需再推算：

- **`ibtmp1_oversize`** — 不止建议封顶，还从「SQL with temp tables」追因落盘临时表 TOP SQL，
  提示开 performance_schema 用 `sys.statements_with_temp_tables` 精确定位元凶；≥100GB / ≥10× 阈值升 P1。
- **`swap_used`** — 关联内存预算：`buffer_pool + 单连接 buffer × max_connections` 理论峰值 vs 物理内存，
  判定是否内存超配导致换出，并给出推荐 buffer_pool / max_connections 上限。
- **`data_to_memory_ratio_high`** — 增加热数据覆盖率测算（热集 ~25% × 数据量 vs buffer_pool），
  RAM 不现实时改建议分库分表/归档，而非盲目加内存。
- **`innodb_hll_high`** — 给出 INNODB_TRX 按 trx_started 定位长事务、kill、innodb_purge_threads 等具体处置 + SQL。

新增 `perConnBufferMB(node)` 辅助函数，`evalMaxConnectionsVsMemory` 复用之（去重）。
两条规则（ibtmp1_oversize / swap_used）的 JSON 由模板式 trigger 改为 `handler` 派发。

#### 2. 补齐缺失的 `tools/config/default-thresholds.json`（**bug 修复**）

此前该文件未随 skill 分支发布，导致 `loadHcConfig` 每次告警退化为空配置，**所有模板式
trigger 规则（读 `cfg.thresholds.X.Y`）都在与 `undefined` 比较而静默失效**。补齐后
`long_query_time_loose` 等阈值规则恢复正常判定（测试集 issues 48 → 49，纯增）。

#### 3. SKILL.md Step 0 决策流程明确为"node + LLM 总结 / md 兜底"

按客户诉求重写决策树框架：**有 node → 混合模式（node 出确定性数据 + LLM 写总结，推荐）；
无 node → 纯 LLM 兜底（md 路径）**，强调 preprocess.js 零依赖、不需 npm install、不产 docx。

---

## [1.0.8] - 2026-05-25

**混合架构：可选 Node 预处理器（快路径）+ 每章「本章小结」**

### 客户反馈

> 智能体处理的内容还是很多，耗时较长。能否先用脚本进行数据处理，然后每章 LLM 总结/润色？

### 改动

#### 1. 新增 `tools/preprocess.js`（单文件 Node 预处理器）

从 SaaS 分支借用 `extract.js + rule-engine.js + rule-helpers/index.js + rules/*.json`，无外部依赖（`require` 只用 fs/path，**不依赖 npm install**）。

客户机有 `node` 即可跑：

```bash
node tools/preprocess.js /path/to/data --out /path/to/data/facts.json
```

约 5-15 秒输出结构化 `facts.json`（~650 KB），含：
- `nodes[]` — 各节点解析数据
- `issues[]` — 42 条规则确定性评估结果（P0-P3 + description + action）
- `healthScore` — 6 维度评分
- `cluster.topology` — 拓扑识别结果

#### 2. SKILL.md 新增 Step 0 决策树（混合工作流）

```
检查 facts.json
├── 存在 ─→ 快路径（5-10 min）
└── 不存在 ─→ 检测 node 可用性
    ├── 有 node ─→ 跑 preprocess.js → 快路径
    └── 无 node ─→ 纯 LLM 路径（10-15 min，原工作流）
```

**两条路径对比**：

| 路径 | LLM input | 总时间 | 一致性 |
|---|---|---|---|
| 快路径（facts.json）| ~10 KB | **5-10 min** | ✅ 高（规则确定性）|
| 纯 LLM 路径 | ~50 KB | 10-15 min | ⚠️ 中 |

#### 3. report-template.md 新增「本章小结」要求

第二至第十五章末尾必须加统一格式 callout：

```markdown
> **📊 本章小结**
>
> - **展示内容**：（这章给了什么信息）
> - **整体状态**：🟢 正常 / 🟡 关注 / 🔴 异常
> - **关键发现**：（最重要的 1-3 条）
> - **建议**：（引用 rules.md action 字段或"维持现状"）
```

状态 emoji 约定：🟢 该章节规则全未触发 / 🟡 P2-P3 触发 / 🔴 P0-P1 触发。

第一章 / 第十六章 / 第十七章不加（本身就是综合性章节）。

### 收益

1. **速度提升 40-50%**（快路径下 input 减 80%，跳过 LLM 规则评估）
2. **一致性大幅改善**（同样数据 → 同样的 issues / 健康度评分 — 规则评估是确定性的）
3. **LLM 专注做叙事**（不再既当"规则评估侦探"又当"报告作家"）
4. **每章独立小结**让客户快速浏览结论（不需要全看完）
5. **零额外依赖**（preprocess.js 只用 Node stdlib，无 npm install）

### 影响

- 客户机有 node ✓ 自动走快路径
- 客户机无 node → 自动 fallback 到纯 LLM 路径，功能完整
- 全部 17 章编号 / 名称约束保留（v1.0.5）
- mermaid `<br/>` 约束保留（v1.0.4）
- 各模式（fast / standard / full）保留（v1.0.2）

### 验证

实测在 `desensitized` 4 节点测试集上：

```bash
node tools/preprocess.js /Users/liups/ai/skill/test/v3/desensitized --out /tmp/facts.json
# → 4 节点 / 45 issues (P0:5/P1:11/P2:25/P3:4) / 健康度 88/100 / 5 秒完成
```

### 不在本次范围

- 章节级并行 LLM 调用（需 SaaS 路径才能 orchestrate，不在 skill 范围）
- 客户机无 node 的情况下用 bash 写预处理器（复杂度过高）

---

## [1.0.7] - 2026-05-24

**CI 化 — push tag 自动打包发布到 Releases 页**

### 改动

新增 `.github/workflows/release.yml`，tag 触发自动构建 + 发布。

### 流程

```bash
echo "1.0.7" > VERSION
sed -i '' 's/^version: .*/version: 1.0.7/' SKILL.md
# 在 CHANGELOG.md 顶部加 "## [1.0.7] - YYYY-MM-DD" 条目
git add -A && git commit -m "release: v1.0.7"
git push origin skill
git tag skill-1.0.7
git push origin skill-1.0.7    # ← Action 触发
```

约 1 分钟后 [Releases](https://github.com/aimdotsh/mysql-healthcheck/releases) 页出现新版本。

### Action 做了什么

1. **校验 3 处版本一致**：VERSION 文件 / SKILL.md frontmatter / CHANGELOG.md 顶部条目
2. **校验 tag 与 VERSION 匹配**（tag 必须是 `skill-` + VERSION 内容）
3. **打包 zip**（排除 `.git` / `.github` / `.DS_Store` / `*.bak`）
4. **从 CHANGELOG 抽取该版本的变更说明**作为 release notes 主体
5. **prepend 安装命令**给 release notes 顶部
6. **发布到 Releases 页**，标记 `latest`

### 校验失败的常见原因

- VERSION 文件与 tag 不匹配（如 tag `skill-1.0.7` 但 VERSION 文件还是 `1.0.6`）→ 报错退出
- CHANGELOG.md 没有该版本的 `## [X.Y.Z]` 条目 → 报错退出
- SKILL.md frontmatter 没有 `version: X.Y.Z` → 仅 warning，不阻断

### 手动触发（保险用）

GitHub UI → Actions → "Release skill" → "Run workflow" → 输入 version 参数。

### 验证

- ✅ skill-1.0.6 之前已通过手动 `gh release create` 发布
- 本版 1.0.7 起改为 Action 自动发布（push tag 触发）
- 测试方式：`git tag skill-1.0.7 && git push origin skill-1.0.7` 后看 Actions 页面

### 不变项

- VERSION / SKILL.md / CHANGELOG 三处版本标识保留
- 报告头依然 Read VERSION 文件填「巡检版本」字段
- 客户拿到 zip 后行为完全不变

---

## [1.0.6] - 2026-05-24

**版本标识 — 多处可查 skill 版本，不再靠文件名猜**

### 客户反馈

> 现在查看 skill 文件能知道是哪个版本么？不只是通过文件名称来判断

### 改动

新增 **3 处版本标识**：

1. **`VERSION` 文件**（新增，仓库根目录单行 `1.0.6`）— 最直接，`cat VERSION`
2. **`SKILL.md` frontmatter 加 `version` 字段** + 两行 HTML 注释（人/机都能看到）

```yaml
---
name: mysql-healthcheck
version: 1.0.6
description: ...
---
```

3. **报告头**：LLM 生成报告时 Read VERSION 文件 → 写到「巡检版本：v1.0.6」字段

### 客户使用场景

| 场景 | 怎么查 |
|---|---|
| 看本地装的哪个版本 | `cat VERSION` 或 `head -3 SKILL.md` |
| 看一份历史报告是哪个版本生成 | 报告头「巡检版本」字段 |
| 对比两份报告差异 | 报告头 version + 生成模式 — 立刻知道是版本差异还是模式差异 |
| 看 GitHub Release 哪个最新 | `gh release view --repo aimdotsh/mysql-healthcheck` |

### 配套：报告头新增「生成模式」字段

之前报告头只有「巡检版本：v1.0」（硬编码占位），现在改成：

```markdown
**巡检版本**：v1.0.6（mysql-healthcheck skill）
**生成模式**：standard
```

客户能立刻看出用 fast / standard / full 哪个模式。

### 影响

- 任何下载到的 skill 包都能 1 秒判断版本
- 报告文件不再"长得一样不知道哪个新" — 看版本号 + 生成模式秒判
- 跨客户 / 跨时间的报告对比有了客观依据
- LLM 必须 Read VERSION 文件（额外 1 个 Read 调用，零性能影响）

---

## [1.0.5] - 2026-05-24

**UX 修复：standard/fast 模式不再产生章节编号 gap，改为「精简章节」**

### 客户反馈

> 省略了第五章节，是就没有第五章节的序号了吗？这是不是不合理

### 根因

v1.0.3 的规则是「standard 模式跳过无数据章节」+「保留位置感，不重新编号」。结果客户看到：

```
第四章 集群拓扑
第六章 性能指标分析    ← 第五章哪去了？
```

UX 困惑：客户不知道是 bug 还是模板残缺。

### 改动

**取消整章删除**，改为「精简章节」：

**规则**：
- 17 章编号**永远连续**（第一/二/三 … 十七）
- standard / fast 模式下"非必填章节"**保留章节标题** + 写 1-2 行说明
- 必填章节正常详细写

**精简章节标准写法**：

```markdown
## 第七章 数据库容量与对象

本章无显著风险点（容量正常、无大碎片表、字符集统一）；如需详细数据请用 full 模式生成。
```

或：

```markdown
## 第三章 MySQL 版本与启动配置

> standard 模式下精简：核心版本信息见执行摘要；详细启动参数请用 full 模式。
```

### 三档模式对比（v1.0.5）

| 模式 | 必填章节（详细） | 精简章节（1-2 行） | 总章节数 |
|---|---|---|---|
| **fast** | 1 / 16 / 17 | 第二至十五章 | 17（一直 17） |
| **standard** | 1/2/4/5/6/12/13/14/15/16/17 | 3/7/8/9/10/11 | 17 |
| **full** | 全 17 章详细 | 无 | 17 |

**关键升级逻辑**：精简章节里如果实际有 P1/P2 问题，应自动升级为详细写。

### 影响

- standard / fast 模式输出 token 略增（精简章每章多 1-2 行），但 UX 不再困惑
- full 模式不变
- 跨报告同章号严格对应同模板章节（更易对比）

### 验证

跑同样 2 个 txt 一次 standard 模式，应当：
- ✅ 第一至第十七章编号完全连续
- ✅ 精简章节存在，内容仅 1-2 行
- ✅ 客户能逐章对比 standard vs full

---

## [1.0.4] - 2026-05-24

**修复：Mermaid 拓扑图节点堆叠 — LLM 用 `\n` 而非 `<br/>` 导致换行失效**

### 客户反馈

> 拓扑图里节点文字 `\n` 没有换行生效，全挤一行，节点超宽堆叠重叠

### 根因

LLM 写 mermaid 时按 JS / Python 字符串习惯写 `\n`，但 mermaid 渲染器**把 `\n` 当字面值显示**：

```mermaid
graph LR
  M["主库\n172.16.7.32\nMySQL 5.7.25"]   ← \n 不换行，节点变成单行 50 字符宽
```

结果：节点超宽 → 相邻节点 / 边标签互相覆盖 → 拓扑图崩坏。

模板 v1.0.1 加 mermaid 指引时**正例**都用了 `<br/>`，但**没显眼地警告"不能用 `\n`"**，所以 LLM 看到自己写的 `<br/>` 觉得"也行"就改回 `\n`（这是 LLM 把 mermaid 当成程序代码的常见失误）。

### 改动

`references/report-template.md` 的「图表使用约定」段 → mermaid 子段加：

1. **显眼 ⚠️ 警告**：「Mermaid 节点内换行必须用 `<br/>` 不是 `\n`」
2. **正反例 mermaid 块**（直接渲染时一对就看出来：错的不换行 vs 对的换行）
3. **错误/正确并列表格**：
   - `"主库\n172.16.7.32"` ❌
   - `"主库<br/>172.16.7.32"` ✅
4. **mermaid 节点内特殊字符规则**：冒号 `:` / 括号 `()` 必须双引号包裹；不能用反斜杠 `\` 和双引号。

### 影响

- LLM 下次生成拓扑图时应当用 `<br/>` 不再堆叠
- 不影响已有报告（用户需手动修复或重新生成）
- 其它 mermaid 块（pie / graph）类似规则也适用

### 验证

跑一次同样的 2 个 txt，第 4 章拓扑图应当：
- ✅ 节点文字按行分布（IP / server_id / 版本 / read_only 各占一行）
- ✅ 节点尺寸正常，不超宽不堆叠
- ✅ GitHub / Obsidian / VS Code 都正常渲染

---

## [1.0.3] - 2026-05-24

**修复：standard 模式下 LLM 自由发挥章节结构 — 强化模板约束**

### 客户反馈

> 我现在跑了两份 .md 巡检报告（同样 2 个 txt），章节结构差别很大

### 根因

v1.0.2 引入 standard 模式时只说「跳过无数据章节」，但**没明确约束「保留的章节必须用模板原编号 / 名称」**。结果 LLM 自由发挥：

| 模板原章节 | LLM 自创版 |
|---|---|
| 第七章 数据库容量与对象 | 「第 7 章 容量与存储」（改名）|
| 第十三章 Schema 审计 | 「第 13 章 可疑检测（异常项汇总）」（杜撰）|
| 第七章合理位置 | 「第 7 章 索引健康」（模板里没这章）|
| 中文数字「第一章」 | 阿拉伯数字「第 1 章」 |

两份报告对比时章节差异巨大，用户对工具失去信任。

### 改动

#### 1. `SKILL.md` 第 8 步加 5 条硬性约束 + 示例

明确规定：
- 章节编号 + 名称必须 1:1 照搬模板
- 不能自创新章节（杜撰新话题放第十六章子节）
- 不能改名 / 合并 / 拆分章节
- 章节标题必须用中文数字
- 省略某章时不要重新编号（保留位置感）

附 standard 模式典型 11 章输出样本，让 LLM 照抄。

#### 2. `references/report-template.md` 顶部加显眼"硬性约束"段

5 条与 SKILL.md 一致的约束，**每条都给正反例**。

最后一句强调：「**违反任一约束 = 输出不一致，客户对比两份报告会发现差异，对工具失去信任。**」

#### 3. 表格化模式说明

| 模式 | 必填章节 | 可选省略 |
|---|---|---|
| fast | 1 / 16 / 17 | 2-15 全部 |
| standard | 1/2/4/5/6/12/13/14/15/16/17 | 3/7/8/9/10/11（无数据时） |
| full | 全 17 章 | 无 |

### 影响

- LLM 输出一致性显著提升 — 不同次跑同样数据应当出**相同章节编号 / 名称**
- 模式间差异**只在内容详尽度**，不在章节结构
- 客户对比两份报告应当能逐章对应

### 验证

跑同样 2 个 txt 两次，比较：
- ✅ 章节编号 / 名称完全一致
- ✅ 中文数字 vs 阿拉伯数字一致
- ✅ standard 模式下应出 ~11 章（1/2/4/5/6/12/13/14/15/16/17，省略 3/7/8/9/10/11 取决于数据）
- ⚠️ 章节内文字描述会有自然语言变化（这是 LLM 正常表现，可接受）

---

## [1.0.2] - 2026-05-22

**性能优化 — 23 分钟 → 7-15 分钟**

### 客户反馈

> 现在跑了两个 txt 的巡检报告，花费了 23 分钟，速度太慢了

### 根因

之前的工作流：

1. 一次性全读 `rules.md`（1040 行）+ `report-template.md`（783 行）+ `parsing.md`（80 行）≈ 50K token input
2. 全读所有 txt 包括 5000 行 slow_query_log_tail / 500 行 error_log_tail / 全量 processlist ≈ 300+ KB
3. 串行评估 42 条规则
4. 输出 17 章完整 markdown ≈ 30-50K token output

**主要瓶颈：输出大量（17 章），其次是 input 冗余（全读规则文档）。**

### 改动

#### 1. `references/rules.md` 顶部加「规则速查矩阵」

42 条规则一张紧凑表格（每行 ≤ 80 字符），列：rule_id / 维度 / 默认 P / 触发信号速查（看 txt 哪段判断）。

LLM **先扫这张表**，根据 txt 头部信息粗判 5-15 条候选规则，**只对候选规则读详情**。input token 减 50-70%。

#### 2. `SKILL.md` 加三档输出模式

| 模式 | 章节 | 预估耗时 |
|---|---|---|
| **fast** | 3 章（摘要 + 行动 + 结论） | 5-7 min |
| **standard**（默认）| 重点 8-10 章（跳过无数据章节） | 10-15 min |
| **full** | 完整 17 章 | 20-30 min |

用户没指定 → standard；说「快」「紧急」→ fast；说「正式交付」「详细」→ full。

#### 3. `SKILL.md` 加性能优化原则段

7 条优化纪律明确告诉 LLM：

1. 先读速查矩阵，不全读 rules.md
2. 大段日志（slow_log_tail / error_log_tail / all processlist）默认跳过，用关键字搜索或读头尾各 50 行
3. 并行读多节点 txt
4. 跳过"无数据"章节（不写「未发现」占位）
5. P2/P3 用表格，只 P0/P1 详细列
6. 引用 rules.md 的 action 字段，不要自由发挥扩写
7. 生成过程不要 stream 状态消息

### 预期效果

| 模式 | 旧版（v1.0.1）| 新版（v1.0.2）|
|---|---|---|
| 快速排查（≈ fast）| ❌ 不支持 | **5-7 min** |
| 日常巡检（≈ standard）| ❌ 不支持 | **10-15 min** |
| 月度交付（≈ full）| 23 min | **15-20 min**（input 减半，output 不变）|

实测看用户的 LLM 平台和模型，结果可能略有不同。

### 影响

- 零结构改动（仍是 LLM-driven，仍输出 markdown）
- 行为改进：默认 standard 模式比之前的"全 17 章"快 30-50%
- 用户可主动切 fast 模式做紧急排查
- 兼容性零变化：fast/standard/full 都遵守 17 章结构规则，仅章节数不同

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
