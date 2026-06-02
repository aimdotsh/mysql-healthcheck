# MySQL 巡检报告生成器 — 使用说明（ykt 2.0）

> Node 脚本链路：`.txt` → `data.json` → `.docx`（内嵌 10 张图表）

---

## 1. 这是什么

把 MySQL 巡检脚本采集的 `.txt`（原始数据）一键转成专业 **`.docx` 巡检报告**。
本版（ykt 2.0）用 `extract.js` + `render.js` 两段式 Node 流水线确定性生成，图表由 `lib/charts.js`（SVG → PNG）直接嵌入，**不需要 LLM 参与撰写**。

**特点**：
- 17 章 + 执行摘要 + 自动目录
- 六维度健康度评分（雷达 + 仪表盘）
- 10 张嵌入图表（健康度仪表 / 六维雷达 / 问题分布 / 拓扑 / 磁盘 / 连接 / Processlist / Buffer Pool / TOP10 大表 / 合规分布）
- 多节点自动展开 + 主从角色识别
- 42 条自动巡检规则（P0~P3），三层可配置 + 可禁用
- 占位符残留自检 + schema 校验
- 中文字体（微软雅黑）+ 蓝色主题 + 优先级配色

---

## 2. 一次性安装

### 2.1 前置条件
- macOS / Linux
- Node.js ≥ 16（终端运行 `node -v` 确认）

### 2.2 安装依赖

```bash
cd <解压目录>/scripts
npm install
```

或在根目录直接：

```bash
bash install.sh
```

只需执行一次，会在 `scripts/node_modules/` 下装好 `docx` 与 `@resvg/resvg-js`。

---

## 3. 准备输入数据

在任意目录下（推荐为每个项目建一个目录）放入巡检脚本输出文件：

```
~/projects/clientA/2026-05-inspect/
├── MySQLHealthCheck_10.10.10.2_202605142013.txt    ← 必需（主库）
├── MySQLHealthCheck_10.10.10.3_202605142015.txt    ← 每个节点一份
└── MySQLHealthCheck_10.10.10.4_202605142016.txt
```

**文件命名约定**（脚本据此识别节点 / 时间）：

| 文件名段 | 用途 | 示例 |
|---|---|---|
| `MySQLHealthCheck_<IP>_<时间戳>.txt` | 必需，原始数据 | `MySQLHealthCheck_10.10.10.2_202605142013.txt` |
| 时间戳 `YYYYMMDDhhmm` | 推断巡检日期 | `202605142013` → `2026-05-14` |

没有 txt？先在 MySQL 主机本地采集（见第 8 节）。

---

## 4. 生成报告

### 方式 A：一步到位

```bash
cd <解压目录>/scripts
node build.js <数据目录> --project "<项目名称>"
```

### 方式 B：两步（便于中间润色 data.json）

**Step 1 解析数据：**

```bash
node extract.js <数据目录> --project "<项目名称>"
```

输出 `<数据目录>/data.json`，并打印检出问题数：

```
解析节点 10.10.10.2 ...
数据已写入 <数据目录>/data.json
  - 节点：4 个
  - 自动检出问题：49 项 (P0:5, P1:11, P2:28, P3:5)
```

| 参数 | 必需 | 说明 |
|---|---|---|
| `<数据目录>` | ✓ | 包含 txt 的目录 |
| `--project "名称"` | 推荐 | 项目正式名称，用于封面与页眉 |
| `--report-version x.y` | 否 | 报告版本号（默认 `2.0`）|
| `--out path.json` | 否 | 自定义 data.json 输出路径 |
| `--config path.json` | 否 | 外部规则配置（禁用规则 / 改阈值）|

**Step 2 渲染 docx：**

```bash
node render.js <数据目录>/data.json
```

输出：

```
✓ schema 校验通过
✓ 占位符校验通过：未发现残留 {…} 模板字符串
生成成功：<数据目录>/<项目>_MySQL健康巡检报告_v2.0.docx
```

| 参数 | 必需 | 说明 |
|---|---|---|
| `<data.json>` | ✓ | Step 1 输出的 JSON |
| `--out path.docx` | 否 | 自定义输出路径 |
| `--soffice path` | 否 | 指定 LibreOffice，导出即带目录页码 |

---

## 5. 自定义巡检范围（禁用规则 / 改阈值）

有的检查项不适用某些客户（如客户已用云快照备份，不需要 `backup_capability` 报 P0）。
在数据目录放一份 `mysql-healthcheck.config.json`，extract 会自动拾起：

```json
{
  "disabledRules": ["backup_capability", "sql_mode_missing_strict"],
  "thresholds": { "disk": { "critical_pct": 95, "high_pct": 90 } }
}
```

三层优先级：**CLI `--config` > 数据目录同名文件 > 内置默认**。
样例见 `scripts/config/samples/strict.json`（严格/合规）与 `lenient.json`（宽松/POC）。
被禁用的规则会在报告 16.x 附录透明披露。

---

## 6. 可选 · 编辑 data.json 润色

`extract.js` 已自动生成完整可用数据。如需更贴业务，可改 data.json：

| 字段 | 改什么 |
|---|---|
| `project` | 项目正式名 |
| `overallAssessment` | 整体评价 |
| `issues[*].description` / `action` | 让问题描述措辞更贴业务 |
| `issues[*].status` | 已处理可改为 "已修复" |
| `recommendations.longTerm` | 追加项目特有长期规划 |

**不要改**节点信息、参数表、TOP10 等纯数据字段（重跑 extract 会被覆盖）。改完重跑 Step 2。

---

## 7. 验收清单

- [ ] 命令行 `✓ schema 校验通过` + `✓ 占位符校验通过` 出现
- [ ] 封面：项目名、巡检日期、集群拓扑、`v2.0版`
- [ ] 17 章齐全 + 执行摘要 + 自动目录
- [ ] 执行摘要健康度仪表 + 六维雷达图正常
- [ ] 第一章问题分布饼图与 P0/P1/P2/P3 计数一致
- [ ] 第二章拓扑图主从角色正确
- [ ] 第十二章从库 `Slave_IO_Running` / `Seconds_Behind` 正确
- [ ] 每页有页眉 + 居中页码（Word/WPS 右键目录 → 更新域）

---

## 8. 配套采集脚本

```bash
# 在 MySQL 主机本地运行（需可访问 MySQL）
collectors/mysqlHealthCheckV3.0.sh \
  --user dbadmin --password 'xxx' \
  --host 127.0.0.1 --port 3306 \
  --output-dir ./reports
```

详见 `collectors/mysqlHealthCheckV3.0.sh --help`。

---

## 9. 常见问题排查

### 报错 "未找到 MySQLHealthCheck_*.txt 文件"
- 检查目录路径；确认文件名形如 `MySQLHealthCheck_<IP>_<时间戳>.txt`

### 报错 "未找到可用的 docx 依赖"
- 漏装依赖。`cd scripts && npm install`

### 图表为空 / "图表生成失败"
- `@resvg/resvg-js` 未装好。删除 `scripts/node_modules` 后重新 `npm install`
- 不影响报告正文，只是图表缺失

### 某节点字段全是 `-`
- 该节点 txt 段名与脚本期待不一致。查 `references/parsing.md`，必要时改 `extract.js` 的 `getSection()` 关键字

### 目录页码空白
- 未装 LibreOffice。在 Word/WPS 右键目录 → 更新域；或 `--soffice <path>` 导出即带页码

### 想加新检测规则
- 在 `scripts/rules/<维度>.json` 追加一条规则；阈值进 `scripts/config/default-thresholds.json`

---

**支持版本**：ykt 2.0.0
