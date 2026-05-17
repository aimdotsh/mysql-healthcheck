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

### `POST /api/v1/reports`

上传采集文件 → 异步生成报告。返回 `jobId`。

**请求**（`multipart/form-data`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `files` | file × N | ✅ | `MySQLHealthCheck_<IP>_<timestamp>.txt`，可多次出现 |
| `project` | string | ❌ | 报告标题中的项目名，缺省随机生成 |
| `configJson` | string | ❌ | 阈值配置 JSON 字符串，会落盘到上传目录的 `mysql-healthcheck.config.json`（采集目录自动发现） |

**响应**（HTTP 202 Accepted）：

```json
{
  "jobId": "89e2fa63982ece56",
  "project": "Demo",
  "status": "queued",
  "progress": "queued",
  "createdAt": "2026-05-17T09:24:56.916Z",
  "completedAt": null,
  "error": null,
  "summary": null,
  "downloadUrl": null,
  "dataJsonUrl": null
}
```

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

---

## 命令行调用示例

```bash
# 1. 提交（多文件）
curl -X POST http://localhost:3000/api/v1/reports \
  -F "project=客户ACME" \
  -F "files=@/path/MySQLHealthCheck_10.0.0.1_20260517.txt" \
  -F "files=@/path/MySQLHealthCheck_10.0.0.2_20260517.txt"
# → {"jobId":"abc123",...}

# 2. 轮询
while true; do
  STATUS=$(curl -s http://localhost:3000/api/v1/reports/abc123 | jq -r .status)
  echo "status=$STATUS"
  [ "$STATUS" = "done" -o "$STATUS" = "error" ] && break
  sleep 2
done

# 3. 下载
curl -o report.docx http://localhost:3000/api/v1/reports/abc123/download
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
