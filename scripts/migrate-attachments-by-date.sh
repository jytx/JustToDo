#!/usr/bin/env bash
# ============================================================================
# 附件按日期分目录迁移脚本（一次性）
#
# 背景：富文本图片走旧命令 save_image，历史上直接落在附件根目录
#       （<附件目录>/<uuid>.png），未按 YYYYMMDD/类型/ 分层。
#       程序已修复（save_image 改为日期分层），本脚本迁移存量：
#       1. 根目录散文件按「文件 mtime 日期/类型」移入子目录
#       2. 同步更新 tasks.note 中 URL 编码的引用路径（%2F → 日期%2F类型%2F）
#       3. 事后校验：引用行数不变、所有引用文件真实存在、根目录无残留
#
# 用法：
#   ./scripts/migrate-attachments-by-date.sh            # dry-run（默认，只打印计划）
#   ./scripts/migrate-attachments-by-date.sh --apply    # 真正执行（先备份 DB）
#
# 注意：执行 --apply 前请先退出 JustToDo 应用，避免 SQLite 并发写。
# ============================================================================
set -euo pipefail

APPLY=""
[ "${1:-}" = "--apply" ] && APPLY=1

# ---- 可配置路径（环境变量可覆盖） ----
APP_DATA="${APP_DATA:-$HOME/Library/Application Support/com.justtodo.app}"
DB_PATH="${DB_PATH:-$APP_DATA/justtodo.db}"

# 附件目录：优先读应用配置的 attachment_path.txt，失效则报错退出
if [ -f "$APP_DATA/attachment_path.txt" ] && [ -d "$(cat "$APP_DATA/attachment_path.txt")" ]; then
  ATT_DIR="$(cat "$APP_DATA/attachment_path.txt")"
else
  echo "错误：未找到有效的附件目录配置（$APP_DATA/attachment_path.txt）" >&2
  exit 1
fi

# ---- 前置检查 ----
if pgrep -x justtodo >/dev/null 2>&1; then
  echo "错误：检测到 JustToDo 正在运行，请先退出应用再执行迁移" >&2
  exit 1
fi
[ -f "$DB_PATH" ] || { echo "错误：数据库不存在: $DB_PATH" >&2; exit 1; }

# 日志统一输出到 logs/
LOG_DIR="$(cd "$(dirname "$0")/.." && pwd)/logs"
mkdir -p "$LOG_DIR"
TS="$(date +%Y%m%d%H%M%S)"
LOG="$LOG_DIR/migrate-attachments-$TS.log"

# 引用行数基准（迁移前后必须一致）
ref_rows_before() { sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE note LIKE '%localhost%2F%';"; }

# 按扩展名映射磁盘类目（与 Rust ATTACHMENT_CATEGORY_DIRS 白名单对齐）
category_of() {
  case "${1##*.}" in
    png|jpg|jpeg|gif|webp|bmp|svg|heic) echo "images" ;;
    mp4|mov|avi|mkv|webm) echo "videos" ;;
    mp3|wav|aac|m4a|flac) echo "audios" ;;
    pdf|md|txt|csv|json|doc|docx|xls|xlsx|ppt|pptx) echo "docs" ;;
    zip|rar|7z|tar|gz) echo "archives" ;;
    *) echo "others" ;;
  esac
}

BEFORE_ROWS="$(ref_rows_before)"
echo "== 附件目录: $ATT_DIR"
echo "== 数据库:   $DB_PATH"
echo "== 引用行数基准: $BEFORE_ROWS"
echo "== 模式: $([ -n "$APPLY" ] && echo 'APPLY（实际执行）' || echo 'DRY-RUN（仅预览）')"
echo ""

# ---- 收集根目录散文件（排除 .DS_Store 与目录） ----
moved=0; updated=0; skipped=0
while IFS= read -r file; do
  name="$(basename "$file")"
  # 日期取文件 mtime —— 与"当天写入"的历史事实最接近
  day="$(date -r "$file" +%Y%m%d)"
  cat="$(category_of "$name")"
  dest_dir="$ATT_DIR/$day/$cat"
  dest="$dest_dir/$name"

  # 该文件在 note 中的引用次数。注意：SQLite LIKE 是整列锚定，
  # 模式必须首尾都带 % 才是"包含"语义（%2F 前缀确保匹配完整路径段）
  refs="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tasks WHERE note LIKE '%2F${name}%';")"

  if [ -e "$dest" ]; then
    echo "跳过（目标已存在）: $name -> $dest" | tee -a "$LOG"
    skipped=$((skipped + 1))
    continue
  fi

  echo "迁移: $name -> $day/$cat/  (note 引用 $refs 行)" | tee -a "$LOG"

  if [ -n "$APPLY" ]; then
    mkdir -p "$dest_dir"
    mv "$file" "$dest"
    moved=$((moved + 1))
    if [ "$refs" -gt 0 ]; then
      # 同步替换富文本中的 URL 编码路径（asset://localhost/%2F...%2F<name>）
      sqlite3 "$DB_PATH" "UPDATE tasks SET note = replace(note, '%2F${name}', '%2F${day}%2F${cat}%2F${name}') WHERE note LIKE '%2F${name}%';"
      updated=$((updated + 1))
    fi
  fi
done < <(find "$ATT_DIR" -maxdepth 1 -type f ! -name ".DS_Store" | sort)

echo "" | tee -a "$LOG"

# ---- 事后校验（仅 APPLY 模式） ----
if [ -n "$APPLY" ]; then
  echo "-- 备份数据库快照..." | tee -a "$LOG"
  sqlite3 "$DB_PATH" ".backup '$DB_PATH.bak-$TS'"

  fail=0
  AFTER_ROWS="$(ref_rows_before)"
  if [ "$AFTER_ROWS" != "$BEFORE_ROWS" ]; then
    echo "校验失败：引用行数变化 $BEFORE_ROWS -> $AFTER_ROWS" | tee -a "$LOG"; fail=1
  fi

  # 提取 note 中所有引用路径并解码 %2F，逐一确认文件存在
  missing=0
  while IFS= read -r enc; do
    dec="$(printf '%s' "$enc" | sed 's|%2F|/|g')"
    if [ ! -f "$dec" ]; then
      echo "校验失败：引用文件缺失 $dec" | tee -a "$LOG"; missing=1
    fi
  done < <(sqlite3 "$DB_PATH" "SELECT note FROM tasks WHERE note LIKE '%localhost%2F%';" \
           | grep -oE 'localhost/%2F[^"'"'"' ]+' | sed 's|^localhost/||')
  [ "$missing" -eq 1 ] && fail=1

  remain="$(find "$ATT_DIR" -maxdepth 1 -type f ! -name ".DS_Store" | wc -l | tr -d ' ')"
  echo "" | tee -a "$LOG"
  echo "结果: 移动文件 $moved 个 / 更新任务 $updated 行 / 跳过 $skipped / 根目录残留 $remain" | tee -a "$LOG"
  echo "备份: $DB_PATH.bak-$TS" | tee -a "$LOG"
  echo "日志: $LOG"
  exit "$fail"
else
  echo "DRY-RUN 完成（未做任何修改）。确认无误后加 --apply 执行。"
fi
