@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 项目管理看板

rem ============================================================
rem  项目管理看板 · 一键启动（薄入口）
rem
rem  全部编排都在 cli\launcher.cjs（DASH-LAUNCHER-NO-SCHED-HOLD-1012）：
rem  ①备好界面依赖 ②把主干最新代码 + 现场构建的界面【发布】出去 ③起常驻服务。
rem
rem  【两种模式】默认【严格模式】：整条启动链（首次依赖安装、现场构建、常驻服务）一律经调度台登记
rem  （常驻服务只申请 1 核的真实长期占用单）；调度台不可用就明确拒绝新启动，不降级、不裸跑。
rem  无调度台的用户显式加参数走独立模式： 启动看板.bat --standalone （整条链路不经调度台）。
rem  细节与实据见 docs\launcher-hold-1014.md。
rem
rem  【为什么不直接从这个目录起服务】(SERVER-RUNS-ON-LIVE-CHECKOUT，负责人 0906 拍板)
rem  这里是看板仓库的【活的工作检出】——随时有对话在切分支、留未提交改动。服务一律从只读的
rem  【发布副本】起（由 cli release 从 origin/主干 导出 + 现场构建界面）。
rem
rem  【落脚点纪律】本窗口的当前目录留在本检出，绝不 cd 进发布副本 ——
rem  Windows 上目录只要是某个进程的当前目录就换不了名，下次 cli release 换名必然失败（实测 EBUSY）。
rem ============================================================

cd /d "%~dp0"

rem ---- 检查 Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo [X] 没找到 Node.js，看板运行需要它。
  echo     请到 https://nodejs.org/ 下载安装 LTS 版本后，再双击本文件。
  echo.
  pause
  exit /b 1
)

rem ---- 全部逻辑交给启动器；参数原样转发（--standalone 走显式独立模式）----
node cli\launcher.cjs %*
set "RC=!errorlevel!"

if not "!RC!"=="0" (
  echo.
  echo [X] 启动器退出码 !RC! —— 上面有原因说明。
  echo.
  pause
  exit /b !RC!
)

echo.
echo 看板服务已停止。可关闭本窗口。
pause
exit /b 0

