# MySQL 巡检报告生成器 · ykt 2.0

> Node 脚本链路，把 MySQL 巡检脚本采集的 `.txt` 一键转成**商业可交付级 `.docx` 巡检报告**，
> 内嵌 **10 张图表**，全程不依赖 LLM。同 txt 必出同 docx。

![version](https://img.shields.io/badge/ykt-2.0.0-blue)
![node](https://img.shields.io/badge/node-%3E%3D16-green)
![output](https://img.shields.io/badge/output-.docx-orange)

---

## 这是什么

`extract.js`（解析 + 规则引擎）→ `render.js`（渲染 docx + 图表）两段式流水线：

- **17 章** + 执行摘要 + 自动目录（封面 / 摘要 / 服务器 / 连接 / 库清单 / 配置 / 性能 / 存储 / ibtmp1 / InnoDB / 事务锁 / 用户权限 / 主从 / Schema 审计 / SQL 治理 / 备份 / 安全合规 / 总结）
- **六维度健康度评分** + 总分仪表盘 + 雷达图
- **10 张内嵌图表**：健康度仪表 / 六维雷达 / 问题分布 / 集群拓扑 / 磁盘 / 连接 / Processlist / Buffer Pool / TOP10 大表 / 合规分布
- **42 条自动巡检规则**（P0~P3 分级，6 维度），三层可配置（CLI / 数据目录 / 内置默认），支持禁用规则
- 多节点自动展开 + 主从角色识别 + 集群拓扑可视化
- 等保 / PCI / GDPR / SOX 合规对照
- 中文字体（微软雅黑）+ 蓝色主题 + 优先级配色 + 占位符残留自检

---

## 快速上手（3 步）

```bash
# 1. 安装依赖（一次性）
cd scripts && npm install        # 或在根目录跑 bash install.sh

# 2. 准备数据目录：放入 MySQLHealthCheck_<IP>_<时间戳>.txt（每节点一份）

# 3. 生成报告（extract + render 一步到位）
node build.js <数据目录> --project "<项目名>"
```

或分两步：

```bash
node extract.js <数据目录> --project "<项目名>"   # → data.json
node render.js  <数据目录>/data.json              # → <项目名>_MySQL健康巡检报告_v2.0.docx
```

没有 txt？先在 MySQL 主机本地采集：

```bash
collectors/mysqlHealthCheckV3.0.sh --user dbadmin --password 'xxx' \
  --host 127.0.0.1 --port 3306 --output-dir ./reports
```

---

## 依赖

- Node.js ≥ 16
- `docx@^8.5.0`（生成 Word）
- `@resvg/resvg-js@^2.6.2`（SVG 图表转 PNG 嵌入）
- 可选 LibreOffice：导出即带完整目录页码（缺省时在 Word/WPS 右键更新域）

---

## 与其它分支的关系

| 分支 | 形态 | 输出 | 适用 |
|---|---|---|---|
| `ykt` (本分支) | Node CLI | **docx + 10 图表** | 商业交付 / 批量自动化 / 确定性 |
| `skill` | 纯 LLM 驱动 | markdown | 内网无依赖 / LLM 介入分析 |
| `SaaS` | Node + HTTP + Docker | docx | 服务化 / Web UI 上传 |

---

## 文档

- [SKILL.md](SKILL.md) — agent 调用协议
- [USAGE.md](USAGE.md) — 完整人类阅读使用说明
- [CHANGELOG.md](CHANGELOG.md) — 版本变更
- [references/rules.md](references/rules.md) — 42 条规则说明
- [references/parsing.md](references/parsing.md) — txt 段名映射
- [references/visual-spec.md](references/visual-spec.md) — 视觉规范（颜色 / 字体 / 列宽）
