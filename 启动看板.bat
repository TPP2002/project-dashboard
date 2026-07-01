@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 项目管理看板

rem 切到脚本所在目录（看板根目录）
cd /d "%~dp0"

echo.
echo ================================================
echo   项目管理看板 - 一键启动
echo ================================================
echo.

rem ---- 检查 Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo [X] 没找到 Node.js，看板运行需要它。
  echo     请到 https://nodejs.org/ 下载安装 LTS 版本后，再双击本文件。
  echo.
  pause
  exit /b 1
)

rem ---- 第一次使用：安装界面依赖（只装一次）----
if not exist "web\node_modules" (
  echo [1/3] 第一次使用，正在安装界面依赖（只需一次，可能要一两分钟）...
  pushd web
  call npm install
  set "INSTALL_ERR=!errorlevel!"
  popd
  if not "!INSTALL_ERR!"=="0" (
    echo.
    echo [X] 依赖安装失败（多半是网络问题）。
    echo     请连上网后，在 web 文件夹里手动运行： npm install
    echo.
    pause
    exit /b 1
  )
) else (
  echo [1/3] 界面依赖已就绪。
)

rem ---- 生成最新界面 ----
echo [2/3] 正在生成最新界面（npm run build）...
pushd web
call npm run build
popd

rem ---- 构建后仍无界面产物 → 友好提示 ----
if not exist "web\dist\index.html" (
  echo.
  echo [X] 还没有可用的界面（web\dist 不存在）。
  echo     请先在 web 文件夹里运行： npm run build
  echo     若提示缺少依赖，请先运行： npm install
  echo.
  pause
  exit /b 1
)

rem ---- 启动服务（server 会自动开浏览器 + 单实例复用）----
echo [3/3] 正在启动看板服务，浏览器稍后自动打开...
echo     关闭看板：在本窗口按 Ctrl+C，或直接关掉窗口。
echo.
node server\server.cjs

echo.
echo 看板服务已停止。可关闭本窗口。
pause
