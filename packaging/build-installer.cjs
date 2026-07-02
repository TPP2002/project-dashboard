'use strict';
/**
 * packaging/build-installer.cjs —— 把「项目管理看板」打包成社区可分发的 Windows 安装器 (.exe)。
 *
 * 产物：一个内嵌 Node 运行时的 NSIS 安装器，社区用户双击安装即用，
 *      不需要预装 Node.js、不需要联网、不碰 ~/.claude（数据落安装目录）。
 *
 * 用法（在装有 Node 的开发机上跑一次，产出 exe 拿去分发）：
 *   node packaging/build-installer.cjs [--version 1.0.0]
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
const cp = require('node:child_process');

// ---------- 路径 ----------
const DASH = path.resolve(__dirname, '..');            // ~/.claude/dashboard（看板源码根）
const PKG = __dirname;                                  // packaging/
const STAGING = path.join(PKG, 'staging');              // 暂存区（安装目录的镜像）
const ROOT = path.join(STAGING, 'root');                // 将成为安装目录的内容
const OUTDIR = path.join(PKG, 'dist');                  // 安装器 exe 输出目录
const ASSETS = path.join(PKG, 'assets');                // 图标等素材
const ICON = path.join(ASSETS, 'icon.ico');             // 品牌图标
const TRAY_SRC = path.join(PKG, 'tray', 'Dashboard.cs');// 托盘启动器源码
const NODE_EXE = process.execPath;                      // 本机 node.exe，直接当运行时打包

// ---------- 版本 ----------
function parseArg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const pkgJson = JSON.parse(fs.readFileSync(path.join(DASH, 'package.json'), 'utf8'));
const VERSION = parseArg('version', pkgJson.version || '1.0.0');
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
  candidates.push('C:\\Program Files (x86)\\NSIS\\makensis.exe');
  candidates.push('C:\\Program Files\\NSIS\\makensis.exe');
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return null;
}

// ---------- 找 csc（.NET 编译器，用于编托盘启动器；缺则回退 .bat）----------
function findCsc() {
  const fw = 'C:\\Windows\\Microsoft.NET\\Framework64';
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

// ============ 1. 校验前置 ============
console.log('== 项目管理看板 · 打包 ==');
console.log('  看板源码：' + DASH);
console.log('  版本    ：' + VERSION);

const MAKENSIS = findMakensis();
if (!MAKENSIS) {
  console.error('\n[X] 没找到 makensis.exe（NSIS 3 编译器）。');
  console.error('    方案A：装过 electron-builder 的机器上其缓存自带（本脚本会自动找）。');
  console.error('    方案B：到 https://nsis.sourceforge.io/ 下载安装 NSIS 3，再重试。');
  process.exit(1);
}
console.log('  makensis：' + MAKENSIS);

const DIST_SRC = path.join(DASH, 'web', 'dist', 'index.html');
if (!fs.existsSync(DIST_SRC)) {
  console.error('\n[X] web/dist 还没构建。先在 web 目录跑：npm install && npm run build');
  process.exit(1);
}
console.log('  node.exe：' + NODE_EXE + '（' + (fs.statSync(NODE_EXE).size / 1048576).toFixed(1) + 'MB）');

// ============ 2. 清空并搭建 staging ============
console.log('\n[1/5] 搭建暂存目录 ...');
rmrf(STAGING);
mkdirp(ROOT);

// —— 应用代码（只拷运行期需要的，剔除测试/开发件）——
copy(path.join(DASH, 'core'), path.join(ROOT, 'core'));
copy(path.join(DASH, 'cli'), path.join(ROOT, 'cli'));
mkdirp(path.join(ROOT, 'server'));
copy(path.join(DASH, 'server', 'server.cjs'), path.join(ROOT, 'server', 'server.cjs'));
mkdirp(path.join(ROOT, 'web'));
copy(path.join(DASH, 'web', 'dist'), path.join(ROOT, 'web', 'dist'));
copy(path.join(DASH, 'package.json'), path.join(ROOT, 'package.json'));
if (fs.existsSync(path.join(DASH, 'README.md'))) copy(path.join(DASH, 'README.md'), path.join(ROOT, 'README.md'));

// —— 使用手册放到根，用户一眼能找到 ——
const manualSrc = path.join(DASH, 'docs', '看板使用手册.md');
if (fs.existsSync(manualSrc)) copy(manualSrc, path.join(ROOT, '使用手册.md'));

// —— 内嵌 Node 运行时 ——
mkdirp(path.join(ROOT, 'node-runtime'));
copy(NODE_EXE, path.join(ROOT, 'node-runtime', 'node.exe'));

// —— 干净的 registry（绝不带打包机上的私人项目路径）——
writeUtf8(path.join(ROOT, 'registry.json'), JSON.stringify({ schemaVersion: '1.0', projects: {} }, null, 2) + '\n');

// ============ 3. 生成启动器 / 助手脚本 / 说明 ============
console.log('[2/5] 生成启动器与说明 ...');

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
else console.warn('  [!] 缺 assets/icon.ico，将用默认图标（可先跑 packaging/make-icon.ps1 生成）。');

let useTray = false;
const csc = findCsc();
if (csc && fs.existsSync(TRAY_SRC)) {
  const trayOut = path.join(ROOT, 'Dashboard.exe');
  const cscArgs = ['/nologo', '/target:winexe', '/codepage:65001',
    '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.dll',
    '/out:' + trayOut, TRAY_SRC];
  if (hasIcon) cscArgs.splice(3, 0, '/win32icon:' + ICON);
  const rc = cp.spawnSync(csc, cscArgs, { encoding: 'utf8' });
  if (rc.status === 0 && fs.existsSync(trayOut)) {
    useTray = true;
    console.log('  ✔ 托盘启动器 Dashboard.exe 已编译（隐藏黑窗口 + 托盘图标）。');
  } else {
    console.warn('  [!] 托盘启动器编译失败，回退到 启动看板.bat（带控制台窗口）。');
    if (rc.stderr) console.warn('      ' + rc.stderr.split('\n').slice(0, 4).join('\n      '));
  }
} else {
  console.warn('  [!] 没找到 csc（.NET 编译器）或托盘源码，用 启动看板.bat（带控制台窗口）。');
}
// 主启动目标：有托盘用 Dashboard.exe，否则用 .bat
const LAUNCH_TARGET = useTray ? 'Dashboard.exe' : '启动看板.bat';
const ICON_REF = hasIcon ? '$INSTDIR\\icon.ico' : (useTray ? '$INSTDIR\\Dashboard.exe' : '$INSTDIR\\node-runtime\\node.exe');

// ============ 4. 生成 NSIS 脚本 ============
console.log('[3/5] 生成 NSIS 脚本 ...');
mkdirp(OUTDIR);
const installedMB = Math.ceil(dirSizeMB(ROOT));
const outExe = path.join(OUTDIR, `${APPNAME}-安装程序-v${VERSION}.exe`);
const nsiPath = path.join(PKG, 'installer.nsi');

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
console.log('[4/5] 调 makensis 编译安装器（LZMA solid 压缩，稍慢）...');
const r = cp.spawnSync(MAKENSIS, [nsiPath], { encoding: 'utf8' });
if (r.stdout) process.stdout.write(r.stdout.split('\n').slice(-12).join('\n') + '\n');
if (r.status !== 0) {
  console.error('\n[X] makensis 编译失败（退出码 ' + r.status + '）。');
  if (r.stderr) console.error(r.stderr);
  process.exit(1);
}

// ============ 完成 ============
console.log('[5/5] 完成 ✔');
if (fs.existsSync(outExe)) {
  console.log('\n安装器已生成：');
  console.log('  ' + outExe);
  console.log('  体积：' + (fs.statSync(outExe).size / 1048576).toFixed(1) + 'MB（安装后约 ' + installedMB + 'MB）');
} else {
  console.error('[X] 编译似乎成功但没找到产物：' + outExe);
  process.exit(1);
}
