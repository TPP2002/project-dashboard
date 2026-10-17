'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const p = require('../core/boardCommand.cjs');
const config = require('./remoteConfig.cjs');
function posixQuote(value) { return "'" + value.replace(/'/g, "'\\''") + "'"; }
function transportSpec(binding) {
  const t = binding.transport;
  if (!t) throw new Error('缺运输配置');
  if (t.type === 'stdio' && process.env.DASHBOARD_REMOTE_TEST_TRANSPORT === '1') {
    if (!Array.isArray(t.args) || t.args.some(x => typeof x !== 'string')) throw new Error('测试 stdio 参数错误');
    return { executable: t.executable, argv: t.args };
  }
  if (t.type !== 'ssh') throw new Error('仅允许 SSH（stdio 仅用于显式测试）');
  if (typeof t.host !== 'string' || !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*$/.test(t.host)) throw new Error('非法 SSH host（不得为选项）');
  if (!Array.isArray(t.entry) || !t.entry.length || t.entry.length > 32 || t.entry.some(x => typeof x !== 'string' || !x || /[\x00-\x1f]/.test(x))) throw new Error('非法固定 SSH 入口');
  return { executable: 'ssh', argv: ['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ForwardAgent=no','--',t.host,t.entry.map(posixQuote).join(' ')] };
}
function send(request, binding) {
  p.validate(request);
  const spec = transportSpec(binding);
  const result = spawnSync(spec.executable, spec.argv, { input: JSON.stringify(request) + '\n', encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  // Do not echo stderr from a transport: it may contain deployment credentials or user text.
  if (result.error || !result.stdout) throw new Error('远程连接/执行失败');
  let reply;
  try { reply = JSON.parse(result.stdout); } catch { throw new Error('远程响应不是有效协议'); }
  if (!reply || typeof reply !== 'object' || Array.isArray(reply) || reply.version !== p.VERSION || reply.requestId !== request.requestId || reply.authorityId !== request.authorityId || reply.authorityEpoch !== request.authorityEpoch || typeof reply.ok !== 'boolean') throw new Error('远程响应版本/身份不匹配');
  if (!reply.ok) throw new Error(reply.error || '远程拒绝请求');
  if (result.status !== 0) throw new Error('远程执行未成功退出');
  if (!reply.result || typeof reply.result !== 'object') throw new Error('远程缺少结果');
  return p.publicResult(reply.result);
}
function localBranch(repo = process.cwd()) {
  return execFileSync('git', ['-C',repo,'rev-parse','--abbrev-ref','HEAD'], { encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:15000 }).trim();
}
function textInput(file) {
  if (file !== undefined && (typeof file !== 'string' || !file.trim())) throw new Error('文件参数必须是单个非空本机路径');
  const fd = file === undefined ? 0 : fs.openSync(path.resolve(file), 'r');
  const chunks = []; let total = 0;
  try {
    const buf = Buffer.alloc(8192);
    for (;;) { const n = fs.readSync(fd, buf, 0, buf.length, null); if (!n) break; total += n; if (total > p.MAX_BYTES) throw new Error('输入超过上限'); chunks.push(Buffer.from(buf.subarray(0,n))); }
  } finally { if (file !== undefined) fs.closeSync(fd); }
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
}
function typedArgs(command, flags) {
  const args = { ...flags }; delete args.project; delete args.registry; delete args.json;
  if (command === 'pending' && (flags.json || flags['json-file'] !== undefined)) {
    args.payload = JSON.parse(textInput(flags['json-file'])); delete args['json-file'];
  } else if (command === 'pending') {
    const opts = flags.opt === undefined ? [] : [].concat(flags.opt);
    const pros = Object.create(null);
    for (const key of Object.keys(flags)) if (key.startsWith('pros-')) { pros[key.slice(5)] = flags[key]; delete args[key]; }
    args.payload = { question:flags.q,options:opts,recommended:flags.rec || opts[0],background:flags.background,optionPros:pros,recommendReason:flags.reason || flags.recommendReason,allowCustom:!flags.strict };
    for (const key of ['q','opt','rec','background','reason','recommendReason','strict']) delete args[key];
  } else if (command === 'add' && (flags['json-file'] !== undefined || (flags.json === true && !(flags._ || []).length))) {
    args.payload = JSON.parse(textInput(flags['json-file'])); delete args['json-file'];
  }
  if (command === 'collect-brief' && flags.file !== undefined) {
    if (flags.text !== undefined || typeof flags.file !== 'string') throw new Error('--text 与 --file 必须二选一');
    args.text = textInput(flags.file); delete args.file;
  }
  if (command === 'unclaim' && flags.branch === undefined) args.branch = localBranch();
  for (const [key, value] of Object.entries(args)) {
    if (p.BOOL.has(key)) {
      if (![true,false,'true','false'].includes(value)) throw new Error('非法布尔参数: ' + key);
      args[key] = value === true || value === 'true';
    } else if (p.NUM.has(key)) {
      const convert = v => { if (v === true || v === '' || !Number.isFinite(Number(v))) throw new Error('非法数字: ' + key); return Number(v); };
      args[key] = Array.isArray(value) ? value.map(convert) : convert(value);
    }
  }
  return args;
}
function perform(command, projectId, args, options = {}) {
  const binding = config.binding(projectId);
  if (!binding) throw new Error('项目未绑定远程');
  const request = { version:p.VERSION,authorityId:binding.authorityId,authorityEpoch:binding.authorityEpoch,requestId:crypto.randomUUID(),projectId,command,args };
  p.validate(request);
  const queued = !p.READ.has(command) && command !== 'sync-progress';
  if (queued) require('./remoteOutbox.cjs').save(request);
  const discardProgress = command === 'sync-progress' ? require('./remoteOutbox.cjs').progressJournal(request) : null;
  try {
    const result = send(request, binding);
    if (queued) require('./remoteOutbox.cjs').acknowledge(request.requestId);
    if (['claim','done'].includes(command)) bindSession(projectId,args._[0],command,options.registry);
    return result;
  } catch (e) {
    throw new Error(`${e.message}；结果待确认 requestId=${request.requestId}` + (queued ? `；重试: node "${path.join(__dirname,'index.cjs')}" remote-retry ${request.requestId}` : '；此读请求/自动进度不排队，请重新查询'));
  } finally {
    if (discardProgress) {
      try { discardProgress(); }
      catch { process.stderr.write('⚠ 自动进度日志清理失败 requestId=' + request.requestId + '；该记录禁止重放\n'); }
    }
  }
}
function bindSession(projectId, taskId, via, registryPath) {
  try {
    const proj = require('../core/resolveProject.cjs').resolveProject(projectId, {registryPath});
    require('../core/sessionBindings.cjs').recordBinding({boardPath:proj.board,taskId,via});
  } catch (e) { process.stderr.write('⚠ 云端成功；本机会话绑定未记上: ' + e.message + '\n'); }
}
function retry(id, registryPath) {
  const entry = require('./remoteOutbox.cjs').read(id);
  const r = entry.request;
  p.validate(r);
  if (r.requestId !== id) throw new Error('待送记录 requestId 与文件编号不符，禁止发送');
  if (r.command === 'sync-progress' || p.READ.has(r.command)) throw new Error('该命令不得排队重放');
  const b = config.binding(r.projectId);
  if (!b || r.authorityId !== b.authorityId || r.authorityEpoch !== b.authorityEpoch) throw new Error('待送请求属于旧权威，禁止重放');
  try {
    const result = send(r,b);
    require('./remoteOutbox.cjs').acknowledge(id);
    if (['claim','done'].includes(r.command)) bindSession(r.projectId,r.args._[0],r.command,registryPath);
    return result;
  } catch (e) { throw new Error(e.message + '；结果待确认 requestId=' + id + '；使用同一 remote-retry 命令重试'); }
}
module.exports = { transportSpec, send, typedArgs, perform, retry, localBranch };
