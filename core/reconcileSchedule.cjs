'use strict';
/**
 * reconcileSchedule.cjs —— 看板对账的 Windows 计划任务:每 N 小时静默跑一次
 * reconcile --all --apply --fetch,输出追加到日志。写法照 cloudService.cjs:
 * 计划任务只挂 wscript.exe + launcher.vbs(窗口隐藏),不直接挂 cmd / powershell / node。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { registryFile } = require('./syncCredential.cjs');

const DEFAULT_TASK = 'DashboardReconcile';
const MAX_LOG_BYTES = 1024 * 1024;
const literal = (value) => '"' + String(value).replace(/"/g, '""') + '"';
// Windows argv quoting, followed by VBScript string quoting (two distinct layers).
const quote = (value) => '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
const ps = (value) => "'" + String(value).replace(/'/g, "''") + "'";
const xml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const powershellArgs = (source) => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')];

const dataDir = (registryPath) => path.join(path.dirname(registryFile(registryPath)), 'reconcile');

function launcherSource({ node, cliScript, registryPath, logPath }) {
  // cmd 只用来做输出重定向;窗口由 Run 的第二参数 0 隐藏。/s 会剥掉最外层一对引号。
  const inner = `${quote(node)} ${quote(cliScript)} reconcile --all --apply --fetch >> ${quote(logPath)} 2>&1`;
  const command = `cmd.exe /d /s /c "${inner}"`;
  return ['Option Explicit', 'Dim sh, rc', 'Set sh = CreateObject("WScript.Shell")',
    ...(registryPath ? [`sh.Environment("PROCESS")("DASHBOARD_REGISTRY") = ${literal(registryPath)}`] : []),
    `rc = sh.Run(${literal(command)}, 0, True)`, 'WScript.Quit rc', ''].join('\r\n');
}

function taskArgs({ taskName = DEFAULT_TASK, launcherPath, everyHours = 2, now = Date.now() }) {
  // 只挂登录触发的话,装完要等下次登录才开始重复;再挂一个从下一个周期起的定时触发。
  const t = new Date(now + everyHours * 3600e3), p = (n) => String(n).padStart(2, '0');
  const start = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}T${p(t.getHours())}:${p(t.getMinutes())}:00`;
  const source = `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><TimeTrigger><Repetition><Interval>PT${everyHours}H</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled></TimeTrigger><LogonTrigger><Repetition><Interval>PT${everyHours}H</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><Enabled>true</Enabled><UserId>__CURRENT_USER__</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>__CURRENT_USER__</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT30M</ExecutionTimeLimit><StartWhenAvailable>true</StartWhenAvailable></Settings><Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>${xml(quote(launcherPath))}</Arguments></Exec></Actions></Task>`;
  return powershellArgs(`$ErrorActionPreference='Stop'; $user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $xml=${ps(source)}.Replace('__CURRENT_USER__',$user); Register-ScheduledTask -TaskName ${ps(taskName)} -Xml $xml -Force | Out-Null`);
}

function defaultRun(command, args) {
  return execFileSync(command, args, { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function windows(platform) {
  if (platform !== 'win32') throw Object.assign(new Error('目前只支持 Windows'), { exitCode: 1 });
}

function install({ registryPath, taskName = DEFAULT_TASK, everyHours = 2, platform = process.platform, run = defaultRun } = {}) {
  windows(platform);
  if (typeof everyHours !== 'number' || !Number.isInteger(everyHours) || everyHours < 1 || everyHours > 24) {
    throw Object.assign(new Error('--every-hours 必须是 1~24 的整数'), { exitCode: 1 });
  }
  const dir = dataDir(registryPath);
  const launcherPath = path.join(dir, 'launcher.vbs');
  const logPath = path.join(dir, 'reconcile.log');
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (fs.statSync(logPath).size > MAX_LOG_BYTES) fs.renameSync(logPath, logPath + '.1');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const source = launcherSource({ node: process.execPath, cliScript: path.resolve(__dirname, '../cli/index.cjs'),
    registryPath: registryFile(registryPath), logPath });
  // WScript reads Unicode scripts reliably with a UTF-16 BOM.
  fs.writeFileSync(launcherPath, '﻿' + source, 'utf16le');
  run('powershell.exe', taskArgs({ taskName, launcherPath, everyHours }));
  return { ok: true, installed: true, taskName, launcherPath, logPath, everyHours,
    text: `已装好:每 ${everyHours} 小时静默对账一次,日志在 ${logPath}` };
}

function uninstall({ registryPath, taskName = DEFAULT_TASK, platform = process.platform, run = defaultRun } = {}) {
  windows(platform);
  run('powershell.exe', powershellArgs(`$ErrorActionPreference='Stop'; Get-ScheduledTask | Where-Object { $_.TaskName -eq ${ps(taskName)} -and $_.TaskPath -eq '\\' } | Unregister-ScheduledTask -Confirm:$false`));
  const dir = dataDir(registryPath);
  fs.rmSync(path.join(dir, 'launcher.vbs'), { force: true });
  return { ok: true, installed: false, taskName, text: '已卸载定时对账,日志保留' };
}

function tailLines(file, n) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n);
  } catch { return []; }
}

function status({ registryPath, taskName = DEFAULT_TASK, platform = process.platform, run = defaultRun } = {}) {
  let task = { installed: false, nextRunTime: null };
  if (platform === 'win32') {
    const output = run('powershell.exe', powershellArgs(`$ErrorActionPreference='Stop'; $t=Get-ScheduledTask | Where-Object { $_.TaskName -eq ${ps(taskName)} -and $_.TaskPath -eq '\\' }; if ($t) { $i=$t | Get-ScheduledTaskInfo; @{installed=$true;nextRunTime=$(if ($i.NextRunTime) { $i.NextRunTime.ToString('o') } else { $null })} | ConvertTo-Json -Compress } else { @{installed=$false;nextRunTime=$null} | ConvertTo-Json -Compress }`));
    task = JSON.parse(String(output).trim());
  }
  const logPath = path.join(dataDir(registryPath), 'reconcile.log');
  const logTail = tailLines(logPath, 20);
  return { ok: true, taskName, supported: platform === 'win32', ...task, logPath, logTail,
    text: `计划任务:${task.installed ? '已安装' : '未安装'}\n下次触发:${task.nextRunTime || '无'}\n日志最后 ${logTail.length} 行:${logTail.length ? '\n' + logTail.join('\n') : '(没有日志)'}` };
}

module.exports = { launcherSource, taskArgs, install, uninstall, status };
