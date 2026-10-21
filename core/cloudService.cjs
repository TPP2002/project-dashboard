'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { syncRoot, registryFile } = require('./syncCredential.cjs');
const { pidAlive } = require('./lock.cjs');

const DEFAULT_TASK = 'DashboardCloudSync';
const literal = value => '"' + String(value).replace(/"/g, '""') + '"';
// Windows argv quoting, followed by VBScript string quoting (two distinct layers).
const quote = value => '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
const ps = value => "'" + String(value).replace(/'/g, "''") + "'";
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const powershellArgs = source => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')];
function launcherSource({ node, cloudSyncScript, schedCli, schedShare, registryPath }) {
  if (!!schedCli !== !!schedShare) throw new Error('--sched-cli 与 --sched-share 必须同时提供');
  const args = schedCli ? [node, schedCli, 'hold', '--share', schedShare, '--project', 'dashboard', '--cores', '1',
    '--title', '看板云同步常驻', '--category', 'other', '--work-type', 'cloud-sync', '--', node, cloudSyncScript, 'run']
    : [node, cloudSyncScript, 'run'];
  return ['Option Explicit', 'Dim sh, rc', 'Set sh = CreateObject("WScript.Shell")',
    ...(registryPath ? [`sh.Environment("PROCESS")("DASHBOARD_REGISTRY") = ${literal(registryPath)}`] : []),
    `rc = sh.Run(${literal(args.map(quote).join(' '))}, 0, True)`, 'WScript.Quit rc', ''].join('\r\n');
}
function taskArgs({ taskName = DEFAULT_TASK, launcherPath }) {
  // schtasks /SC ONLOGON cannot express this repetition; register the task XML.
  const source = `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Repetition><Interval>PT10M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><Enabled>true</Enabled><UserId>__CURRENT_USER__</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>__CURRENT_USER__</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><StartWhenAvailable>true</StartWhenAvailable></Settings><Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>${xml(quote(launcherPath))}</Arguments></Exec></Actions></Task>`;
  return powershellArgs(`$ErrorActionPreference='Stop'; $user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $xml=${ps(source)}.Replace('__CURRENT_USER__',$user); Register-ScheduledTask -TaskName ${ps(taskName)} -Xml $xml -Force | Out-Null`);
}
function defaultRun(command, args) {
  return execFileSync(command, args, { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function windows(platform) {
  if (platform !== 'win32') throw Object.assign(new Error('目前只支持 Windows'), { exitCode: 1 });
}
function install({ registryPath, taskName = DEFAULT_TASK, schedCli, schedShare, platform = process.platform, run = defaultRun } = {}) {
  windows(platform);
  if (!!schedCli !== !!schedShare) throw new Error('--sched-cli 与 --sched-share 必须同时提供');
  for (const value of [schedCli, schedShare].filter(Boolean)) {
    if (typeof value !== 'string' || !path.win32.isAbsolute(value)) throw new Error('调度台路径必须是绝对路径');
  }
  const root = syncRoot(registryPath), launcherPath = path.join(root, 'launcher.vbs');
  const source = launcherSource({ node: process.execPath, cloudSyncScript: path.resolve(__dirname, '../cli/cloudSync.cjs'),
    schedCli, schedShare, registryPath: registryFile(registryPath) });
  fs.mkdirSync(root, { recursive: true });
  // WScript reads Unicode scripts reliably with a UTF-16 BOM, including Chinese titles.
  fs.writeFileSync(launcherPath, '\ufeff' + source, 'utf16le');
  run('powershell.exe', taskArgs({ taskName, launcherPath }));
  fs.rmSync(path.join(root, 'stop.request'), { force: true });
  run('schtasks.exe', ['/Run', '/TN', taskName]);
  return { ok: true, installed: true, taskName, launcherPath, text: '已安装并启动后台云同步' };
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function lockPid(root) {
  try { const pid = Number(fs.readFileSync(path.join(root, 'agent.lock'), 'utf8')); return Number.isSafeInteger(pid) && pid > 0 ? pid : null; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function uninstall({ registryPath, taskName = DEFAULT_TASK, platform = process.platform, run = defaultRun,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), alive = pidAlive } = {}) {
  windows(platform);
  run('powershell.exe', powershellArgs(`$ErrorActionPreference='Stop'; Get-ScheduledTask | Where-Object { $_.TaskName -eq ${ps(taskName)} -and $_.TaskPath -eq '\\' } | Unregister-ScheduledTask -Confirm:$false`));
  const root = syncRoot(registryPath), lock = path.join(root, 'agent.lock');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'stop.request'), new Date().toISOString());
  const deadline = now() + 15000;
  while (fs.existsSync(lock) && now() < deadline) await sleep(100);
  let forced = false;
  if (fs.existsSync(lock)) {
    const pid = lockPid(root);
    if (!pid) throw new Error('同步锁中的进程号无效，无法确认停止');
    if (alive(pid)) { run('taskkill.exe', ['/PID', String(pid), '/T', '/F']); forced = true; }
    if (alive(pid)) throw new Error('同步程序尚未停止');
    if (lockPid(root) === pid) fs.unlinkSync(lock);
  }
  fs.rmSync(path.join(root, 'launcher.vbs'), { force: true });
  return { ok: true, installed: false, taskName, forced, text: '已卸载后台云同步，队列与状态保留' };
}
function status({ registryPath, taskName = DEFAULT_TASK, platform = process.platform, run = defaultRun, alive = pidAlive } = {}) {
  let task = { installed: false, nextRunTime: null };
  if (platform === 'win32') {
    const output = run('powershell.exe', powershellArgs(`$ErrorActionPreference='Stop'; $t=Get-ScheduledTask | Where-Object { $_.TaskName -eq ${ps(taskName)} -and $_.TaskPath -eq '\\' }; if ($t) { $i=$t | Get-ScheduledTaskInfo; @{installed=$true;nextRunTime=$i.NextRunTime.ToString('o')} | ConvertTo-Json -Compress } else { @{installed=$false;nextRunTime=$null} | ConvertTo-Json -Compress }`));
    task = JSON.parse(String(output).trim());
  }
  const root = syncRoot(registryPath), report = readJson(path.join(root, 'status.json')), pid = lockPid(root);
  const running = !!pid && alive(pid);
  return { ok: true, taskName, supported: platform === 'win32', ...task, running, pid, status: report,
    text: `计划任务：${task.installed ? '已安装' : '未安装'}\n下次触发：${task.nextRunTime || '无'}\n同步程序：${running ? '正在运行' : '未运行'}` };
}
module.exports = { launcherSource, taskArgs, install, uninstall, status };
