# 视觉规范（render.js 渲染遵循）

仅当用户要求修改样式（颜色 / 字体 / 列宽等）时需要查阅。

## 页面

- 纸张：A4
- 页边距：上下 1440 DXA / 左 1800 DXA / 右 1440 DXA
- 字体：Microsoft YaHei（微软雅黑），正文 11pt
- 表格总宽：8640 DXA（避开 WPS 列宽溢出 bug）

## 颜色（render.js `COLOR` 常量）

| 用途 | 色值 |
|---|---|
| primary（H1 / 表格标题底）| `#1F4E79` |
| secondary（H2 / 表头底）| `#2E75B6` |
| tertiary（H3）| `#2F5496` |
| text（正文）| `#404040` |
| muted（页脚 / 注释）| `#666666` |
| light（页眉灰）| `#888888` |
| shadeRow（正文交替底）| `#EAF3FB` |
| codeBg（代码块底）| `#EBF5FB` |
| codeFg（代码文字）| `#1A5276` |
| p0（紧急行）| `#FFCCCC` |
| p1（重要行）| `#FFE4B5` |
| p2（建议行）| `#FFFACD` |
| p3（观察行）| `#FFFFFF` |

## 标题层级

- H1（章节标题）：32 half-pt 粗体 #1F4E79
- H2（二级）：26 half-pt 粗体 #2E75B6
- H3（三级）：24 half-pt 粗体 #2F5496

## 表格

- 表头行：蓝底白字 `#2E75B6`，`ShadingType.CLEAR`
- 正文行：交替白色 / 浅蓝 `#EAF3FB`
- 边框：灰色单线 `#CCCCCC`
- 列宽：`columnWidths` 显式声明（每个 cell 也带 width 属性，避免 WPS 退化）
- 列宽按 header 关键字加权（详见 render.js `deriveColumnWidths`）

## 页眉 / 页脚

- 页眉：项目名 + IP 列表 + logo + 灰色细线（render.js Header 段）
- 页脚：居中页码「第 X 页」（PageNumber.CURRENT）

## 优先级配色（priorityRow 函数）

| 级别 | 行底色 | 说明 |
|---|---|---|
| P0 | `#FFCCCC` | 紧急，立即处理 |
| P1 | `#FFE4B5` | 重要，本周内处理 |
| P2 | `#FFFACD` | 建议，本月内处理 |
| P3 | `#FFFFFF` | 观察，持续监控 |

## 封面 / 禁用

- 封面：项目名 + 副标题 + 巡检/报告日期 + 拓扑摘要 + 版本号 + 蓝色水平线 + 分页符
- **禁用**所有「撰写人 / ENMO DBA 团队」之类署名
