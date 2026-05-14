#!/usr/bin/env bash
# MySQL 巡检报告技能 — 一键安装脚本
#
# 用法：
#   bash install.sh                       # 默认装到 ~/.claude/skills/mysql-healthcheck
#   bash install.sh --target claude       # 装到 ~/.claude/skills/
#   bash install.sh --target workbuddy    # 装到 ~/.workbuddy/skills/
#   bash install.sh --target ~/foo        # 自定义父目录
#   PREFIX=~/.config bash install.sh      # 兼容旧的 PREFIX 环境变量

set -e

# ----- 颜色 -----
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;36m'
RESET='\033[0m'

step()  { echo -e "${BLUE}==>${RESET} $1"; }
ok()    { echo -e "${GREEN}✓${RESET} $1"; }
warn()  { echo -e "${YELLOW}⚠${RESET} $1"; }
fail()  { echo -e "${RED}✗${RESET} $1"; exit 1; }

# ----- 找到本脚本所在目录 -----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_NAME="mysql-healthcheck"

# ----- 参数解析 -----
TARGET_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET_ARG="$2"; shift 2 ;;
    -h|--help)
      head -10 "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) warn "未知参数: $1"; shift ;;
  esac
done

# ----- 决定安装目标 -----
# 优先级：--target 参数 > PREFIX 环境变量 > 自动探测 > 默认 ~/.claude/skills
if [[ -n "$TARGET_ARG" ]]; then
  case "$TARGET_ARG" in
    claude)    PREFIX="$HOME/.claude/skills" ;;
    workbuddy) PREFIX="$HOME/.workbuddy/skills" ;;
    *)         PREFIX="$TARGET_ARG" ;;
  esac
elif [[ -n "${PREFIX:-}" ]]; then
  : # 用环境变量
elif [[ -d "$HOME/.claude/skills" ]]; then
  PREFIX="$HOME/.claude/skills"
elif [[ -d "$HOME/.workbuddy/skills" ]]; then
  PREFIX="$HOME/.workbuddy/skills"
else
  PREFIX="$HOME/.claude/skills"   # 默认走 Claude Code 标准位置
fi
TARGET="$PREFIX/$PKG_NAME"

echo
step "MySQL 健康检查技能 v4.1 — 安装程序"
echo "    源目录：$SCRIPT_DIR"
echo "    目标：  $TARGET"
echo

# ----- 检查 Node.js -----
step "检查 Node.js"
if ! command -v node >/dev/null 2>&1; then
  fail "未找到 node 命令。请先安装 Node.js ≥16：https://nodejs.org/"
fi
NODE_VERSION="$(node -v | sed 's/v//')"
NODE_MAJOR="$(echo "$NODE_VERSION" | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 16 ]; then
  fail "Node.js 版本过低（当前 v$NODE_VERSION，最低需要 v16）"
fi
ok "Node.js v$NODE_VERSION"

# ----- 检查 npm -----
if ! command -v npm >/dev/null 2>&1; then
  fail "未找到 npm 命令。请安装与 Node.js 配套的 npm"
fi
ok "npm $(npm -v)"

# ----- 检查源文件完整性 -----
step "检查源文件"
for f in SKILL.md README.md scripts/extract.js scripts/render.js scripts/package.json; do
  if [ ! -f "$SCRIPT_DIR/$f" ]; then
    fail "缺失关键文件：$f（源目录可能不完整）"
  fi
done
ok "源文件齐全"

# ----- 如果源目录与目标目录相同（即就地安装），跳过拷贝 -----
if [ "$SCRIPT_DIR" = "$TARGET" ]; then
  step "检测到源目录就是目标目录（就地安装，跳过文件拷贝）"
else
  # ----- 如果目标已存在，备份 -----
  if [ -d "$TARGET" ]; then
    BACKUP="$TARGET.bak.$(date +%Y%m%d%H%M%S)"
    warn "目标目录已存在，备份到 $BACKUP"
    mv "$TARGET" "$BACKUP"
  fi

  # ----- 拷贝目录 -----
  step "拷贝技能文件到 $TARGET"
  mkdir -p "$PREFIX"
  rsync -a \
    --exclude='node_modules' \
    --exclude='data.json' \
    --exclude='*.docx' \
    --exclude='.git' \
    --exclude='.DS_Store' \
    "$SCRIPT_DIR/" "$TARGET/"
  ok "文件拷贝完成"
fi

# ----- 安装依赖 -----
step "安装 npm 依赖（docx + @resvg/resvg-js）"
cd "$TARGET/scripts"
npm install --no-audit --no-fund --silent
ok "依赖安装完成"

# ----- 完成 -----
echo
echo -e "${GREEN}═══════════════════════════════════════════${RESET}"
echo -e "${GREEN}  ✓ 安装成功${RESET}"
echo -e "${GREEN}═══════════════════════════════════════════${RESET}"
echo
echo "  技能位置：$TARGET"
echo

# 不同安装位置给不同的下一步提示
case "$PREFIX" in
  *"/.claude/skills")
    echo -e "${BLUE}Claude Code 用户：${RESET}"
    echo "  本 skill 已被 Claude Code 自动识别。"
    echo "  在对话中说「帮我生成 <数据目录> 的 MySQL 巡检报告」即可触发。"
    ;;
  *"/.workbuddy/skills")
    echo -e "${BLUE}workbuddy 用户：${RESET}"
    echo "  本 skill 已就位于 workbuddy 标准目录。"
    ;;
esac

echo
echo -e "${BLUE}命令行直接调用：${RESET}"
echo "  cd $TARGET/scripts"
echo '  node extract.js <数据目录> --project "项目名"'
echo "  node render.js  <数据目录>/data.json"
echo
echo "  详细文档：$TARGET/USAGE.md"
echo
