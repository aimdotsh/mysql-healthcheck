FROM node:20-slim AS builder

WORKDIR /app

# ---- 安装 scripts 依赖（含 @resvg/resvg-js 原生模块）----
COPY scripts/package.json scripts/package-lock.json ./scripts/
RUN cd scripts && npm install --omit=dev

# ---- 安装 saas 依赖（express / multer）----
COPY saas/package.json saas/package-lock.json ./saas/
RUN cd saas && npm install --omit=dev

# ---- 复制源码 ----
COPY scripts/ ./scripts/
COPY saas/ ./saas/

# 为 runner.js 中硬编码的 REPO_ROOT = __dirname/../../ 确保路径正确
# runner.js: path.resolve(__dirname, '..', '..') → /app
# scripts 在 /app/scripts，saas 在 /app/saas  ✓

# ---- 准备 storage 目录（挂载点）----
RUN mkdir -p /data/uploads /data/reports

WORKDIR /app/saas
EXPOSE 3000

ENV PORT=3000
ENV STORAGE_ROOT=/data
ENV NODE_ENV=production

CMD ["node", "server.js"]
