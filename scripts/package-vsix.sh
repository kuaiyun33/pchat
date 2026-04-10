#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ ! -d node_modules ]]; then
  echo "[pchat] 未检测到 node_modules，正在执行 npm install…"
  npm install
fi
npm run package
echo ""
shopt -s nullglob
vsix=(pchat-*.vsix)
if ((${#vsix[@]} > 0)); then
  newest="$(ls -t "${vsix[@]}" | head -1)"
  echo "VSIX: $ROOT/$newest"
else
  echo "未在当前目录找到 pchat-*.vsix，请查看上方 vsce 输出。"
fi
