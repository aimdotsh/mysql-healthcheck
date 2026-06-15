# 二进制使用说明（离线 / 无 LLM / 无 node）

面向**无外网、无 node、数据不能出场**的客户现场（如 RHEL 7.9）。一个自包含可执行文件，
本机直接把采集到的 `MySQLHealthCheck_*.txt` 生成 **Markdown + HTML** 巡检报告，
全程**不联网、不调用任何大模型、零安装**。

> 有 node 的环境等价命令是 `node tools/report.js <数据目录> [参数…]`，参数完全一致。

---

## 1. 获取二进制

- **从 Release 下载**（推荐）：[Releases 页](https://github.com/aimdotsh/mysql-healthcheck/releases) →
  对应 `offline-v*` 版本 → 下载 `mysql-healthcheck-linux-x64`。
- **自行构建**（需有网的构建机）：`npm install && npm run build:bin` → 产物在 `dist/mysql-healthcheck-linux-x64`。

拷到客户机后赋可执行权限：

```bash
chmod +x mysql-healthcheck-linux-x64
```

**运行环境要求**：Linux **x86-64**，glibc **≥ 2.17**（RHEL/CentOS 7 及以上、Ubuntu 16.04+ 均满足）。
运行时**无需安装 node 或任何依赖**——Node 16 运行时已打包进二进制。

---

## 2. 基本用法

```bash
# 最简：在数据目录内生成 md + html
./mysql-healthcheck-linux-x64 /path/to/采集数据目录

# 指定项目名 + 输出目录
./mysql-healthcheck-linux-x64 /path/to/data --project "DemoCluster 数据库" --out-dir /tmp/report
```

「采集数据目录」= 含一个或多个 `MySQLHealthCheck_<IP>_<时间戳>.txt` 的目录
（由 `collectors/mysqlHealthCheckV3.0.sh` 在 MySQL 主机上采集得到）。

不带任何参数运行会打印用法提示并以非 0 退出。

---

## 3. 完整参数

| 参数 | 是否必填 | 默认值 | 说明 |
|---|---|---|---|
| `<数据目录>` | **必填**（第 1 个位置参数） | — | 含 `MySQLHealthCheck_*.txt` 的目录；支持多节点（每节点一个 txt） |
| `--out-dir <目录>` | 可选 | 同「数据目录」 | 报告输出目录；**不存在会自动递归创建** |
| `--format md\|html\|both` | 可选 | `both` | 输出格式：仅 markdown / 仅 html / 两者都出 |
| `--project "<名称>"` | 可选 | 文件名推断，否则 `未命名项目` | 报告标题里的项目名（名字含空格要加引号）。**建议显式指定** |
| `--config <path>` | 可选 | 无（用内置默认阈值） | 指定阈值/规则配置 JSON，覆盖默认阈值、禁用规则、调整优先级 |
| `--emit-facts` | 可选 | 关 | 额外在输出目录写一份 `facts.json`（结构化中间结果，便于调试 / 二次加工） |

> 配置自动发现：若**数据目录**下存在 `mysql-healthcheck.config.json`，会被自动加载（无需 `--config`）；
> 同时给了 `--config` 时，`--config` 优先级更高。配置项含义见 [USAGE.md §5](../USAGE.md) 与
> 内置默认 `tools/config/default-thresholds.json`。

---

## 4. 输出

在输出目录生成（`<日期>` 为运行当天 `YYYYMMDD`）：

| 文件 | 条件 | 说明 |
|---|---|---|
| `MySQL巡检报告_<日期>.md` | `--format md` 或 `both` | 17 章 Markdown，便于后续转 Word / 归档 |
| `MySQL巡检报告_<日期>.html` | `--format html` 或 `both` | **自包含** HTML：内联 CSS + 内联 SVG 图表（健康度仪表 / 拓扑 / 命中率 / 六维雷达）。双击用浏览器打开即可，浏览器可直接「打印 → 另存为 PDF」 |
| `facts.json` | 仅 `--emit-facts` | 结构化中间结果（nodes / issues / healthScore） |

运行结束会在 stderr 打印一行摘要，例如：
`报告已生成（节点 4 / 问题 49 / 健康度 88）：`

报告内容：17 章（执行摘要 / OS 硬件 / 版本 / 集群拓扑 / 参数 / 性能 / 容量 / InnoDB /
引擎深度 / 会话锁错误日志 / 用户权限 / 主从 / Schema 审计 / SQL 治理 / 备份评估 /
**行动计划（P0→P3，含当前值→推荐值 + 可执行 SQL）** / 结论）。

---

## 5. 示例

```bash
# 1) 标准交付：指定项目名，md+html 都出，输出到单独目录
./mysql-healthcheck-linux-x64 ./reports/客户A --project "客户A 生产集群" --out-dir ./out

# 2) 只要一份 HTML 给现场看
./mysql-healthcheck-linux-x64 ./reports/客户A --format html

# 3) 用客户专属阈值（如金融场景磁盘 80% 即告警）
./mysql-healthcheck-linux-x64 ./reports/客户A --config ./strict.json

# 4) 调试：同时导出 facts.json 看中间数据
./mysql-healthcheck-linux-x64 ./reports/客户A --emit-facts --out-dir /tmp/dbg
```

---

## 6. 退出码与常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 打印「用法: …」后退出 | 没传数据目录，或第一个参数是 `--` 开头。把数据目录放在第一个位置。 |
| 报错「目录不存在或不是目录」 | 数据目录路径错误。 |
| 报错「…下未找到任何巡检 txt 文件」 | 目录里没有 `MySQLHealthCheck_*.txt`（或文件名/内容不被识别）。先用 `collectors/mysqlHealthCheckV3.0.sh` 采集。 |
| `cannot execute binary file` / 段错误 | 不是 Linux x86-64 环境，或 glibc < 2.17。换符合要求的机器，或在有 node 的机器上用 `node tools/report.js`。 |
| `Permission denied` | 先 `chmod +x mysql-healthcheck-linux-x64`。 |

---

## 7. 安全与合规要点

- **不联网**：二进制只读本地 txt、只写本地报告，无任何网络请求。
- **不调用大模型**：所有判断、阈值比较、优先级分级、推荐值与 SQL 均由内置确定性规则计算。
- **数据不出场**：`.txt` 与报告都在客户本机生成。
- **可复现**：同一份采集数据 + 同一版本二进制 → 报告逐字一致（仅「距上次备份 N 天」等随运行日期变化）。
- 体积约 43 MB（含 Node 16 运行时）。如客户安全策略禁止未知二进制，可改用源码 + node 方式
  （`node tools/report.js`），或联系维护者评估 Python 兜底方案。
