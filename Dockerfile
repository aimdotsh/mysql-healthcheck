# MySQL Healthcheck SaaS — production Dockerfile
#
# 多阶段：deps（装依赖）→ runtime（仅运行时所需）。
# 镜像产物 ~250 MB（node:20-slim 基础）。
#
# 构建：docker build -t mysql-healthcheck-saas:latest .
# 运行：docker run -p 3000:3000 -v $(pwd)/storage:/data mysql-healthcheck-saas:latest
# 一般配合 docker-compose.yml + 反向代理使用，详见 deploy/DEPLOY.md

# ============== Stage 1: 装依赖 ==============
FROM node:20-slim AS deps

WORKDIR /app

# 先装 scripts 依赖（含 @resvg/resvg-js 原生模块，构建慢，单独 cache）
COPY scripts/package.json scripts/package-lock.json* ./scripts/
RUN cd scripts && npm install --omit=dev --no-audit --no-fund

# 再装 saas 依赖（express / multer / jszip）
COPY saas/package.json saas/package-lock.json* ./saas/
RUN cd saas && npm install --omit=dev --no-audit --no-fund

# ============== Stage 2: 运行时 ==============
FROM node:20-slim AS runtime

# tini 作 PID 1：正确处理信号转发 + 回收僵尸进程
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 复制依赖（来自 deps 阶段，保留原生模块）
COPY --from=deps /app/scripts/node_modules ./scripts/node_modules
COPY --from=deps /app/saas/node_modules    ./saas/node_modules

# 复制源码（注意 .dockerignore 已过滤掉 tests/docs/.git 等）
COPY scripts/    ./scripts/
COPY saas/       ./saas/
# 采集脚本：Web UI「采集脚本使用说明」页支持直接下载
COPY collectors/ ./collectors/

# 准备数据目录（容器外挂卷应该挂到 /data）
RUN mkdir -p /data/uploads /data/reports /data/history

# 创建非 root 用户运行（安全实践）
RUN groupadd -r mysqlhc && useradd -r -g mysqlhc -u 1001 mysqlhc \
    && chown -R mysqlhc:mysqlhc /app /data
USER mysqlhc

WORKDIR /app/saas

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_ROOT=/data \
    MAX_FILES=16 \
    MAX_FILE_SIZE_MB=50

# 健康检查：每 30s 测一次 /api/v1/health
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:${PORT}/api/v1/health || exit 1

# tini 作 PID 1，处理 SIGTERM / SIGINT 优雅退出
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
