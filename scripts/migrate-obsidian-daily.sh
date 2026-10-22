#!/usr/bin/env bash
# ============================================================================
# Obsidian Daily → JustToDo 数据迁移（一次性）
#
# 背景：JustToDo 完成前的每日待办记录在 Obsidian vault 的 Daily 目录，
#       本脚本将其迁入 JustToDo：
#       1. 工作清单下按月/按日建清单（2026-01 ~ 2026-06 新建月清单，
#          2026-07/08 复用现有；缺失日清单补建，已存在的日清单追加任务）
#       2. checkbox 转任务（- [x] → 已完成），NOTE 块转备注，
#          优先级 ⏫/🔼/🔽 → 高/中/低，Tab 缩进 → 子任务
#       3. 图片附件按「YYYYMMDD/images/」规则复制到 JustToDo 附件目录
#
# 安全：默认 dry-run 仅预览；--apply 时自动备份 justtodo.db.bak-<时间戳>，
#       事务写入、仅 INSERT、失败回滚；Daily 原文件全程只读；
#       同清单同标题任务判重跳过，可安全重跑。
#       执行前请先退出 JustToDo 应用（脚本会检测）。
#
# 用法：
#   ./scripts/migrate-obsidian-daily.sh            # dry-run 预览
#   ./scripts/migrate-obsidian-daily.sh --apply    # 实际执行（先自动备份）
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

exec node --no-warnings scripts/migrate-obsidian-daily.mjs "$@"
