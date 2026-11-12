#!/usr/bin/env node
'use strict';
// Downloadable CLI: deliberately independent of the dashboard installation.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { Writable } = require('node:stream');
const { spawn } = require('node:child_process');
const HOME = path.resolve(process.env.BOARD_MEMBER_HOME || path.join(os.homedir(), '.board-member'));
const LABELS = { urgent: '紧急', high: '高', medium: '中', low: '低', optional: '可选' };
const USAGE = `login --server <网址> --username <用户名> [--label <设备名>]
logout
whoami
use <项目id>
projects
list [--project <项目id>] [--mine] [--status <状态>] [--all]
show <卡号> [--project <项目id>]
add --title <标题> [--plain-title <人话标题>] [--desc <描述> | --desc-file <文件>] [--project <项目id>]
claim <卡号> [--project <项目id>]
done <卡号> [--project <项目id>]
join <卡号> [--project <项目id>]
leave <卡号> [--project <项目id>]
progress <卡号> --percent <0~100> [--note <说明>] [--project <项目id>]
note <卡号> (--text <内容> | --text-file <文件>) [--project <项目id>]
unclaim <卡号> --reason <原因> [--project <项目id>]
park <卡号> --reason <原因> [--project <项目id>]
unpark <卡号> --reason <原因> [--project <项目id>]
cancel <卡号> --reason <原因> [--project <项目id>]
reopen <卡号> --reason <原因> [--project <项目id>]
priority <卡号> --level <紧急|高|中|低|可选|urgent|high|medium|low|optional> [--project <项目id>]
remove-collaborator <卡号> --user-id <成员id> [--project <项目id>]
guide
help / --help（所有命令支持 --json）
给 AI 看的说明:node board-member.cjs guide`;
const GUIDE = `云端看板 · AI 使用说明
你在替 <显示名> 操作云端看板 <网址>。下面的命令都写成:<命令> 子命令 参数

开工前
1. <命令> whoami  确认登录的是谁、能进哪些项目
2. <命令> list --mine  看自己手上的卡
3. 接新活:用 list 找卡,或用 add 建卡,再用 claim 领下来

干活中
- 每到一个节点:<命令> progress <卡号> --percent <0-100> --note "做到哪了"
- 有疑问、卡住了、要别人看:<命令> note <卡号> --text "说明"
- 别人领着的卡想一起做:<命令> join <卡号>,不要 claim

收尾
- 做完了:<命令> done <卡号>。进度报到 100 不会自动完工
- 暂时不做:park <卡号> --reason "原因";不做了:unclaim <卡号> --reason "原因"

规矩
- 动一张卡之前先 show <卡号>,只做「你现在能做」里列出的操作
- 不要替组员登录,不要向组员要密码;提示要重新登录时,请组员本人在终端运行 login
- 命令被拒(退出码 1)时把原因转告组员,不要换个命令绕过去
- 要负责人拍板的事,用 note 留言说明,不要自己定
- 退出码:0 成功,1 被拒,2 命令写错,3 要重新登录,4 连不上服务器`;
class Failure extends Error {
  constructor(message, exitCode, status = 0) { super(message); this.exitCode = exitCode; this.status = status; }
}
const usage = message => { throw new Failure(message, 2); };
function normalizeServer(value) {
  let u;
  try { u = new URL(value); } catch { usage('网址格式不对'); }
  if (u.username || u.password || !(u.protocol === 'https:' ||
      (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))) usage('网址必须使用 HTTPS，本机测试可使用回环 HTTP');
  return u.origin;
}
function parse(argv) {
  const args = []; const flags = Object.create(null);
  const boolean = new Set(['json', 'mine', 'all', 'help']);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { args.push(argv[i]); continue; }
    const key = argv[i].slice(2);
    if (Object.hasOwn(flags, key)) usage('同一参数不能重复');
    if (boolean.has(key)) flags[key] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) usage('参数缺少内容');
      flags[key] = argv[++i];
    }
  }
  const command = flags.help ? 'help' : args.shift() || 'help';
  const specs = {
    login: [0, ['server', 'username', 'label']], logout: [0, []], whoami: [0, []], projects: [0, []], use: [1, []],
    list: [0, ['project', 'mine', 'status', 'all']], show: [1, ['project']],
    add: [0, ['project', 'title', 'plain-title', 'desc', 'desc-file']],
    claim: [1, ['project']], done: [1, ['project']], join: [1, ['project']], leave: [1, ['project']],
    progress: [1, ['project', 'percent', 'note']], note: [1, ['project', 'text', 'text-file']],
    priority: [1, ['project', 'level']], 'remove-collaborator': [1, ['project', 'user-id']],
    guide: [0, []], help: [0, []],
  };
  for (const c of ['unclaim', 'park', 'unpark', 'cancel', 'reopen']) specs[c] = [1, ['project', 'reason']];
  const spec = specs[command];
  if (!spec || args.length !== spec[0] || Object.keys(flags).some(k => !['json', 'help', ...spec[1]].includes(k))) usage('命令或参数不对；密码只能由本人从终端输入');
  const required = (key, max) => {
    if (typeof flags[key] !== 'string' || !flags[key].trim() || (max && [...flags[key]].length > max)) usage('缺少或无效的 --' + key);
  };
  const loadText = (key, max) => {
    if (flags[key] !== undefined && flags[key + '-file'] !== undefined) usage('文字与文件参数只能选一个');
    if (flags[key + '-file'] !== undefined) {
      try { flags[key] = fs.readFileSync(flags[key + '-file'], 'utf8'); } catch { usage('无法读取文字文件'); }
    }
    if (flags[key] !== undefined && [...flags[key]].length > max) usage('文字太长');
  };
  if (command === 'login') {
    required('server'); required('username'); flags.server = normalizeServer(flags.server);
    if (flags.label !== undefined) required('label', 128);
  }
  if (spec[1].includes('reason')) required('reason', 500);
  if (command === 'progress' && (!/^\d+$/.test(flags.percent || '') || Number(flags.percent) > 100)) usage('进度须为 0~100 的整数');
  if (command === 'priority' && !Object.keys(LABELS).some(k => k === flags.level || LABELS[k] === flags.level)) usage('优先级档位不对');
  if (command === 'remove-collaborator') required('user-id');
  if (command === 'add') { required('title', 200); loadText('desc', 4000); }
  if (command === 'note') { loadText('text', 2000); required('text', 2000); }
  return { command, args, flags };
}
function atomic(file, value) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(HOME, 0o700);
  const dest = path.join(HOME, file); const temp = dest + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, dest);
    if (process.platform !== 'win32') fs.chmodSync(dest, 0o600);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function readJson(file) { return JSON.parse(fs.readFileSync(path.join(HOME, file), 'utf8')); }
function clearCredentials() {
  for (const file of ['device.cred', 'session.cred']) {
    try { fs.unlinkSync(path.join(HOME, file)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
function crypt(operation, input) {
  const scripts = {
    protect: '$b=[Text.Encoding]::UTF8.GetBytes($s); $r=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))',
    unprotect: '$b=[Convert]::FromBase64String($s); $r=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($r))',
  };
  return new Promise((resolve, reject) => {
    const script = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); " + scripts[operation];
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; let settled = false;
    const finish = bad => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (bad) reject(new Failure('本机凭据加解密失败', 3)); else resolve(output);
    };
    const timer = setTimeout(() => { child.kill(); finish(true); }, 30000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', d => { output += d; }); child.stderr.resume();
    child.once('error', () => finish(true)); child.once('close', code => finish(code !== 0));
    child.stdin.on('error', () => finish(true)); child.stdin.end(input, 'utf8');
  });
}
async function saveDevice(created) {
  const blob = process.platform === 'win32' ? await crypt('protect', created.token) : Buffer.from(created.token).toString('base64');
  atomic('device.cred', { v: 1, scheme: process.platform === 'win32' ? 'dpapi-user' : 'file-0600',
    deviceId: created.device.id, label: created.device.label, expiresAt: created.device.expiresAt, blob });
}
function loginHint(config) {
  return `请让组员本人在终端运行:node board-member.cjs login --server ${config?.server || '<网址>'} --username ${config?.username || '<用户名>'}`;
}
async function loadDevice(config) {
  try {
    const r = readJson('device.cred');
    if (r.v !== 1 || r.scheme !== (process.platform === 'win32' ? 'dpapi-user' : 'file-0600') ||
        typeof r.deviceId !== 'string' || typeof r.blob !== 'string' || !(Date.parse(r.expiresAt) > Date.now())) throw new Error();
    const token = process.platform === 'win32' ? await crypt('unprotect', r.blob) : Buffer.from(r.blob, 'base64').toString('utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error();
    return { ...r, token };
  } catch { throw new Failure(loginHint(config), 3, 401); }
}
function readPassword() {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
    if (input.isTTY) process.stderr.write('密码:');
    const reader = readline.createInterface({ input, output: silent, terminal: !!input.isTTY, historySize: 0 });
    let settled = false;
    const onError = () => finish('', true);
    const finish = (value, bad) => {
      if (settled) return; settled = true; reader.close(); input.pause(); input.removeListener('error', onError);
      if (input.isTTY) process.stderr.write('\n');
      if (bad) reject(new Failure('无法读取密码', 2)); else resolve(value);
    };
    reader.once('line', value => finish(value)); reader.once('close', () => finish(''));
    reader.once('SIGINT', onError); input.once('error', onError);
  });
}
// No session cache is needed: each invocation exchanges the protected device
// token. Keep all session/CSRF bytes in memory, including the one 401 retry.
function client(config) {
  let cookie = '', csrf = '';
  const secrets = new Set();
  function redact(value) {
    let result = String(value);
    for (const secret of secrets) if (secret) result = result.split(secret).join('[保密]');
    return result;
  }
  async function exchange(route, data) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(config.server + route, { method: data === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
        headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined ? {} : {
          Origin: config.server, 'X-Dashboard-Request': '1', 'Content-Type': 'application/json', 'X-Dashboard-CSRF': csrf,
        }) }, body: data === undefined ? undefined : JSON.stringify(data) });
      let body;
      try { body = await res.json(); }
      catch {
        if (res.ok) throw new Failure('服务器响应无效', 4, res.status);
        body = {};
      }
      if (!res.ok) {
        const reason = { 400: '参数不对', 401: '需要重新登录', 403: '没有权限', 404: '找不到这个项目或卡', 409: '卡片当前状态不允许这样做', 429: '操作太频繁请稍后' }[res.status] || '服务器暂时不可用';
        throw new Failure(`${reason}(服务器原话:${redact(body.error || reason)})`, res.status === 401 ? 3 : res.status >= 500 ? 4 : 1, res.status);
      }
      const raw = res.headers.get('set-cookie')?.match(/(?:^|,\s*)dashboard_session=([^;]+)/)?.[1];
      if (raw) { cookie = 'dashboard_session=' + raw; secrets.add(raw); secrets.add(cookie); }
      if (body.csrfToken) { csrf = body.csrfToken; secrets.add(csrf); }
      return body;
    } catch (e) {
      if (e instanceof Failure) throw e;
      throw new Failure('网络不通或服务器响应无效', 4);
    } finally { clearTimeout(timer); }
  }
  async function deviceLogin(device) {
    cookie = ''; csrf = ''; secrets.add(device.token);
    await exchange('/api/auth/device-login', { token: device.token });
    const session = await exchange('/api/auth/session');
    if (!session.user) throw new Failure(loginHint(config), 3, 401);
    return session;
  }
  return { exchange, deviceLogin, remember: s => secrets.add(s),
    async request(route, data, device) {
      try { return await exchange(route, data); }
      catch (e) {
        if (e.status !== 401) throw e;
        await deviceLogin(device); return exchange(route, data);
      }
    },
  };
}
const clean = value => JSON.parse(JSON.stringify(value, (k, v) => ['csrfToken', 'token', 'password', 'cookie'].includes(k) ? undefined : v));
function output(json, value, text) { console.log(json ? JSON.stringify(clean(value)) : text); }
const assignee = t => t.assigneeName || (t.aiWork ? 'AI 施工' : '无人认领');
function actionUsage(action, id) {
  const mapped = action === 'removeCollaborator' ? 'remove-collaborator' : action;
  const extra = { progress: ' --percent <0-100> [--note <说明>]', note: ' --text <内容>',
    priority: ' --level <档位>', 'remove-collaborator': ' --user-id <成员id>' }[mapped] ||
    (['unclaim', 'park', 'unpark', 'cancel', 'reopen'].includes(mapped) ? ' --reason <原因>' : '');
  return `node "${path.resolve(__filename)}" ${mapped} ${id}${extra}`;
}
async function main() {
  const { command, args, flags } = parse(process.argv.slice(2)); const json = !!flags.json;
  if (command === 'help') return output(json, { ok: true, help: USAGE }, USAGE);
  let config;
  try { config = readJson('config.json'); if (config.v !== 1 || !config.username) throw new Error(); config.server = normalizeServer(config.server); }
  catch { config = null; }
  if (command === 'login') {
    config = { v: 1, server: flags.server, username: flags.username };
    const api = client(config); let password = await readPassword();
    if (!password) usage('密码不能为空');
    api.remember(password);
    let session;
    try { session = await api.exchange('/api/auth/login', { username: flags.username, password }); }
    finally { password = undefined; }
    let created;
    try {
      created = await api.exchange('/api/auth/my-devices', { label: flags.label || `命令行·${os.hostname()}` });
      await saveDevice(created); atomic('config.json', config);
    } finally { await api.exchange('/api/auth/logout', {}); }
    return output(json, { ...clean(session), device: created.device }, `已登录:${session.user.displayName}(${session.user.role}),本机设备:${created.device.label},有效期到 ${created.device.expiresAt}`);
  }
  if (command === 'guide') {
    let name = '未登录', server = '未登录';
    if (config) {
      try { const device = await loadDevice(config); const session = await client(config).deviceLogin(device); name = session.user.displayName; server = config.server; }
      catch (e) { if (e.exitCode !== 3) throw e; }
    }
    const guide = GUIDE.replaceAll('<显示名>', name).replaceAll('<网址>', server).replaceAll('<命令>', `node "${path.resolve(__filename)}"`);
    return output(json, { ok: true, guide }, guide);
  }
  if (command === 'logout') {
    let revokeError;
    try {
      if (!config) throw new Failure(loginHint(config), 3, 401);
      const device = await loadDevice(config); const api = client(config); await api.deviceLogin(device);
      await api.request('/api/auth/my-devices/' + encodeURIComponent(device.deviceId) + '/revoke', {}, device);
    } catch (e) { revokeError = e; }
    finally { clearCredentials(); }
    if (revokeError) {
      const code = revokeError instanceof Failure ? revokeError.exitCode : 4;
      throw new Failure('本机凭据已删,服务器上的设备没撤成,请在网页上撤销' + (code === 3 ? ';' + loginHint(config) : ''), code, revokeError.status || 0);
    }
    return output(json, { ok: true }, '已退出登录');
  }
  if (!config) throw new Failure(loginHint(config), 3, 401);
  const device = await loadDevice(config); const api = client(config);
  let session;
  try { session = await api.deviceLogin(device); }
  catch (e) { if (e.status === 401) throw new Failure(loginHint(config), 3, 401); throw e; }
  const request = async (route, data) => {
    try { return await api.request(route, data, device); }
    catch (e) { if (e.status === 401) throw new Failure(loginHint(config), 3, 401); throw e; }
  };
  const projects = await request('/api/projects');
  if (command === 'projects') return output(json, projects, projects.projects.map(p => `${p.id}\t${p.name}`).join('\n'));
  if (command === 'whoami') return output(json, session, `${session.user.displayName} (${session.user.username})\n角色:${session.user.role}\n可进项目:${projects.projects.map(p => `${p.id} ${p.name}`).join('、')}\n服务器:${config.server}\n设备有效期:${device.expiresAt}`);
  const projectId = command === 'use' ? args[0] : flags.project || config.defaultProject || (projects.projects.length === 1 ? projects.projects[0].id : '');
  if (!projectId) usage('请用 --project 指定项目，可选项目:' + projects.projects.map(p => `${p.id} ${p.name}`).join('、'));
  if (command === 'use') {
    if (!projects.projects.some(p => p.id === projectId)) throw new Failure('没有权限(服务器原话:Forbidden)', 1, 403);
    await request('/api/board/' + encodeURIComponent(projectId)); config.defaultProject = projectId; atomic('config.json', config);
    return output(json, projects, '默认项目:' + projectId);
  }
  if (['list', 'show'].includes(command)) {
    const board = await request('/api/board/' + encodeURIComponent(projectId));
    if (command === 'list') {
      const tasks = board.tasks.filter(t => (flags.all || !['已完工', '已作废', '收官'].includes(t.status)) &&
        (!flags.status || t.status === flags.status) && (!flags.mine || t.assigneeUserId === session.user.id || (t.collaborators || []).some(c => c.userId === session.user.id)));
      return output(json, board, tasks.map(t => `${t.id}\t${t.status}\t${t.percent || 0}%\t${LABELS[t.priority] || '中'}\t${t.plainTitle || t.title}\t${assignee(t)}\t协作${(t.collaborators || []).length}人`).join('\n'));
    }
    const t = board.tasks.find(t => t.id === args[0]);
    if (!t) throw new Failure('找不到这个项目或卡(服务器原话:Not found)', 1, 404);
    const lines = [`标题:${t.title}`, `人话标题:${t.plainTitle || t.title}`, `描述:${t.description || ''}`, `状态:${t.status}`, `进度:${t.percent || 0}%`,
      `优先级:${LABELS[t.priority] || '中'}`, `主负责人:${assignee(t)}`, `协作人:${(t.collaborators || []).map(c => c.name).join('、') || '无'}`];
    if (t.blockReason) lines.push('阻塞原因:' + t.blockReason);
    if (t.cancelReason) lines.push('作废原因:' + t.cancelReason);
    lines.push('最近留言:', ...(t.messages || []).slice(-10).map(m => `${m.ts} ${m.author}: ${m.text}`), '', '你现在能做:',
      ...(t.actions.length ? t.actions.map(a => actionUsage(a, t.id)) : ['只能查看']));
    return output(json, board, lines.join('\n'));
  }
  const root = '/api/collaboration/projects/' + encodeURIComponent(projectId) + '/tasks';
  let data = {}, route = root + '/' + encodeURIComponent(args[0]) + '/' + command;
  if (command === 'add') {
    route = root; data = { title: flags.title };
    if (flags['plain-title'] !== undefined) data.plainTitle = flags['plain-title'];
    if (flags.desc !== undefined) data.description = flags.desc;
  } else if (command === 'progress') { data.percent = Number(flags.percent); if (flags.note !== undefined) data.note = flags.note; }
  else if (command === 'note') data.text = flags.text;
  else if (command === 'priority') data.priority = flags.level;
  else if (command === 'remove-collaborator') data.userId = flags['user-id'];
  else if (flags.reason !== undefined) data.reason = flags.reason;
  const result = await request(route, data);
  output(json, result, command === 'add' ? result.task.id : `已更新:${result.task.id}`);
}
if (Number(process.versions.node.split('.')[0]) < 18) {
  const error = '需要 Node 18 或更新版本';
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, error, status: 0, exitCode: 2 })); else console.error(error);
  process.exitCode = 2;
} else main().catch(error => {
  const code = error instanceof Failure ? error.exitCode : 2;
  const message = error instanceof Failure ? error.message : '本机文件操作失败，请检查目录权限';
  const step = process.argv[2]?.startsWith('--') ? '命令' : ({ login: '登录', logout: '退出登录' }[process.argv[2]] || '操作');
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: `${step}失败:${message}`, status: error.status || 0, exitCode: code }));
  else console.error(`${step}失败:${message}`);
  process.exitCode = code;
});
