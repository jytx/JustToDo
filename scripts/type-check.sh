#!/usr/bin/env bash
# 前端类型检查（vue-tsc --noEmit）
# 等价于: npm run build 的前置步骤（不产出任何文件）
# 用法: ./scripts/type-check.sh
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> 前端类型检查（vue-tsc --noEmit）"
npx vue-tsc --noEmit
