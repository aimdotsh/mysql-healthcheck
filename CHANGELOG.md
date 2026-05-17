# CHANGELOG

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [4.9.0] - 2026-05-17

**根因关联引擎数据驱动重写**。把 v4.8 之前充满「可能 / 疑似」类弱推断的根因关联，改造为**数据交叉验证**驱动：每条关联引用具体数值（uptime / qps / 磁盘百分比），模糊措辞替换为「已确认 / 已排除 / 需进一步排查」三态。

### 🆕 信号扩展（Phase A）

- **uptime 数值化**：`parseUptimeToSec()` 把 `490 days 7 hours 57 min 15 sec` → 42364635 秒，存为 `n.uptimeSec`。用于区分「冷重启」「长期运行」。
- **日志文件大小精确解析**：
  - `n.slowLogSizeBytes` ← 慢日志 `file size: 3.1G` 段
  - `n.errorLogSizeBytes` ← 错误日志 `file size: 50K` 段
  - `n.binlogDirSizeBytes` / `n.binlogDirPath` ← binlog 目录 `总大小: 52G` 段
- **collector v3.0 → v3.1** 新增 2 个段：
  - `[11] Datadir size`：`du -sh $DATA_DIR`
  - `[11] Relay log directory`：`du -sh $RELAY_LOG_DIR`（与 binlog 同目录时跳过避免重复）
- **`n.diskAttribution`**：按 binlog / slowLog / errorLog / relayLog / ibtmp1 / datadir 排序的容量归因清单（每项含 `bytes` + `pct`），让磁盘高位根因可以**明确**说出「主因是 binlog 占 72%（38 GB）」，而非含糊「可能是 binlog」。

### 🔄 现有 6 条 correlation 全部重写

| 编号 | 旧版（弱推断） | 新版（数据驱动） |
|---|---|---|
| C1 | "可能主因是 binlog" | 用 `diskAttribution` 拆出主因 + 百分比；针对性 SQL（binlog/慢日志/错误日志/ibtmp1 各有专属处置） |
| C2 | "可能丢失最近 1 秒" | 标【已确认】+ 明确 RPO 估算 |
| C3 | "提示业务中存在...触发" | 加慢查询占比 + 「已基本确认」 |
| C4 | "差异通常源于节点重启时间不同" — **猜测** | 用 `uptimeSec` 交叉验证：差 > 7 天 → 【已确认】重启时间不同；qps 差 > 2× → 【已确认】读业务不均衡；都不足 → 【需进一步排查】+ 列出已排除项 |
| C5 | "root@% 风险" | 标【已确认】 |
| C6 | "可能未预热" — **猜测** | 用 `uptimeSec` 区分：< 30 天 → 【已确认】冷启动；> 30 天 → 【已排除冷启动】，归因为「工作集偏小或资源浪费」 |

### 🆕 10 条新增 senior-DBA correlations

- **C7 复制延迟根因拆解** — parallel_workers / 大事务 / 主从 qps 差异，定位为「单线程」「读负载挤占」「binlog 格式不对」其中一种
- **C8 Swap 压力级联** — bp_size / qps / max_connections 三因素同时检查，给出具体处置（下调 bp / vm.swappiness / 扩容）
- **C9 OS + MySQL 双重 EOL 风险** — 同时 EOL 时显式联合告警，给出 1-3 个月迁移路径
- **C10 慢日志膨胀因素** — `log_queries_not_using_indexes=ON` / `long_query_time` 过低 / 真实慢 SQL 多，三种情形分别确认
- **C11 错误日志暴涨** — `errorLogSizeBytes` + `errorLogAnalysis.errorCount` 交叉判断
- **C12 持久化弱 + 高复制延迟 → RPO 量化** — 把丢失数据窗口算成 `主库丢失 1s + 从库延迟 N s` 总秒数
- **C13 从库可写 + 复制延迟 → 数据漂移加剧**
- **C14 自增列耗尽 + 慢查询累积 → 故障窗口临近**
- **C15 节点间 binlog 增长速率差异** — 用 `uptimeSec` 折算每日增量，超过 5× 差异告警

### 📊 实测对比（v3 测试集 4 节点集群）

| 关联点 | v4.8 措辞 | v4.9 措辞 |
|---|---|---|
| 从库 ibtmp1 差异 | "源于节点重启时间不同" | "275 天 vs 967 天 → 【已确认】重启时间不同（差 692 天，足以解释 1467× ibtmp1 差异）" |
| 灾备内存低 | "可能 buffer pool 未预热" | "uptime 275 天 → 【已排除冷启动】足够预热；归因为工作集偏小或资源浪费" |
| 磁盘高位 | "可能 binlog 主因" | "binlog 占 71%（55.8 GB）/ ibtmp1 占 24%（17.4 GB）/ 慢日志 4%（3.1 GB）— 主因明确：binlog" |
| OS + MySQL EOL | （未关联） | "CentOS 6 + MySQL 5.7 双重 EOL，规划 1-3 个月联合迁移" |

### 🧪 验证

- `npm test` 全绿（collector_autodiscovery + report_regression）
- 单节点报告无 correlation（合理 — 多节点关联不适用）
- v3 测试集产出 7 条 correlation，全部带【已确认】或具体数据
- 老版本 collector 采集（缺 Datadir/Relay log 段）自动退化为旧文案，向后兼容

---

## [4.8.0] - 2026-05-17

**重大版本**。两件大事：(A) 规则阈值与开关全面可配置化；(B) 新增 12 条 senior-DBA 经验级参数推荐规则，带「当前值 → 推荐值（基于本机 RAM/CPU/数据量计算）+ 一键 SQL」。

### 🆕 规则配置化（重大）

引入三层 deep-merge 配置体系，按 `内置默认 < 采集目录同名 < CLI --config` 优先级合并：

1. **内置默认** `scripts/config/default-thresholds.json`：含 30+ 阈值，覆盖 disk / memory / innodb（含 bp_too_small/large、bp_hit、HLL、ibtmp1、redo_log）/ session / replication / sql / frag / binlog / max_connections / data_memory / auto_increment 共 11 个分组。
2. **采集目录同名文件**：若数据目录有 `mysql-healthcheck.config.json`，自动 deep-merge（无需 CLI 参数）。适合「客户 A 用一份配置，客户 B 用另一份」交付场景。
3. **CLI `--config <path>`**：最高优先，临时覆盖用。

配套能力：
- **`disabledRules`**：按 type 禁用规则（例：`["sql_mode_missing_strict", "wait_timeout_too_long"]`）；`push()` 已统一接管。
- **`priorities`**：覆盖单条规则优先级（例：`{"wildcard_medium": "P3"}` 把中危降为观察）。
- **样本配置**：`scripts/config/samples/strict.json`（金融/合规客户阈值收紧）、`lenient.json`（POC/内部宽松 + 禁用合规向规则）。
- **`data.json` 透出**：合并后的 `hcConfig` + `disabledRulesApplied` 写入 data.json，render.js 与外部审计可读。

**迁移现有 17 处硬编码阈值**：mem_high / disk_critical / disk_high / innodb_hll_warn / hll_p1 / long_running_seconds_p2 / repl_delay_high / repl_delay_low / heavy_frag (rate + min_mb) / slow_query_abs_high / slow_query_abs_med / long_query_time_loose / ibtmp1_max_gb / bp_hit_low_pct / bp_hit_warn_pct / expire_logs_max_days / parallel_workers_data_gb_p1 / _p2 → 全部读 `cfg.thresholds.X.Y`，默认值保持原状（零回归 — `npm test` 全绿）。

### 🆕 12 条 senior-DBA 参数推荐规则

每条都计算「基于本机 RAM/CPU/数据量的推荐值」+ 携带新字段 `currentValue` / `recommendedValue` / `dimension`，render 端会以彩色「✦ 当前值 → 推荐值」对照行展示。

| # | type | dimension | priority | 触发条件（精简） |
|---|---|---|---|---|
| 1 | `bp_too_small` | performance | P1/P2 | innodb_buffer_pool 占 RAM < 40%（用户的示例规则） |
| 2 | `bp_too_large` | availability | P1 | innodb_buffer_pool 占 RAM > 80%（OOM 风险） |
| 3 | `redo_log_too_small` | performance | P1/P2 | innodb_log_file_size < 512MB 且数据量大 |
| 4 | `flush_method_not_o_direct` | performance | P2 | Linux 上 flush_method ≠ O_DIRECT |
| 5 | `doublewrite_off` | durability | P1 | innodb_doublewrite=OFF（数据丢失风险） |
| 6 | `charset_not_utf8mb4` | dataDesign | P2 | character_set_server 非 utf8mb4 |
| 7 | `sql_mode_missing_strict` | dataDesign | P2 | sql_mode 缺 STRICT_TRANS_TABLES |
| 8 | `auth_plugin_native_on_80` | security | P2 | 8.0+ 仍用 mysql_native_password |
| 9 | `performance_schema_off` | operations | P2 | performance_schema = OFF |
| 10 | `max_connections_vs_memory` | availability | P1/P2 | max_conn × 单连接峰值 > 30% RAM |
| 11 | `slave_skip_errors_set` | durability | **P0** | slave_skip_errors 非空（数据漂移） |
| 12 | `auto_increment_exhausting` | dataDesign | P0/P1/P2 | 自增列 rate ≥ 0.7（rate ≥ 0.9 升 P0） |

**用户示例验证**：`innodb_buffer_pool_size = 1 GB` on RAM 16 GB → 触发 P2 `bp_too_small` → currentValue=`1024 MB（占 RAM 16 GB 的 6%）` → recommendedValue=`9.6 GB（~60% RAM，保留 OS/连接/临时表余量）` → sql=`SET GLOBAL innodb_buffer_pool_size = 10307921920; -- my.cnf: ...`

### 🎨 渲染增强

- `chapterConclusion` 16.2 行动计划：每条 issue 的 `i.action` 后插入彩色对照行「✦ 当前值：X → 推荐值：Y」，仅当 issue 同时携带 `currentValue` + `recommendedValue` 时显示（现有规则不带，行为不变）。
- `computeHealthScore` 优先使用 `issue.dimension`，旧规则回退到 type 正则映射（零行为变化）。

### 🧪 验证

- `npm test`（collector_autodiscovery + report_regression）全绿，默认配置等效旧硬编码。
- 8 个真实节点样本中，新规则共触发 16 次（bp_too_small × 5, max_connections_vs_memory × 8, flush_method_not_o_direct × 7, redo_log_too_small × 1, data_to_memory_ratio_high × 1）。
- 用 strict 配置（disk 70/60, long_query 2, expire_logs 7）触发规则数从 ~10 涨到 50+，证明配置覆盖链路完全打通。

### 📋 v4.9 backlog

- 剩余 10 条 senior-DBA 规则：bp_instances_mismatch / tmp_table_size_mismatch / flush_log_at_trx_commit=2 / io_capacity_default / skip_name_resolve_off / wait_timeout_too_long / password_lifetime_missing
- OS 层规则（swappiness / THP / NUMA），需要扩展采集脚本
- 配置 schema 校验 + `--validate-config <path>` CLI

---

## [4.7.2] - 2026-05-17

**报告聚焦补丁**。基于 v4.7.1 实际查阅反馈，做两处「降噪」调整：

### 🐛 修复 / 调整

- **#1 排除 event_scheduler 等 MySQL 内部守护线程**：v4.7.1 报告里出现「存在长时间运行会话：event_scheduler@localhost 13164257s（状态 Waiting on empty queue）」之类条目 — event_scheduler 的 Time 字段会等于 MySQL 进程 Uptime（典型几千万秒），但属于正常空闲守护，不是业务长事务。`businessLongSessions` 新增 `isInternalDaemon` 过滤：user = `event_scheduler` 或含 "event scheduler" 字样 / state = "Waiting on empty queue" / "Waiting for next activation"。

- **#2 移除第十六章「安全合规审计」**：用户反馈合规检查整章（PASS/WARN/FAIL/UNKNOWN 检查项、合规等级、等保 2.0 / PCI DSS / GDPR / SOX 框架对照、TLS 加密细节、整改建议优先级等）属于咨询性 / 框架对照内容，不是日常巡检关注点。本期一并去除：
  - render.js：移除 `chapterSecurityCompliance(data)` 调用（保留函数代码以便日后还原）；移除关键事实表「合规等级」行；章节号「十七、巡检总结与行动计划」→「十六、」（含 17.1/17.2/17.3 → 16.1/16.2/16.3）；摘要页提示「17 章详细分析」→「16 章详细分析」。
  - extract.js：`promoteAssessmentIssues` 中停止把 `compliance_fail_*` 提升到 `issues[]`，避免第一章问题汇总 / 第十六章行动计划出现「合规失败：未启用 audit log」等条目。原代码以 `/* */` 注释保留，方便日后还原。
  - **真正的安全风险（root@%、弱口令、复制账号 wildcard 等）依然由 `wildcard_critical` / `wildcard_high` / `wildcard_medium` 规则独立捕获，不会因此遗漏**。
  - 回归测试 `tests/report_regression_test.js` 同步：旧断言「audit compliance issue should be promoted into issues」改为「`compliance_fail_*` 不应出现在 issues」。

### 📊 v4.7.1 → v4.7.2 关键差异

| 指标 | v4.7.1 | v4.7.2 |
|---|---|---|
| event_scheduler 长会话告警 | 报 P2 噪声 | **过滤** |
| 第十六章「安全合规审计」 | 完整渲染（合规等级 / 框架对照） | **整章移除** |
| 单节点报告体积 | ~158 KB | **~146 KB（-12 KB）** |
| 第一章问题汇总中合规失败 issue | 出现 | **不再出现** |
| 章节总数 | 17 | **16** |

### 🧪 回归测试

- `npm test`（collector_autodiscovery + report_regression）全绿。
- 多节点 v3 测试集无回归，新断言「compliance_fail_* 不应出现」通过。

---

## [4.7.1] - 2026-05-16

**单节点报告语义打磨补丁**。基于 v4.7 单节点实际查阅反馈，第五章与第十一章仍残留 3 处多节点假设的措辞 / 建议。

### 🐛 修复

- **#1 第五章 5.1 核心参数表**：单节点下不再说「MySQL 版本 → 主从一致」/「server_id → 各节点唯一」/「read_only → 主 0/从 1」。基于 `data.cluster.nodeCount === 1` 判定，自适应改为「-」/「本节点唯一标识」/「主库建议 0（除非只读主场景）」。多节点保持原文案。

- **#2 第五章 5.2 参数差异分析**：单节点时之前显示「各节点核心参数完全一致」，逻辑上矛盾（无节点可对比）。改为「本次仅采集单节点，不涉及节点间参数差异分析。如该实例属于主从集群，建议补充采集从库 txt 后重新出报告，以校验主从参数一致性。」多节点路径不变。

- **#3 第十一章 11.2 host=% 用户分级**：之前每个 host=% 用户独立 1 行（典型节点 7-9 行）。改为按 (level, reason) 聚合，同等级 + 同类型多用户合并为 1 行，列出全部用户名 + 数量。单用户直接展示；多用户：「user_a、user_b、...（共 N 个）」。标题改为「N 个用户、M 类，按危险等级排序」。高危/致命警示行仍单独列出具体用户名（便于定位修复）。

- **#4 第十一章 11.3 安全建议**：之前无条件输出「立即清理 host=% 的 root / 管理员账号：`DROP USER 'root'@'%'`」即使节点没有 root@%。改为按实际情况条件渲染：
  - 仅当存在 root/admin/dba/super @% 才提 DROP 建议（含实际用户名）
  - 仅当存在 repl @% 才提复制账号收紧
  - 仅当存在 backup/dump @% 才提备份账号收紧
  - 仅当节点是 MySQL 5.7 才提 caching_sha2_password 迁移
  - 通用建议（password_lifetime / 定期审计）保留
  - 完全无 host=% 用户时给正面反馈「账号策略整体合规」

### 🧪 验证

- 实测样本 8 节点：5.1 表的「主从」措辞已消失；5.2 改为单节点说明；11.2 各节点表格行数下降到 3-4 行；11.3 不再出现误导的 DROP root@%。
- 回归测试 `npm test` 全绿，多节点回归集（含 DR）无回归。

---

## [4.7.0] - 2026-05-16

**自动填充 TOC（导出即带完整目录）**。v4.6.1 通过剥离 fldChar dirty 消除了 Word 打开时的弹窗，代价是 TOC 首次打开为空，用户需手动右键 → 更新域。v4.7 在导出阶段调用本机 LibreOffice headless 自动刷新 TOC，让用户**打开 docx 立即看到含真实页码 + 超链接的完整目录**。如本机无 LibreOffice，自动降级回 v4.6.1 行为（TOC 空 + 无弹窗）。

### 🆕 新功能

- **`detectLibreOffice()`**：按优先级检测本机 LibreOffice 二进制路径
  - macOS GUI: `/Applications/LibreOffice.app/Contents/MacOS/soffice`
  - Apple Silicon Homebrew: `/opt/homebrew/bin/soffice`
  - Linux: `/usr/bin/soffice` / `/usr/local/bin/soffice` / `/opt/libreoffice/program/soffice`
  - 兜底：`which soffice`
  - 环境变量覆盖：`SOFFICE` 或 `LIBREOFFICE`
- **`refreshFieldsViaLibreOffice()`**：调用 `soffice --headless --convert-to docx` 让 LO 加载 docx → 检测到 `<w:updateFields/>` 后刷新 TOC（生成真实页码 + 内嵌 hyperlink）→ 保存。带 30 秒超时 + 用户配置隔离（`-env:UserInstallation`）。
- **`verifyTocPopulated()`**：刷新后验证 fldChar 不再含 `dirty="true"` 且 SDT 内含 `<w:hyperlink w:anchor>` 或 `PAGEREF`，避免静默失败。
- **CLI 新增**：
  - `--no-toc-refresh`：强制跳过 LibreOffice 刷新，等同 v4.6.1 行为
  - `--soffice <path>`：手动指定 LibreOffice 二进制路径（也支持 `SOFFICE` / `LIBREOFFICE` 环境变量）

### 📋 降级行为矩阵

| 用户机器 | --no-toc-refresh | 结果 |
|---|---|---|
| 装了 LibreOffice | 否 | ✓ TOC 含真实页码 + 超链接，打开无弹窗 |
| 装了 LibreOffice | 是 | ⊘ TOC 空，stripDirtyFields 清除 dirty，无弹窗 |
| 未装 LibreOffice | - | ⓘ 同 stripDirtyFields 行为，TOC 空但无弹窗，提示安装方法 |
| LibreOffice 调用失败/超时/路径无效 | - | ⚠ 自动回退到 stripDirtyFields，告知用户失败原因 |

**核心保证**：无论何种情况，**docx 文件总能正常生成且 Word 打开时不弹窗**。LibreOffice 仅作为锦上添花的页码生成器。

### 📦 安装 LibreOffice（可选）

- macOS：`brew install --cask libreoffice`
- Ubuntu/Debian：`sudo apt install libreoffice`
- 首次打开 LO 时 macOS 可能弹「来自互联网的应用」确认，在系统设置中允许即可

### 🎨 目录页提示文案

调整为同时覆盖两种场景：「本目录在导出时已自动刷新（如检测到 LibreOffice）。若 TOC 仍显示为空，请在目录上右键 → 更新域 → 更新整个目录。」

### 🧪 验证

- 未装 LibreOffice 环境：8 个样本报告全部正常生成，TOC 空但无弹窗，控制台打印明确提示 + 安装建议
- 装了 LibreOffice 后：TOC 应含完整章节 + 子节 + 真实页码 + 可点击超链接
- 失败兼容：传 `--soffice /nonexistent/path` 模拟失败 → 自动降级 + 打印警告
- 回归测试 `npm test` 全绿

---

## [4.6.1] - 2026-05-16

**v4.6 Word 弹窗修复打补丁**。v4.6 通过 `features.updateFields=true` 期望 Word 静默更新 TOC，但实测在部分 Word/WPS 版本下仍然弹出「This document contains fields that may refer to other files. Do you want to update the fields?」。

### 🐛 修复

- **真正可靠地消除 Word/WPS 弹窗**：从根上剥离 fldChar 的 `w:dirty="true"` 属性。流程：
  1. `Packer.toBuffer(doc)` 得到 docx buffer
  2. 用 `JSZip` 解压 buffer
  3. 用正则把 `word/document.xml` 里 fldChar 上的 `w:dirty="true"` 全部剥离
  4. 重新打包成 buffer 写盘
- 同时移除 v4.6 的 `features.updateFields=true`（实测会触发弹窗，不是抑制）
- TOC 内容打开后默认为空，用户首次需在目录上右键 → 更新域 → 更新整个目录。原有的提示段落已经引导。

### 验证

- `unzip -p ... word/document.xml | grep w:dirty` 返回 0 处 → 字段无 dirty 标识，Word 不再询问。
- 回归测试 + 8 个单节点样本重生成全部正确。

---

## [4.6.0] - 2026-05-16

**报告体验打磨轮次**。基于 v4.5 单节点报告的用户实际查阅反馈，修复 4 个体验问题，并对单节点场景文案做整体打磨。

### 🐛 必修

- **#1 Word 打开「是否更新字段」提示**：docx 库的 `TableOfContents` 硬编码 `fldChar dirty=true`，导致 Word/WPS 打开报告时弹出「This document contains fields that may refer to other files. Do you want to update the fields?」干扰阅读体验。修复：`new Document({ features: { updateFields: true } })` → settings.xml 注入 `<w:updateFields/>`，Word 静默更新 TOC 不再询问。
- **#2 host=% 同类账号告警刷屏**：之前每个 host=% 用户独立产生一条 issue（如多个业务账号都开放了 host=%），单个节点最多看到 8 条相同建议的 wildcard_medium，挤占报告关键信息。聚合为每 (node, level) 一条 issue：
  - 1 个：「存在 host=% 的业务用户：user_a（...）」
  - N 个：「存在 host=% 的业务用户 N 个：user_a、user_b、...（...）」
  - 同步在 issue 上新增 `affectedUsers[]` 字段；`sql` 字段对每个用户分别给出 DROP / CREATE / GRANT 示例，用 `-- ----` 分隔。
- **#3 拓扑图文字压压节点框**：v4.5 单节点拓扑 H=180 时，副标题与节点框间距只有 9px，红色 self-ref 警告与副标题间距过小，视觉上文字"压"在节点框边缘。改为从上到下的固定锚点布局（title y=24 / box cy=80 / subtitle y=130 / warn y=158），不带警告 H=160，带警告 H=190。

### 🎨 单节点场景文案打磨

- 关键事实表：「集群拓扑 / 集群 IP」→「采集范围 / 节点 IP」
- 第一章摘要：「生产环境 MySQL 集群」→「生产环境 MySQL 实例」
- 第一章「集群级问题 N 项 / 节点级问题 M 项」→ 单节点跳过，问题表标题改为 1.1 问题汇总
- 第十二章 12.1：「集群采用 单节点」→「本次仅采集单节点，无主从复制配置」
- 第十二章 12.4：「复制配置整体合理」→ 单节点时「无主从复制可分析，如属主从集群建议补充采集从库 txt」
- 12.4 replIssueTypes 加入 self_ref_slave_residue → 残留清理建议自动并入

### 📊 v4.5 → v4.6 关键差异（实测样本）

| 项 | v4.5 | v4.6 |
|---|---|---|
| Word 打开弹窗 | 「是否更新字段」 | **静默更新 TOC，无弹窗** |
| host=% 业务用户告警 | 最多 8 条 wildcard_medium | **1 条聚合 P2，列出 N 个用户** |
| 拓扑图副标题间距 | 9px（贴边） | **24px 呼吸空间** |
| 关键事实表用词 | "集群拓扑 / 集群 IP" | **"采集范围 / 节点 IP"** |
| 第一章问题分类 | 强行分集群级/节点级 | **单节点合并为 1.1 问题汇总** |

### 🧪 回归测试

- 多节点回归（含 DR）+ collector autodiscovery 全绿
- 8 个单节点样本重生成报告：100% 主库识别正确、host=% 聚合生效、TOC 静默更新

---

## [4.5.0] - 2026-05-15

**单节点 / 仅主库采集场景适配轮次**。基于某项目 8 套独立主库（每库一个 .txt）的真实数据反馈，发现并修复 3 类严重的角色误判，并让"仅采集主库"场景下的报告体验合理化。

### 🐛 角色识别修复

- **self-referencing slave 残留 → primary**：v4.4 仍把 `SHOW SLAVE STATUS` 的 `Master_Host` 指向本机自身的节点误判为「从库」。这是历史从库被提升为主后未执行 `RESET SLAVE ALL` 留下的元数据残留。新增 `refineSelfReferencingSlave()`：识别 Master_Host == 本机 IP / hostname / localhost / 127.0.0.1，把 `isSlave` 置回 false，并保留 `selfReferencingSlaveResidue` 元数据。
- **standalone primary 兑底**：v4.4 把 `read_only=0 + log_bin 启用 + 无 binlog dump 线程` 的独立主库标为 `unknown`。新增 `inferStandalonePrimary()`：
  - `standalone_rw`: read_only=0/OFF + 无远端 master → primary
  - `standalone_readonly`: read_only=1/ON + log_bin 启用 → primary + `needsConfirmation`（典型场景：监控后端库 / 报表只读库 / 备机配置）
  - 单节点采集兜底：`nodes.length=1` 且仍为 unknown → 强制 primary + `needsConfirmation`
- **强信号优先**：`normalizeNodeRoles` 循环顶部新增 `inferPrimaryFromConnections` 强信号判定 — 只要有 Binlog Dump 线程 / connected slaves / slaveIps，即使存在 self-loop slave 残留也直接标 primary。

### 📋 新增 issue & 调级

- **新增 P2 issue `self_ref_slave_residue`**：引导 DBA 用 `STOP SLAVE; RESET SLAVE ALL;` 清理残留复制元数据，避免误导监控/巡检工具。
- **`master_readonly` 智能调级**：`source=standalone_readonly` 时降级为 P3 + `needsConfirmation`，避免监控后端 / 报表只读库被误报 P1；常规主库 read_only=1 仍是 P1。

### 🎨 单节点场景渲染优化

- **chapter 2.1**：单节点时标题从「集群拓扑」→「节点拓扑」；描述措辞调整；`needsConfirmation` 节点角色加 🔍 标识 + 推断来源说明（如「节点 X（主库）：只读主库（read_only=1 + log_bin 启用）」）。
- **chapter 12**：
  - 单节点顶部加显式提示，说明「如该集群实际配置了主从复制，建议补充采集从库 txt 后重新出报告」。
  - self-ref slave 残留：12.2 改为「SHOW SLAVE STATUS 残留详情」表，列出节点 IP / 残留 Master_Host / IO/SQL 线程状态 / 清理 SQL，替代原本误导的"从库复制状态"空表。
  - 仅当存在真从库时才渲染 12.2 从库状态表。
- **拓扑图 (`charts.topology`)**：单节点 → 居中单节点框 + 副标题「单节点 · 未配置主从复制（或仅采集到主库）」；存在 self-ref 残留时图上加红色警告；多节点时每个非主库节点按真实角色（dr/slave/未知）配色与标签（之前 DR 节点会被画成"从库"色）。

### 📊 v4.4 → v4.5 关键差异（实测样本 8 节点）

| 指标 | v4.4 | v4.5 |
|---|---|---|
| 角色识别 | 3 误判从库 + 2 unknown + 3 ok | **8/8 主库正确** |
| 单节点 chapter 12 | 空"从库复制状态"表 | **「单节点 / 残留清理 SQL」指引** |
| 拓扑图（单节点） | 左主右"未识别从库"占位 | **居中单节点 + 简洁副标题** |
| 只读主（监控库典型场景） | 报 P1 master_readonly | **P3 + 推断说明 + 🔍 确认** |
| self-ref 残留指引 | 无 | **新增 P2 issue + RESET SLAVE ALL SQL** |

### 🧪 回归测试

- `tests/report_regression_test.js` + `tests/collector_autodiscovery_test.sh` 全绿。
- 多节点回归集（含 DR 节点）依旧正确：dr 标签、灾备角色、复制拓扑图、issue 链路无回归。

---

## [4.4.0] - 2026-05-15

**v4.3 报告评审反馈轮次**。基于真实 4 节点 2.2TB 集群的 v4.3 巡检报告评审，针对 17 项问题落地 9 项核心修复。

### 🐛 必修级 bug 修复

- **#9 parseBackupDirs flushCurrent — 恢复 93GB 备份数据**：v4.3 在测试集中错误地报告 172.16.7.4 节点「未发现备份产物」，实际该节点 /data/backup 下存有 93GB 真实备份（tbl_order_detail_20240729.sql 48GB + tbl_order_20240724.sql 13GB + tbl_topup_20240718.sql 36GB）。根因是解析逻辑遇到 `[--] /path 不存在` 行时直接覆盖正在累积的 `current` 指针。修复：引入 `flushCurrent()` 闭包，遇到 header / "不存在" 行时先 push 已累积条目再开启新条目。同时把 `exists:true/false` 字段显式化。
- **#2 DR 角色端到端识别**：v4.3 第二章 / 12.2 仍把灾备节点显示为「从库」，与第一章节点级问题 #6 的「灾备节点 dr-mysql」描述自相矛盾。根因是 `normalizeNodeRoles` 的 `isSlave=true` 分支会无条件覆盖 `node.role = 'slave'`，吞掉 `canonicalRole` 已识别的 `dr`。修复：循环顶部优先识别 `isDrNode` → role='dr'，primary 循环保留 dr 角色；render.js + extract.js 的 `roleLabel` 同步增加 `dr → 灾备` 映射。

### 🧹 噪声治理

- **#4 isTempOrHistoryTable 大幅扩展**：v4.3 报告 7.4 把 `dd / pp / pp1 / t_year / t_year_month / t_month / calendar / t_bit / t_orderid_tmp` 等都标为「业务表」误导客户。扩展规则识别：极短表名（≤3 字符 + 数字后缀）、日期/时间字典表（t_year / t_month / calendar）、临时表中缀（_temp_ / _tmp_ / _test_）、_bak/_backup/_old 含数字后缀、_copy/_new/_old 副本、test 表。实测 v3 数据集 30 张 noPK 表分类从「业务 10+, 临时 18」→「业务 5, 临时 23」。
- **#5/#17 SQL 治理过滤元数据查询**：v4.3 14.4 / 14.5 前几位被 `SELECT NOW(), SYSTEM_USER()` / `SELECT SPECIFIC_NAME FROM INFORMATION_SCHEMA...` / `SHOW PLUGINS` / `SHOW FULL FIELDS FROM ...` 占据，这些是客户端 / Navicat / 监控工具的元数据探测查询，挤占了业务慢 SQL 的位置。新增 `isMetadataQuery()` 函数，过滤 SHOW / DESC / EXPLAIN / information_schema / performance_schema / SET / COMMIT 等 5 类元数据查询，应用到 5 个 TOP SQL 段（topSqlByLatency / topSqlByExec / topSqlByAvg / sqlNoGoodIndex / sqlWithTmp）。

### 📋 内容准确性

- **#6 12.4 复制建议改为引用 issues**：v4.3 第一章 issue 说「slave_parallel_workers=0 建议设为 8-16」，第十二章 12.4 手写文案说「4-8」，数字冲突违反单一真相源原则。删除手写文案，改为从 `data.issues[]` 筛选复制类 issue（gtid_off / slave_parallel_workers_zero / sync_binlog_weak / repl_delay_high/low / repl_thread_down / replica_io_running_no / replica_sql_running_no）逐条展示 description+action。未来调整 8-16 之类的数字只需改 deriveIssues 一处。

### 💡 缺失分析补强

- **#12 第七章可释放空间汇总**：v4.3 7.2（历史归档表 GB）+ 7.3（高碎片表 GB）分别给出可释放空间但未汇总。新增彩色 callout：「本次巡检识别可释放空间合计约 X GB（碎片 Y GB + 归档 Z GB），相当于主库当前数据量的 N%」+ 清理优先级建议。

### 🎨 视觉表达

- **#14 7.4 无主键表 TOP 10 + 折叠**：v4.3 一次性列出 30+ 张混合表（业务/临时/字典）。改为业务表按行数排序仅展开 TOP 10，业务表 >10 张时提示「另有 N 张见 data.json」；历史/归档表 + 临时/测试表折叠为单行计数，仅显示前 5 个示例。
- **#15 16.5 合规框架对照加「关键缺失项」列**：v4.3 只显示 等保 ❌ / PCI ⚠️ / GDPR ❌ / SOX ⚠️，未说明缺什么。新增「关键缺失项」列，从 16.2 检查项的 PASS/FAIL 自动汇总：等保 2.0 → 密码强度策略、审计日志；PCI DSS → at-rest 加密、TLS/SSL、审计日志；GDPR → 审计日志。

### 🧪 回归测试

- 同步更新 `tests/report_regression_test.js`：
  - 172.16.128.101 角色断言从 `slave` → `dr`
  - 节点标签断言从 `（从库）` → `（灾备）`
  - backupAssessment 断言从「未发现备份产物 P2」 → 「最近备份已 X 天前 P0」（使用 startsWith 兼容日期相对性）
  - hintPaths 使用 Set.has 兼容路径合并语义变化

### 📊 v4.3 → v4.4 关键差异

| 指标 | v4.3 | v4.4 |
|---|---|---|
| 备份产物识别 | 漏报 93GB | **正确识别 P0 备份过旧** |
| 灾备节点显示 | 「从库」（误导） | **「灾备」** |
| noPK 业务表数 | 30+（含字典/临时） | **5 张真实业务表** |
| TOP SQL 元数据噪声 | 前几位被占 | **过滤 5 类元数据查询** |
| 12.4 复制建议数字 | 4-8 vs 8-16 冲突 | **统一引用 issues** |
| 合规框架对照 | 仅 ❌/⚠️ 状态 | **附「关键缺失项」列** |

### 📋 Backlog → v5.0

- #7 合规框架可配置（PCI/等保升级 FAIL）
- #8 行动计划按业务影响二次排序
- #10 DR buffer pool 错配关联规则
- #11 容量趋势 / 增长预估（基于 binlog 时间差）
- #13 业务/SLA 视角执行摘要
- #16 上次巡检对比机制（`--compare previous_data.json`）

---

## [4.3.0] - 2026-05-15

**专家评审反馈轮次**。回应一位资深 DBA 对 v4.2 报告的 11 条质量反馈，10 项已落地。

### 🆕 新增规则

- **#11 MySQL 版本 EOL 告警**：5.7 触发 P1，含升级路径 SQL hint
- **#1 `slave_parallel_workers=0` 大集群告警**：≥500 GB → P1，100-500 GB → P2
- **#10 ghost 表识别**：识别 gh-ost / pt-osc 残留，≥1 GB 单独 P2，加 `needsConfirmation`

### 🐛 修复 / 改进

- **#6 root@% 双触发去重**：合并 `wildcard_critical` + `compliance_fail_no_wildcard_root` → 单条 P0 含 `dualTrigger` ⚡
- **#5 DR 灾备节点识别**：新增 `dr` 角色；DR `read_only=0` 从 P1 → P3 + `needsConfirmation`
- **#7 无主键表过滤**：`isTempOrHistoryTable()` 识别 `tmp_/temp_/_bak/_20YYMMDD`，55 张 → 28 张业务表
- **#8 TLS 弱协议 PASS → WARN**：检测 `tls_version` 含 TLSv1/1.1，提示 NIST 已废弃
- **#2 `open_files_limit` 修正**：优先级 mysqld /proc/PID/limits > SHOW VARIABLES > OS ulimit
- **#3 `expire_logs_days` 智能解读**：从库 ≥ 主库且差距 ≤30 天 → ✓ 合理 PITR

### 🎨 渲染

- **#13 needsConfirmation**：描述前加 🔍 `[需人工确认]`
- **#6 dualTrigger**：级别后加 ⚡ 标识
- **图表更新**：新增 MySQL 拓扑图、连接使用率图、Processlist 分布图；当前报告最多包含 10 张嵌入图表

### 📋 Backlog

- #4 HLL 联合告警（易误报）
- #9 备份注释 cron 解析（边界复杂）

### 📊 v4.2 → v4.3 关键差异

| 指标 | v4.2 | v4.3 |
|---|---|---|
| P0 项 | 2 | **1**（去重）|
| 无主键表描述 | "最多 55 张" | **"业务表 28 张（27 临时表过滤）"** |
| TLS（含 TLSv1） | PASS | **WARN** |
| EOL/parallel/ghost 新规则 | 0 | **3 项新 issue** |

---

## [4.2.0] - 2026-05-14

**专业化加固轮次**，主要应对 Codex 代码评审给出的反馈。

### 🆕 新增

- **采集脚本 auto-detect mysql runtime**（`collectors/mysqlHealthCheckV3.0.sh`）
  - 从 `ps -ef` 自动解析 `mysqld --defaults-file/--basedir/--socket/--port`
  - 自动读取 my.cnf `[client]` 段的 user/password
  - 优先使用 `basedir/bin/mysql` 客户端
  - 用 `--defaults-extra-file` 临时文件传密码（密码不再出现在 ps 输出）
  - 新增 `--test-login`、`--socket`、`--defaults-file`、`--ssl-mode` 参数
  - 登录失败直接 exit 1，避免生成无效报告
- **回归测试**：新增 `tests/collector_autodiscovery_test.sh`
- **优化 backlog**：`references/optimization-backlog.md` 列出 10 项后续优化方向
- **AGENTS.md**：给 AI 智能体的开发规范
- **`npm run build`**：封装 extract + render 两步流程，支持参数透传

### 🐛 修复 / 改进（响应 Codex 代码评审）

- **Codex #1**：`npm run build` 改为 `node build.js`，解决参数无法传给两端的问题
- **Codex #2**：USAGE.md 从 v4.0 / 13 章过期描述升级到 v4.2 / 17 章
- **Codex #4**：`assessBackup()` / `assessSecurity()` 严重风险自动注入 `issues[]`
  - 备份缺失 → P0 进第一章问题汇总和第十七章行动计划
  - `root@%` / 空密码 → P0；其它合规 FAIL → P1
  - 实测 4 节点集群：issues 27 → 29，P0 1 → 3
- **Codex #9**：安全合规结论新增 `UNKNOWN` 状态
  - 区分「未采集」与「采集了但未启用」
  - `complianceLevel` 排除 UNKNOWN，UNKNOWN >50% 时输出「数据不足」
- **Codex #10**：归档 `scripts/gen_report.js` → `legacy/gen_report.js`

### 📋 后续待办（详见 `references/optimization-backlog.md`）

- Codex #5：schema 校验 + collector 版本识别
- Codex #6：解析器升级（collector 改 TSV/JSON 输出）
- Codex #7：拆分超大脚本到 lib/parser、lib/rules 等模块
- Codex #8：补足 fixtures 与回归测试

---

## [4.1.0] - 2026-05-14

**重命名与版本号解耦**。

### ⚠️ 重命名（Breaking）

| 项 | 旧 | 新 |
|---|---|---|
| skill 名称 | `mysql-inspection-report` | `mysql-healthcheck` |
| GitHub 仓库 / 发行包 | `mysql-inspection-report` | `mysql-healthcheck` |
| 安装目录 | `~/.workbuddy/skills/mysql-inspection-report/` | `~/.workbuddy/skills/mysql-healthcheck/` |
| Claude Code skill | `~/.claude/skills/mysql-inspection-report/` | `~/.claude/skills/mysql-healthcheck/` |
| package.json name | `mysql-inspection-report-detailed` | `mysql-healthcheck` |

新名字与采集脚本 `mysqlHealthCheckV3.0.sh` 命名一脉相承，整个工具链统一。

### 🆕 报告版本与工具版本解耦

之前 docx 封面和文件名沿用 skill 版本号（v4.0），容易混淆「工具版本」与「报告版本」。从 v4.1 起：

- **报告版本**（写在 docx 文件名和封面）默认 `v1.0`，每次给客户递交一份就是 v1.0；如果同一份报告反复修订，可改为 v1.1 / v1.2
- **工具版本**（v4.1）仅写在 docx 元数据（`creator` 字段）和 README/CHANGELOG
- `extract.js` 新增 `--report-version` 参数；`data.json` 新增 `reportVersion` 字段

### 🎨 docx 文案调整

- 封面主标题：「MySQL 数据库巡检报告（详细版）」→ **「MySQL 数据库健康巡检报告」**
- 文件名：`<项目>_MySQL数据库巡检报告_详细版_v4.0.docx` → **`<项目>_MySQL健康巡检报告_v1.0.docx`**
- 封面版本行：`版本：v4.0` → **`报告版本：v<reportVersion>`**

### 🐛 修复

- 清理所有「8 章精简版」相关描述，仅保留单一主线（v4.1）

---

## [4.0.0] - 2026-05-13

**商业可交付级**升级。结构从 13 章扩展到 **17 章**，增加图表、目录、执行摘要、健康度评分等高级 DBA 报告必备元素。

### 🆕 新增章节

- **执行摘要页**（面向管理层一页式摘要）：6 维度健康度评分 + 关键事实速览
- **目录页（TOC）**：自动生成可点击目录
- **十三、Schema 设计审计**：未使用索引 / 冗余索引 / 大字段分布 / 分区表 / 自增列使用率 / 存储过程清单（这些数据原本已采集但 v3.x 未渲染）
- **十四、SQL 性能治理**：TOP 20 慢 SQL（performance_schema.events_statements_summary_by_digest）+ 慢日志样本 + 全表扫描 SQL + 临时表 SQL
- **十五、备份与恢复评估**：备份工具检测 / cron 调度 / 备份产物 / RTO·RPO 推算
- **十六、安全合规审计**：9 项自动检查 + 等保 2.0 / PCI DSS / GDPR / SOX 框架对照
- **十七、巡检总结与行动计划**：原十三章重命名

### 🎨 新增图表（替代纯文字 / 表格）

- 健康度仪表（圆环式 Gauge）
- 6 维度雷达图（可用性 / 安全性 / 性能 / 数据规范 / 持久化 / 运维）
- 问题优先级分布饼图
- 磁盘使用率横向柱状图
- Buffer Pool 命中率纵向柱状图
- TOP 10 大表横向柱状图（含归档表着色）
- 安全合规结果饼图

### 🔧 内部架构

- `scripts/lib/charts.js` —— 纯 SVG 图表生成器（gauge / pie / hbar / vbar / radar；v4.3 增加 topology）
- `@resvg/resvg-js` —— SVG → PNG 转换（预编译二进制，跨平台无需 native 编译）
- `extract.js` 新增字段：`healthScore`（六维度评分）/ `backupAssessment` / `securityAssessment` / `topSqlByLatency` / `unusedIndexes` / `redundantIndexes` / `autoIncrementUsage` / `slowLogAnalysis` / `errorLogAnalysis` 等

### 📥 采集脚本升级（V3.0）

新增 `collectors/mysqlHealthCheckV3.0.sh`（替代旧的 V2.0 + html SQL）：

- **单脚本，单 txt 输出**（不再生成 html，统一格式便于解析）
- 段名规范：`----->>>---->>>  [NN] 段名`（13 个模块）
- 支持命令行参数 + 非交互式批量运行
- **新增采集**：
  - 慢日志 tail（默认 5000 行）
  - 错误日志 tail（默认 1000 行）
  - TOP 20 SQL by latency / exec count / avg latency
  - 备份工具检测 / crontab 扫描 / 备份目录扫描
  - TLS / SSL 配置与状态
  - InnoDB 加密状态
  - 审计插件状态
  - 密码策略
  - 失败登录次数
  - CPU 型号、NUMA 信息、内核参数、网络连接数
  - InnoDB key metrics + buffer pool stats（per pool）
  - 客户访谈占位段

### 🐛 修复

- CPU 型号字段不再显示 `-`（V3 采集脚本读取 `/proc/cpuinfo`）
- 数据库列表 / 用户清单错取 IP 最小节点（已修复为取主库）
- v3.1 → v4.0 版本号全局更新

---

## [3.1.0] - 2026-05-13

基于 v3.0 报告的实战使用反馈，对**分析深度**、**问题聚合**、**用户体验**做了系统性提升。

### 🆕 新增

- **跨节点 issue 聚合**：同一条问题影响多个节点时自动合并为一行（如「sync_binlog=0 — 全部节点」），不再 N 个节点重复列 N 次。
- **根因关联分析（correlations）**：自动识别 6 类典型关联，第一章新增「1.3 根因关联分析」段：
  - DR 节点磁盘高位 ↔ binlog 永不过期
  - 全集群持久化偏弱（commit=0 + sync_binlog=0）
  - 主库慢查询累积 ↔ ibtmp1 增长
  - 从库间 ibtmp1 大小差异显著
  - 集群所有节点 root@%
  - DR 节点内存利用率显著低于主库
- **参数差异自动判断**：5.2 章用 ✅/❌ 表格替代纯枚举，自动标注每项差异是否合理（server_id 不同 ✅，expire_logs_days 不同 ❌）。
- **host=% 用户按危险等级分组**：第十一章新增「11.2 host=% 用户分级」表，按致命/高危/中危/低危分类，避免一锅炖。
- **行动计划带 SQL 示例**：第十三章每条 P0/P1/P2 后附现成 SQL 命令，可复制即执行。
- **历史归档表识别**：第七章 TOP10 自动标注带日期后缀的归档表（`tbl_xxx_20240606`），并提示归档可释放空间。
- **跨节点库差异检测**：第四章自动比较主从节点的数据库列表，发现增减。
- **慢查询按绝对值分级**：累计 >100 万 → P1，>10 万 → P2（原版本按比例容易低估）。
- **新规则**：
  - `expire_logs_days = 0`（永不过期）→ P1
  - `slow_query_log = 0` → P2
  - `ibtmp1` 配置缺 `:max:` 上限 → P2
  - `lower_case_table_names = 0`（Linux 跨平台风险）→ P3

### 🐛 修复

- **第十一章用户清单**：以前取的是 IP 最小的节点（DR 灾备），现取**主库**节点。第四章数据库清单同样修复。
- **第三章长会话误报**：以前会把从库 `system user` 的复制线程（运行时长上千万秒）当成长会话；现已过滤 `system user` 与 `Waiting for master / Queueing master event / Slave has read all` 状态。
- **第七章碎片表噪声**：以前列出 22 张含几 MB 临时表的高碎片表；现仅保留碎片空间 ≥100MB 且碎片率 ≥70% 的表。
- **行动计划重复**：以前同一条问题（如 sync_binlog=0）在 4 个节点上各列 1 次，共重复 15+ 次。现自动去重。
- **持久化建议措辞**：从库报告的 `innodb_flush_log_at_trx_commit=0` 不再写"若为主库建议改为 1"（措辞自相矛盾）。

### 🎨 改进

- 第一章新增「1.1 集群级问题 / 1.2 节点级问题」分组，结构更清晰。
- 整体评估在 P0 紧急存在时显示「存在紧急风险，需立即处理」。
- 第七章新增「合计可释放空间」提示与「大表推荐 pt-online-schema-change」说明。

### 📊 数据指标

以一个 4 节点集群为例：
- 问题总数：35 → **27**
- 重复条目：12 → **0**
- 自动关联：0 → **6 条**
- 行动计划带 SQL：0 → **几乎全部 P0/P1/P2**

---

## [3.0.0] - 2026-05-13

首个数据驱动版本（核心架构）。

### 新增

- **数据/视图分离**：`extract.js` 解析原始 txt/html 为 `data.json`，`render.js` 渲染 docx，互不耦合。
- **多节点表格自动展开**：4 节点就 4 行，无需手工复制粘贴模板。
- **20+ 条自动巡检规则**：内存、磁盘、复制延迟、配置一致性等。
- **占位符残留自检**：渲染结束自动解压 docx 检查 `{xxx}` 残留。
- **列宽智能加权**：按列内容类型分配权重（序号 0.5 / 描述 2.2 / 节点 IP 1.1），避免 WPS/Word 表格列宽混乱。
- **数值规范化**：`innodb_buffer_pool_size_in_mb` 等字段自动去除尾零（`40960.00000000` → `40960`）。
- **server_id 修正**：从 my.cnf 多行赋值中按 MySQL 行为取最后一行。
- 一键安装脚本 `install.sh`。

### 修复

- A4 内容宽度计算错误（9200 DXA 改为 8640 DXA）。
- 各表格列宽未显式声明，WPS 中表格挤窄。

---

## 早期版本（已废弃）

- v2.0：13 章硬编码 docx 模板，全部占位需手工替换 —— 已被 v3.0 数据驱动方案完全替代
