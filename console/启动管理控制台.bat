@echo off
chcp 65001 >nul
title 多音源播放器 · 账号管理
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 需要 Node.js 才能运行，请先安装：https://nodejs.org/
  pause
  exit /b 1
)

echo 正在启动管理控制台...
start "" http://127.0.0.1:47800
node server.mjs

pause
