#!/usr/bin/env bash
# 启动 Tauri 开发模式（前端热更新 + Rust 原生窗口）
# 用法: ./scripts/dev.sh
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> 启动 Tauri dev（前端热更新 + 原生窗口）"
npm run tauri:dev
