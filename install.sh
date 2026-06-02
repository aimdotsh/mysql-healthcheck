#!/usr/bin/env bash
# ykt 2.0 一键安装：装好 Node 依赖（docx + @resvg/resvg-js）
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未检测到 node，请先安装 Node.js >= 16" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 16 ]; then
  echo "✗ Node 版本过低（当前 $(node -v)），需要 >= 16" >&2
  exit 1
fi

echo "→ 安装 scripts/ 依赖（docx + @resvg/resvg-js）..."
cd "$DIR/scripts"
npm install

echo ""
echo "✓ 安装完成。生成报告："
echo "    cd $DIR/scripts"
echo "    node build.js <数据目录> --project \"<项目名>\""
