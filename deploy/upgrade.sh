#!/usr/bin/env bash
# MySQL Healthcheck SaaS — 一键升级到最新版
#
# 用法：
#   cd /opt/mysql-healthcheck
#   ./deploy/upgrade.sh
#
# 流程：拉代码 → 重建镜像 → 滚动重启 → 清旧镜像 → 健康检查

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> 当前版本"
docker compose exec saas cat /app/scripts/package.json 2>/dev/null | grep version || echo "  (容器未运行)"

echo "==> 1/5 拉取最新代码"
git fetch origin SaaS
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/SaaS)
if [ "$LOCAL" = "$REMOTE" ]; then
  echo "  已是最新（$LOCAL），跳过。"
else
  git pull origin SaaS
  echo "  本地 $LOCAL → 远端 $REMOTE"
fi

echo "==> 2/5 重新构建镜像"
docker compose build

echo "==> 3/5 滚动重启"
docker compose up -d

echo "==> 4/5 清理旧镜像"
docker image prune -f --filter "label=stage=builder" >/dev/null
docker image prune -f >/dev/null

echo "==> 5/5 等待健康检查"
for i in {1..30}; do
  STATUS=$(docker inspect mysql-hc-saas --format='{{.State.Health.Status}}' 2>/dev/null || echo "starting")
  if [ "$STATUS" = "healthy" ]; then
    echo "  ✓ healthy"
    break
  fi
  echo "  等待中... ($i/30, 当前 $STATUS)"
  sleep 2
done

if [ "$STATUS" != "healthy" ]; then
  echo "  ✗ 健康检查超时，请查日志：docker compose logs saas"
  exit 1
fi

echo ""
echo "==> 升级完成 ✓"
echo "    版本：$(curl -s http://127.0.0.1:3000/api/v1/health | head -c 200)"
