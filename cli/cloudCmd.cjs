'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { registryFile, syncRoot, readConfig, writeConfig, enrollDevice,
  clearDeviceCredential, loadDeviceCredential, withCloudClient } = require('../core/syncCredential.cjs');
const SUBCOMMANDS = ['config', 'login', 'logout', 'reconnect', 'status', 'ack', 'attach', 'detach', 'service'];
const { atomicWriteJsonSync, atomicWriteFileSync } = require('../core/atomicWrite.cjs');
const { resolveProject, readRegistry } = require('../core/resolveProject.cjs');
const { withLock } = require('../core/lock.cjs');
const { assertValid } = require('../core/boardSchema.cjs');
const { terminalText } = require('../core/syncNotice.cjs');

function writeRegistry(file, registry) {
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o7777 : undefined;
  atomicWriteJsonSync(file, registry);
  if (mode !== undefined) {
    try { fs.chmodSync(file, mode); } catch (error) { if (process.platform !== 'win32') throw error; }
  }
}

function readJson(file, fallback, tolerant = false) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (tolerant || error.code === 'ENOENT') return fallback; throw error; }
}
function project(flags, registryPath) {
  return resolveProject(flags.project || flags._[1], { registryPath });
}
function clockTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toTimeString().slice(0, 8) : '未知';
}
function status(flags, registryPath) {
  const report = readJson(path.join(syncRoot(registryPath), 'status.json'), null, true);
  const connection = report?.agent ? { ...report.agent, updatedAt: report.updatedAt } : null;
  let first = connection ? ({
    connected: '已连接', reconnecting: `正在重连(下次重试 ${clockTime(connection.nextRetryAt)})`,
    'login-required': '请重新登录云端', stopped: '已停止',
  }[connection.state] || '同步程序没在运行') : '同步程序没在运行';
  const age = connection && Math.floor((Date.now() - Date.parse(connection.updatedAt)) / 1000);
  if (age > 60 && connection.state !== 'stopped') first += `(状态 ${age} 秒没更新,同步程序可能已退出)`;
  let registry;
  try { registry = readRegistry(registryPath); } catch { registry = {}; }
  const projects = [], lines = [first];
  for (const [id, entry] of Object.entries(registry.projects || {})) {
    if (entry?.cloud?.enabled !== true || (flags.project && flags.project !== id)) continue;
    const reported = report?.projects?.[id];
    const summary = reported?.remoteProjectId === entry.cloud.remoteProjectId ? reported : null;
    const rejected = require('../core/syncNotice.cjs').unseenRejected({
      cloud: entry.cloud, syncDir: path.join(syncRoot(registryPath), id),
    });
    const row = { id, remoteProjectId: entry.cloud.remoteProjectId,
      pending: summary?.pending ?? null, rejectedUnseen: rejected.length,
      untracked: summary?.untracked ?? null, lastPullAt: summary?.lastPullAt ?? null, rejected };
    projects.push(row);
    lines.push(`${id} → ${row.remoteProjectId}、待发 ${row.pending ?? '未知'} 条、未读退回 ${row.rejectedUnseen} 条、` +
      `未同步提醒 ${row.untracked ?? '未知'} 条、上次同步 ${row.lastPullAt || '尚无'}${summary ? '' : '（同步程序还没报到）'}`);
    for (const item of rejected) lines.push(terminalText(`  ${item.seq}、${item.command}、${(item.taskIds || []).join(',')}、${item.reason || item.error}、${item.at}`));
  }
  return { connection, projects, text: lines.join('\n') };
}
function ack(flags, registryPath) {
  const proj = project(flags, registryPath);
  if (!proj.cloud) throw new Error('项目尚未开启云同步');
  if (flags.all !== undefined && flags.all !== true) throw new Error('--all 不接受参数值');
  if ((flags.all === true) === (flags.seq !== undefined)) throw new Error('请指定 --all 或 --seq <序号>，两者二选一');
  const seqs = flags.seq === undefined ? [] : (Array.isArray(flags.seq) ? flags.seq : [flags.seq]).map(value => {
    const seq = Number(value);
    if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(seq) || seq < 1) throw new Error('退回序号必须是正整数');
    return seq;
  });
  const count = withLock(proj.lock, () => {
    const file = path.join(proj.syncDir, 'rejected.json');
    const rejected = readJson(file, { v: 1, items: [] });
    if (!Array.isArray(rejected.items)) throw new Error('退回记录无法读取');
    if (seqs.some(seq => !rejected.items.some(item => item.seq === seq))) throw new Error('退回序号不存在');
    let changed = 0;
    for (const item of rejected.items) if (!item.seen && (flags.all || seqs.includes(item.seq))) { item.seen = true; changed++; }
    if (changed) atomicWriteJsonSync(file, rejected);
    return changed;
  });
  return { ok: true, count, text: `已标为知道了 ${count} 条` };
}
function sequence(proj) {
  let raw;
  try { raw = fs.readFileSync(path.join(proj.syncDir, 'outbox.seq'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return 0; }
  const seq = Number(raw.trim());
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('同步序号文件无效');
  return seq;
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
async function attach(flags, registryPath) {
  const proj = project(flags, registryPath);
  if (proj.cloud) throw new Error('项目已经开启云同步');
  if ((flags.upload === true) === (flags.adopt === true)) throw new Error('--upload 与 --adopt 必须二选一');
  if (typeof flags.remote !== 'string' || !flags.remote.trim()) throw new Error('请指定 --remote <云端项目id>');
  let credential;
  try { credential = await loadDeviceCredential(registryPath); }
  catch { throw new Error('请先 cloud login 登录云端'); }
  if (!credential || Date.parse(credential.expiresAt) <= Date.now()) throw new Error('请先 cloud login 登录云端');
  const before = withLock(proj.lock, () => fs.readFileSync(proj.board));
  let board = JSON.parse(before.toString('utf8'));
  assertValid(board);
  let result;
  try {
    result = await withCloudClient(registryPath, async (client, { config, ready }) => {
      if (credential.origin !== config.origin) throw new Error('连接地址已改变，请先 cloud login 登录云端');
      await ready(() => client.deviceLogin());
      return flags.upload ? client.upload(flags.remote, board, proj.name) : client.snapshot(flags.remote);
    }, { credential });
  } catch (error) {
    if (flags.upload && error.httpStatus === 409) throw new Error('云上已有这个项目,改用 --adopt');
    throw error;
  } finally { credential = undefined; }
  if (flags.adopt) board = result.board;
  board.project.id = proj.id;
  assertValid(board);
  let backup = null;
  // Network I/O never holds the synchronous board lock. Recheck before commit:
  // an upload must not silently swallow local writes made during that request.
  withLock(registryPath + '.lock', () => {
    const registry = readRegistry(registryPath);
    const current = resolveProject(proj.id, { registryPath });
    if (current.cloud) throw new Error('项目已经开启云同步');
    if (current.board !== proj.board) throw new Error('项目路径已改变，请重新接入');
    withLock(proj.lock, () => {
      const local = fs.readFileSync(proj.board);
      if (flags.upload && !local.equals(before)) throw new Error('上传期间本机看板已改变，尚未接入；云端已保留上传副本，请核对后再接入');
      const ackedSeq = sequence(proj);
      fs.mkdirSync(proj.syncDir, { recursive: true });
      if (flags.adopt) {
        backup = path.join(proj.syncDir, `backup-${stamp()}.json`);
        atomicWriteFileSync(backup, local);
        assertValid(board);
        atomicWriteJsonSync(proj.board, board);
      }
      atomicWriteJsonSync(path.join(proj.syncDir, 'base.json'), board);
      atomicWriteJsonSync(path.join(proj.syncDir, 'state.json'), { v: 1, ackedSeq, etag: result.etag,
        lastPullAt: flags.adopt ? new Date().toISOString() : null, lastPushAt: null,
        lastArchiveDay: null, untracked: [], lastError: null });
      registry.projects[proj.id].cloud = { enabled: true, remoteProjectId: flags.remote, attachedAt: new Date().toISOString() };
      writeRegistry(registryPath, registry);
    });
  });
  return { ok: true, id: proj.id, remoteProjectId: flags.remote, backup,
    text: flags.upload ? `已上传本机看板并接入云同步：${proj.id} → ${flags.remote}`
      : `已采用云端看板并接入云同步：${proj.id} → ${flags.remote}\n本机原本备份：${backup}` };
}
function detach(flags, registryPath) {
  const initial = project(flags, registryPath);
  return withLock(registryPath + '.lock', () => {
    const registry = readRegistry(registryPath), proj = resolveProject(initial.id, { registryPath });
    if (!proj.cloud) throw new Error('项目尚未开启云同步');
    return withLock(proj.lock, () => {
      const stateFile = path.join(proj.syncDir, 'state.json');
      const state = readJson(stateFile, { v: 1, ackedSeq: 0, etag: null,
        lastPullAt: null, lastPushAt: null, lastArchiveDay: null, untracked: [], lastError: null });
      if (!Number.isSafeInteger(state.ackedSeq) || state.ackedSeq < 0) throw new Error('同步进度文件无效');
      let raw = '';
      try { raw = fs.readFileSync(path.join(proj.syncDir, 'outbox.jsonl'), 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      // Keep each original line, including whitespace and its line ending.
      const rows = (raw.match(/[^\n]*\n|[^\n]+$/g) || []).filter(line => line.trim())
        .map(line => ({ line, row: JSON.parse(line) }));
      const pending = rows.filter(({ row }) => row.kind === 'op' && row.seq > state.ackedSeq);
      if (pending.length && flags['drop-pending'] !== true) {
        throw new Error(`还有 ${pending.length} 条没送上云,等同步程序发完再退出,或加 --drop-pending 丢弃`);
      }
      let dropped = null;
      if (pending.length) {
        fs.mkdirSync(proj.syncDir, { recursive: true });
        dropped = path.join(proj.syncDir, `dropped-${stamp()}.jsonl`);
        // A unique timestamped receipt is appended and flushed before advancing.
        const fd = fs.openSync(dropped, 'a');
        try { fs.writeFileSync(fd, pending.map(({ line }) => line).join('')); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        state.ackedSeq = Math.max(state.ackedSeq, ...rows.map(({ row }) => row.seq));
        atomicWriteJsonSync(stateFile, state);
      }
      registry.projects[proj.id].cloud.enabled = false;
      writeRegistry(registryPath, registry);
      return { ok: true, dropped, text: '已退出云同步,本机看板保留' };
    });
  });
}

function reconnect(registryPath) {
  const root = syncRoot(registryPath);
  fs.mkdirSync(root, { recursive: true });
  atomicWriteJsonSync(path.join(root, 'reconnect.request'), { at: new Date().toISOString() });
}
function configCommand(flags, registryPath) {
  const keys = ['ssh-host', 'remote-port', 'local-port', 'origin', 'direct', 'base-url'];
  if (!keys.some(key => flags[key] !== undefined)) {
    let config;
    try { config = readConfig(registryPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { ok: true, config: config || null,
      text: config ? JSON.stringify(config, null, 2) : '尚未配置云端连接' };
  }
  const config = writeConfig(registryPath, flags.direct ? {
    v: 1, mode: 'direct', baseUrl: flags['base-url'], origin: flags.origin,
  } : {
    v: 1, mode: 'ssh', sshHost: flags['ssh-host'], origin: flags.origin,
    remotePort: typeof flags['remote-port'] === 'string' ? Number(flags['remote-port']) : NaN,
    localPort: typeof flags['local-port'] === 'string' ? Number(flags['local-port']) : NaN,
  });
  return { ok: true, config, text: '已保存云端连接配置' };
}

// Neither argv nor environment variables are a password channel. Unknown login
// flags/extra positional arguments are rejected without echoing their contents.
function checkLoginFlags(flags) {
  const allowed = new Set(['_', 'username', 'label', 'registry', 'json']);
  if (Object.keys(flags).some(key => !allowed.has(key)) || flags._.length !== 1
      || [flags.username, flags.label].some(value => Array.isArray(value)
        || (typeof value === 'string' && /(?:password|passwd|pwd|密码)\s*[:=]/i.test(value)))) {
    throw new Error('密码只从标准输入读');
  }
  if (typeof flags.username !== 'string' || !flags.username.trim()) throw new Error('请指定 --username <账号>');
  if (flags.label !== undefined && (typeof flags.label !== 'string' || !flags.label.trim())) throw new Error('设备名不能为空');
}
function readPassword(input = process.stdin, output = process.stderr) {
  const readline = require('node:readline');
  const { Writable } = require('node:stream');
  return new Promise((resolve, reject) => {
    // readline receives a silent output stream: typed characters, including
    // pasted text, never go to the real terminal.
    const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
    if (input.isTTY) output.write('云端密码:');
    const reader = readline.createInterface({ input, output: silent, terminal: !!input.isTTY, historySize: 0 });
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      reader.close(); input.pause();
      input.removeListener('error', onError);
      if (input.isTTY) output.write('\n');
      if (error) reject(new Error('无法读取云端密码')); else resolve(value);
    };
    const onError = () => finish('', true);
    reader.once('line', value => finish(value));
    reader.once('close', () => finish(''));
    reader.once('SIGINT', () => finish('', true));
    input.once('error', onError);
  });
}
async function login(flags, registryPath) {
  checkLoginFlags(flags);
  let password = await readPassword();
  if (!password) throw new Error('密码不能为空，密码只从标准输入读');
  let device;
  try {
    device = await enrollDevice({ registryPath, username: flags.username, password,
      label: flags.label || `本机同步·${os.hostname()}` });
  } catch (error) {
    throw new Error(error.httpStatus === 401 ? '账号或密码不对（HTTP 401）'
      : Number.isInteger(error.httpStatus) ? `云端登录失败（HTTP ${error.httpStatus}）`
        : '云端登录失败，请检查连接配置、网络或本机凭据加密');
  } finally { password = undefined; }
  reconnect(registryPath);
  return { ok: true, device, text: `已登录云端：${device.label}，到期日 ${device.expiresAt}` };
}
async function cloud(flags) {
  const command = flags._?.[0];
  if (!SUBCOMMANDS.includes(command)) {
    throw Object.assign(new Error('未知云端子命令。可用: ' + SUBCOMMANDS.join(' ')), { exitCode: 2 });
  }
  const registryPath = registryFile(flags.registry);
  if (command === 'service') {
    const action = flags._[1];
    if (!['install', 'uninstall', 'status'].includes(action) || flags._.length !== 2) {
      throw Object.assign(new Error('用法：cloud service install | uninstall | status'), { exitCode: 2 });
    }
    const allowed = new Set(['_', 'registry', 'json', 'task-name', 'sched-cli', 'sched-share']);
    if (Object.keys(flags).some(key => !allowed.has(key))) throw new Error('未知后台服务参数');
    for (const key of ['registry', 'task-name', 'sched-cli', 'sched-share']) {
      if (flags[key] !== undefined && (typeof flags[key] !== 'string' || !flags[key].trim())) throw new Error('后台服务参数必须提供非空值');
    }
    return require('../core/cloudService.cjs')[action]({ registryPath, taskName: flags['task-name'],
      schedCli: flags['sched-cli'], schedShare: flags['sched-share'] });
  }
  if (command === 'config') return configCommand(flags, registryPath);
  if (command === 'login') return login(flags, registryPath);
  if (command === 'logout') {
    clearDeviceCredential(registryPath); reconnect(registryPath);
    return { ok: true, text: '已退出云端登录,队列保留' };
  }
  if (command === 'reconnect') {
    reconnect(registryPath); return { ok: true, text: '已请求重新连接云端' };
  }
  if (command === 'status') return status(flags, registryPath);
  if (command === 'ack') return ack(flags, registryPath);
  if (command === 'attach') return attach(flags, registryPath);
  if (command === 'detach') return detach(flags, registryPath);
}
module.exports = { cloud };
