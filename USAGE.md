# MySQL 巡检报告技能 — 安装与使用说明

> 适用版本：v3.0（数据驱动 + 自动分析）

---

## 1. 这是什么

一个把 MySQL 巡检脚本采集的 `.txt`（原始数据）和 `.html`（可选）一键转成专业 **`.docx` 巡检报告** 的技能。

**特点**：
- 17 章 + 执行摘要 + 自动目录（封面 / 执行摘要 / 目录 / 巡检摘要 / 服务器 / 连接 / 库清单 / 配置参数 / 性能 / 存储 / ibtmp1 / InnoDB / 事务锁 / 用户权限 / 主从 / Schema 审计 / SQL 治理 / 备份评估 / 安全合规 / 总结）
- 健康度评分模型：6 维度雷达图 + 总分仪表盘
- 10 张嵌入图表（健康度仪表 / 六维雷达 / 问题分布 / MySQL 拓扑 / 磁盘 / 连接 / Processlist / Buffer Pool / TOP10 大表 / 合规分布）
- 多节点自动展开（4 节点就 4 行，不用复制粘贴）
- 内置 20 条自动巡检规则（P0~P3 分级）
- 占位符残留自检
- 中文字体（微软雅黑）+ 蓝色主题 + 优先级配色

---

## 2. 一次性安装

### 2.1 前置条件
- macOS / Linux
- Node.js ≥ 16（终端运行 `node -v` 确认）

### 2.2 拷贝技能目录

技能默认安装路径：`~/.workbuddy/skills/mysql-healthcheck/`。
如已存在则跳过；首次安装可从压缩包或仓库拷过来：

```bash
mkdir -p ~/.workbuddy/skills
# 把整个 mysql-healthcheck/ 目录放进去
```

最终文件结构：
```
~/.workbuddy/skills/mysql-healthcheck/
├── SKILL.md
├── USAGE.md          ← 本文档
└── scripts/
    ├── package.json
    ├── extract.js
    ├── render.js
    └── assets/logo.png
```

### 2.3 安装 docx 依赖

```bash
cd ~/.workbuddy/skills/mysql-healthcheck/scripts
npm install
```

只需执行一次，会在 `scripts/node_modules/` 下装好 `docx` 及其依赖。

---

## 3. 准备输入数据

在任意目录下（推荐为每个项目建一个目录）放入巡检脚本输出文件：

```
~/projects/clientA/2026-04-inspect/
├── MySQLHealthCheck_172.16.7.2_202604301023.txt    ← 必需（主库）
├── MySQLHealthCheck_172.16.7.3_202604301027.txt    ← 每个节点一份
├── MySQLHealthCheck_172.16.7.4_202604301025.txt
├── 172.16.7.2_apple_pri-2026-04-30.html            ← 可选（兼容历史 ibtmp1 补充数据）
└── 172.16.7.3_apple_slave1-2026-04-30.html
```

**文件命名约定**（脚本据此识别节点 / 时间 / 角色）：

| 文件名段 | 用途 | 示例 |
|---|---|---|
| `MySQLHealthCheck_<IP>_<时间戳>.txt` | 必需，原始数据 | `MySQLHealthCheck_172.16.7.2_202604301023.txt` |
| 时间戳 `YYYYMMDDhhmm` | 推断巡检日期 | `202604301023` → `2026-04-30` |
| html 中 `pri`/`master`/`primary` 关键字 | 识别主库 | `172.16.7.2_apple_pri-...html` → 主库 |
| html 中 `slave`/`replica` 关键字 | 识别从库 | `..._slave1-...html` |

V3 TXT 已包含 `innodb_tablespaces (含 ibtmp1)`，通常可直接解析 ibtmp1 当前占用；只有该段未返回 ibtmp1 行时才会显示为 `-` 并在报告中标注采集状态。HTML 仅作为历史兼容输入。

---

## 4. 生成报告（两步）

### Step 1：提取数据

```bash
cd ~/.workbuddy/skills/mysql-healthcheck/scripts
node extract.js <数据目录> --project "<项目名称>"
```

例：
```bash
node extract.js ~/projects/clientA/2026-04-inspect --project "一卡通 Apple 集群"
```

输出：在数据目录下生成 `data.json`，并打印自动检出的问题数：
```
解析节点 172.16.7.2 ...
解析节点 172.16.7.3 ...
数据已写入 ~/projects/clientA/2026-04-inspect/data.json
  - 节点：4 个
  - 自动检出问题：35 项 (P0:0, P1:15, P2:20, P3:0)
```

参数：

| 参数 | 必需 | 说明 |
|---|---|---|
| `<数据目录>` | ✓ | 包含 txt/html 的目录 |
| `--project "名称"` | 推荐 | 项目正式名称，用于封面与页眉 |
| `--out path.json` | 否 | 自定义 data.json 输出路径（默认数据目录下）|

### Step 2：渲染 docx

```bash
node render.js <数据目录>/data.json
```

例：
```bash
node render.js ~/projects/clientA/2026-04-inspect/data.json
```

输出：
```
✓ 占位符校验通过：未发现残留 {…} 模板字符串
生成成功：~/projects/clientA/2026-04-inspect/一卡通_Apple_集群_MySQL数据库巡检报告_详细版_v3.0.docx
  文件大小：39.1 KB
```

参数：

| 参数 | 必需 | 说明 |
|---|---|---|
| `<data.json>` | ✓ | Step 1 输出的 JSON |
| `--out path.docx` | 否 | 自定义输出路径（默认与 data.json 同目录）|

---

## 5. 可选 · 编辑 data.json 润色

`extract.js` 已自动生成完整可用数据。若需要让报告**更贴合业务场景**：

打开 `data.json`，可以改：

| 字段 | 改什么 |
|---|---|
| `project` | 项目正式名 |
| `overallAssessment` | 整体评价（默认按 issues 自动推）|
| `issues[*].description` | 让问题描述措辞更贴业务 |
| `issues[*].action` | 调整建议措施 |
| `issues[*].status` | 若已处理可改为 "已修复" |
| `recommendations.longTerm` | 追加项目特有长期规划 |

改完保存，再执行 Step 2 即可。**不要改**节点信息、参数表、TOP10 等纯数据字段（重跑 extract 会被覆盖）。

---

## 6. 验收清单

打开输出的 docx，检查：

- [ ] 封面：项目名、巡检日期、集群拓扑（如「一主3从」）显示正确
- [ ] 17 个章节齐全（一～十七）+ 执行摘要 + 自动目录
- [ ] 第一章「问题汇总」表有内容，按 P0/P1/P2/P3 分色显示
- [ ] 第二章「集群节点信息」行数等于节点数
- [ ] 第五章「核心配置参数对比」按节点列横向展示
- [ ] 第七章 TOP 10 大表显示真实库表名与数据量
- [ ] 第十二章从库复制状态显示 `Slave_IO_Running` / `Seconds_Behind`
- [ ] 第十三章「行动计划」按 P0/P1/P2/长期 分组
- [ ] 每页有页眉（项目名 + IP）+ 居中页码
- [ ] 命令行 `✓ 占位符校验通过` 出现

---

## 7. 常见问题排查

### 报错 "未找到 MySQLHealthCheck_*.txt 文件"
- 检查目录路径是否正确
- 确认文件名形如 `MySQLHealthCheck_<IP>_<时间戳>.txt`

### 报错 "未找到可用的 docx 依赖"
- 漏装依赖。执行 `cd ~/.workbuddy/skills/mysql-healthcheck/scripts && npm install`

### docx 打开后只是封面没正文
- 极可能是依赖损坏。删除 `scripts/node_modules` 后 `npm install` 重装

### 某节点字段全是 `-`
- 该节点 txt 段名与脚本期待不一致。打开 txt 查找 `----->>>---->>>` 后跟的真实段名，如与 `extract.js` 中 `getSection(content, 'XXX')` 的关键字不同，需更新关键字

### server_id 显示错误
- my.cnf 中可能有多个 `server_id =` 行，脚本取最后一行（与 MySQL 实际行为一致）；如果还是不对，手工编辑 `data.json` 里 `variables.server_id`

### 想加新的检测规则
- 编辑 `scripts/extract.js` 的 `analyzeIssues(nodes)` 函数，参考已有规则照写一条 `add('P1', '描述', nodeLabel, '建议')`

### 想加新的章节
- 在 `scripts/render.js` 写一个 `chapterXxx(data)` 返回 `[Paragraph, Table, ...]`
- 在 `buildDocument` 的 `children` 数组中加 `...chapterXxx(data)`

---

## 8. 升级 / 卸载

### 升级
直接覆盖 `~/.workbuddy/skills/mysql-healthcheck/` 目录即可，依赖仍在。

### 卸载
```bash
rm -rf ~/.workbuddy/skills/mysql-healthcheck
```

---

## 9. 一行 alias（可选）

为方便日常使用，可在 `~/.zshrc` 或 `~/.bashrc` 中加：

```bash
alias mysql-report='cd ~/.workbuddy/skills/mysql-healthcheck/scripts && node extract.js'
alias mysql-render='node ~/.workbuddy/skills/mysql-healthcheck/scripts/render.js'
```

之后只需：
```bash
mysql-report ~/projects/clientA/2026-04-inspect --project "项目名"
mysql-render ~/projects/clientA/2026-04-inspect/data.json
```

---

## 10. 完整示例（复制即可用）

```bash
# 1. 一次性安装
cd ~/.workbuddy/skills/mysql-healthcheck/scripts
npm install

# 2. 准备数据目录
DATA_DIR=~/projects/clientA/2026-04-inspect
# 把 MySQLHealthCheck_*.txt 和可选的 *.html 放到 $DATA_DIR

# 3. 生成报告（两条命令）
node extract.js "$DATA_DIR" --project "客户A 生产集群"
node render.js  "$DATA_DIR/data.json"

# 4. 打开查看
open "$DATA_DIR"/*MySQL数据库巡检报告*.docx
```

---

**支持版本**：v3.0  
**最后更新**：2026-05-13
