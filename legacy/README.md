# Legacy Code

本目录存放历史版本代码，**仅供考古参考**，不参与当前工具链。

## gen_report.js

v2.0 (2026-04) 版本的 docx 模板。当时是单一巨型脚本，硬编码所有占位符（如 `{IP}`、`{hostname}`），每次生成报告都需要手工编辑脚本填入数据。

v3.0+ 用数据驱动方案彻底替代：

```
collectors/mysqlHealthCheckV3.0.sh
       ↓ (原始 txt)
scripts/extract.js
       ↓ (结构化 data.json)
scripts/render.js
       ↓ (17 章 docx)
```

**不要**修改或调用 `gen_report.js`。如要研究 docx 渲染细节，请阅读 `scripts/render.js`。
