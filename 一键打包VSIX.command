#!/bin/bash
# macOS 双击运行：在终端中执行 VSIX 打包（先 build 再 vsce package）
set -euo pipefail
cd "$(dirname "$0")"
echo "=========================================="
echo "  PChat 一键打包 VSIX"
echo "  目录: $(pwd)"
echo "=========================================="
bash ./scripts/package-vsix.sh
npm run build && cp -R dist/* ~/.cursor/extensions/local.pchat-1.0.1/dist/
echo ""
read -r -p "按 Enter 关闭窗口…" _
