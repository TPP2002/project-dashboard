'use strict';
const REPLAY_COMMANDS = Object.freeze(['add', 'claim', 'assign', 'unclaim', 'progress', 'await-collect',
  'collect-brief', 'pending', 'decide', 'undecide', 'park', 'unpark', 'block', 'unblock', 'done', 'cancel',
  'reopen', 'note', 'request-info', 'edit', 'mark-landed', 'cost', 'set']);
const PATCH_COMMANDS = Object.freeze(['sync-from-git', 'doctor', 'backfill', 'sync-progress']);

function entryGateRefusal(cmd, flags) {
  // 批量建卡(add --json-file / --json)的档位与人话标题闸是【逐项】判的(见 commands.addBatch),
  // 这里放行,否则整批必被这两道单卡闸拦死——它们查的是命令行 flag,批量清单里根本没有。
  const batchAdd = cmd === 'add' && require('../cli/commands.cjs').isBatchAdd(flags);
  // ADD-MODEL-GATE(0901 负责人拍板):命令行建卡必须标建议档位——纪律靠自觉必失守,机器闸兜底。
  // 只拦 CLI 入口;内部编程调用 cmds.add(importCmd 历史导入/docsAudit 自动巡检卡/测试)不经此处。
  if (cmd === 'add' && !batchAdd && (flags.model === undefined || flags.model === true || String(flags.model).trim() === '')) {
    return ('建卡必须带 --model <建议档位>(0901 拍板,机器闸)。按模型路由表(skill §12.2)照抄一个:\n' +
      '  机械执行/清单/一行修 → --model "sonnet·低"\n' +
      '  照单施工/接线/修复   → --model "opus·中"\n' +
      '  设计/评审/校准/疑难  → --model "fable·高"\n' +
      '  负责人亲办不开对话   → --model "负责人本人办"\n' +
      '  (编排型可组合,如 "fable·高编排+opus施工";≤40 字符)');
  }
  // ADD-PLAINTITLE-GATE(CLI-ADD-NO-PLAINTITLE-FILESCOPE):建卡三件套(skill §11.9)要求
  // plainTitle(负责人看的人话标题)与 title(模型看的技术说明)都要给——纪律靠自觉必失守,
  // --model 闸已证明有效,同样机器闸兜底。只拦 CLI 入口,内部编程调用不经此处。
  if (cmd === 'add' && !batchAdd && (flags['plain-title'] === undefined || flags['plain-title'] === true || String(flags['plain-title']).trim() === '')) {
    return ('建卡必须带 --plain-title <人话标题>(skill §11.9 建卡三件套,机器闸兜底)。\n' +
      '  --title 是给模型看的技术详细说明(照旧不变),--plain-title 是另加给负责人看的一句人话\n' +
      '  (20~35 字,禁文件名/路径/函数名/类名/命令/英文缩写/内部编号)。例:\n' +
      '  add T1 --model "sonnet·低" --title "统一 roundToTick 的实现" \\\n' +
      '         --plain-title "价格计算的四舍五入有五套规则并存,可能算出对不上的数字"\n' +
      '  （顺手可加 --scope "<glob>"（可重复）登记这张卡大概会改哪些文件，不必等 claim 才补）');
  }
  // COST-LEDGER-CLOSEOUT-DISCIPLINE(0914 负责人当面下达并当场加码):每张卡收官前必须把这一单
  // 消耗的开销/额度登记入账,**不登记不得收官**。判据与拒收文案在 commands.costGateRefusal;
  // 同上两道闸,只拦 CLI 入口(人敲的、派单器 spawn 的都走这条路),内部编程调用不经此处。
  if (cmd === 'done') {
    const refusal = require('../cli/commands.cjs').costGateRefusal(flags);
    if (refusal) return refusal;
  }
  return null;
}

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const LOCAL_FLAGS = ['registry', 'json', 'help', 'project'];
const array = v => v === undefined ? [] : Array.isArray(v) ? v : [v];

function effectiveAuthor(cmd, flags) {
  if (cmd === 'request-info') return flags.author === undefined ? '负责人' : flags.author;
  if (cmd === 'undecide') return flags.author === undefined ? '看板' : flags.author;
  if (cmd === 'claim') return flags.author || array(flags.branch)[0] || 'cli';
  if (cmd === 'decide') return flags.author || '看板';
  if (cmd === 'note') return (flags.from === 'human' ? '负责人' : flags.from ?? flags.author) || 'cli';
  if (cmd === 'backfill') return flags.author || 'backfill';
  if (cmd === 'sync-progress') return flags.author || 'todo-hook';
  return flags.author || 'cli';
}

function runCliOperation(cmd, flags, fn) {
  const outbox = require('./syncOutbox.cjs');
  if (!REPLAY_COMMANDS.includes(cmd) && !PATCH_COMMANDS.includes(cmd)) {
    return outbox.withUntrackedSource(cmd, () => fn(flags));
  }
  // Only cloud projects need input snapshots. Leave non-cloud invocation and
  // parameter-error ordering intact, including stdin and missing-file messages.
  let cloud = false;
  try {
    cloud = !!require('./resolveProject.cjs').resolveProject(flags.project,
      { registryPath: flags.registry ? path.resolve(flags.registry) : undefined }).cloud;
  } catch { /* The command reports its original project/parameter error. */ }
  if (!cloud && cmd !== 'sync-progress') return fn(flags);
  const cmds = require('../cli/commands.cjs');
  const defaults = {};
  const files = {};
  const recordedFlags = { ...flags, _: [...(flags._ || [])] };
  const author = effectiveAuthor(cmd, flags);
  // collect-brief intentionally leaves collectBrief.author absent by default;
  // its activity author is still 'cli'. Do not invent that optional card field.
  if (cmd !== 'collect-brief' || flags.author !== undefined) recordedFlags.author = author;
  if (cloud && REPLAY_COMMANDS.includes(cmd)) {
    const inputKeys = cmd === 'collect-brief' ? ['file'] : ['add', 'pending'].includes(cmd) ? ['json-file'] : [];
    for (const key of inputKeys) {
      if (flags[key] !== undefined && flags[key] !== true) {
        try { files[key] = defaults[key] = fs.readFileSync(path.resolve(String(flags[key])), 'utf8'); }
        catch { /* Let the unchanged command reader report its original error. */ }
      }
    }
    if ((cmd === 'pending' && (flags._ || [])[0] && flags.json || cmd === 'add' && cmds.isBatchAdd(flags))
      && flags['json-file'] === undefined) files.stdin = defaults.stdin = cmds.readStdinSync();
    if (cmd === 'unclaim') {
      const branches = array(flags.branch).filter(x => x !== true).map(String);
      defaults.branches = branches.length ? branches : [cmds.currentBranch()].filter(Boolean);
      recordedFlags.branch = defaults.branches;
    }
    Object.defineProperty(flags, cmds.COMMAND_DEFAULTS, { value: defaults, configurable: true });
  }
  for (const key of LOCAL_FLAGS) delete recordedFlags[key];
  outbox.setOpContext({ opId: crypto.randomUUID(), command: cmd, flags: recordedFlags,
    files, author, clientTs: new Date().toISOString(), device: os.hostname() });
  try {
    const result = fn(flags);
    // sync-progress deliberately catches hook failures. A queue failure is still
    // fatal at the CLI boundary, rather than silently losing a cloud operation.
    if (outbox.getRecordingError()) throw outbox.getRecordingError();
    return result;
  } finally {
    outbox.clearOpContext();
    delete flags[cmds.COMMAND_DEFAULTS];
  }
}

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function applyPatch(flags) {
  const meta = ['commitShas', 'prNumbers', 'gitBranch'];
  if (Object.keys(flags).some(k => !['taskId', 'add', 'remove', 'project', 'registry', 'author'].includes(k))
    || ['add', 'remove'].some(op => !object(flags[op]) || Object.keys(flags[op]).some(k => !meta.includes(k))
      || meta.some(k => !Array.isArray(flags[op][k])))) fail(400, 'patch-ai-meta 只接受 taskId 与三个元数据数组 add/remove');
  const { resolveProject } = require('./resolveProject.cjs');
  const store = require('../cli/store.cjs');
  const proj = resolveProject(flags.project, { registryPath: flags.registry });
  const { board, changed } = store.mutateTask(proj, flags.taskId, b => {
    const task = (b.tasks || []).find(t => t.id === flags.taskId);
    if (!task) fail(404, `任务 ${flags.taskId} 不存在`);
    for (const key of meta) {
      const values = [...(task[key] || []).filter(value => !flags.remove[key].includes(value)), ...flags.add[key]];
      task[key] = key === 'commitShas' ? store.unionShas(values) : [...new Set(values)];
    }
  });
  return { ok: true, task: store.findTask(board, flags.taskId), changed };
}

/** Replay is synchronous, uses the supplied registry and embedded input only,
 * and never goes through CLI main (auto-project, context creation or output). */
function applyOp(op, { registryPath, projectId, author, actorUserId, actorName } = {}) {
  if (!object(op) || op.kind !== 'op') fail(400, '只接受 kind:op 操作');
  if (!REPLAY_COMMANDS.includes(op.command) && op.command !== 'patch-ai-meta') fail(403, '不允许重放该命令');
  if (!object(op.flags) || !object(op.files || {})) fail(400, '操作参数或文件内容格式无效');
  if (typeof registryPath !== 'string' || !path.isAbsolute(registryPath)) fail(400, 'registryPath 必须是绝对路径');
  if (typeof projectId !== 'string' || !projectId) fail(400, '必须指定 projectId');
  if (actorUserId !== undefined && (typeof actorUserId !== 'string' || !actorUserId.trim())) fail(400, 'actorUserId 必须是非空字符串');
  const { readRegistry } = require('./resolveProject.cjs');
  let tempDir;
  try {
    const entry = readRegistry(registryPath).projects?.[projectId];
    if (!entry) fail(404, `未注册的项目 "${projectId}"`);
    for (const key of ['mainRepo', 'codeRepo', 'board', 'docsRoot', 'index']) {
      if ((key === 'mainRepo' || entry[key]) && (typeof entry[key] !== 'string' || !path.isAbsolute(entry[key]))) {
        fail(400, `registry ${key} 必须是绝对路径`);
      }
    }
    if (Array.isArray(entry.costRoots) && entry.costRoots.some(p => typeof p !== 'string' || !path.isAbsolute(p))) {
      fail(400, 'registry costRoots 必须是绝对路径');
    }
    const flags = { ...op.flags, project: projectId, registry: registryPath };
    for (const key of ['json', 'help']) delete flags[key];
    if (author !== undefined) { flags.author = author; delete flags.from; }
    const files = op.files || {};
    const allowedFiles = ['add', 'pending'].includes(op.command) ? ['json-file', 'stdin']
      : op.command === 'collect-brief' ? ['file'] : [];
    if (Object.keys(files).some(k => !allowedFiles.includes(k) || typeof files[k] !== 'string')) fail(400, '操作文件字段无效');
    for (const key of ['json-file', 'file']) {
      if (allowedFiles.includes(key) && flags[key] !== undefined && !Object.hasOwn(files, key)) fail(400, `缺少内联文件 ${key}`);
    }
    if (Object.hasOwn(files, 'stdin') && Object.hasOwn(files, 'json-file')) fail(400, '输入文件重复');
    if (Object.keys(files).length) {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-replay-'));
      for (const [key, content] of Object.entries(files)) {
        const file = path.join(tempDir, key + '.txt');
        fs.writeFileSync(file, content, 'utf8');
        flags[key === 'stdin' ? 'json-file' : key] = file;
      }
    }
    const cmds = require('../cli/commands.cjs');
    // An empty branch snapshot is meaningful: never fall back to git on replay.
    Object.defineProperty(flags, cmds.COMMAND_DEFAULTS, { value: { branches: array(flags.branch), bindingEnv: {},
      ...(actorUserId === undefined ? {} : { actorUserId, actorName }) } });
    const refusal = entryGateRefusal(op.command, flags);
    if (refusal) fail(400, refusal);
    const index = require('../cli/index.cjs');
    return require('./syncOutbox.cjs').withoutRecording(() => {
      let result;
      if (op.command === 'patch-ai-meta') result = applyPatch(flags);
      else {
        const [modulePath, fn] = index.REGISTRY[op.command];
        result = require(path.join(__dirname, '..', 'cli', modulePath))[fn](flags);
      }
      return { ok: true, result: index.slimJson(result || { ok: true }) };
    });
  } catch (e) {
    if (!e.status) e.status = /不存在|ENOENT/.test(e.message) ? 404
      : /已存在|非法迁移|已完工|已作废|已答|尚未拍板|已落地|获取锁超时/.test(e.message) ? 409 : 400;
    throw e;
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = { REPLAY_COMMANDS, PATCH_COMMANDS, entryGateRefusal, runCliOperation, applyOp };

