@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 项目管理看板

rem ============================================================
rem  项目管理看板 · 一键启动
rem
rem  做三件事：①备好界面依赖 ②把主干最新代码 + 现场构建的界面【发布】出去 ③从发布副本起服务。
rem
rem  【为什么不直接从这个目录起服务】(SERVER-RUNS-ON-LIVE-CHECKOUT，负责人 0906 拍板)
rem  这里是看板仓库的【活的工作检出】——随时有对话在切分支、留未提交改动。从这里起服务，
rem  等于负责人天天看的看板跟着别人改到一半的代码漂；而且服务是常驻进程，合进主干也一直不生效。
rem  所以：代码一律从只读的【发布副本】起（发布副本由 cli release 从 origin/主干 导出 + 现场构建界面）。
rem
rem  【落脚点纪律】本窗口的当前目录留在本检出，绝不 cd 进发布副本 ——
rem  Windows 上目录只要是某个进程的当前目录就换不了名，下次 cli release 换名必然失败（实测 EBUSY）。
rem ============================================================

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

rem ---- 第一次使用：安装界面依赖（发布时要用它把界面构建出来，只装一次）----
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

rem ---- 发布：把 origin/主干 的代码导出成发布副本，并用同一个提交现场构建界面 ----
echo [2/3] 正在发布最新版本（导出主干代码 + 构建界面，可能要几十秒）...
node cli\index.cjs release
set "REL_ERR=!errorlevel!"

rem ---- 找到发布副本目录（服务从它起）----
set "REL="
for /f "usebackq delims=" %%i in (`node cli\index.cjs release --print-dest`) do set "REL=%%i"
if not defined REL (
  echo.
  echo [X] 取不到发布副本目录，起不了服务。上面 node 的输出里有原因。
  echo.
  pause
  exit /b 1
)

if not "!REL_ERR!"=="0" (
  if exist "!REL!\server\server.cjs" (
    echo.
    echo [!] 这次发布没成功（上面有原因，多半是没联网，或者界面构建报错）。
    echo     先用上一次发布好的那份启动 —— 它可能不是最新的。
    echo.
  ) else (
    echo.
    echo [X] 发布失败，而且这台机器上还没有可用的发布副本，起不了服务。
    echo     联网后重试；只想先起后台不看界面，可手动运行： node cli\index.cjs release --skip-web
    echo.
    pause
    exit /b 1
  )
)

rem ---- 启动服务（代码来自发布副本；已在跑的若是旧版本，服务自己会换新）----
echo [3/3] 正在启动看板服务（代码来自：!REL!），浏览器稍后自动打开...
echo     关闭看板：在本窗口按 Ctrl+C，或直接关掉窗口。
echo.
node "!REL!\server\server.cjs"

echo.
echo 看板服务已停止。可关闭本窗口。
pause
