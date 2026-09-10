#!/usr/bin/env bash
# Release 打包：生成 src-tauri/target/release/bundle/ 下的 .app / .msi。
# 正式安装包（体积小、有 LTO 优化）；比 debug 构建慢（首次可能 10 分钟+）。
#
# 用法: ./scripts/build-release.sh
#
# 产物:
#   macOS:   src-tauri/target/release/bundle/macos/JustToDo.app
#            src-tauri/target/release/bundle/dmg/JustToDo_0.1.0_aarch64.dmg(若 dmg 步骤成功)
#
# 签名（macOS 重要）：通知贪睡按钮（UNUserNotificationCenter）在 adhoc 签名下
# 系统直接拒绝通知授权（error 1，弹窗都不弹），必须用稳定身份签名。
# 默认使用钥匙串里的 Apple Development 证书；可用环境变量覆盖：
#   APPLE_SIGNING_IDENTITY="xxx" ./scripts/build-release.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# 未显式指定时使用本机 Apple Development 证书（保持授权记录跨打包稳定）
export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-Apple Development: 477939838@qq.com (FP6EVV3Y8A)}"

mkdir -p logs
LOG_FILE="logs/build-release-$(date +%Y%m%d-%H%M%S).log"

echo "==> Release 打包（签名: ${APPLE_SIGNING_IDENTITY}）,日志: $LOG_FILE"
npm run tauri build 2>&1 | tee "$LOG_FILE"
