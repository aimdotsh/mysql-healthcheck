---
name: mysql-healthcheck
description: 为 MySQL 数据库集群生成商业可交付级巡检报告（.docx）。当用户提供包含 MySQLHealthCheck_*.txt 的数据目录并要求「生成巡检报告」「整理巡检数据」「写月度巡检」「健康评估」「上线评估」「故障复盘」「合规自查」「商业交付级报告」等任务时使用。产物含 17 章详细分析 + 执行摘要 + 自动目录 + 六维度健康度评分 + TOP SQL 治理 + 备份评估 + 等保/PCI/GDPR/SOX 合规对照表 + 10 张嵌入图表。
---

# MySQL 巡检报告 Skill

## 何时调用本 skill

满足以下**任一**条件时调用：

1. 用户提供一个目录，内含 `MySQLHealthCheck_<IP>_<时间戳>.txt` 文件
2. 用户提及生成 / 整理 / 撰写以下任一类型的报告：
   - MySQL 巡检报告 / 月度巡检
   - 数据库健康评估 / 体检
   - 上线前评估 / 大促前体检
   - 故障复盘 / 性能事件审计
   - 合规自查（等保 / PCI / GDPR / SOX）
   - 商业交付级 / 客户递交版 MySQL 报告

**不要**用于：非 MySQL 数据库；纯只读数据查询任务（不生成 docx）。

---

## 输入契约

数据目录至少包含：

```
<数据目录>/
├── MySQLHealthCheck_<IP>_<时间戳>.txt     # 必需，每节点一份
└── (可选) MySQLHealthCheck_*.txt          # 多节点集群
```

- 文件命名约定：`MySQLHealthCheck_<IPv4>_<YYYYMMDDhhmm>.txt`
- 时间戳用于推断巡检日期；IP 用于识别节点
- **没有该文件 → 拒绝执行**，提示用户先用 `collectors/mysqlHealthCheckV3.0.sh` 采集

---

## 执行流程（标准 2 步 + 可选润色）

### Step 0（可选但**强烈建议**）：交互确认巡检范围

extract 启动前主动问用户**有哪些检查项不适用**。常见可禁用的规则：

| 规则 id | 默认行为 | 什么场景下建议禁用 |
|---|---|---|
| `backup_capability` | **P0**：节点未装 mysqldump/xtrabackup/mariabackup 即报警 | 客户已通过其它方式备份（云快照 / DBaaS 后台 / 物理 SAN snap / 独立备份服务器拉远程 dump 等）— **本规则误报率高，建议每次都问** |
| `sql_mode_missing_strict` | P2：sql_mode 未含 STRICT_TRANS_TABLES 即报警 | 老应用依赖宽松模式静默成功（不能 truncation 报错） |
| `slow_log_off` | P2：slow_query_log=0 即报警 | 客户用 PMM / Datadog / SkyWalking 等监控代替了慢日志 |
| `lct_zero_linux` | P3：Linux + lct=0 即提示 | 客户业务确认无跨平台迁移需求 |
| `long_query_time_loose` | P3：long_query_time ≥ 5 即提示 | 慢 SQL 治理已委托外部审计，巡检不关心 |
| `flush_method_not_o_direct` | P2：Linux 下 innodb_flush_method ≠ O_DIRECT | 客户用 ZFS / 特殊存储栈，故意选了 fsync |
| `auth_plugin_native_on_80` | P2：8.0+ 默认仍是 mysql_native_password | 客户驱动版本受限，暂时不迁 caching_sha2_password |

**推荐的交互话术（用户**没**主动声明时主动询问）：

> 「生成报告前确认一下：是否需要把『备份能力评估』作为问题报出来？如果客户已经用其它方式备份（云快照 / DBaaS 后台 / 独立备份服务器），可以禁用，否则会在第一章报一个 P0。还有几个常被禁用的规则：sql_mode 严格模式、慢日志开启、Linux 大小写敏感、long_query_time 阈值 — 客户场景不在意的话也可以一起禁用。」

用户回答后，在数据目录写一份 `mysql-healthcheck.config.json`，extract 会自动拾起：

```bash
cat > <数据目录>/mysql-healthcheck.config.json <<'EOF'
{
  "disabledRules": ["backup_capability"]
}
EOF
```

或者用 `--config <path>` 指定外部位置。三层优先级：**CLI `--config` > 数据目录同名文件 > 内置默认**。

**禁用的规则会在报告末尾透明披露**（16.x 附录列「本次报告已禁用以下规则」），防止"漏报"误会。

### Step 1：解析数据

```bash
cd ~/.workbuddy/skills/mysql-healthcheck/scripts
node extract.js <数据目录> --project "<项目正式名>"
```

参数：
- `<数据目录>` 必填 —— 绝对路径或相对路径
- `--project "<名称>"` 强烈推荐 —— 不指定会用文件名推断（可能不准）
- `--out <path.json>` 可选 —— 自定义 data.json 输出位置（默认写入数据目录）

成功输出形如：
```
解析节点 10.10.10.2 ...
数据已写入 <数据目录>/data.json
  - 节点：N 个
  - 自动检出问题：N 项 (P0:N, P1:N, P2:N, P3:N)
```

### Step 2：渲染 docx

```bash
node render.js <数据目录>/data.json
```

参数：
- `<data.json>` 必填
- `--out <path.docx>` 可选

成功输出形如：
```
✓ 占位符校验通过：未发现残留 {…} 模板字符串
生成成功：<数据目录>/<项目>_MySQL健康巡检报告_v1.0.docx
```

### Step 3（可选）：润色 data.json 后重渲染

如果用户希望调整业务侧描述（不影响纯技术数据），可手工编辑 data.json 这些字段：

| 字段 | 用途 |
|---|---|
| `project` | 项目正式名 |
| `overallAssessment` | 整体评价（默认按 issues 自动生成）|
| `issues[*].description` / `action` | 让问题描述措辞更贴业务 |
| `issues[*].status` | 已处理可改为 "已修复" |
| `recommendations.longTerm` | 追加项目特有长期规划 |
| `nodes[*].interviewTemplate` | 客户访谈占位（见 references/interview-guide.md）|

**不要改**：`nodes[*].variables` / `topTables` / `disks` 等纯采集数据 —— 重跑 extract.js 会覆盖。

改完后只需重跑 Step 2。

---

## 首次安装

如果脚本目录不存在或 `npm install` 未执行：

```bash
cd <发行包解压路径>/mysql-healthcheck
bash install.sh                                    # 装到 ~/.workbuddy/skills/
```

依赖：Node.js ≥ 16；npm；`docx@^8.5.0`；`@resvg/resvg-js@^2.6.2`

---

## 输出命名

```
<项目名>_MySQL健康巡检报告_v1.0.docx
```

项目名中的特殊字符会被替换为 `_`。

---

## 失败处理

| 报错 | 原因 | 修复 |
|---|---|---|
| `错误：<dir> 下未找到 MySQLHealthCheck_*.txt 文件` | 数据目录路径错或文件名不符合约定 | 与用户确认目录，必要时用 `find <dir> -name "MySQLHealthCheck*"` 定位 |
| `错误：未找到可用的 docx 依赖` | 漏装 npm 依赖 | `cd .../scripts && npm install` |
| `图表生成失败` | `@resvg/resvg-js` 未装 | `npm install` 重装；不影响报告生成，只是图表占位为空 |
| 某节点字段全是 `-` | txt 段名与解析器期待不一致 | 查 `references/parsing.md`，必要时改 `extract.js` 中的 `getSection()` 关键字 |
| docx 在 WPS 表格列宽乱 | 极早期版本残留 | v4.0 已修复；重跑 render.js 即可 |
| 残留 `{xxx}` 占位符 | 模板硬编码未替换 | 不该出现，请查 render.js |

---

## 验证清单（生成后建议向用户确认）

- [ ] 命令行输出 `✓ 占位符校验通过`
- [ ] docx 17 章齐全，含执行摘要 + 目录
- [ ] 封面显示项目名、巡检日期、拓扑摘要
- [ ] 第十二章从库 IO/SQL 线程状态、延迟正确
- [ ] 第十五章备份评估非空（若 V3.0 采集脚本运行过）
- [ ] 第十六章安全合规检查 PASS/WARN/FAIL 计数合理
- [ ] 在 WPS / Word 中**右键目录 → 更新域**显示页码

---

## 涉及的子文档（仅按需阅读）

| 子文档 | 何时阅读 |
|---|---|
| `references/visual-spec.md` | 用户要求改颜色 / 字体 / 列宽 / 配色 |
| `references/rules.md` | 用户问"为什么报了 X 问题"或想新增检测规则 |
| `references/parsing.md` | extract.js 解析失败 / 想新增采集字段 |
| `references/interview-guide.md` | 用户要填写客户访谈表 / 业务方需要协助 |
| `USAGE.md` | 用户希望直接看完整的人类阅读使用说明 |
| `CHANGELOG.md` | 用户问版本历史或差异 |

---

## 配套采集脚本

如果用户没有 txt 数据，引导先采集：

```bash
# 在 MySQL 主机本地运行（需可访问 MySQL）
collectors/mysqlHealthCheckV3.0.sh \
  --user dbadmin --password 'xxx' \
  --host 127.0.0.1 --port 3306 \
  --output-dir ./reports
```

详见 `collectors/mysqlHealthCheckV3.0.sh --help`。

---

## 关键文件

```
~/.workbuddy/skills/mysql-healthcheck/
├── SKILL.md                       # 本文档（agent 协议）
├── USAGE.md                       # 完整使用说明（人类视角）
├── CHANGELOG.md                   # 版本变更
├── references/                    # 按需加载的技术细节
│   ├── visual-spec.md
│   ├── rules.md
│   ├── parsing.md
│   └── interview-guide.md
├── collectors/                    # 仅发行包含；workbuddy 不一定有
│   └── mysqlHealthCheckV3.0.sh
└── scripts/
    ├── extract.js                 # txt → data.json
    ├── render.js                  # data.json → docx
    ├── lib/charts.js              # SVG 图表
    └── assets/logo.png
```
