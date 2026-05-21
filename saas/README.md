# mysql-healthcheck SaaS

把 `scripts/extract.js` + `scripts/render.js` 包装成 **HTTP 服务**：

- 🌐 **Web UI** — 浏览器拖拽上传 `MySQLHealthCheck_*.txt`，几秒后下载 `.docx` 报告
- 🔌 **REST API** — 程序化对接（CI/CD、巡检平台、企业内门户）

> 在 `SaaS` 分支上独立维护，不影响主线开发。基于 v4.9 的 extract + render，所有规则、阈值配置、根因关联完全可用。

---

## 快速开始

```bash
# 1. 安装依赖
cd saas
npm install

# 2. 启动服务（默认 3000 端口）
node server.js

# 3. 浏览器打开
open http://localhost:3000
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | 监听端口 |
| `API_KEY` | （空，全开） | 设置后所有 `/api/*` 请求需带 `X-API-Key` 头 |
| `STORAGE_ROOT` | `saas/storage` | 上传文件与生成报告的根目录 |
| `MAX_FILES` | 16 | 单次最多上传文件数 |
| `MAX_FILE_SIZE_MB` | 50 | 单文件最大尺寸 |

示例：
```bash
PORT=8080 API_KEY=$(openssl rand -hex 16) STORAGE_ROOT=/var/mysql-hc node server.js
```

---

## 🔍 自动集群发现（v1.1+）

**核心特性**：上传 N 个 `*.txt`，系统自动按 MySQL 复制拓扑分组，每个独立集群生成一份独立报告。

举例：上传 14 个 txt（8 个单点 + 1 套一主三从 + 1 套一主一从）→ 系统自动识别 **10 个集群** → 并发生成 **10 份独立 docx**。

### 分组算法

1. 对每个 txt 做轻量解析（不调用完整 extract），提取：
   - 节点 IP（文件名 `MySQLHealthCheck_<IP>_*.txt`）+ hostname
   - `SHOW SLAVE STATUS` 的 `Master_Host`（若有）
   - 「slave IP is: …」的从库 IP 列表（若有）
2. **self-referencing slave 残留**（`Master_Host = 本机 IP/hostname/localhost`）自动识别为非真从库（v4.5 逻辑）
3. 用 **Union-Find** 把节点连通：
   - 若 A 的 `Master_Host` 指向集合中的另一个节点 B → A、B 同一簇
   - 若 A 的 `slaveIps` 列出集合中的 B → A、B 同一簇
4. 每个连通分量 = 一个集群；孤立节点（无连边）= 单节点集群

### 边界场景

| 场景 | 处理 |
|---|---|
| 从库的 master 不在上传集合中 | 该从库作为单节点处理（标 `hasOrphanSlave=true`，但仍生成报告）|
| `Master_Host` 是 hostname 而非 IP | grouper 把每个节点的 hostname 也加入索引，能正确匹配 |
| self-ref slave（曾是从库未 RESET SLAVE ALL） | 标 `selfRef=true`，作为单节点处理（不与其它节点合并）|
| 双主 / M-M 拓扑 | 通过传递闭包自动合并为一个集群 |

---

## REST API

所有响应均为 JSON（下载除外）。

### `GET /api/v1/health`

健康检查，**不需要鉴权**。

```json
{
  "status": "ok",
  "saasVersion": "1.0.0",
  "scriptsVersion": "4.9.0",
  "apiKeyEnabled": false,
  "storage": { "uploadsDir": "...", "reportsDir": "..." }
}
```

### 历史记录与批量下载 (v1.2+)

- **每次上传自动落盘成历史记录**：`storage/history/<batchId>.json` 持久化保存批次元数据 + 每个集群的 summary，进程重启后 Web UI 历史 Tab 仍能看到全部往期。
- **批量 ZIP 下载**：一次上传识别出 N 份报告，可一键打包成 zip 下载（含 README.txt 清单）。

Web UI 顶部有两个 Tab：
- **📤 新建报告**：拖拽上传、生成、并发跟踪 + 一键 zip 下载全部
- **📚 历史记录**：列出所有历史批次，支持按项目名 / batchId / 节点 IP 搜索；可查看详情、按集群下载、批量 zip 下载、删除整个批次

### `POST /api/v1/reports`

上传采集文件 → 自动按复制拓扑分组 → 每个集群异步生成报告。**返回 batch 结构**（每个集群一个子作业）。

**请求**（`multipart/form-data`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `files` | file × N | ✅ | `MySQLHealthCheck_<IP>_<timestamp>.txt`，可同时上传多个集群的文件 |
| `project` | string | ❌ | 报告标题中的项目名前缀；多集群时自动加 `_<集群主库 IP>` 后缀 |
| `configJson` | string | ❌ | 阈值配置 JSON 字符串，会落盘到每个子作业的 `mysql-healthcheck.config.json` |

**响应**（HTTP 202 Accepted）：

```json
{
  "batchId": "c17aa90bd190b3b3",
  "receivedFiles": 14,
  "clusterCount": 10,
  "project": "myproject",
  "clusters": [
    {
      "jobId": "074206f9ebdc4a03",
      "label": "10.10.10.2 集群（一主3从（异步复制））",
      "topology": "一主3从（异步复制）",
      "nodes": ["10.10.10.2", "10.10.10.3", "10.10.10.4", "10.10.10.101"],
      "primaryIp": "10.10.10.2",
      "fileCount": 4,
      "files": ["MySQLHealthCheck_10.10.10.2_*.txt", ...],
      "statusUrl": "/api/v1/reports/074206f9ebdc4a03"
    },
    {
      "jobId": "da0f1d49701a141c",
      "label": "10.0.128.236（单节点）",
      "topology": "单节点",
      "nodes": ["10.0.128.236"],
      "primaryIp": "10.0.128.236",
      "fileCount": 1,
      "files": ["MySQLHealthCheck_10.0.128.236_*.txt"],
      "statusUrl": "/api/v1/reports/da0f1d49701a141c"
    }
    // ... 其它集群
  ]
}
```

**注意**：每个 cluster 是独立的 job，需用各自的 `jobId` 单独轮询和下载。所有集群并发处理。

### `GET /api/v1/reports/:id`

查询 job 状态（轮询用）。

**响应字段**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `jobId` | string | 同 POST 返回 |
| `status` | enum | `queued` / `running:extract` / `running:render` / `done` / `error` |
| `progress` | string | 当前阶段描述 |
| `summary` | object\|null | done 时填充：`nodeCount`, `topology`, `issueCount`, `p0/p1/p2/p3`, `healthScoreTotal`, `correlationCount`, `overallAssessment`, `docxSizeBytes`, `disabledRules` |
| `downloadUrl` | string\|null | done 时为下载链接 |
| `dataJsonUrl` | string\|null | done 时为 data.json 链接 |
| `error` | string\|null | error 时为错误信息 |
| `createdAt` / `completedAt` | ISO8601 | - |

**完成示例**：

```json
{
  "jobId": "89e2fa63982ece56",
  "status": "done",
  "summary": {
    "nodeCount": 2,
    "topology": "一主1从（异步复制）",
    "issueCount": 30,
    "p0": 2, "p1": 8, "p2": 17, "p3": 3,
    "healthScoreTotal": 73,
    "correlationCount": 5,
    "overallAssessment": "存在紧急风险，需立即处理（健康度评分 73/100）",
    "docxSizeBytes": 183417,
    "disabledRules": []
  },
  "downloadUrl": "/api/v1/reports/89e2fa63982ece56/download",
  "dataJsonUrl": "/api/v1/reports/89e2fa63982ece56/data.json"
}
```

### `GET /api/v1/reports/:id/download`

下载 `.docx` 报告。

- 状态 `done` 才可下载，否则返回 409
- 文件存在 TTL（默认 6 小时），过期返回 410

**响应头**：

```
Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document
Content-Disposition: attachment; filename="..."
```

### `GET /api/v1/reports/:id/data.json`

下载 `data.json`（便于二次加工 / 集成数据仓库）。

### `GET /api/v1/reports/batch/:batchId/download` (v1.2+)

把整个 batch 的所有已生成 docx 打包成 zip 下载。zip 内含：

```
<project>_<batchId-prefix>/
├── <cluster1>_MySQL健康巡检报告_v1.0.docx
├── <cluster2>_MySQL健康巡检报告_v1.0.docx
├── ...
└── README.txt                    ← 批次清单与每集群 P0/P1 摘要
```

至少 1 份 cluster 完成才能下载（否则返回 409）。

### `GET /api/v1/history` (v1.2+)

列出历史批次（按 createdAt 倒序）。

**Query 参数**：

| 参数 | 默认 | 说明 |
|---|---|---|
| `limit` | 50 | 最多返回条数（上限 200）|
| `offset` | 0 | 分页偏移 |
| `q` | - | 模糊搜索：项目名 / batchId / 节点 IP |

**响应**：

```json
{
  "total": 23,
  "items": [
    {
      "batchId": "eb0e5f452af0d758",
      "createdAt": "2026-05-18T03:00:30Z",
      "updatedAt": "2026-05-18T03:01:09Z",
      "project": "v12-test",
      "receivedFiles": 4,
      "clusterCount": 3,
      "doneCount": 3,
      "errorCount": 0,
      "issueAggregate": { "p0": 4, "p1": 15, "p2": 27, "p3": 8 }
    },
    ...
  ]
}
```

### `GET /api/v1/history/:batchId` (v1.2+)

单条批次详情，含每个 cluster 的完整 summary、状态、磁盘路径、错误信息（如有）。可在批次完成后随时回看（无 TTL，除非主动删除）。

### `DELETE /api/v1/history/:batchId` (v1.2+)

删除整个批次：从 history 移除 + 删除 `storage/uploads/<jobId>/` 与 `storage/reports/<jobId>/` 各子目录。返回 `{ ok: true, deletedBatchId: '...' }`。

---

## 命令行调用示例

### 单集群（最常见）

```bash
# 1. 提交一套主从集群的多个文件
RESP=$(curl -s -X POST http://localhost:3000/api/v1/reports \
  -F "project=客户ACME" \
  -F "files=@/path/MySQLHealthCheck_10.0.0.1_*.txt" \
  -F "files=@/path/MySQLHealthCheck_10.0.0.2_*.txt")
JOB=$(echo "$RESP" | jq -r '.clusters[0].jobId')

# 2. 轮询
while true; do
  STATUS=$(curl -s http://localhost:3000/api/v1/reports/$JOB | jq -r .status)
  echo "status=$STATUS"
  [ "$STATUS" = "done" -o "$STATUS" = "error" ] && break
  sleep 2
done

# 3. 下载
curl -o report.docx http://localhost:3000/api/v1/reports/$JOB/download
```

### 批量混合（自动识别集群）

```bash
# 一次性上传多套集群的文件：8 个单点 + 1 套主从（4 节点） + 1 套主从（2 节点）= 14 个 txt
# 系统会自动识别为 10 个独立集群 → 并发生成 10 份报告

curl -s -X POST http://localhost:3000/api/v1/reports \
  -F "project=monthly-batch" \
  $(for f in /data/uploads/MySQLHealthCheck_*.txt; do printf -- '-F files=@%s ' "$f"; done) \
  > batch.json

# 解析每个集群的 jobId 并下载
jq -r '.clusters[] | .jobId' batch.json | while read jid; do
  # 等待完成
  while [ "$(curl -s http://localhost:3000/api/v1/reports/$jid | jq -r .status)" != "done" ]; do sleep 2; done
  # 下载
  LABEL=$(curl -s http://localhost:3000/api/v1/reports/$jid | jq -r '.project // "report"')
  curl -s -o "report_${LABEL}.docx" http://localhost:3000/api/v1/reports/$jid/download
  echo "saved report_${LABEL}.docx"
done
```

### 带 API key 调用

```bash
export API_KEY=mysecretkey
# 启动时：API_KEY=$API_KEY node server.js

curl -X POST http://localhost:3000/api/v1/reports \
  -H "X-API-Key: $API_KEY" \
  -F "files=@/path/MySQLHealthCheck_*.txt"
```

### 带自定义阈值配置

```bash
curl -X POST http://localhost:3000/api/v1/reports \
  -F 'configJson={"thresholds":{"disk":{"critical_pct":85}},"disabledRules":["sql_mode_missing_strict"]}' \
  -F "files=@/path/MySQLHealthCheck_*.txt"
```

### 屏蔽特殊磁盘（光驱 / 安装 ISO / USB 等）的说明性条目

v4.9 起，光驱 / 自动挂载的安装 ISO / 可移动介质如果 100% 占用，会自动降级为 **P3 说明性条目**（描述「设计如此，无需处理」），不再误报 P0。但仍会在报告里出现一条说明性 issue。如果希望**完全静默**，加入 `disabledRules`：

```bash
curl -X POST http://localhost:3000/api/v1/reports \
  -F 'configJson={"disabledRules":["disk_optical_full","disk_install_iso_full","disk_removable_full","disk_pseudo_fs_full"]}' \
  -F "files=@/path/MySQLHealthCheck_*.txt"
```

可挑选其中需要的几条：

| Rule type | 触发条件 |
|---|---|
| `disk_optical_full` | `/dev/sr*` / `/dev/cdrom` / `/dev/dvd` 光驱挂载使用率 ≥ 80% |
| `disk_install_iso_full` | `/run/media/<user>/<RHEL-x.x \| CentOS-x \| Ubuntu-x \| Debian-x \| ...>` 自动挂载 |
| `disk_removable_full` | 其它 `/run/media/...` 自动挂载（USB / 移动硬盘）|
| `disk_pseudo_fs_full` | `tmpfs` / `devtmpfs` / `overlay` / `squashfs` 等系统伪文件系统 |

完整规则清单 + 所有可禁用 / 可调阈值的规则 type 见 [`references/rules.md`](../references/rules.md)。

---

## Web UI 功能

- 拖拽 / 点击上传 `*.txt` 文件
- 实时进度条 + 阶段提示（解析 → 渲染 → 完成）
- 完成后展示：节点数、拓扑、健康度评分、P0~P3 分布、根因关联数
- 一键下载 `.docx` 和 `data.json`
- 自定义项目名 / 阈值 JSON

界面 ≤ 20 KB 纯静态 HTML + JS，无构建步骤。

---

## 架构

```
HTTP 请求
   ↓
Express + multer (server.js)
   ↓ multipart files → storage/uploads/<jobId>/
JobStore.create(jobId) — 内存 Map
   ↓ setImmediate 异步
runner.generateReport()
   ↓ child_process.spawn
node scripts/extract.js <uploadDir> --out data.json
   ↓
node scripts/render.js data.json --out report.docx --no-toc-refresh
   ↓
storage/reports/<jobId>/{report.docx, data.json}
JobStore.update(status='done')
   ↓
GET /api/v1/reports/:id  ← 客户端轮询
GET /api/v1/reports/:id/download  ← 流式返回 docx
```

**v1 设计原则**：
- 单进程 / 内存 job 表 / 文件系统存储 — 零外部依赖
- `extract.js` + `render.js` 完全不改动，子进程调用确保隔离
- TTL 自动清理过期 job（6h 默认）

---

## 部署

### 本机开发

```bash
cd saas && node server.js
```

### 生产部署（PM2）

```bash
npm install -g pm2
cd saas
pm2 start server.js --name mysql-hc-saas \
  --env PORT=8080 \
  --env API_KEY="$(openssl rand -hex 16)" \
  --env STORAGE_ROOT=/var/mysql-hc
pm2 save
pm2 startup
```

### Docker（参考）

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY . /app
RUN cd scripts && npm install --omit=dev
RUN cd saas && npm install --omit=dev
WORKDIR /app/saas
EXPOSE 3000
CMD ["node", "server.js"]
```

```bash
docker build -t mysql-hc-saas .
docker run -d -p 3000:3000 -e API_KEY=changeme -v $(pwd)/saas/storage:/app/saas/storage mysql-hc-saas
```

### 反向代理（Nginx）

```nginx
location /mysql-hc/ {
    proxy_pass http://127.0.0.1:3000/;
    client_max_body_size 1000M;
    proxy_read_timeout 600s;
}
```

---

## 生产化清单

v1 故意保持极简。生产部署建议补充：

- [ ] **持久化 job 表** — 替换 `lib/jobs.js` 为 Redis / PostgreSQL
- [ ] **多副本** — 加 Redis pub/sub，让任意副本接收上传 / 查询都拿得到状态
- [ ] **文件存储外置** — `storage/` 改用 S3 / OSS / MinIO
- [ ] **批量并发限流** — 用 `bull` / `bullmq` 做任务队列
- [ ] **请求审计** — 用户身份、上传文件名、生成时间入日志/审计库
- [ ] **HTTPS / mTLS** — 通过前置 Nginx / ALB 完成
- [ ] **多租户** — 把 API_KEY 替换为 OAuth2 / JWT，按租户隔离 storage 路径
- [ ] **配额** — 单租户 N 个 job / 天，单文件上传速率限制

---

## 故障排查

### 上传后 status 一直 queued

extract / render 子进程可能阻塞。查日志：

```bash
node server.js 2>&1 | tee /var/log/mysql-hc-saas.log
```

常见原因：
- 上传的 `.txt` 不是采集脚本输出格式
- `scripts/node_modules` 没装：`cd scripts && npm install`

### docx 文件大小异常（< 50 KB）

通常是图表渲染（`@resvg/resvg-js`）失败。重装：

```bash
cd scripts && rm -rf node_modules && npm install
```

### 端口被占

```bash
PORT=8080 node server.js
# 或
lsof -i :3000 → kill <pid>
```

---

## Roadmap

- v1.1：用 `bullmq` + Redis 替换内存 job 表
- v1.2：S3 兼容存储后端
- v2：多租户 + OAuth2 + 配额管理
- v2：WebSocket 推送 job 状态（替代轮询）
- v2：批量上传 zip 包自动解压
