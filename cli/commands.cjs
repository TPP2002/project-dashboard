'use strict';
/**
 * commands.cjs —— CLI 语义命令（board 唯一写者）。每个命令收 flags，走 store.mutate 改字段。
 * 状态机：claim 只能从 未开工/待开工/可复工/待拍板/已拍板 → 施工中（防倒退）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { mutate, readBoard, findTask, unionBy } = require('./store.cjs');
const { resolveProject, readRegistry, REGISTRY_PATH, DASHBOARD_HOME } = require('../core/resolveProject.cjs');
const { atomicWriteJsonSync } = require('../core/atomicWrite.cjs');
const { emptyBoard, STATUS, emojiFor } = require('../core/boardSchema.cjs');
const { normalizeReal } = require('../core/safePath.cjs');
const { withLock } = require('../core/lock.cjs');

// ---------- helpers ----------
const today = () => new Date().toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();
function need(v, usage) { if (v === undefined || v === true || v === '') throw new Error('缺参数。用法: ' + usage); return v; }
function asArray(v) { return v === undefined ? [] : Array.isArray(v) ? v : [v]; }
function getRegistryPath(flags) { return flags.registry ? path.resolve(flags.registry) : REGISTRY_PATH; }
function resolveProj(flags) { return resolveProject(need(flags.project, '--project <id>'), { registryPath: getRegistryPath(flags) }); }
function okTask(board, id) { return { ok: true, task: (board.tasks || []).find((x) => x.id === id) }; }
function act(type, author, text, taskId) { return { ts: nowIso(), author: author || 'cli', type, text, taskId: taskId || null }; }
function setPath(obj, dotted, val) { const p = dotted.split('.'); let o = obj; for (let i = 0; i < p.length - 1; i++) { o[p[i]] = o[p[i]] || {}; o = o[p[i]]; } o[p[p.length - 1]] = val; }
function deriveStats(b) {
  const byStatus = {}; for (const t of (b.tasks || [])) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  const total = (b.tasks || []).length; const done = byStatus['已完工'] || 0;
  return { byStatus, total, done, progress: total ? Math.round((done / total) * 100) : 0 };
}
function statsLine(s) { return `进度 ${s.progress}%（${s.done}/${s.total} 完工）· ` + Object.entries(s.byStatus).map(([k, v]) => `${k}${v}`).join(' '); }

// ---------- register（写 registry + 建空 board） ----------
function register(flags) {
  const id = need(flags.id, 'register --id <id> --name <名> --root <主仓路径> [--board <path>]');
  const name = flags.name || id;
  const root = need(flags.root, 'register --root <主仓路径>');
  const mainRepo = normalizeReal(root);
  const board = flags.board ? path.resolve(flags.board) : path.join(mainRepo, '.dashboard', 'board.json');
  const registryPath = getRegistryPath(flags);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  withLock(registryPath + '.lock', () => {
    const reg = fs.existsSync(registryPath) ? readRegistry(registryPath) : { schemaVersion: '1.0', projects: {} };
    reg.projects = reg.projects || {};
    reg.projects[id] = { name, mainRepo, board };
    atomicWriteJsonSync(registryPath, reg);
  });
  fs.mkdirSync(path.dirname(board), { recursive: true });
  if (!fs.existsSync(board)) atomicWriteJsonSync(board, emptyBoard({ id, name, mainRepo }));
  return { ok: true, id, board };
}

// ---------- add（新建 task） ----------
function add(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'add <taskId> --title <标题> [--status <状态>] [--wave <n>] [--desc <一句话>]');
  const title = need(flags.title, '--title <标题>');
  const status = flags.status || '未开工';
  if (!STATUS.includes(status)) throw new Error(`--status 非法，允许: ${STATUS.join('/')}`);
  const board = mutate(proj, (b) => {
    b.tasks = b.tasks || [];
    if (b.tasks.find((t) => t.id === id)) throw new Error(`任务 ${id} 已存在`);
    b.tasks.push({
      id, title, description: flags.desc || '', status,
      percent: status === '已完工' ? 100 : 0,
      wave: flags.wave !== undefined ? parseInt(flags.wave, 10) : 0,
      dates: { design: today(), start: null, done: null },
      gitBranch: [], worktree: [], prNumbers: [], commitShas: [], decisions: [],
      deps: { dependsOn: [], blockedBy: [], relatedTasks: [] }, docs: [],
    });
  }, act('note', flags.author, `新建任务 ${id}：${title}`, id));
  return okTask(board, id);
}

// ---------- claim（认领 → 施工中） ----------
function claim(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'claim <taskId> --branch <b> [--scope <glob>...]');
  const branches = asArray(flags.branch);
  const scopes = asArray(flags.scope);
  const author = flags.author || branches[0] || 'cli';
  const ALLOWED = ['未开工', '待开工', '可复工', '待拍板', '已拍板', '施工中'];
  const board = mutate(proj, (b) => {
    const t = findTask(b, id);
    if (!ALLOWED.includes(t.status)) throw new Error(`claim 非法迁移：${t.status} → 施工中（只能从 ${ALLOWED.join('/')}）`);
    t.status = '施工中';
    t.dates = t.dates || {}; if (!t.dates.start) t.dates.start = today();
    t.lastProgressAt = nowIso(); // 认领即盖戳,施工中卡片一开始就能显示"更新于 X 前"
    if (branches.length) t.gitBranch = unionBy([...(t.gitBranch || []), ...branches], String);
    if (scopes.length) t.fileScope = unionBy([...(t.fileScope || []), ...scopes], String);
  }, act('claim', author, `认领 ${id}：分支 ${branches.join(',') || '-'}${scopes.length ? '，文件域 ' + scopes.join(',') : ''}`, id));
  return okTask(board, id);
}

// ---------- progress（里程碑回写） ----------
function progress(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'progress <taskId> --percent <n> [--next <里程碑>] [--tests t/p/mff]');
  const pct = flags.percent !== undefined ? parseInt(flags.percent, 10) : undefined;
  const board = mutate(proj, (b) => {
    const t = findTask(b, id);
    if (pct !== undefined) { if (isNaN(pct) || pct < 0 || pct > 100) throw new Error('--percent 应为 0-100'); t.percent = pct; }
    if (flags.next !== undefined) t.nextMilestone = String(flags.next);
    if (flags.tests) { const [tot, pass, mff] = String(flags.tests).split('/').map(Number); t.tests = { total: tot || 0, passing: pass || 0, mustFailFirst: mff || 0 }; }
    if (flags.typecheck !== undefined) t.typecheck = flags.typecheck === true || flags.typecheck === 'true';
    t.lastProgressAt = nowIso(); // 盖"进度更新时间"戳,前端据此显示"更新于 X 前",让陈旧可见
  }, act('progress', flags.author, `进度 ${id}${pct !== undefined ? ' ' + pct + '%' : ''}${flags.next ? '：' + flags.next : ''}`, id));
  return okTask(board, id);
}

/**
 * sync-progress —— 自动进度同步(TodoWrite 钩子调用):
 * 按当前 git 分支找到"施工中"的任务,把对话待办清单的完成比同步成 percent。
 * 治"进度纯靠对话记得调 cli progress、不报就冻住"——挂在对话每次更新待办上,全自动。
 * 规则:只进不退(max)、自动进度封顶 95(真完工靠 cli done 置 100)、找不到任务静默跳过。
 */
function syncProgress(flags) {
  const proj = resolveProj(flags);
  const pct = flags.percent !== undefined ? parseInt(flags.percent, 10) : undefined;
  if (pct === undefined || isNaN(pct)) return { ok: true, skipped: '缺 --percent' };
  // 分支:优先 --branch,否则读当前 git 分支(钩子在对话 cwd 里跑)
  let branch = flags.branch ? String(asArray(flags.branch)[0]) : '';
  if (!branch) {
    try { branch = require('node:child_process').execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(); }
    catch (_) { branch = ''; }
  }
  if (!branch || branch === 'HEAD') return { ok: true, skipped: '无有效分支' };
  // 先只读:找匹配的施工中任务,没有就不写(免 activity 噪音)
  const board0 = readBoard(proj.board);
  const cand = (board0.tasks || []).find((t) =>
    t.status === '施工中' && (t.gitBranch || []).map(String).includes(branch));
  if (!cand) return { ok: true, skipped: `无施工中任务匹配分支 ${branch}` };
  const target = Math.max(cand.percent || 0, Math.min(95, Math.max(0, pct))); // 只进不退、封顶 95
  if (target <= (cand.percent || 0)) return { ok: true, skipped: `进度未前进(当前 ${cand.percent || 0}%)` };
  const board = mutate(proj, (b) => {
    const t = findTask(b, cand.id);
    t.percent = target;
    t.lastProgressAt = nowIso();
  }, act('progress', flags.author || 'todo-hook', `进度(自动) ${cand.id} ${target}%`, cand.id));
  return okTask(board, cand.id);
}

// ---------- pending（登记待拍板问题） ----------
// pending 必须给全三件套（skill §6.2/§6.3 硬规则）——缺就报错，绝不允许"术语墙裸奔"。
// 两种输入模式：
//   ① --json：从 stdin 读整块 JSON（推荐给对话用，便于结构化）
//   ② 命令行 flag：--q --opt --opt --rec --background --reason --pros-<option>=<text> [--strict]
// strict=true 时禁用 allowCustom，默认开放自定义答案。
function readStdinSync() {
  try { return require('node:fs').readFileSync(0, 'utf8'); }
  catch { return ''; }
}
const MIN_BG = 60;      // 背景至少 60 字（怕术语墙一句话糊弄）
const MIN_REASON = 30;  // 推荐理由至少 30 字
const MIN_PROS = 20;    // 每个选项利弊至少 20 字

function validatePendingPayload(p) {
  const errs = [];
  const missing = (k) => (p[k] === undefined || p[k] === null || String(p[k]).trim() === '');
  if (missing('question')) errs.push('缺 question（要拍什么板）');
  if (!Array.isArray(p.options) || p.options.length < 2) errs.push('options 至少 2 个（一元选项没法叫拍板）');
  if (missing('recommended')) errs.push('缺 recommended（推荐哪个）');
  else if (Array.isArray(p.options) && !p.options.includes(p.recommended)) errs.push(`recommended「${p.recommended}」不在 options 内`);
  if (missing('background')) errs.push('缺 background（背景大白话，讲清"什么问题+为什么+影响+要做啥"，见 skill §6.2）');
  else if (String(p.background).trim().length < MIN_BG) errs.push(`background 太短（${String(p.background).trim().length}<${MIN_BG} 字）——skill §6.2 要求分点讲透，别一句话糊弄`);
  if (missing('recommendReason')) errs.push('缺 recommendReason（讲透为什么推这个，不是空推荐）');
  else if (String(p.recommendReason).trim().length < MIN_REASON) errs.push(`recommendReason 太短（${String(p.recommendReason).trim().length}<${MIN_REASON} 字）`);
  if (!p.optionPros || typeof p.optionPros !== 'object') errs.push('缺 optionPros（每个选项的【好处】【代价】拆解）');
  else {
    for (const opt of (p.options || [])) {
      const txt = (p.optionPros[opt] || '').trim();
      if (!txt) errs.push(`optionPros 缺选项「${opt}」的利弊`);
      else if (txt.length < MIN_PROS) errs.push(`optionPros["${opt}"] 太短（${txt.length}<${MIN_PROS} 字）——分【好处】【代价】具体讲`);
    }
  }
  return errs;
}

function pending(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'pending <taskId> --json <<< "{...}"  或  --q --opt --opt --rec --background --reason --pros-<opt>=<text>');
  // 组装 payload
  let payload;
  if (flags.json) {
    const raw = readStdinSync();
    if (!raw.trim()) throw new Error('--json 需从 stdin 读 JSON，但 stdin 为空');
    try { payload = JSON.parse(raw); } catch (e) { throw new Error('--json stdin 解析失败：' + e.message); }
  } else {
    const options = asArray(flags.opt);
    const optionPros = {};
    for (const k of Object.keys(flags)) {
      if (k.startsWith('pros-')) optionPros[k.slice(5)] = flags[k];
    }
    payload = {
      question: flags.q,
      options,
      recommended: flags.rec || options[0],
      background: flags.background,
      optionPros,
      recommendReason: flags.reason || flags.recommendReason,
      allowCustom: flags.strict ? false : true,
    };
  }
  // 硬校验
  const errs = validatePendingPayload(payload);
  if (errs.length) {
    throw new Error('登记待拍板不合格（skill §6.2 硬规则，缺字段/太短就不许提交）:\n  - ' + errs.join('\n  - ') + '\n\n模板 JSON（存成 pending.json 后 `... pending <id> --json < pending.json`）:\n' + JSON.stringify({
      question: '一句大白话问题',
      options: ['选项A', '选项B'],
      recommended: '选项A',
      background: '【场景】...\n【问题】...\n【要做的事】...\n【为什么这重要】...',
      optionPros: { '选项A': '【好处】...\n【代价】...', '选项B': '【好处】...\n【代价】...' },
      recommendReason: '讲透为什么推这个（历史教训/前置条件/机会成本/风险权衡）',
      allowCustom: true,
    }, null, 2));
  }
  const board = mutate(proj, (b) => {
    const t = findTask(b, id); t.decisions = t.decisions || [];
    const did = flags.did || ('d' + (t.decisions.length + 1));
    if (t.decisions.find((d) => d.id === did)) throw new Error(`decision ${did} 已存在`);
    t.decisions.push({
      id: did,
      question: payload.question,
      options: payload.options,
      recommended: payload.recommended,
      background: payload.background,
      optionPros: payload.optionPros,
      recommendReason: payload.recommendReason,
      allowCustom: payload.allowCustom !== false,
      answer: null,
      decidedAt: null,
    });
    if (['未开工', '待开工'].includes(t.status)) t.status = '待拍板';
  }, act('pending', flags.author, `待拍板 ${id}：${payload.question}`, id));
  return okTask(board, id);
}

// ---------- decide（拍板：填答案） ----------
function decide(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'decide <taskId> --did <dN> --answer <答案> [--promote]');
  const did = need(flags.did, '--did <dN>');
  const answer = need(flags.answer, '--answer <答案>');
  const board = mutate(proj, (b) => {
    const t = findTask(b, id);
    const d = (t.decisions || []).find((x) => x.id === did);
    if (!d) throw new Error(`decision ${did} 不存在`);
    if (!d.options.includes(answer) && !d.allowCustom) throw new Error(`答案「${answer}」不在选项 ${d.options.join('/')} 中`);
    d.answer = answer; d.decidedAt = today();
    if (flags.promote && (t.decisions || []).every((x) => x.answer !== null) && t.status === '待拍板') t.status = '已拍板';
  }, act('decide', flags.author || '看板', `拍板 ${id}·${did}=${answer}`, id));
  return okTask(board, id);
}

// ---------- mark-landed（拍板已代码落地，从"待落地队列"消失）----------
function markLanded(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'mark-landed <taskId> --did <dN> [--commit <sha>]');
  const did = need(flags.did, '--did <dN>');
  const board = mutate(proj, (b) => {
    const t = findTask(b, id);
    const d = (t.decisions || []).find((x) => x.id === did);
    if (!d) throw new Error(`decision ${did} 不存在`);
    if (d.answer === null || d.answer === undefined) throw new Error(`decision ${did} 还没拍板,不能标已落地`);
    d.landed = true;
    d.landedAt = today();
    if (flags.commit) d.landedCommit = String(flags.commit);
  }, act('note', flags.author || 'cli', `拍板 ${id}·${did} 已代码落地`, id));
  return okTask(board, id);
}

// ---------- park / block ----------
function park(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'park <taskId> --reason <理由> [--note <遗留>]');
  const reason = need(flags.reason, '--reason <理由>');
  const board = mutate(proj, (b) => {
    const t = findTask(b, id); t.status = '暂缓'; t.blockReason = reason;
    if (flags.note) t.parkedNote = String(flags.note);
  }, act('park', flags.author, `暂缓 ${id}：${reason}`, id));
  return okTask(board, id);
}
function block(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'block <taskId> --by <taskId>... --reason <理由>');
  const by = asArray(flags.by);
  const board = mutate(proj, (b) => {
    const t = findTask(b, id);
    t.deps = t.deps || { dependsOn: [], blockedBy: [], relatedTasks: [] };
    t.deps.blockedBy = unionBy([...(t.deps.blockedBy || []), ...by], String);
    if (flags.reason) t.blockReason = String(flags.reason);
  }, act('block', flags.author, `阻塞 ${id}：被 ${by.join(',')} 挡`, id));
  return okTask(board, id);
}

// ---------- done（收官 / 完工） ----------
function done(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'done <taskId> [--pr <n>...] [--commit <sha>...] [--collect]');
  const prs = asArray(flags.pr).map(Number).filter((n) => !isNaN(n));
  const commits = asArray(flags.commit).map(String);
  const board = mutate(proj, (b) => {
    const t = findTask(b, id);
    t.status = flags.collect ? '收官' : '已完工';
    t.dates = t.dates || {}; t.dates.done = today(); t.percent = 100;
    if (prs.length) t.prNumbers = unionBy([...(t.prNumbers || []), ...prs], String);
    if (commits.length) t.commitShas = unionBy([...(t.commitShas || []), ...commits], String);
  }, act('done', flags.author, `${flags.collect ? '收官' : '完工'} ${id}${prs.length ? '·PR ' + prs.join(',') : ''}`, id));
  return okTask(board, id);
}

// ---------- note（全局活动流） ----------
function note(flags) {
  const proj = resolveProj(flags);
  const text = need(flags.text, 'note --text <文本> [--task <id>]');
  mutate(proj, () => {}, act('note', flags.author, text, flags.task || null));
  return { ok: true };
}

// ---------- set（通用兜底赋值） ----------
function set(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'set <taskId> --field <点路径> --value <json>');
  const field = need(flags.field, '--field <点路径>');
  const raw = need(flags.value, '--value <json>');
  let val; try { val = JSON.parse(raw); } catch { val = raw; }
  const board = mutate(proj, (b) => { setPath(findTask(b, id), field, val); },
    act('note', flags.author, `set ${id}.${field}=${raw}`, id));
  return okTask(board, id);
}

// ---------- list / show（只读，读时派生） ----------
function list(flags) {
  const proj = resolveProj(flags);
  const b = readBoard(proj.board);
  let tasks = b.tasks || [];
  if (flags.status) tasks = tasks.filter((t) => t.status === flags.status);
  if (flags.wave !== undefined) tasks = tasks.filter((t) => String(t.wave) === String(flags.wave));
  const rows = tasks.map((t) => `${emojiFor(t.status)} ${String(t.id).padEnd(10)} ${String(t.status).padEnd(6)} ${String(t.percent || 0).padStart(3)}%  ${t.gitBranch && t.gitBranch.length ? t.gitBranch.join(',') : '-'}  ${t.title}`);
  return { ok: true, text: `${proj.name}  ${statsLine(deriveStats(b))}\n` + rows.join('\n') };
}
function show(flags) {
  const proj = resolveProj(flags);
  const b = readBoard(proj.board);
  if (flags.pending) {
    const items = [];
    for (const t of (b.tasks || [])) for (const d of (t.decisions || [])) if (d.answer === null) {
      items.push(`❓ ${t.id}·${d.id} ${d.question}\n   选项：${d.options.join(' / ')}｜推荐：${d.recommended}`);
    }
    return { ok: true, text: items.length ? `待拍板 ${items.length} 条：\n` + items.join('\n') : '无待拍板' };
  }
  const id = need(flags._[0], 'show <taskId> | show --pending');
  return { ok: true, text: JSON.stringify(findTask(b, id), null, 2) };
}

module.exports = { register, add, claim, progress, syncProgress, pending, decide, markLanded, park, block, done, note, set, list, show, deriveStats };
