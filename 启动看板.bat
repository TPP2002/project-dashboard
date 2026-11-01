@echo off
chcp 65001 >nul
setlocal
rem 启动器在本检出目录工作，服务来自发布副本；绝不把当前目录切进发布副本。
rem cli\launcher.cjs 负责严格模式和显式 --standalone 的完整编排。
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [X] 没找到 Node.js，请安装后重试。
  pause
  exit /b 1
)
if defined DASHBOARD_HOME (set "LOGHOME=%DASHBOARD_HOME%") else (set "LOGHOME=%USERPROFILE%\.claude\dashboard")
wscript.exe //B //Nologo "%~dp0scripts/launcher-silent.vbs" %*
echo 看板已在后台启动，浏览器稍后自动打开；日志：%LOGHOME%\logs\launcher-YYYYMMDD.log；看护：node cli/watchdog.cjs status
exit /b 0
