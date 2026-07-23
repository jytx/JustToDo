#!/usr/bin/env bash
# Debug 打包：生成 src-tauri/target/debug/bundle/ 下的 .app / .msi。
# 比 release 快很多（无 LTO/优化），适合验证图标、配置、构建链路。
#
# 用法: ./scripts/build-debug.sh
#
# 产物:
#   macOS:   src-tauri/target/debug/bundle/macos/JustToDo.app
#            src-tauri/target/debug/bundle/dmg/JustToDo_0.1.0_aarch64.dmg(若 targets=all)
#   Windows: src-tauri/target/debug/bundle/msi/*.msi
#            src-tauri/target/debug/bundle/nsis/*.exe
set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p logs
LOG_FILE="logs/build-debug-$(date +%Y%m%d-%H%M%S).log"

echo "==> Debug 打包,日志: $LOG_FILE"
npm run tauri build -- --debug 2>&1 | tee "$LOG_FILE"