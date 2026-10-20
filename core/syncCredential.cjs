'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { REGISTRY_PATH } = require('./resolveProject.cjs');
const { atomicWriteJsonSync } = require('./atomicWrite.cjs');

const registryFile = registryPath => path.resolve(registryPath || process.env.DASHBOARD_REGISTRY || REGISTRY_PATH);
const syncRoot = registryPath => path.join(path.dirname(registryFile(registryPath)), 'sync');
function httpUrl(value, originOnly = false) {
  let url;
  try { url = new URL(value); } catch { throw new Error('连接地址必须是有效的 http(s) 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || (originOnly && url.pathname !== '/')) throw new Error('连接地址不得含凭据、查询参数或非源路径');
  return originOnly ? url.origin : url.href.replace(/\/$/, '');
}
function validateConfig(config) {
  if (!config || config.v !== 1 || !['ssh', 'direct'].includes(config.mode)) throw new Error('连接配置版本或模式无效');
  const result = { v: 1, mode: config.mode, origin: httpUrl(config.origin, true) };
  if (config.mode === 'ssh') {
    if (typeof config.sshHost !== 'string' || !config.sshHost || /^-/.test(config.sshHost)
        || /[\s\x00-\x1f\x7f]/u.test(config.sshHost)) throw new Error('SSH 主机名无效');
    for (const key of ['remotePort', 'localPort']) {
      if (!Number.isInteger(config[key]) || config[key] < 1 || config[key] > 65535) throw new Error('隧道端口必须是 1 至 65535 的整数');
      result[key] = config[key];
    }
    result.sshHost = config.sshHost;
  } else result.baseUrl = httpUrl(config.baseUrl);
  return result;
}
function readConfig(registryPath) {
  return validateConfig(JSON.parse(fs.readFileSync(path.join(syncRoot(registryPath), 'config.json'), 'utf8')));
}
function writeConfig(registryPath, config) {
  const checked = validateConfig(config);
  fs.mkdirSync(syncRoot(registryPath), { recursive: true });
  atomicWriteJsonSync(path.join(syncRoot(registryPath), 'config.json'), checked);
  return checked;
}
const baseUrl = config => config.mode === 'ssh' ? `http://127.0.0.1:${config.localPort}` : config.baseUrl;

// Only fixed code is an argument. Input/output are UTF-8 / base64 over pipes;
// PowerShell's exception text is deliberately never forwarded to callers.
const DPAPI = {
  protect: "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($s); $r=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))",
  unprotect: "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($s); $r=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($r))",
};
function crypt(operation, input, options = {}) {
  if ((options.platform || process.platform) !== 'win32') return Promise.reject(new Error('设备凭据加密只支持 Windows'));
  const launch = options.spawn || spawn;
  return new Promise((resolve, reject) => {
    const script = '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ' + DPAPI[operation];
    const child = launch('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(new Error('设备凭据加解密失败')); else resolve(output);
    };
    const timer = setTimeout(() => { child.kill(); finish(true); }, 30000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.resume();
    child.once('error', () => finish(true));
    child.once('close', code => finish(code !== 0));
    child.stdin.on('error', () => finish(true));
    child.stdin.end(input, 'utf8');
  });
}
const protect = (input, options) => crypt('protect', input, options);
const unprotect = (input, options) => crypt('unprotect', input, options);
async function saveDeviceCredential({ registryPath, token, origin, label, deviceId, expiresAt, protector = { protect } }) {
  const root = syncRoot(registryPath);
  fs.mkdirSync(root, { recursive: true });
  const blob = await protector.protect(token);
  const record = { v: 1, scheme: 'dpapi-user', origin: httpUrl(origin, true), label, deviceId, expiresAt, blob };
  const file = path.join(root, 'device.cred');
  atomicWriteJsonSync(file, record);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  return { deviceId, label, expiresAt };
}
async function loadDeviceCredential(registryPath, protector = { unprotect }) {
  let record;
  try { record = JSON.parse(fs.readFileSync(path.join(syncRoot(registryPath), 'device.cred'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('设备凭据文件无法读取'); }
  if (record.v !== 1 || record.scheme !== 'dpapi-user' || typeof record.blob !== 'string'
      || typeof record.deviceId !== 'string' || !record.deviceId || !Number.isFinite(Date.parse(record.expiresAt))) {
    throw new Error('设备凭据文件无效');
  }
  const token = await protector.unprotect(record.blob);
  return { origin: httpUrl(record.origin, true), label: record.label, deviceId: record.deviceId, expiresAt: record.expiresAt, token };
}
function clearDeviceCredential(registryPath) {
  try { fs.unlinkSync(path.join(syncRoot(registryPath), 'device.cred')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function enrollDevice({ registryPath, username, password, label, protector }) {
  const config = readConfig(registryPath);
  const { createSyncClient } = require('./syncClient.cjs');
  const client = createSyncClient({ config });
  let tunnel, tunnelFailed = false;
  try {
    if (config.mode === 'ssh') {
      tunnel = spawn('ssh', require('./syncAgent.cjs').buildSshArgs(config), { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      tunnel.stderr.resume();
      tunnel.once('error', () => { tunnelFailed = true; });
      tunnel.once('exit', () => { tunnelFailed = true; });
    }
    const deadline = Date.now() + 15000;
    while (true) {
      try { await client.passwordLogin(username, password); break; }
      catch (error) {
        if (!tunnel || tunnelFailed || error.code !== 'NETWORK_ERROR' || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    password = undefined;
    const result = await client.request('/api/auth/devices', { label });
    return await saveDeviceCredential({ registryPath, token: result.token, origin: config.origin,
      label: result.device.label, deviceId: result.device.id, expiresAt: result.device.expiresAt, protector });
  } finally {
    password = undefined;
    try { await client.logout(); } finally { tunnel?.kill(); client.close(); }
  }
}
module.exports = { registryFile, syncRoot, validateConfig, readConfig, writeConfig, baseUrl,
  protect, unprotect, saveDeviceCredential, loadDeviceCredential, clearDeviceCredential, enrollDevice };
