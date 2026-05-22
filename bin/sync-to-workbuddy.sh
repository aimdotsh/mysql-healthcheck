#!/usr/bin/env bash
# sync-to-workbuddy.sh — 把当前源仓库同步到 ~/.workbuddy/skills/mysql-healthcheck/
#
# 用法：
#   ./bin/sync-to-workbuddy.sh           # 标准同步（保留 dist 自身的 saas/storage 数据）
#   ./bin/sync-to-workbuddy.sh --dry-run # 只看会改什么，不实际改
#   ./bin/sync-to-workbuddy.sh --clean   # 同步前先清空 workbuddy（含 saas/storage 等运行时数据）
#
# 路径约定：
#   源（含 .git，开发用）：/Users/liups/ai/skill/mysql-healthcheck/
#   目标（dist，无 .git，runtime 用）：~/.workbuddy/skills/mysql-healthcheck/

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DST="$HOME/.workbuddy/skills/mysql-healthcheck"

# 参数
DRY_RUN=""
CLEAN=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN="--dry-run" ;;
    --clean)   CLEAN=1 ;;
    -h|--help)
      head -16 "$0" | tail -15
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

if [[ ! -d "$SRC/.git" ]]; then
  echo "✗ 源目录不像 git 仓库：$SRC" >&2
  exit 1
fi

mkdir -p "$DST"

# 可选：清空 dist（含 saas/storage 等历史数据，谨慎）
if [[ -n "$CLEAN" && -z "$DRY_RUN" ]]; then
  echo "==> 清空 $DST/"
  rm -rf "$DST"
  mkdir -p "$DST"
fi

echo "==> rsync $SRC/ → $DST/"
echo "    （排除：.git / Docker / deploy / DS_Store / saas/storage 运行时数据）"
rsync -a $DRY_RUN --delete \
  --exclude='.git/' \
  --exclude='.gitignore' \
  --exclude='.gitattributes' \
  --exclude='.DS_Store' \
  --exclude='**/.DS_Store' \
  --exclude='deploy/' \
  --exclude='Dockerfile' \
  --exclude='docker-compose.yml' \
  --exclude='.dockerignore' \
  --exclude='bin/sync-to-workbuddy.sh' \
  --exclude='saas/storage/uploads/*' \
  --exclude='saas/storage/reports/*' \
  --exclude='saas/storage/history/*.json' \
  --filter='protect saas/storage/uploads/.gitkeep' \
  --filter='protect saas/storage/reports/.gitkeep' \
  --filter='protect saas/storage/history/.gitkeep' \
  "$SRC/" "$DST/"

if [[ -n "$DRY_RUN" ]]; then
  echo "==> dry-run 完成（未真正改动）"
  exit 0
fi

echo ""
echo "==> 同步完成"
echo "    源大小：  $(du -sh "$SRC"  | awk '{print $1}')"
echo "    dist大小：$(du -sh "$DST" | awk '{print $1}')"

# 提示版本
SRC_VER=$(grep '"version"' "$SRC/scripts/package.json" 2>/dev/null | head -1 | sed 's/[^0-9.]//g')
DST_VER=$(grep '"version"' "$DST/scripts/package.json" 2>/dev/null | head -1 | sed 's/[^0-9.]//g')
echo "    源版本：  $SRC_VER"
echo "    dist版本：$DST_VER"
