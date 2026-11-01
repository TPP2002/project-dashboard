'use strict';
const path = require('node:path');
const realFs = require('node:fs');
const cp = require('node:child_process');
const { DASHBOARD_HOME } = require('../core/resolveProject.cjs');
const { serviceStatus } = require('./release.cjs');

function createWatchdog({ platform = process.platform, home = DASHBOARD_HOME, repoRoot = path.resolve(__dirname, '..'),
  run = (command, args, opts) => cp.execFileSync(command, args, opts), fs = realFs,
  now = () => new Date(), log = console.log, err = console.error, probe = serviceStatus } = {}) {
  const dir = path.join(home, 'watchdog');
  const cmdPath = path.join(dir, 'dashboard-watchdog.cmd');
  const vbsPath = path.join(dir, 'dashboard-watchdog-silent-launch.vbs');
  const xmlPath = path.join(dir, 'DashboardLauncherWatchdog.xml');
  const logs = path.join(home, 'logs');
  const runHidden = (c, a) => run(c, a, { windowsHide: true, encoding: 'utf8' });
  const win = s => s.replace(/\//g, '\\');
  const xmlEscape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const quoteVbs = s => '"""' + s.replace(/"/g, '""') + '"""';
  function render() {
    let sid = '';
    if (platform === 'win32') { try { sid = String(runHidden('whoami', ['/user'])).match(/S-1-(?:\d+-)+\d+/i)?.[0] || ''; } catch {} }
    const date = now();
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
    const cmd = [
      '@echo off', 'setlocal EnableExtensions EnableDelayedExpansion',
      `set "LOG=${win(path.join(dir, 'watchdog.log'))}"`, `set "LOGDIR=${win(logs)}"`,
      'for /L %%P in (6060,1,6068) do (curl.exe -s -f -m 3 -o NUL http://127.0.0.1:%%P/api/health && exit /b 0)',
      'if not exist "%LOGDIR%" mkdir "%LOGDIR%"',
      'forfiles /p "%LOGDIR%" /m launcher-*.log /d -7 /c "cmd /c del @path" >NUL 2>&1',
      'if exist "%LOG%" for %%F in ("%LOG%") do if %%~zF GTR 1048576 move /Y "%LOG%" "%LOG%.1" >NUL',
      'set "DAY="',
      'for /f "tokens=1-3 delims=/- ." %%a in ("%date%") do (',
      '  set "A=%%a" & set "B=%%b" & set "C=%%c"',
      '  if "!A:~4,1!"=="" if not "!A:~3,1!"=="" set "DAY=!A!!B!!C!"',
      '  if "!C:~4,1!"=="" if not "!C:~3,1!"=="" set "DAY=!C!!A!!B!"',
      ')',
      'echo(!DAY!| findstr /r /x "[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]" >NUL || set "DAY="',
      'set "OUT=%LOGDIR%\\launcher.log"', 'if defined DAY set "OUT=%LOGDIR%\\launcher-!DAY!.log"',
      'echo [%date% %time%] no dashboard on 6060-6068, starting launcher>>"%LOG%"',
      `cd /d "${win(repoRoot)}"`, 'set DASHBOARD_NO_OPEN=1',
      'node cli\\launcher.cjs >>"%OUT%" 2>&1', 'exit /b %errorlevel%', ''
    ].join('\r\n');
    const vbs = `Set sh = CreateObject("WScript.Shell")\r\nsh.Run ${quoteVbs(win(cmdPath))}, 0, False\r\n`;
    const xml = `<?xml version="1.0" encoding="UTF-16"?>\r\n<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><URI>\\DashboardLauncherWatchdog</URI></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger><TimeTrigger><Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>${local}</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers><Principals><Principal id="Author">${sid ? `<UserId>${xmlEscape(sid)}</UserId>` : ''}<LogonType>InteractiveToken</LogonType></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings><Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>&quot;${xmlEscape(win(vbsPath))}&quot;</Arguments></Exec></Actions></Task>\r\n`;
    return { cmd, vbs, xml: Buffer.concat([Buffer.from([255, 254]), Buffer.from(xml, 'utf16le')]) };
  }
  function alternatives() { log(`macOS launchd: run node ${path.join(repoRoot, 'cli', 'launcher.cjs')} with DASHBOARD_NO_OPEN=1 on a 300-second interval.\ncron: */5 * * * * DASHBOARD_NO_OPEN=1 node "${path.join(repoRoot, 'cli', 'launcher.cjs')}"`); return 2; }
  function taskRun(args) { try { return runHidden('schtasks', args); } catch (e) { throw new Error(`${e.message}${e.stderr ? '\n' + e.stderr.toString() : ''}`); } }
  function install() {
    if (platform !== 'win32') return alternatives();
    fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(logs, { recursive: true });
    const r = render(); if (/[^\x00-\x7f]/.test(r.cmd)) throw new Error('看护路径含非 ASCII 字符，无法生成无损的 ASCII 脚本');
    fs.writeFileSync(cmdPath, r.cmd, 'ascii'); fs.writeFileSync(vbsPath, Buffer.concat([Buffer.from([255, 254]), Buffer.from(r.vbs, 'utf16le')])); fs.writeFileSync(xmlPath, r.xml);
    taskRun(['/Create', '/TN', 'DashboardLauncherWatchdog', '/XML', xmlPath, '/F']);
    taskRun(['/Query', '/TN', 'DashboardLauncherWatchdog']); return 0;
  }
  function uninstall() { if (platform !== 'win32') return alternatives(); taskRun(['/Delete', '/TN', 'DashboardLauncherWatchdog', '/F']); return 0; }
  function status() {
    const task = { registered: false, lastRunTime: null, lastResult: null, nextRunTime: null, status: null };
    if (platform === 'win32') {
      try {
        const output = String(taskRun(['/Query', '/TN', 'DashboardLauncherWatchdog', '/V', '/FO', 'LIST'])); task.registered = true;
        const names = { 'last run time': 'lastRunTime', '上次运行时间': 'lastRunTime', 'last result': 'lastResult', '上次结果': 'lastResult', 'next run time': 'nextRunTime', '下次运行时间': 'nextRunTime', status: 'status', '状态': 'status' };
        for (const line of output.split(/\r?\n/)) { const m = line.match(/^\s*([^:：]+)[:：]\s*(.*?)\s*$/); if (m && names[m[1].trim().toLowerCase()]) task[names[m[1].trim().toLowerCase()]] = m[2]; }
      } catch (e) { err(e.message); }
    }
    let record = null; try { const r = JSON.parse(fs.readFileSync(path.join(home, 'launcher-instance.json'), 'utf8')); record = { key: r.key, ticketId: r.ticketId, wrapperPid: r.wrapperPid, watcherPid: r.watcherPid, serverPid: r.serverPid }; } catch {}
    const health = probe({ portBase: 6060, portRange: 8 });
    const result = { task, health, record }; log(JSON.stringify(result, null, 2)); return result;
  }
  return { install, uninstall, status, render };
}
if (require.main === module) {
  const dog = createWatchdog(); const action = process.argv[2];
  if (!['install', 'uninstall', 'status'].includes(action)) { console.error('Usage: node cli/watchdog.cjs install|uninstall|status'); process.exitCode = 2; }
  else { try { const result = dog[action](); if (typeof result === 'number') process.exitCode = result; } catch (e) { console.error(e.message); process.exitCode = 1; } }
}
module.exports = { createWatchdog };
