#!/bin/sh
# 小林的音源扩展 · 本地管理控制台
#
# 正常情况下宿主会自动启动控制台，这个脚本用于手动启动或排查问题。

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node。请先安装 Node.js 18+：https://nodejs.org/"
  exit 1
fi

# 已经有一个在跑就只打开浏览器
if curl -s -o /dev/null -m 1 "http://127.0.0.1:47800/api/status"; then
  echo "控制台已在运行：http://127.0.0.1:47800"
else
  echo "启动控制台：http://127.0.0.1:47800"
  node server.mjs &
  sleep 1
fi

# macOS 用 open，Linux 用 xdg-open
if command -v open >/dev/null 2>&1; then
  open "http://127.0.0.1:47800"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://127.0.0.1:47800"
else
  echo "请手动打开：http://127.0.0.1:47800"
fi
