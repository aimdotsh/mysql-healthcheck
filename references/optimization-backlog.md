# mysql-healthcheck 专业化优化待办

后续优化方向记录，暂不在本轮展开实现。

1. 修复 `npm run build` 参数转发，确保一条命令可完成 extract + render。
2. 同步 `README.md`、`USAGE.md`、`SKILL.md` 的版本、章节数、输出命名和采集流程。
3. 完善采集端分发与版本校验，确保 `collectors/mysqlHealthCheckV3.0.sh` 与解析器契约一致。
4. 将备份、安全合规等严重风险稳定纳入 `issues[]`、第一章汇总和第十七章行动计划。
5. 增加 `data.json` schema 校验、collector 版本识别和渲染前数据完整性诊断。
6. 强化 SQL/表格解析可靠性，优先考虑采集端输出 TSV/JSON，减少管道符和换行导致的错列。
7. 拆分 `extract.js` 与 `render.js`，将解析器、规则、评估、章节渲染分模块维护。
8. 建立脱敏 fixtures 与回归测试，覆盖单节点、主从、V2/V3 格式、渲染烟测。
9. 合规结论增加 `UNKNOWN` 状态，区分“未采集”和“明确未启用”。
10. 清理或归档旧的 `scripts/gen_report.js`，避免维护入口混淆。
