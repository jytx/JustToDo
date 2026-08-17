#!/usr/bin/env bash
# Release 打包：生成 src-tauri/target/release/bundle/ 下的 .app / .msi。
# 正式安装包（体积小、有 LTO 优化）；比 debug 构建慢（首次可能 10 分钟+）。
#
# 用法: ./scripts/build-release.sh
#
# 产物:
#   macOS:   src-tauri/target/release/bundle/macos/JustToDo.app
#            src-tauri/target/release/bundle/dmg/JustToDo_0.1.0_aarch64.dmg(若 dmg 步骤成功)
set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p logs
LOG_FILE="logs/build-release-$(date +%Y%m%d-%H%M%S).log"

echo "==> Release 打包,日志: $LOG_FILE"
npm run tauri build 2>&1 | tee "$LOG_FILE"
