#!/usr/bin/env bash
# 安装项目依赖
# 用法： ./scripts/install-deps.sh
#
# 备注：所有 Run & Debug 相关命令一律通过 scripts/ 下的 .sh 启动。
# 这里只装 npm 依赖，不做更多的事情。
#
# Tiptap 系列内部传递依赖偶尔会出现 peerDependencies 冲突（不同 ^3.27.x
# 子版本指向了不同 core），用 --legacy-peer-deps 让 npm 跳过严格检测。
# 已有 package-lock.json；若 lock 不存在则用 --force 一次性解决。

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f package-lock.json ]; then
  npm install --legacy-peer-deps
else
  npm install --force
fi

