# CHANGELOG

本文件记录 **ykt** 分支（Node 直出 docx 版）的版本变更。

---

## [2.0.0] - 2026-06-02

**首发 ykt 分支：Node 脚本链路直出 docx + 10 张内嵌图表**

从 SaaS 分支抽出纯报告生成流水线，剥离 HTTP 服务端 / Docker / 部署套件，
保留确定性的 Node 链路，专为「商业交付 / 批量自动化 / 确定性输出」场景设计。

- ✅ `extract.js`（解析 + 42 条规则引擎）→ `render.js`（渲染 docx + 图表）两段式
- ✅ `build.js` 一步到位（extract + render 串联）
- ✅ **10 张内嵌图表**（SVG → PNG）：健康度仪表 / 六维雷达 / 问题分布 / 集群拓扑 / 磁盘 / 连接 / Processlist / Buffer Pool / TOP10 大表 / 合规分布
- ✅ 17 章 + 执行摘要 + 自动目录 + 六维度健康度评分
- ✅ 三层规则配置（CLI `--config` > 数据目录 `mysql-healthcheck.config.json` > 内置默认）+ 禁用规则透明披露
- ✅ 主从角色识别 + 集群拓扑可视化 + 多节点自动展开
- ✅ 等保 / PCI / GDPR / SOX 合规对照
- ✅ schema 校验 + 占位符残留自检
- ✅ 默认报告版本号 `2.0`（封面 / 页眉 / 文件名）

**依赖**：Node.js ≥ 16；`docx@^8.5.0`；`@resvg/resvg-js@^2.6.2`。

**与其它分支**：
- `skill` 分支 = 纯 LLM 驱动 + markdown 输出（内网无依赖场景）
- `SaaS` 分支 = Node + HTTP + Docker + Web UI（服务化场景）
- 三分支并存，规则集（42 条）一致，互不影响。
