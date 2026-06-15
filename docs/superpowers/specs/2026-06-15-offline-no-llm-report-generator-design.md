# 离线 / 无 LLM / 无 node 巡检报告生成器 — 设计 spec

**日期**：2026-06-15
**分支**：skill
**版本**：1.0.9 → 1.1.0

---

## 一、背景与问题

客户现场为**无外网、RHEL 7.9、无 node** 的隔离环境：

- 采集到的 `MySQLHealthCheck_*.txt` 数据**不能带出**，只能在客户本机分析、本机出报告。
- RHEL 7.9 默认官方 YUM 源**不带 node**，且无外网，无法 `yum install` 任何运行时。
- 报告生成**不能依赖 LLM**——所有 DBA 经验、判断、建议必须以离线规则形式内置。

当前三个分支都无法直接满足：

| 分支 | 报告由谁生成 | 为什么不满足 |
|---|---|---|
| skill | LLM 读 facts.json 写 markdown | 依赖 LLM |
| SaaS / ykt | `render.js` + `docx` + `@resvg/resvg-js`（原生包） | 依赖 node + 原生包，离线装不上 |

## 二、核心洞察

**分析层已经完全离线、零依赖、零 LLM。** `tools/preprocess.js` + `rule-engine.js` + `rule-helpers/index.js` + 6 个 `tools/rules/*.json`（约 4300 行）只 `require` 了 `fs` / `path` 两个 Node 内置模块，已编码全部阈值、判断、`currentValue → recommendedValue`、可执行 SQL。

唯一缺口是**渲染**：今天由 LLM 写散文，或由 SaaS `render.js` + 原生 `resvg` 出 docx。

因此本次**只新增一个纯内置模块的渲染器 + 打包**，**不碰任何规则逻辑**（零回归、零规则漂移）。

## 三、已确认的决策（brainstorming 结论）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 打包方式 | **二进制 + 零依赖 JS 渲染器，两者都做** | 一套 JS 代码；有 node 直接 `node tools/report.js`，无 node 用二进制 |
| 输出格式 | **md + html 都出** | md 供后续转换，html 自包含供现场查看/打印 |
| 代码放置 | **扩展 skill 分支** | 复用唯一一份规则管线，零漂移（刚修过 config/规则漂移） |
| 无-node 交付物 | **先二进制，Python 作备选** | 二进制零成本复用现有 JS；Python 仅在客户安全策略拦截二进制时再启动 |
| 渲染器内部 | **block 模型 + 双序列化器** | md/html 同源，不漂移 |
| 图表 | **全 6 种**（gauge/pie/hbar/vbar/radar/topology） | `charts.js` 已写好，HTML 内联近零成本 |
| 二进制构建 | **CI（tag 触发，复刻 ykt workflow）+ 本地先编一个** | 可复现 + 立即可测 |

### 关键澄清：二进制不需要客户装 node

`pkg` 把整个 Node 16 运行时与 JS 一起打进单个可执行文件。**JS / node 只在构建端（mac / CI，有网）需要；客户机零安装**，直接 `./mysql-healthcheck-linux-x64 <目录>`。客户既看不到 JS 也不需要任何运行时。

## 四、架构

```
MySQLHealthCheck_*.txt   ← 客户现场采集，数据永不出场
        │
   tools/preprocess.js      （现有，零依赖）→ facts（内存对象，可选落 facts.json）
        │
   tools/render-offline.js  （新，零依赖）
     ├─ tools/charts.js     （新：从 SaaS 拷来，删 resvg/svgToPng，只留 6 个纯 SVG 构造器）
     ├─ 构造 17 章 block 数组（数据来自 facts）
     └─ toMarkdown(blocks) / toHtml(blocks)
        │
        ├─ MySQL巡检报告_<日期>.md
        └─ MySQL巡检报告_<日期>.html   （自包含：内联 CSS + 内联 SVG）
        ▲
   tools/report.js （新，瘦 CLI 入口）= preprocess → render 一步到位；二进制入口
```

**两种运行方式，同一套代码：**

- **有 node**（开发 / 其它客户）：`node tools/report.js <数据目录>` → md + html，全程无 LLM。
- **无 node**（本客户）：`./mysql-healthcheck-linux-x64 <数据目录>` → 同样的 md + html。

## 五、组件设计（按单一职责拆分）

### 5.1 `tools/preprocess.js`（现有，不改）
txt → 结构化 facts（nodes / issues / healthScore / cluster.topology）。零依赖。

### 5.2 `tools/charts.js`（新，从 `SaaS:scripts/lib/charts.js` 移植）
- **保留**：`COLORS`、`svgWrap`、`escapeXml`、`describeArc`、`gauge`、`pie`、`hbar`、`vbar`、`radar`、`topology`（全部纯 JS，返回 SVG 字符串）。
- **删除**：`loadResvg`、`svgToPng`、`@resvg/resvg-js` 的 require/路径（仅用于 docx 栅格化，HTML 用不到）。
- 移植后**零外部依赖**（仅 `path`）。

### 5.3 `tools/render-offline.js`（新，核心）
- **block 模型**：每章构造成 block 数组。block 类型：`heading` / `paragraph` / `table` / `list` / `callout` / `codeblock` / `chart`。
- **两个序列化器**：
  - `toMarkdown(blocks)` → GitHub flavored markdown；`chart` 块降级为紧凑表格 / ASCII 摘要。
  - `toHtml(blocks)` → 自包含 HTML（`<style>` 内联 CSS + `chart` 块内联 SVG）。
- **章节构造器**：复用现有 17 章框架（参照 `references/report-template.md` 与 `SaaS:scripts/render.js`），从 facts 取数：
  - `facts.nodes[]` → 第二~五章（OS / 实例 / 拓扑 / 参数）表格
  - `facts.issues[]` → 第十六章行动计划（按 P0-P3 排序 + currentValue/recommendedValue/sql）
  - `facts.healthScore` → 第一章执行摘要、第十七章结论
  - `facts.cluster.topology` → 第四章拓扑（`charts.topology` 内联 SVG）

### 5.4 `tools/report.js`（新，瘦 CLI）
- 解析参数：`<数据目录>`、`--out-dir`、`--format md|html|both`（默认 both）、`--project`、`--emit-facts`（调试用，额外落 facts.json）。
- 调 preprocess → render-offline → 写 md + html 到数据目录。
- 即二进制入口。

### 5.5 构建 / 发布
- `package.json`（新，**仅构建端用，不进客户交付**）：`bin` 指向 `tools/report.js`；`pkg` 配置 `targets: ["node16-linux-x64"]` + `assets`（见风险 7.1）；`devDependencies` 仅 `pkg`。
- `.github/workflows/release-binary.yml`（新，复刻 ykt）：push tag → `npx pkg` 构建 linux-x64 二进制 → 挂到 GitHub Release。
- 二进制**不入仓**（`.gitignore` 已忽略 `*.zip`，另加二进制名）。

## 六、数据流 & 交付

现场交付包 = `collectors/mysqlHealthCheckV3.0.sh`（纯 bash，零依赖）+ `mysql-healthcheck-linux-x64`（二进制）。客户**本机**采集 → 本机生成报告，`.txt` 与报告都不出场，无外网、无 node、无 LLM。

## 七、RHEL 7.9 / 打包关键约束与风险

### 7.1 pkg 资产加载（实现重点）
`rule-engine.js` 用 `fs.readdirSync(rulesDir)` + `fs.readFileSync` 读 `rules/*.json` 与 `config/default-thresholds.json`。pkg 快照文件系统对 `readdirSync` 支持有坑。

**缓解**：构建前把规则加载改为可被 pkg 静态分析的形式 —— 优先 `require()` 各 JSON（pkg 自动打包 require 依赖），或在 `package.json` 的 `pkg.assets` 显式列出 `tools/rules/*.json`、`tools/config/*.json` 并确认 `__dirname` 解析到快照路径。**CI 构建后必须实跑二进制验证规则确实加载（issue 数 = 49）**，不能只看编译成功。

### 7.2 glibc 2.17
RHEL 7.9 = glibc 2.17；Node 18+ 要 glibc 2.28，**排除**。Node SEA 需 Node 20+，**排除**。必须 `pkg --target node16-linux-x64`（Node 16 官方 linux-x64 在 CentOS 7 上编译，兼容 glibc 2.17）。**在 RHEL 7 测试机 / 容器实测确认**。

### 7.3 架构
默认 x86_64。若客户为 aarch64 等，二进制不可用 → 文档注明回退路径（需另编对应架构，或客户侧另想办法）。

### 7.4 其它降级
- txt 缺段：preprocess 已有 collectionStatus 标记，渲染器显示「未采集」而非崩溃。
- 体积：二进制约 40-50 MB（含 Node 运行时），可接受。
- 安全审查：若客户 HIDS/EDR 拦截未知二进制 → 启动备选 Python 2.7 方案（见九）。

## 八、测试

- **渲染器**（`node tools/report.js <脱敏测试集>`）：
  - 断言 facts 的 49 个 issue 全部出现在报告中。
  - md 与 html 都含 17 章标题；两者问题条目一致（同源验证）。
  - html 自包含：无 `http://` / `https://` 外链、无 `<script src>`、图表为内联 `<svg>`。
- **回归**：issue type/priority 与现有 facts.json 逐条一致（未动规则，应零差异）。
- **二进制冒烟**：CI / 本地构建后在 linux-x64 跑同一测试集，输出与 `node tools/report.js` 一致；并在 glibc 2.17 环境确认可启动 + issue 数 = 49。

## 九、备选方案（Python 2.7，暂不实施）

仅当客户安全策略拦截二进制时启动：用 `/usr/bin/python`（RHEL 7.9 自带 2.7.5）stdlib-only 重写解析 + 规则 + 渲染。代价：约 4300 行 JS 全量移植到 Python 2.7（无 f-string、需处理 unicode），且形成双套规则引擎（漂移风险）。**本轮不做**，记录为契约。

## 十、范围边界（YAGNI）

**做**：零依赖 JS 渲染器（md+html）、charts.js 移植、report.js CLI、pkg node16 二进制 + CI、版本/文档更新。

**不做**：docx（交独立 md→word skill）、Python 重写（备选）、提交二进制、改任何规则逻辑、其它分支改动。

## 十一、交付物清单

| 文件 | 动作 |
|---|---|
| `tools/charts.js` | 新增（移植 + 删 resvg） |
| `tools/render-offline.js` | 新增（block 模型 + 双序列化 + 17 章） |
| `tools/report.js` | 新增（CLI 入口 = preprocess→render） |
| `package.json` | 新增（仅构建端：bin + pkg 配置 + devDep pkg） |
| `.github/workflows/release-binary.yml` | 新增（tag → pkg → Release） |
| `.gitignore` | 加二进制产物名 |
| `SKILL.md` | 新增「无 node → 二进制」「纯 node 无 LLM 出报告」模式说明 |
| `CHANGELOG.md` / `VERSION` | 1.0.9 → 1.1.0 条目 |
| 脱敏测试集验证脚本 | 验证 md+html 与二进制 |
