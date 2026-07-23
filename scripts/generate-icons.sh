#!/usr/bin/env bash
# 从 src-tauri/icons/icon.png 主图自动衍生全套平台图标。
#
# 用法:
#   ./scripts/generate-icons.sh                  # 直接执行
#   ./scripts/generate-icons.sh path/to/x.png    # 用指定图片替换主图后衍生
#
# 前置:把 1024x1024 透明背景 PNG 放到 src-tauri/icons/icon.png(或作为参数传入)。
# 注意:本脚本不会备份现有 icons——备份由调用方决定(避免误删)。
set -euo pipefail

cd "$(dirname "$0")/.."

LOG_DIR="logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/generate-icons-$(date +%Y%m%d-%H%M%S).log"

SOURCE="${1:-src-tauri/icons/icon.png}"
ICON_DIR="src-tauri/icons"

if [[ ! -f "$SOURCE" ]]; then
  echo "✗ 主图不存在: $SOURCE" | tee -a "$LOG_FILE"
  exit 1
fi

echo "==> 主图: $SOURCE" | tee -a "$LOG_FILE"
echo "==> 输出: $ICON_DIR/" | tee -a "$LOG_FILE"
echo "==> 日志: $LOG_FILE" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

# 如果传入的是外部路径,先复制成 icon.png(作为新的主图)
if [[ "$SOURCE" != "$ICON_DIR/icon.png" ]]; then
  echo "==> 复制新主图到 $ICON_DIR/icon.png" | tee -a "$LOG_FILE"
  cp "$SOURCE" "$ICON_DIR/icon.png"
fi

# 备份现有衍生图标(保留主图 icon.png)
BACKUP_DIR="src-tauri/icons.bak.$(date +%Y%m%d-%H%M%S)"
echo "==> 备份现有衍生图标到 $BACKUP_DIR" | tee -a "$LOG_FILE"
mkdir -p "$BACKUP_DIR"
# 备份除 icon.png 外的所有文件
find "$ICON_DIR" -mindepth 1 -maxdepth 1 ! -name 'icon.png' -exec cp -R {} "$BACKUP_DIR"/ \;

# 调用 Tauri CLI 自动衍生所有平台图标
echo "==> 执行 npm run tauri icon" | tee -a "$LOG_FILE"
npm run tauri icon "$ICON_DIR/icon.png" 2>&1 | tee -a "$LOG_FILE"

echo "" | tee -a "$LOG_FILE"
echo "==> 完成。产物:" | tee -a "$LOG_FILE"
ls -la "$ICON_DIR" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"
echo "==> 旧图标备份: $BACKUP_DIR" | tee -a "$LOG_FILE"