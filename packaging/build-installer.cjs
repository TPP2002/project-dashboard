'use strict';
/**
 * packaging/build-installer.cjs —— 把「项目管理看板」打包成社区可分发的 Windows 安装器 (.exe)。
 *
 * 产物：一个内嵌 Node 运行时的 NSIS 安装器，社区用户双击安装即用，
 *      不需要预装 Node.js、不需要联网、不碰 ~/.claude（数据落安装目录）。
 *
 * 用法（在装有 Node 的开发机上跑一次，产出 exe 拿去分发）：
 *   node packaging/build-installer.cjs [--version 1.0.0] [--skip-selfcheck]
 *   node packaging/build-installer.cjs --help
 *
 * 依赖：
 *   - Node（跑本脚本 + 被打包进去当运行时，用的是本机 process.execPath）。
 *   - makensis.exe（NSIS 3 编译器）。优先用 electron-builder 缓存里的那份；
 *     没有则报错并给出获取指引（本脚本不联网下载）。
 *
 * 铁律：只读看板源码 + 只写 packaging/ 下的 staging/dist，绝不改被打包的源文件。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const cp = require('node:child_process');
const { RUNTIME_PATHS } = require('../core/runtimeRoot.cjs');

// ---------- 路径 ----------
const DASH = path.resolve(__dirname, '..');            // ~/.claude/dashboard（看板源码根）
const PKG = __dirname;                                  // packaging/
const STAGING = path.join(PKG, 'staging');              // 暂存区（安装目录的镜像）
const ROOT = path.join(STAGING, 'root');                // 将成为安装目录的内容
const OUTDIR = path.join(PKG, 'dist');                  // 安装器 exe 输出目录
const NODE_EXE = process.execPath;                      // 本机 node.exe，直接当运行时打包

// ---------- 版本 ----------
function parseArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const APPNAME = '项目管理看板';
const APPID = 'ProjectDashboard';                        // 安装目录 / 卸载注册表键（ASCII，稳）

// ---------- 找 makensis ----------
function findMakensis() {
  const cacheRoot = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'nsis');
  const candidates = [];
  try {
    for (const d of fs.readdirSync(cacheRoot)) {
      if (d.startsWith('nsis-') && !d.startsWith('nsis-resources')) {
        candidates.push(path.join(cacheRoot, d, 'makensis.exe'));
      }
    }
  } catch (_) { /* 缓存不存在 */ }
  // 也看 PATH / 常见安装位置
  candidates.push(path.join('C:', 'Program Files (x86)', 'NSIS', 'makensis.exe'));
  candidates.push(path.join('C:', 'Program Files', 'NSIS', 'makensis.exe'));
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return null;
}

// ---------- 找 csc（.NET 编译器，用于编托盘启动器；缺则回退 .bat）----------
function findCsc() {
  const fw = path.join('C:', 'Windows', 'Microsoft.NET', 'Framework64');
  const cands = [];
  try {
    for (const d of fs.readdirSync(fw)) {
      if (d.startsWith('v4.')) cands.push(path.join(fw, d, 'csc.exe'));
    }
  } catch (_) { /* 无 .NET */ }
  cands.sort().reverse(); // 取较新的 v4.x
  for (const c of cands) { if (fs.existsSync(c)) return c; }
  return null;
}

// ---------- 工具 ----------
function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function copy(src, dst) { fs.cpSync(src, dst, { recursive: true }); }
function writeUtf8(p, s) { mkdirp(path.dirname(p)); fs.writeFileSync(p, s, 'utf8'); }
function writeUtf8Bom(p, s) { mkdirp(path.dirname(p)); fs.writeFileSync(p, '﻿' + s, 'utf8'); }
function dirSizeMB(p) {
  let total = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp); else total += fs.statSync(fp).size;
    }
  })(p);
  return total / 1048576;
}

/**
 * 同步重建 dest（必填，调用方指定的安装目录），源码只读。
 * distDir/nodeExe 可注入；缺前端入口或任何运行期路径就抛错。
 * 返回启动器、图标和体积信息，供 main 生成原有安装脚本；log 可用空函数静音。
 */
function stageRoot(opts = {}) {
  const DASH = path.resolve(opts.src ?? path.resolve(__dirname, '..'));
  if (typeof opts.dest !== 'string' || !opts.dest.trim()) throw new Error('搭建安装目录必须指定 dest。');
  const ROOT = path.resolve(opts.dest);
  const NODE_EXE = path.resolve(opts.nodeExe ?? process.execPath);
  const DIST_DIR = path.resolve(opts.distDir ?? path.join(DASH, 'web', 'dist'));
  const ICON = path.join(DASH, 'packaging', 'assets', 'icon.ico');
  const TRAY_SRC = path.join(DASH, 'packaging', 'tray', 'Dashboard.cs');
  const log = opts.log ?? console.log;

  // 清空前先确认目标不包含源码，也不落进将要拷贝的目录，免得误删输入或递归拷自己。
  const contains = (parent, child) => {
    const rel = path.relative(parent, child);
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
  };
  const inputs = [...RUNTIME_PATHS.map(rel => path.join(DASH, rel)), DIST_DIR, NODE_EXE];
  if (contains(ROOT, DASH) || inputs.some(input => contains(ROOT, input) || contains(input, ROOT))) {
    throw new Error('安装目录不能覆盖源码或待拷贝的输入：' + ROOT);
  }
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    throw new Error('前端产物缺 index.html：' + DIST_DIR + '；请先构建 web/dist，或指定 distDir。');
  }
  for (const rel of RUNTIME_PATHS) {
    if (!fs.existsSync(path.join(DASH, rel))) throw new Error('缺少运行期路径：' + rel);
  }
  const VERSION = opts.version ?? JSON.parse(fs.readFileSync(path.join(DASH, 'package.json'), 'utf8')).version;

  // ============ 1. 清空并搭建 staging ============
  log('\n[1/6] 搭建暂存目录 ...');
  rmrf(ROOT);
  mkdirp(ROOT);

  // 和 cli release 共用白名单，目录整拷：以后新增同目录模块也不会漏带。
  for (const rel of RUNTIME_PATHS) copy(path.join(DASH, rel), path.join(ROOT, rel));
  mkdirp(path.join(ROOT, 'web'));
  copy(DIST_DIR, path.join(ROOT, 'web', 'dist'));
  if (fs.existsSync(path.join(DASH, 'README.md'))) copy(path.join(DASH, 'README.md'), path.join(ROOT, 'README.md'));

  // —— 使用手册放到根，用户一眼能找到 ——
  const manualSrc = path.join(DASH, 'docs', '看板使用手册.md');
  if (fs.existsSync(manualSrc)) copy(manualSrc, path.join(ROOT, '使用手册.md'));

  // —— 内嵌 Node 运行时 ——
  mkdirp(path.join(ROOT, 'node-runtime'));
  copy(NODE_EXE, path.join(ROOT, 'node-runtime', 'node.exe'));

  // —— 干净的 registry（绝不带打包机上的私人项目路径）——
  writeUtf8(path.join(ROOT, 'registry.json'), JSON.stringify({ schemaVersion: '1.0', projects: {} }, null, 2) + '\n');

  // ============ 2. 生成启动器 / 助手脚本 / 说明 ============
  log('[2/6] 生成启动器与说明 ...');

  // 主启动器：设 DASHBOARD_HOME=安装目录，用内嵌 node 起 server
  const launcherBat =
`@echo off
chcp 65001 >nul
title ${APPNAME}
cd /d "%~dp0"
rem 数据根 = 安装目录（脱离 ~/.claude，纯绿色，卸载即净）
set "DASHBOARD_HOME=%~dp0"
if "%DASHBOARD_HOME:~-1%"=="\\" set "DASHBOARD_HOME=%DASHBOARD_HOME:~0,-1%"

echo.
echo ================================================
echo   ${APPNAME}  正在启动...
echo ================================================
echo   浏览器稍后自动打开；没打开就手动访问下面显示的地址。
echo   关闭看板：按 Ctrl+C 或直接关掉本窗口。
echo.

"%~dp0node-runtime\\node.exe" "%~dp0server\\server.cjs"

echo.
echo 看板已停止，可关闭本窗口。
pause >nul
`;
  writeUtf8Bom(path.join(ROOT, '启动看板.bat'), launcherBat);

  // 添加项目助手：向导式包装 cli register，非技术用户也能加项目
  const addProjectBat =
`@echo off
chcp 65001 >nul
title ${APPNAME} - 添加项目
cd /d "%~dp0"
set "DASHBOARD_HOME=%~dp0"
if "%DASHBOARD_HOME:~-1%"=="\\" set "DASHBOARD_HOME=%DASHBOARD_HOME:~0,-1%"

echo.
echo ==== 把一个项目加入看板（一次性设置）====
echo.
echo 提示：项目代号用英文/数字（如 myapp）；项目文件夹可直接拖进本窗口再回车。
echo.
set /p PID=1) 项目代号:
set /p PNAME=2) 项目名称（显示用）:
set /p PROOT=3) 项目文件夹路径:
echo.
"%~dp0node-runtime\\node.exe" "%~dp0cli\\index.cjs" register --id "%PID%" --name "%PNAME%" --root "%PROOT%"
echo.
echo 若上面显示已注册，回到看板刷新即可看到该项目。
echo 之后可用命令给项目加任务：node-runtime\\node.exe cli\\index.cjs add ^<任务号^> --project %PID% --title "标题"
echo.
pause
`;
  writeUtf8Bom(path.join(ROOT, '添加项目.bat'), addProjectBat);

  // Node.js 再分发声明（MIT，附带义务）
  const notice =
`本安装包内嵌了 Node.js 运行时（node-runtime\\node.exe）。

Node.js 版权归 Node.js 贡献者与 OpenJS Foundation 所有，以 MIT 许可证发布。
许可证全文见：https://github.com/nodejs/node/blob/main/LICENSE
打包所用版本：${process.version}

「项目管理看板」自身的许可与版权由其作者决定；本文件仅声明所内嵌第三方组件。
`;
  writeUtf8(path.join(ROOT, 'NOTICE-第三方声明.txt'), notice);

  // 首次使用速览
  const quickstart =
`${APPNAME} · 快速开始
${'='.repeat(40)}

1) 启动：双击「${APPNAME}」桌面图标，或本文件夹里的「启动看板.bat」。
   浏览器会自动打开 http://127.0.0.1:6060/（端口被占会自动顺延）。

2) 第一次是空的？双击「添加项目.bat」把你的项目文件夹加进来。
   （或用命令：node-runtime\\node.exe cli\\index.cjs register --id <代号> --name <名称> --root <文件夹>）

3) 关闭：关掉那个黑色命令行窗口，或在里面按 Ctrl+C。

详细图文见同目录「使用手册.md」。
数据只存在本安装目录（registry.json + 各项目的 .dashboard\\board.json），不联网、不上传。
`;
  writeUtf8Bom(path.join(ROOT, '开始使用.txt'), quickstart);

  // —— 品牌图标 + 托盘启动器 ——
  let hasIcon = fs.existsSync(ICON);
  if (hasIcon) copy(ICON, path.join(ROOT, 'icon.ico'));
  else log('  [!] 缺 assets/icon.ico，将用默认图标（可先跑 packaging/make-icon.ps1 生成）。');

  let useTray = false;
  const csc = findCsc();
  if (csc && fs.existsSync(TRAY_SRC)) {
    const trayOut = path.join(ROOT, 'Dashboard.exe');
    const cscArgs = ['/nologo', '/target:winexe', '/codepage:65001',
      '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.dll',
      '/out:' + trayOut, TRAY_SRC];
    if (hasIcon) cscArgs.splice(3, 0, '/win32icon:' + ICON);
    const rc = cp.spawnSync(csc, cscArgs, { encoding: 'utf8', windowsHide: true });
    if (rc.status === 0 && fs.existsSync(trayOut)) {
      useTray = true;
      log('  ✔ 托盘启动器 Dashboard.exe 已编译（隐藏黑窗口 + 托盘图标）。');
    } else {
      log('  [!] 托盘启动器编译失败，回退到 启动看板.bat（带控制台窗口）。');
      if (rc.stderr) log('      ' + rc.stderr.split('\n').slice(0, 4).join('\n      '));
      if (rc.error) log('      ' + rc.error.message);
    }
  } else {
    log('  [!] 没找到 csc（.NET 编译器）或托盘源码，用 启动看板.bat（带控制台窗口）。');
  }
  // 主启动目标：有托盘用 Dashboard.exe，否则用 .bat
  const LAUNCH_TARGET = useTray ? 'Dashboard.exe' : '启动看板.bat';
  const ICON_REF = hasIcon ? '$INSTDIR\\icon.ico' : (useTray ? '$INSTDIR\\Dashboard.exe' : '$INSTDIR\\node-runtime\\node.exe');

  return { root: ROOT, useTray, hasIcon, launchTarget: LAUNCH_TARGET, iconRef: ICON_REF, sizeMB: dirSizeMB(ROOT), version: VERSION };
}

/**
 * 用内嵌运行时检查安装目录，成功返回本次子进程的 health。
 * timeoutMs 默认 30000 毫秒；失败带 stderr 开头，无论成败都等子进程退出后才返回。
 */
async function selfCheckStagedRoot(root, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const log = opts.log ?? console.log;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('自检 timeoutMs 必须是正数。');
  root = path.resolve(root);
  // 随机只用于避开日常服务端口，不参与业务数据；仍须核对 pid，防止单实例复用造成假绿。
  const port = 40000 + Math.floor(Math.random() * 20001);
  log(`  自检：用内嵌 node 启动服务（端口 ${port}）...`);
  let child;
  try {
    child = cp.spawn(path.join(root, 'node-runtime', 'node.exe'), [path.join(root, 'server', 'server.cjs')], {
      cwd: root,
      env: { ...process.env, DASHBOARD_HOME: root, DASHBOARD_REGISTRY: path.join(root, 'registry.json'),
        DASHBOARD_NO_OPEN: '1', DASHBOARD_PORT: String(port) },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err) {
    throw new Error('自检启动失败：' + err.message + '\n子进程 stderr：（尚未启动，无输出）');
  }

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(0, 16384); });
  let exited = false;
  const exit = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
  // close 晚于 exit，确保 stderr 已读完、Windows 上可执行文件也已释放。
  const closed = new Promise(resolve => child.once('close', resolve));
  let request, pollTimer, deadlineTimer, killTimer;
  let settled = false;
  let health, failure;
  try {
    health = await new Promise((resolve, reject) => {
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve(value);
      };
      const fail = err => finish(err);
      child.once('error', err => fail(new Error('子进程启动或终止失败：' + err.message)));
      child.once('exit', (code, signal) => fail(new Error(`子进程提前退出（退出码 ${code}，信号 ${signal || '无'}）`)));
      deadlineTimer = setTimeout(() => fail(new Error(`等待 /api/health 超时（${timeoutMs} 毫秒）`)), timeoutMs);

      function poll() {
        if (settled) return;
        request = http.get({ host: '127.0.0.1', port, path: '/api/health', agent: false }, res => {
          let body = '';
          res.setEncoding('utf8');
          res.on('error', fail);
          res.on('data', chunk => {
            body += chunk;
            if (body.length > 65536) fail(new Error('健康响应过大，无法验证服务身份。'));
          });
          res.on('end', () => {
            if (settled) return;
            let value;
            try { value = JSON.parse(body); }
            catch (err) { fail(new Error('健康响应不是有效 JSON：' + err.message)); return; }
            if (res.statusCode !== 200 || value?.ok !== true || value?.service !== 'claude-dashboard' || value?.pid !== child.pid) {
              fail(new Error(`健康响应不属于本次启动的服务（HTTP ${res.statusCode}，期望 pid ${child.pid}，收到 ${body.slice(0, 512)}）`));
              return;
            }
            finish(null, value);
          });
        });
        request.setTimeout(1000, () => request.destroy(new Error('探活请求超时')));
        // 启动阶段的连接拒绝属于尚未就绪；总超时统一兜底，不无限重试。
        request.once('error', () => { if (!settled) pollTimer = setTimeout(poll, 100); });
      }
      poll();
    });
  } catch (err) {
    failure = err;
  } finally {
    settled = true;
    clearTimeout(deadlineTimer);
    clearTimeout(pollTimer);
    if (request) request.destroy();
    if (child.pid && !exited) {
      child.kill();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exit;
      clearTimeout(killTimer);
    }
    await closed;
  }
  if (failure) {
    const excerpt = stderr.trim().split(/\r?\n/).slice(0, 12).join('\n') || '（无输出）';
    throw new Error(`自检失败（端口 ${port}，pid ${child.pid || '未启动'}）：${failure.message}\n子进程 stderr（前几行）：\n${excerpt}`);
  }
  log(`  ✔ 自检通过：服务正常应答，pid ${health.pid}；自检进程已退出。`);
  return health;
}

async function main() {
  const log = console.log;
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    log('用法：node packaging/build-installer.cjs [--version 1.0.0] [--skip-selfcheck]');
    log('默认在编译安装器前启动内嵌服务自检；--skip-selfcheck 仅用于调试。');
    return;
  }
  try {
    // ============ 校验前置（只有直接执行脚本才跑，require 保持安静） ============
    const pkgJson = JSON.parse(fs.readFileSync(path.join(DASH, 'package.json'), 'utf8'));
    const VERSION = parseArg('version', pkgJson.version || '1.0.0');
    log('== 项目管理看板 · 打包 ==');
    log('  看板源码：' + DASH);
    log('  版本    ：' + VERSION);
    const MAKENSIS = findMakensis();
    if (!MAKENSIS) {
      throw new Error('没找到 makensis.exe（NSIS 3 编译器）。\n' +
        '    方案A：装过 electron-builder 的机器上其缓存自带（本脚本会自动找）。\n' +
        '    方案B：到 https://nsis.sourceforge.io/ 下载安装 NSIS 3，再重试。');
    }
    log('  makensis：' + MAKENSIS);
    log('  node.exe：' + NODE_EXE + '（' + (fs.statSync(NODE_EXE).size / 1048576).toFixed(1) + 'MB）');
    const { useTray, hasIcon, launchTarget: LAUNCH_TARGET, iconRef: ICON_REF, sizeMB } = stageRoot({ dest: ROOT, version: VERSION, log });
    const ICON = path.join(DASH, 'packaging', 'assets', 'icon.ico');

    // ============ 3. 自检（先验能启动，再花时间压缩） ============
    if (process.argv.includes('--skip-selfcheck')) log('[3/6] [!] 已跳过启动自检（仅供调试）。');
    else {
      log('[3/6] 检查安装目录能否正常启动 ...');
      await selfCheckStagedRoot(ROOT, { log });
    }

    // ============ 4. 生成 NSIS 脚本 ============
    log('[4/6] 生成 NSIS 脚本 ...');
    mkdirp(OUTDIR);
    const installedMB = Math.ceil(sizeMB);
    const outExe = path.join(OUTDIR, `${APPNAME}-安装程序-v${VERSION}.exe`);
    const nsiPath = path.join(STAGING, 'installer.nsi');

    // NSIS 里用到的绝对路径统一转成反斜杠
    const bs = (p) => p.replace(/\//g, '\\');

    const nsi =
`Unicode true
!include "MUI2.nsh"

!define APPNAME "${APPNAME}"
!define APPID "${APPID}"
!define VERSION "${VERSION}"

Name "\${APPNAME}"
OutFile "${bs(outExe)}"
InstallDir "$LOCALAPPDATA\\Programs\\${APPID}"
InstallDirRegKey HKCU "Software\\${APPID}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "\${APPNAME} v\${VERSION}"

${hasIcon ? `!define MUI_ICON "${bs(ICON)}"
!define MUI_UNICON "${bs(ICON)}"
` : ''}!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\\${LAUNCH_TARGET}"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 \${APPNAME}"
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\\使用手册.md"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "打开使用手册"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${bs(ROOT)}\\*"

  ; —— 快捷方式（图标暂用 node.exe 自带；品牌图标见打磨清单）——
  CreateDirectory "$SMPROGRAMS\\\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\\\${APPNAME}\\\${APPNAME}.lnk" "$INSTDIR\\${LAUNCH_TARGET}" "" "${ICON_REF}" 0
  CreateShortcut "$SMPROGRAMS\\\${APPNAME}\\添加项目.lnk" "$INSTDIR\\添加项目.bat" "" "${ICON_REF}" 0
  CreateShortcut "$SMPROGRAMS\\\${APPNAME}\\使用手册.lnk" "$INSTDIR\\使用手册.md"
${useTray ? `  CreateShortcut "$SMPROGRAMS\\\${APPNAME}\\启动看板（控制台调试）.lnk" "$INSTDIR\\启动看板.bat" "" "${ICON_REF}" 0
` : ''}  CreateShortcut "$SMPROGRAMS\\\${APPNAME}\\卸载 \${APPNAME}.lnk" "$INSTDIR\\uninstall.exe"
  CreateShortcut "$DESKTOP\\\${APPNAME}.lnk" "$INSTDIR\\${LAUNCH_TARGET}" "" "${ICON_REF}" 0

  ; —— 卸载信息 + 控制面板「程序和功能」——
  WriteRegStr HKCU "Software\\${APPID}" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\\uninstall.exe"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APPID}" "DisplayName" "\${APPNAME}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APPID}" "DisplayVersion" "\${VERSION}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APPID}" "UninstallString" "$\\"$INSTDIR\\uninstall.exe$\\""
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APPID}" "DisplayIcon" "${ICON_REF}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APPID}" "Publisher" "\${APPNAME}"
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APPID}" "NoModify" 1
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APPID}" "NoRepair" 1
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APPID}" "EstimatedSize" ${installedMB * 1024}
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\\\${APPNAME}.lnk"
  RMDir /r "$SMPROGRAMS\\\${APPNAME}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APPID}"
  DeleteRegKey HKCU "Software\\${APPID}"
SectionEnd
`;
    writeUtf8Bom(nsiPath, nsi);

    // ============ 5. 调 makensis 编译 ============
    log('[5/6] 调 makensis 编译安装器（LZMA solid 压缩，稍慢）...');
    const r = cp.spawnSync(MAKENSIS, [nsiPath], { encoding: 'utf8', windowsHide: true });
    if (r.stdout) log(r.stdout.split('\n').slice(-12).join('\n'));
    if (r.status !== 0) {
      throw new Error('makensis 编译失败（退出码 ' + r.status + '）。\n' + (r.stderr || r.error?.message || ''));
    }

    // ============ 完成 ============
    log('[6/6] 完成 ✔');
    if (fs.existsSync(outExe)) {
      log('\n安装器已生成：');
      log('  ' + outExe);
      log('  体积：' + (fs.statSync(outExe).size / 1048576).toFixed(1) + 'MB（安装后约 ' + installedMB + 'MB）');
    } else {
      throw new Error('编译似乎成功但没找到产物：' + outExe);
    }
  } catch (err) {
    log('\n[X] ' + err.message);
    process.exit(1);
  }
}

module.exports = { stageRoot, selfCheckStagedRoot };
if (require.main === module) main();
