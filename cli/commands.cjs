'use strict';
/**
 * commands.cjs —— CLI 语义命令（board 唯一写者）。每个命令收 flags，走 store.mutate 改字段。
 * 状态机：claim 只能从 未开工/待开工/可复工/待拍板/已拍板 → 施工中（防倒退）；
 * 往回走的三个动作各有各的语义，不许互相顶替：unclaim = 我不做了但活还在（施工中 → 待开工/可复工）、
 * cancel = 这活不做了（任意 → 已作废）、reopen = 结了案又要重来（已完工/已作废 → 待开工）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { mutate, mutateTask, readBoard, readBoardOrNull, findTask, unionBy, unionShas } = require('./store.cjs');
const { resolveProject, readRegistry, detectProjectIds, REGISTRY_PATH, DASHBOARD_HOME } = require('../core/resolveProject.cjs');
const { atomicWriteJsonSync } = require('../core/atomicWrite.cjs');
const { emptyBoard, STATUS, TASKID, VOID_STATUSES } = require('../core/boardSchema.cjs');
const { renderList, renderShowCard } = require('./renderTask.cjs');
const { normalizeReal } = require('../core/safePath.cjs');
const { isGeneratedArtifact } = require('../core/generatedArtifacts.cjs');
const { withLock } = require('../core/lock.cjs');

// ---------- helpers ----------
// today = 本地时区日期。旧版用 toISOString()(UTC)——北京凌晨 0:00-7:59 的完工/开工/拍板
// 全被记成前一天（体检 B3）。activity 时间戳仍存 ISO UTC（精确时刻，展示端自行转本地）。
const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const nowIso = () => new Date().toISOString();
function need(v, usage) { if (v === undefined || v === true || v === '') throw new Error('缺参数。用法: ' + usage); return v; }
function asArray(v) { return v === undefined ? [] : Array.isArray(v) ? v : [v]; }
/**
 * 建卡/认领填了自动生成物就当场提醒(卡 BOARD-FILESCOPE-INDEX-POLLUTION)。
 * 只提醒不拦:字段照原样收下(对人有信息量),但判撞车的那两处会忽略它——
 * 与其让人以为"填了就被保护了",不如当场说清楚。
 */
function warnGeneratedScopes(scopes) {
  const bad = asArray(scopes).filter((s) => isGeneratedArtifact(s));
  if (!bad.length) return;
  process.stderr.write(
    `⚠ 文件范围里有自动生成物:${bad.join('、')}\n` +
    '  这类文件谁干活都会碰(自动生成的目录/锁文件/构建产物),已按原样记进卡里,\n' +
    '  但并行判断(哪些卡能同时派)与占用防撞会忽略它——靠它是挡不住撞车的。\n' +
    '  建卡指引:fileScope 只填这张卡真正要动的手写文件。\n');
}
function getRegistryPath(flags) { return flags.registry ? path.resolve(flags.registry) : REGISTRY_PATH; }
function resolveProj(flags) { return resolveProject(need(flags.project, '--project <id>（在项目仓里跑可省略，CLI 入口会自动认；见 cli/index.cjs autoFillProject）'), { registryPath: getRegistryPath(flags) }); }
// changed：本次真正动了哪些字段，由 mutateTask 在锁内比前后快照得出。写命令的 --json 只回它，
// 不回整卡（AUD-CLI-BRIEF-AND-HELP，审计 §4-A4）。
function okTask(board, id, changed) { return { ok: true, task: (board.tasks || []).find((x) => x.id === id), changed: changed || [] }; }
function act(type, author, text, taskId) { return { ts: nowIso(), author: author || 'cli', type, text, taskId: taskId || null }; }
/** 摘要：超过 n 个字就截断加省略号（卡片上的「下一步」只有一行，塞不下整段问题）。 */
function summarize(s, n) { const x = String(s || '').trim(); return x.length > n ? x.slice(0, n) + '…' : x; }
/** 已拍板、但还没标「代码落地」的决策 —— done 与 mark-landed --all 的共同目标。 */
function isDecidedNotLanded(d) { return !!d && d.answer !== null && d.answer !== undefined && !d.landed; }
function landDecision(d, commit) { d.landed = true; d.landedAt = today(); if (commit) d.landedCommit = String(commit); }
/** 当前 git 分支（不在仓库里 / 处于游离 HEAD 时返回空串）。unclaim 不给 --branch 时用它猜。 */
function currentBranch() {
  try {
    const b = require('node:child_process').execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return b === 'HEAD' ? '' : b;
  } catch (_) { return ''; }
}
function setPath(obj, dotted, val) { const p = dotted.split('.'); let o = obj; for (let i = 0; i < p.length - 1; i++) { o[p[i]] = o[p[i]] || {}; o = o[p[i]]; } o[p[p.length - 1]] = val; }
function deriveStats(b) {
  const byStatus = {}; for (const t of (b.tasks || [])) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  // 作废卡进状态分布、但【不进完成度的分母】：它不是「没做完」，是「不做了」。
  // 留在分母里的后果是作废得越多、进度看着越低 —— 负责人会以为活越干越回去（审计 §4-C1）。
  const total = (b.tasks || []).filter((t) => !VOID_STATUSES.includes(t.status)).length;
  const done = byStatus['已完工'] || 0;
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
  // 一份清单建一批（--json-file / --json）走批量分支：一次加锁一次写盘、全有或全无
  if (isBatchAdd(flags)) return addBatch(flags);
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'add <taskId> --title <标题> --plain-title <人话标题> [--status <状态>] [--wave <n>] [--desc <一句话>] [--model <建议档位>] [--scope <glob>...]\n      批量: add --json-file <清单.json>  或  add --json < 清单.json');
  const title = need(flags.title, '--title <标题>');
  const status = flags.status || '未开工';
  if (!STATUS.includes(status)) throw new Error(`--status 非法，允许: ${STATUS.join('/')}`);
  let modelHint;
  if (flags.model !== undefined && flags.model !== true) {
    modelHint = String(flags.model).trim();
    if (modelHint.length > 40) throw new Error('--model 建议档位太长(≤40 字符,如 "sonnet·低" / "opus" / "fable·max")');
  }
  let plainTitle;
  if (flags['plain-title'] !== undefined && flags['plain-title'] !== true) {
    plainTitle = String(flags['plain-title']).trim();
    if (!plainTitle) throw new Error('--plain-title 不能是空字符串');
  }
  const scopes = asArray(flags.scope);
  const { board, changed } = mutateTask(proj, id, (b) => {
    b.tasks = b.tasks || [];
    if (b.tasks.find((t) => t.id === id)) throw new Error(`任务 ${id} 已存在`);
    const t = {
      id, title, description: flags.desc || '', status,
      percent: status === '已完工' ? 100 : 0,
      wave: flags.wave !== undefined ? parseInt(flags.wave, 10) : 0,
      dates: { design: today(), start: null, done: null },
      gitBranch: [], worktree: [], prNumbers: [], commitShas: [], decisions: [],
      deps: { dependsOn: [], blockedBy: [], relatedTasks: [] }, docs: [],
    };
    if (modelHint) t.modelHint = modelHint;
    if (plainTitle) t.plainTitle = plainTitle;
    if (scopes.length) t.fileScope = scopes;
    b.tasks.push(t);
  }, act('note', flags.author, `新建任务 ${id}：${title}${modelHint ? '（建议档位 ' + modelHint + '）' : ''}${plainTitle ? '（人话标题 ' + plainTitle + '）' : ''}`, id));
  warnGeneratedScopes(scopes);
  return okTask(board, id, changed);
}

// ---------- 批量建卡（AUD-CLI-BATCH-AND-AUTOPROJECT ①）----------
/**
 * 这次 add 是不是【批量】：给了 --json-file，或给了 --json 且没写卡号。
 *
 * 为什么拿"没写卡号"当判据：单卡 add 的卡号是位置参数、必给；而 `--json` 在本 CLI 里还兼着
 * 全局"输出 JSON"开关（见 cli/index.cjs 尾部）。若只看 --json，`add T1 … --json` 这种老写法
 * 会被当成批量、把卡号静默丢掉——一个纯输出格式的开关不该把建卡语义整个换掉。
 * cli/index.cjs 的两道单卡机器闸（--model / --plain-title）也照这个判据放行，两处必须同一口径，
 * 所以判据只写这一份、由入口 require 过去用。
 */
function isBatchAdd(flags) {
  if (typeof flags['json-file'] === 'string' && flags['json-file'].trim()) return true;
  return flags.json === true && !((flags._ || []).length);
}

/**
 * 读一块 JSON 输入：--json-file <路径> 优先，否则 --json 从 stdin。
 * BOM 必须剥：Windows PowerShell 的 `>` / `Out-File` / `Set-Content -Encoding utf8` 默认写 UTF-8 BOM，
 * 而 JSON.parse 见 BOM 直接抛 "Unexpected token"——本来 --json-file 就是为了绕开 PowerShell 的
 * heredoc 之苦（审计 A8），再被 BOM 绊一跤就白加了。
 */
function readJsonInput(flags, what) {
  const strip = (t) => (t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t);
  const file = flags['json-file'];
  if (file === true) throw new Error('--json-file 后面漏写路径了。用法: --json-file <路径>');
  if (file !== undefined) {
    const abs = path.resolve(String(file));
    let raw;
    try { raw = fs.readFileSync(abs, 'utf8'); }
    catch (e) { throw new Error(`--json-file 读不到 ${abs}：${e.message}`); }
    if (!raw.trim()) throw new Error(`--json-file ${abs} 是空文件`);
    try { return JSON.parse(strip(raw)); }
    catch (e) { throw new Error(`--json-file ${abs} 解析失败：${e.message}`); }
  }
  const raw = readStdinSync();
  if (!raw.trim()) {
    throw new Error(`--json 需从 stdin 读${what}，但 stdin 为空。\n  （PowerShell 下 heredoc 不好使，改用 --json-file <路径> 更省事）`);
  }
  try { return JSON.parse(strip(raw)); }
  catch (e) { throw new Error(`--json stdin 解析失败：${e.message}`); }
}

// 批量清单每项认得的字段。多一个不认识的就当场拒——批量最怕"写错键名被静默吞掉"：
// 20 张卡里有一张 plaintitle 拼错，回读才发现人话标题是空的，正是 CLI-ADD-NO-PLAINTITLE-FILESCOPE 那个坑。
const BATCH_ITEM_KEYS = ['id', 'plainTitle', 'title', 'model', 'scope', 'deps', 'wave', 'desc', 'status'];
const DEP_KEYS = ['dependsOn', 'blockedBy', 'relatedTasks'];

function batchReject(errs) {
  return new Error(
    `批量建卡整批拒绝（${errs.length} 处问题，一张都没建）:\n  - ` + errs.join('\n  - ') +
    '\n\n每项的字段：' + BATCH_ITEM_KEYS.join(' / ') +
    '\n  id/title/plainTitle/model 必给（后两个就是单卡 add 的 --plain-title / --model 机器闸，逐项照查）;' +
    '\n  scope=数组(会改哪些文件), deps={dependsOn,blockedBy,relatedTasks}, wave 默认 0, status 默认 未开工。',
  );
}

/**
 * 批量建卡：一份清单 → 一次加锁、一次写盘。
 *
 * 治的病（审计 A8）：规划会话一次要建 10~20 张卡 = 起 10~20 个 node 进程、把整份 board.json
 * 解析 10~20 遍、抢 10~20 次锁；中途任何一张被机器闸拒收，前面的已经落盘了、剩下的没建，
 * 板停在一个谁也说不清的半截状态。
 *
 * 所以口径是【全有或全无】：先把全部问题一次性收齐报出来（不是遇到第一个就退），
 * 全对了才进锁写一次。校验分两段——形状类（字段齐不齐、类型对不对）在锁外做；
 * 跟板有关的（卡号是不是已存在、依赖指向的卡在不在）先只读查一遍，好把错误跟形状问题一起报全，
 * 再在锁内重查一遍兜并发（两次之间可能有别的对话刚建了同号的卡）。
 */
function addBatch(flags) {
  const proj = resolveProj(flags);
  const payload = readJsonInput(flags, '任务清单数组');
  const items = Array.isArray(payload)
    ? payload
    : (payload && Array.isArray(payload.tasks) ? payload.tasks : null);
  if (!items) throw new Error('批量建卡的 JSON 应是【数组】(或 {"tasks":[…]})，每项一张卡');
  if (!items.length) throw new Error('批量建卡清单是空数组，没什么可建的');

  const errs = [];
  const drafts = [];
  const seen = new Map(); // id → 第几项（查批内重号）
  const str = (v) => (typeof v === 'string' ? v.trim() : '');

  items.forEach((item, i) => {
    const at = `第 ${i + 1} 项`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errs.push(`${at}: 应为对象`); return; }
    const id = str(item.id);
    const at2 = id ? `${at}(${id})` : at;
    for (const k of Object.keys(item)) {
      if (!BATCH_ITEM_KEYS.includes(k)) errs.push(`${at2}: 不认识的字段「${k}」——是不是拼错了？认得的只有 ${BATCH_ITEM_KEYS.join('/')}`);
    }
    if (!id) errs.push(`${at2}: 缺 id`);
    else if (!TASKID.test(id)) errs.push(`${at2}: 非法卡号「${id}」——只能大写字母/数字/连字号，且首字符不是连字号`);
    else if (seen.has(id)) errs.push(`${at2}: 卡号跟第 ${seen.get(id) + 1} 项重了`);
    else seen.set(id, i);

    const title = str(item.title);
    if (!title) errs.push(`${at2}: 缺 title（给模型看的技术说明）`);
    const plainTitle = str(item.plainTitle);
    if (!plainTitle) errs.push(`${at2}: 缺 plainTitle（给负责人看的一句人话，20~35 字，禁文件名/函数名/编号；= 单卡 add 的 --plain-title 机器闸）`);
    const model = str(item.model);
    if (!model) errs.push(`${at2}: 缺 model（建议档位，= 单卡 add 的 --model 机器闸；照抄 "sonnet·低"/"opus·中"/"fable·高"/"负责人本人办"）`);
    else if (model.length > 40) errs.push(`${at2}: model 太长（${model.length}>40 字符）`);

    const status = item.status === undefined ? '未开工' : item.status;
    if (!STATUS.includes(status)) errs.push(`${at2}: status 非法「${status}」，允许: ${STATUS.join('/')}`);

    let wave = 0;
    if (item.wave !== undefined) {
      wave = typeof item.wave === 'number' ? item.wave : parseInt(item.wave, 10);
      if (!Number.isInteger(wave) || wave < 0) errs.push(`${at2}: wave 应为 ≥0 的整数（新冒出来的卡一律留 0，别继承父卡的波次）`);
    }

    let scope = [];
    if (item.scope !== undefined) {
      if (!Array.isArray(item.scope)) errs.push(`${at2}: scope 应为数组（这张卡会改哪些文件，glob；拿不准就给 []，别瞎猜）`);
      else if (item.scope.some((x) => !str(x))) errs.push(`${at2}: scope 里有空项或非字符串`);
      else scope = item.scope.map((x) => x.trim());
    }

    const deps = { dependsOn: [], blockedBy: [], relatedTasks: [] };
    if (item.deps !== undefined) {
      if (!item.deps || typeof item.deps !== 'object' || Array.isArray(item.deps)) {
        errs.push(`${at2}: deps 应为对象 {dependsOn:[],blockedBy:[],relatedTasks:[]}`);
      } else {
        for (const k of Object.keys(item.deps)) {
          if (!DEP_KEYS.includes(k)) errs.push(`${at2}: deps 里不认识的字段「${k}」——只有 ${DEP_KEYS.join('/')}`);
        }
        for (const rel of DEP_KEYS) {
          const v = item.deps[rel];
          if (v === undefined) continue;
          if (!Array.isArray(v)) { errs.push(`${at2}: deps.${rel} 应为数组`); continue; }
          if (v.some((x) => !str(x))) { errs.push(`${at2}: deps.${rel} 里有空项或非字符串`); continue; }
          deps[rel] = v.map((x) => x.trim());
        }
      }
    }

    if (item.desc !== undefined && typeof item.desc !== 'string') errs.push(`${at2}: desc 应为字符串`);

    drafts.push({ id, title, plainTitle, model, status, wave, scope, deps, desc: item.desc || '' });
  });

  // 跟板有关的校验：先只读查一遍，好把错误跟上面的形状问题一起报全（锁内还会再查一次兜并发）
  const existingIds = new Set((((readBoardOrNull(proj.board) || {}).tasks) || []).map((t) => t.id));
  const batchIds = new Set(drafts.map((d) => d.id).filter(Boolean));
  for (const d of drafts) {
    if (!d.id) continue;
    if (existingIds.has(d.id)) errs.push(`第 ${seen.get(d.id) + 1} 项(${d.id}): 卡号已在板上，换个号或删掉这项`);
    for (const rel of DEP_KEYS) {
      for (const ref of d.deps[rel]) {
        if (!existingIds.has(ref) && !batchIds.has(ref)) errs.push(`${d.id}.deps.${rel}: 指向不存在的卡「${ref}」（板上没有、这批里也没有）`);
      }
    }
  }
  if (errs.length) throw batchReject(errs);

  const board = mutate(proj, (b) => {
    b.tasks = b.tasks || [];
    b.activity = b.activity || [];
    // 锁内重查：从只读那一遍到现在，别的对话可能刚建了同号的卡
    const now = new Set(b.tasks.map((t) => t.id));
    const clash = drafts.map((d) => d.id).filter((id) => now.has(id));
    if (clash.length) throw new Error(`批量建卡整批拒绝：抢锁期间这些卡号被别的对话建走了：${clash.join('、')}`);
    for (const d of drafts) {
      const t = {
        id: d.id, title: d.title, description: d.desc, status: d.status,
        percent: d.status === '已完工' ? 100 : 0,
        wave: d.wave,
        dates: { design: today(), start: null, done: null },
        gitBranch: [], worktree: [], prNumbers: [], commitShas: [], decisions: [],
        deps: d.deps, docs: [],
      };
      t.modelHint = d.model;
      t.plainTitle = d.plainTitle;
      if (d.scope.length) t.fileScope = d.scope;
      b.tasks.push(t);
      // 每张卡各留一条流水，跟单卡 add 一模一样 —— 批量不该让某张卡在活动流里查无此人
      b.activity.push(act('note', flags.author, `新建任务 ${d.id}：${d.title}（建议档位 ${d.model}）（人话标题 ${d.plainTitle}）`, d.id));
    }
  }, act('note', flags.author, `批量建卡 ${drafts.length} 张：${drafts.map((d) => d.id).join('、')}`, null));

  warnGeneratedScopes(drafts.flatMap((d) => d.scope));
  const ids = drafts.map((d) => d.id);
  return {
    ok: true, count: ids.length, ids,
    tasks: (board.tasks || []).filter((t) => batchIds.has(t.id)),
    text: `✔ 批量建卡 ${ids.length} 张（一次加锁一次写盘）：${ids.join('、')}`,
  };
}

// ---------- claim（认领 → 施工中） ----------
function claim(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'claim <taskId> --branch <b> [--scope <glob>...]');
  const branches = asArray(flags.branch);
  const scopes = asArray(flags.scope);
  const author = flags.author || branches[0] || 'cli';
  const ALLOWED = ['未开工', '待开工', '可复工', '待拍板', '已拍板', '施工中'];
  const { board, changed } = mutateTask(proj, id, (b) => {
    const t = findTask(b, id);
    if (!ALLOWED.includes(t.status)) {
      throw new Error(`claim 非法迁移：${t.status} → 施工中（只能从 ${ALLOWED.join('/')}）` +
        `。已完工 / 已作废的卡要接着做，先 reopen ${id} --reason "<为什么重开>"`);
    }
    t.status = '施工中';
    t.dates = t.dates || {}; if (!t.dates.start) t.dates.start = today();
    t.lastProgressAt = nowIso(); // 认领即盖戳,施工中卡片一开始就能显示"更新于 X 前"
    if (branches.length) t.gitBranch = unionBy([...(t.gitBranch || []), ...branches], String);
    if (scopes.length) t.fileScope = unionBy([...(t.fileScope || []), ...scopes], String);
  }, act('claim', author, `认领 ${id}：分支 ${branches.join(',') || '-'}${scopes.length ? '，文件域 ' + scopes.join(',') : ''}`, id));
  warnGeneratedScopes(scopes);
  const res = okTask(board, id, changed);
  // --brief：认领即打印开工任务书，省掉"claim 完再 brief 一次"这一趟（AUD-CLI-BRIEF-AND-HELP）。
  // 惰性 require：不带 --brief 的调用不该为它付启动成本。
  if (flags.brief) {
    const { buildBrief } = require('./brief.cjs');
    res.text = `✔ claim ${id} → ${res.task.status}\n\n`
      + buildBrief({ pid: proj.id, projName: proj.name, board, task: res.task });
  }
  return res;
}

// 终态 = 这张卡的一生已经结账。要再动它，只有 reopen 一条路。
const TERMINAL_STATUSES = ['已完工', '已作废'];

// ---------- unclaim（放弃认领 → 退回可派状态） ----------
// 病根：CLI 只有往前走的命令。对话一中断、任务一转手，卡就永远挂着「施工中」——
// 看板上显示有人在干、实际没人；别人以为被占了不敢接，负责人也看不出这活其实停了（审计 §4-A5）。
// 退回哪个状态照 claim 之前的原样来：暂缓解除过的卡回「可复工」，其余回「待开工」。
// 进度不清零 —— 「做到 60% 没人接」比「回到 0」更接近事实，下一个接手的人靠它判断还剩多少。
function unclaim(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'unclaim <taskId> --reason <理由> [--branch <b>...]');
  const reason = String(need(flags.reason, '--reason <理由>'));
  const branches = asArray(flags.branch).filter((x) => x !== true).map(String);
  const { board, changed } = mutateTask(proj, id, (b) => {
    const t = findTask(b, id);
    if (t.status !== '施工中') throw new Error(`unclaim 非法迁移：${t.status} → 待开工（只能从 施工中）`);
    // 退回哪一档看这张卡「这一轮是不是解冻来的」：解除暂缓留下的 unparkReason 还挂着，就说明是，
    // 回「可复工」；一律退成「待开工」会把它跟从没开工过的卡混为一谈。
    // （park / cancel / reopen 都会抹掉 unparkReason，所以它只在当前这一轮有效，不会串味。）
    t.status = t.unparkReason ? '可复工' : '待开工';
    // 分支给了就摘给的那几条；没给就摘当前 git 分支（在自己工位上跑时最省事）。
    // 一条都没摘也不报错：别人代为释放一张卡时，本来就未必知道对方用的哪个分支。
    const drop = branches.length ? branches : [currentBranch()].filter(Boolean);
    if (drop.length) t.gitBranch = (t.gitBranch || []).filter((x) => !drop.includes(String(x)));
    t.unclaimReason = reason; t.unclaimedAt = today();
    t.lastProgressAt = nowIso();
  }, act('unclaim', flags.author, `放弃认领 ${id}：${reason}`, id));
  return okTask(board, id, changed);
}

// ---------- progress（里程碑回写） ----------
function progress(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'progress <taskId> --percent <n> [--next <里程碑>] [--tests t/p/mff]');
  const pct = flags.percent !== undefined ? parseInt(flags.percent, 10) : undefined;
  const { board, changed } = mutateTask(proj, id, (b) => {
    const t = findTask(b, id);
    // 终态卡不许再报进度：结了案的卡还在动进度，看板上就分不清它到底完没完（审计 §4-A7）。
    // 「收官」不在此列 —— 那是正在收尾，本来就该继续报。
    if (TERMINAL_STATUSES.includes(t.status)) {
      throw new Error(`${id} 已经是「${t.status}」，不能再报进度；要接着做先 reopen ${id} --reason "<为什么重开>"`);
    }
    if (pct !== undefined) { if (isNaN(pct) || pct < 0 || pct > 100) throw new Error('--percent 应为 0-100'); t.percent = pct; }
    if (flags.next !== undefined) t.nextMilestone = String(flags.next);
    if (flags.tests) { const [tot, pass, mff] = String(flags.tests).split('/').map(Number); t.tests = { total: tot || 0, passing: pass || 0, mustFailFirst: mff || 0 }; }
    if (flags.typecheck !== undefined) t.typecheck = flags.typecheck === true || flags.typecheck === 'true';
    t.lastProgressAt = nowIso(); // 盖"进度更新时间"戳,前端据此显示"更新于 X 前",让陈旧可见
  }, act('progress', flags.author, `进度 ${id}${pct !== undefined ? ' ' + pct + '%' : ''}${flags.next ? '：' + flags.next : ''}`, id));
  return okTask(board, id, changed);
}

/**
 * sync-progress —— 自动进度同步(TodoWrite 钩子调用):
 * 按当前 git 分支找到"施工中"的任务,把对话待办清单的完成比同步成 percent。
 * 治"进度纯靠对话记得调 cli progress、不报就冻住"——挂在对话每次更新待办上,全自动。
 * 规则:只进不退(max)、自动进度封顶 95(真完工靠 cli done 置 100)、找不到任务静默跳过。
 */
function syncProgress(flags) {
  const skip = (skipped) => ({ ok: true, skipped, silent: true });
  try {
    // 显式项目优先；自动识别保留 mainRepo / codeRepo / worktree 的全部命中。
    const registryPath = getRegistryPath(flags);
    const ids = flags.project ? [flags.project] : detectProjectIds({ registryPath });
    if (!ids.length) return skip('当前目录不属于任何看板项目');
    const pct = flags.percent !== undefined ? parseInt(flags.percent, 10) : undefined;
    if (pct === undefined || isNaN(pct)) return skip('缺 --percent');
    // currentBranch 的 git stderr 已隔离；空仓、非仓与游离 HEAD 都不打扰对话。
    const branch = (flags.branch ? String(asArray(flags.branch)[0]) : '') || currentBranch();
    if (!branch || branch === 'HEAD') return skip('无有效分支');

    // 按板消歧，同一块板有多张匹配卡仍只算一块；板内继续沿用首张施工卡规则。
    const matches = [];
    for (const id of ids) {
      const proj = resolveProject(id, { registryPath });
      const board0 = readBoard(proj.board);
      const cand = (board0.tasks || []).find((t) =>
        t.status === '施工中' && (t.gitBranch || []).map(String).includes(branch));
      if (cand) matches.push({ proj, cand });
    }
    if (ids.length > 1 && matches.length !== 1) {
      return skip(`项目归属有歧义：${ids.join('、')} 中有 ${matches.length} 块板的施工中任务匹配分支 ${branch}`);
    }
    if (!matches.length) return skip(`无施工中任务匹配分支 ${branch}`);
    const { proj, cand } = matches[0];
    const target = Math.max(cand.percent || 0, Math.min(95, Math.max(0, pct))); // 只进不退、封顶 95
    if (target <= (cand.percent || 0)) return skip(`进度未前进(当前 ${cand.percent || 0}%)`);
    const { board, changed } = mutateTask(proj, cand.id, (b) => {
      const t = findTask(b, cand.id);
      t.percent = target;
      t.lastProgressAt = nowIso();
    }, act('progress', flags.author || 'todo-hook', `进度(自动) ${cand.id} ${target}%`, cand.id));
    return okTask(board, cand.id, changed);
  } catch (e) {
    // 钩子路径上的解析、读板与写入异常都只交回原因，不向对话打印错误。
    return skip(`进度同步跳过：${e?.message || String(e)}`);
  }
}

// ---------- pending（登记待拍板问题） ----------
// pending 必须给全三件套（skill §6.2/§6.3 硬规则）——缺就报错，绝不允许"术语墙裸奔"。
// 三种输入模式：
//   ① --json-file <路径>：从文件读整块 JSON（首选。Windows PowerShell 下 heredoc 不好使，
//      而这块 JSON 有三件套、动辄几百字，命令行拼不出来——审计 A8）
//   ② --json：从 stdin 读整块 JSON（POSIX shell 下的等价写法）
//   ③ 命令行 flag：--q --opt --opt --rec --background --reason --pros-<option>=<text> [--strict]
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
  const id = need(flags._[0], 'pending <taskId> --json-file <路径>  或  --json < 文件  或  --q --opt --opt --rec --background --reason --pros-<opt>=<text>');
  // 组装 payload
  let payload;
  if (flags.json || flags['json-file'] !== undefined) {
    payload = readJsonInput(flags, '待拍板 JSON');
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
    throw new Error('登记待拍板不合格（skill §6.2 硬规则，缺字段/太短就不许提交）:\n  - ' + errs.join('\n  - ') + '\n\n模板 JSON（存成 pending.json 后 `... pending <id> --json-file pending.json`）:\n' + JSON.stringify({
      question: '一句大白话问题',
      options: ['选项A', '选项B'],
      recommended: '选项A',
      background: '【场景】...\n【问题】...\n【要做的事】...\n【为什么这重要】...',
      optionPros: { '选项A': '【好处】...\n【代价】...', '选项B': '【好处】...\n【代价】...' },
      recommendReason: '讲透为什么推这个（历史教训/前置条件/机会成本/风险权衡）',
      allowCustom: true,
    }, null, 2));
  }
  const { board, changed } = mutateTask(proj, id, (b) => {
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
    // 施工中的卡不拽回「待拍板」（它确实还在施工），但也不能一点挂起的痕迹都没有：
    // 卡片上的「下一步」改成「等拍板：…」，负责人扫一眼就知道这张卡在等他（审计 §4-A7）。
    else if (t.status === '施工中') t.nextMilestone = '等拍板：' + summarize(payload.question, 40);
  }, act('pending', flags.author, `待拍板 ${id}：${payload.question}`, id));
  return okTask(board, id, changed);
}

// ---------- decide（拍板：填答案） ----------
// 状态前进【默认开】（DECIDE-LEAVES-STATUS-STALE）：答完最后一条决策，卡自己从「待拍板」走到「已拍板」。
// 为什么不是让调用方记得加 --promote：负责人真正拍板的入口是网页，而 server 的 /api/decide 从来
// 不带这个 flag，于是拍完板卡还挂着「待拍板」，得有人再手工 `set` 一次才对得上事实 —— 靠人记 = 必失守，
// 看板就此长期落后于事实（skill §0）。要让卡继续留在「待拍板」，显式给 --no-promote。
// 三道闸缺一不可：本卡【全部】决策都已答 + 卡此刻【正挂在待拍板】+ 没给 --no-promote。
// 施工中/暂缓等其它状态一律不动，免得拍个板把卡的真实进度拽回去。
function decide(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'decide <taskId> --did <dN> --answer <答案> [--no-promote]');
  const did = need(flags.did, '--did <dN>');
  const answer = need(flags.answer, '--answer <答案>');
  const promote = !flags['no-promote']; // --promote 仍可传，是历史写法的等价 no-op
  const { board, changed } = mutateTask(proj, id, (b) => {
    const t = findTask(b, id);
    const d = (t.decisions || []).find((x) => x.id === did);
    if (!d) throw new Error(`decision ${did} 不存在`);
    if (!d.options.includes(answer) && !d.allowCustom) throw new Error(`答案「${answer}」不在选项 ${d.options.join('/')} 中`);
    d.answer = answer; d.decidedAt = today();
    if (promote && (t.decisions || []).every((x) => x.answer !== null) && t.status === '待拍板') t.status = '已拍板';
  }, act('decide', flags.author || '看板', `拍板 ${id}·${did}=${answer}`, id));
  return okTask(board, id, changed);
}

// ---------- mark-landed（拍板已代码落地，从"待落地队列"消失）----------
// --all：本卡「已拍板但没标落地」的一次标完。逐条标是纪律活，靠人记必失守——实测待落地
// 671 条里 506 条挂在已完工卡上，队列被淹掉就等于没有队列（审计 §4-A6）。
function markLanded(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'mark-landed <taskId> (--did <dN> | --all) [--commit <sha>]');
  const all = flags.all === true || flags.all === 'true';
  const did = all ? undefined : need(flags.did, '--did <dN>（或用 --all 一次标完本卡所有已拍板未落地的）');
  const commit = (flags.commit !== undefined && flags.commit !== true) ? String(asArray(flags.commit)[0]) : undefined;
  const landed = [];
  const { board, changed } = mutateTask(proj, id, (b) => {
    const t = findTask(b, id);
    landed.length = 0; // mutate 可能重试，别把上一轮的结果累加进来
    if (all) {
      const targets = (t.decisions || []).filter(isDecidedNotLanded);
      if (!targets.length) throw new Error(`${id} 没有「已拍板但未标落地」的决策，--all 无事可做`);
      for (const d of targets) { landDecision(d, commit); landed.push(d.id); }
    } else {
      const d = (t.decisions || []).find((x) => x.id === did);
      if (!d) throw new Error(`decision ${did} 不存在`);
      if (d.answer === null || d.answer === undefined) throw new Error(`decision ${did} 还没拍板,不能标已落地`);
      landDecision(d, commit); landed.push(d.id);
    }
  }, act('note', flags.author || 'cli', all ? `拍板 ${id} 已代码落地（全部未落地项）` : `拍板 ${id}·${did} 已代码落地`, id));
  const res = okTask(board, id, changed);
  res.landed = landed;
  if (all) res.text = `✔ mark-landed ${id} → 标了 ${landed.length} 条：${landed.join(', ')}`;
  return res;
}

// ---------- park / block ----------
function park(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'park <taskId> --reason <理由> [--note <遗留>]');
  const reason = need(flags.reason, '--reason <理由>');
  const { board, changed } = mutateTask(proj, id, (b) => {
    const t = findTask(b, id); t.status = '暂缓'; t.blockReason = reason;
    if (flags.note) t.parkedNote = String(flags.note);
    // 再次暂缓要抹掉上一轮的解除依据：否则卡挂着「暂缓」却还带着上次的复工理由与日期，
    // show 出来两套说法并存，读的人分不清哪条是当下的（与 unpark 删 blockReason 同一道理）。
    delete t.unparkReason; delete t.unparkedAt;
  }, act('park', flags.author, `暂缓 ${id}：${reason}`, id));
  return okTask(board, id, changed);
}
// 解除暂缓是一次有依据的决定，须单独留痕，不能混进 claim（PARK-HAS-NO-UNPARK）。
// 旧阻塞理由与遗留说明必须删除，解除依据另存，避免复工后仍被当作硬阻塞。
function unpark(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'unpark <taskId> --reason <解除依据>');
  const reason = String(need(flags.reason, '--reason <解除依据>'));
  const { board, changed } = mutateTask(proj, id, (b) => {
    const t = findTask(b, id);
    if (t.status !== '暂缓') throw new Error(`unpark 非法迁移：${t.status} → 可复工（只能从 暂缓）`);
    t.status = '可复工'; delete t.blockReason; delete t.parkedNote;
    t.unparkReason = reason; t.unparkedAt = today();
  }, act('unpark', flags.author, `复工 ${id}：${reason}`, id));
  return okTask(board, id, changed);
}
function block(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'block <taskId> --by <taskId>... --reason <理由>');
  const by = asArray(flags.by);
  const { board, changed } = mutateTask(proj, id, (b) => {
    const t = findTask(b, id);
    t.deps = t.deps || { dependsOn: [], blockedBy: [], relatedTasks: [] };
    t.deps.blockedBy = unionBy([...(t.deps.blockedBy || []), ...by], String);
    if (flags.reason) t.blockReason = String(flags.reason);
  }, act('block', flags.author, `阻塞 ${id}：被 ${by.join(',')} 挡`, id));
  return okTask(board, id, changed);
}

// ---------- done（收官 / 完工） ----------
function done(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'done <taskId> [--pr <n>...] [--commit <sha>...] [--collect]');
  const prs = asArray(flags.pr).map(Number).filter((n) => !isNaN(n));
  const commits = asArray(flags.commit).map(String);
  const collect = flags.collect === true || flags.collect === 'true';
  const landed = [];
  const { board, changed } = mutateTask(proj, id, (b) => {
    const t = findTask(b, id);
    landed.length = 0; // mutate 可能重试
    t.status = collect ? '收官' : '已完工';
    t.dates = t.dates || {};
    // 收官 ≠ 完工。给「收官」也写完工日期 + 100%，等于让一张还在收尾的卡在统计和每日成果里
    // 冒充成果，完工日那栏也从此对不上账（审计 §4-A7）。进度照旧由 progress 报。
    if (!collect) { t.dates.done = today(); t.percent = 100; }
    if (prs.length) t.prNumbers = unionBy([...(t.prNumbers || []), ...prs], String);
    if (commits.length) t.commitShas = unionShas([...(t.commitShas || []), ...commits]);
    // 卡都完工了，本卡那些「已拍板却没人标落地」的决策，落地的就是这次施工。逐条标是纪律活、
    // 必失守（审计 §4-A6），这里顺手结掉；已经标过的不碰，免得覆盖掉更准的那个提交号。
    if (!collect) {
      for (const d of (t.decisions || []).filter(isDecidedNotLanded)) { landDecision(d, commits[0]); landed.push(d.id); }
    }
  }, act('done', flags.author, `${collect ? '收官' : '完工'} ${id}${prs.length ? '·PR ' + prs.join(',') : ''}`, id));
  const res = okTask(board, id, changed);
  res.landed = landed;
  if (landed.length) {
    res.text = `✔ done ${id} → ${res.task.status}
  ↳ 顺带把 ${landed.length} 条拍板标成已落地：${landed.join(', ')}`;
  }
  return res;
}

// ---------- cancel（作废：这活不做了） ----------
// 十个状态里原本没有「取消」：方案被否、需求撤了、重复建卡，都只能让卡一直挂着假装还要做，
// 或者被人拿 done 当垃圾桶用（于是完工数里混着一堆根本没干的活，审计 §4-C1）。
// 任意状态都能作废 —— 一件事什么时候被叫停，不由它当前干到哪儿决定。
function cancel(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'cancel <taskId> --reason <理由>');
  const reason = String(need(flags.reason, '--reason <理由>'));
  const { board, changed } = mutateTask(proj, id, (b) => {
    const t = findTask(b, id);
    t.status = '已作废';
    t.cancelReason = reason; t.cancelledAt = today();
    // 作废是终局，之前那些「为什么停着 / 为什么放手 / 下一步干嘛」的说法全过期了，一起抹掉，
    // 免得 show 出来两套说法并存、读的人分不清哪条是当下的（同 park/unpark 的道理）。
    delete t.blockReason; delete t.parkedNote; delete t.unparkReason; delete t.unparkedAt;
    delete t.unclaimReason; delete t.unclaimedAt; delete t.nextMilestone;
    t.lastProgressAt = nowIso();
  }, act('cancel', flags.author, `作废 ${id}：${reason}`, id));
  return okTask(board, id, changed);
}

// ---------- reopen（重开：结了案又要重来） ----------
// 验收没过要返工、当初作废的活又要做了 —— 此前只能裸 set 改状态、绕过全部校验，
// 而且改完 percent 还是 100、完工日期还挂着，这张卡在「每日成果」里会被重复数一次。
// 活动流一条不删：完过工、作过废都是它一生的一部分，抹掉就查不出返工历史了。
function reopen(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'reopen <taskId> --reason <理由>');
  const reason = String(need(flags.reason, '--reason <理由>'));
  const { board, changed } = mutateTask(proj, id, (b) => {
    const t = findTask(b, id);
    if (!TERMINAL_STATUSES.includes(t.status)) {
      throw new Error(`reopen 非法迁移：${t.status} → 待开工（只能从 ${TERMINAL_STATUSES.join('/')}）`);
    }
    t.status = '待开工';
    t.percent = 0;
    t.dates = t.dates || {}; t.dates.done = null;
    // 上一轮的说法全清掉（同 cancel）：作废理由、放弃认领理由，以及「这卡是解冻来的」那条
    // 解除依据 —— 重开之后是全新一轮，unclaim 不该再把它退回「可复工」。
    // PR / 提交 / 拍板记录全留 —— 重开不是重建。
    delete t.cancelReason; delete t.cancelledAt;
    delete t.unclaimReason; delete t.unclaimedAt;
    delete t.unparkReason; delete t.unparkedAt;
    t.reopenReason = reason; t.reopenedAt = today();
    t.lastProgressAt = nowIso();
  }, act('reopen', flags.author, `重开 ${id}：${reason}`, id));
  return okTask(board, id, changed);
}

// ---------- note（全局活动流） ----------
function note(flags) {
  const proj = resolveProj(flags);
  const text = need(flags.text, 'note --text <文本> [--task <卡ID>]；卡号也可写成位置参数：note <卡ID> --text <文本>');
  // 卡号两种写法等价。原先只读 flags.task，位置参数落进 flags._[0] 从没被碰过，
  // 而 claim/progress/done 都吃位置参数 —— 同一个 CLI 两种约定。写成位置参数时
  // taskId 被静默丢成 null，而 null 是假值、恰好绕过 boardSchema 的引用完整性校验
  // （那道校验是 `if (a.taskId && !ids.has(a.taskId))`），于是不报错、退出码 0、
  // CLI 照常打印 ✔，note 却挂在 taskId=null 上，任何卡都看不到。
  if (flags.task === true) throw new Error('缺参数。用法: --task <卡ID>（--task 后面漏写卡号了）');
  const 位置卡号 = (flags._ || [])[0];
  const 标志卡号 = typeof flags.task === 'string' ? flags.task : undefined;
  if (位置卡号 && 标志卡号 && 位置卡号 !== 标志卡号) {
    throw new Error(`卡号写了两个且不一致：位置参数「${位置卡号}」与 --task「${标志卡号}」，只写一个`);
  }
  const taskId = 标志卡号 || 位置卡号 || null;
  // 卡号打错时由 boardSchema 的引用完整性校验在写前拦下（锁内校验，坏数据绝不落盘）。
  // kind:'message' —— 这是"有人特意留的一句话"，区别于 add/set/mark-landed 那些同样记成
  // type:'note' 的记账流水。brief 的「最近留言」只捡这种，否则整段技术说明会跟着流水又吐一遍
  // （AUD-CLI-BRIEF-AND-HELP）。老数据没有这个标记，只会少显示，不会显示错。
  const from = flags.from === undefined ? undefined : need(flags.from, '--from <身份>');
  const author = from === 'human' ? '负责人' : from ?? flags.author;
  mutate(proj, () => {}, { ...act('note', author, text, taskId), kind: 'message' });
  return { ok: true, taskId, text: `✔ note${taskId ? ` → ${taskId}` : ' → （项目级留言，未挂任何卡）'}` };
}

// ---------- edit（改卡面：标题 / 人话标题 / 说明 / 档位 / 波次） ----------
// 此前改这几样只能裸 set：`set P01 --field title --value ...` 绕过一切校验，
// 字段名打错就往卡上挂一个谁也不认识的属性，写进去了也没人发现（审计 §4-A5）。
// edit 只认这五个字段、逐个校验、留一条看得懂的痕；set 留着做真正的兜底。
function edit(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'edit <taskId> [--title <技术说明>] [--plain-title <人话标题>] [--desc <一句话>] [--model <建议档位>] [--wave <n>]');
  // flag 后面漏写值时 parseFlags 记成 true —— 那是手误，不是「要清空」，当场拒掉。
  const raw = (key) => {
    const v = flags[key];
    if (v === undefined) return undefined;
    if (v === true) throw new Error(`--${key} 后面漏写值了`);
    return String(Array.isArray(v) ? v[v.length - 1] : v);
  };
  const title = raw('title');
  const plainTitle = raw('plain-title');
  const desc = raw('desc');           // 允许空串：说明写错了要能删掉
  const model = raw('model');
  const wave = raw('wave');
  if (![title, plainTitle, desc, model, wave].some((v) => v !== undefined)) {
    throw new Error('edit 至少给一个要改的字段：--title / --plain-title / --desc / --model / --wave');
  }
  if (title !== undefined && !title.trim()) throw new Error('--title 不能是空的（技术说明是模型读卡的唯一入口）');
  if (plainTitle !== undefined && !plainTitle.trim()) throw new Error('--plain-title 不能是空的（负责人只看得懂这一层）');
  if (model !== undefined) {
    if (!model.trim()) throw new Error('--model 不能是空的');
    if (model.trim().length > 40) throw new Error('--model 建议档位太长(≤40 字符,如 "sonnet·低" / "opus·中")');
  }
  let waveNum;
  if (wave !== undefined) {
    waveNum = parseInt(wave, 10);
    if (!Number.isInteger(waveNum) || waveNum < 0 || String(waveNum) !== wave.trim()) throw new Error('--wave 应为 ≥0 的整数');
  }
  // 给活动流用的人话清单；下面 mutateTask 回的 changed 是字段名，两者用途不同，别混。
  const changedLabels = [];
  if (title !== undefined) changedLabels.push('技术说明');
  if (plainTitle !== undefined) changedLabels.push('人话标题');
  if (desc !== undefined) changedLabels.push('一句话说明');
  if (model !== undefined) changedLabels.push('建议档位');
  if (wave !== undefined) changedLabels.push('波次');
  const { board, changed } = mutateTask(proj, id, (b) => {
    const t = findTask(b, id);
    if (title !== undefined) t.title = title.trim();
    if (plainTitle !== undefined) t.plainTitle = plainTitle.trim();
    if (desc !== undefined) t.description = desc;
    if (model !== undefined) t.modelHint = model.trim();
    if (wave !== undefined) t.wave = waveNum;
  }, act('note', flags.author, `edit ${id}：改了 ${changedLabels.join('、')}`, id));
  return okTask(board, id, changed);
}

// ---------- set（通用兜底赋值） ----------
/**
 * 有专门命令的字段 → 该走哪条命令（AUD-CLI-BATCH-AND-AUTOPROJECT ⑤，审计 A5「只能裸 set」）。
 *
 * set 是【通用兜底赋值】：JSON.parse 一下就整个覆盖过去，不走状态机白名单、不合并数组、
 * 活动流里只留一条 `note`。用它改 status，看板上看到的是"有人 note 了一句"，而不是"认领/完工"；
 * 用它改 gitBranch，会把别的对话刚 union 进来的分支整个抹掉。所以这里只提示、不拦截：
 * 照旧把值写进去（有些字段确实只能靠它），但把正路当场指出来，免得下次还走这条。
 *
 * fn 是这条命令在本模块的导出名（多数与命令名同名，mark-landed 例外）。运行时只列
 * 【本模块真有】的命令 —— 生命周期命令（unclaim/cancel/reopen/edit，AUD-CLI-LIFECYCLE-CMDS）
 * 落地那天，这张表不用改就会自动把它们提示出来；没落地时也不会指一条不存在的命令。
 */
const FIELD_COMMANDS = {
  status: [
    { cmd: 'claim', use: 'claim <id> --branch <分支>（→ 施工中，走迁移白名单）' },
    { cmd: 'park', use: 'park <id> --reason <理由>（→ 暂缓）' },
    { cmd: 'unpark', use: 'unpark <id> --reason <解除依据>（暂缓 → 可复工）' },
    { cmd: 'block', use: 'block <id> --by <卡号>… --reason <理由>（登记被谁挡）' },
    { cmd: 'done', use: 'done <id> --pr <n> --commit <sha>（→ 已完工，顺带记 PR/提交）' },
    { cmd: 'unclaim', use: 'unclaim <id> --reason <理由>（施工中 → 待开工）' },
    { cmd: 'cancel', use: 'cancel <id> --reason <理由>（→ 已作废）' },
    { cmd: 'reopen', use: 'reopen <id> --reason <理由>（终态 → 待开工）' },
  ],
  percent: [{ cmd: 'progress', use: 'progress <id> --percent <n>（顺带盖"更新于"时间戳）' }],
  nextMilestone: [{ cmd: 'progress', use: 'progress <id> --next "<下一步>"' }],
  lastProgressAt: [{ cmd: 'progress', use: 'progress <id> --percent <n>（这个戳由 progress/claim 自动盖）' }],
  tests: [{ cmd: 'progress', use: 'progress <id> --tests <总数/通过/必败>' }],
  typecheck: [{ cmd: 'progress', use: 'progress <id> --typecheck true' }],
  gitBranch: [{ cmd: 'claim', use: 'claim <id> --branch <分支>（union 合并；set 是整个覆盖，会抹掉别人刚记的分支）' }],
  fileScope: [
    { cmd: 'claim', use: 'claim <id> --scope <glob>…（union 合并）' },
    { cmd: 'add', use: 'add … --scope <glob>…（建卡时就登记）' },
  ],
  prNumbers: [{ cmd: 'done', use: 'done <id> --pr <n>' }],
  commitShas: [{ cmd: 'done', use: 'done <id> --commit <sha>（长短哈希会归并成同一个提交）' }],
  decisions: [
    { cmd: 'pending', use: 'pending <id> --json-file <路径>（三件套硬校验，裸 set 绕过去 = 术语墙裸奔）' },
    { cmd: 'decide', use: 'decide <id> --did <dN> --answer <答案>' },
    { cmd: 'mark-landed', fn: 'markLanded', use: 'mark-landed <id> --did <dN> --commit <sha>' },
  ],
  blockReason: [
    { cmd: 'block', use: 'block <id> --by <卡号>… --reason <理由>' },
    { cmd: 'park', use: 'park <id> --reason <理由>' },
  ],
  parkedNote: [{ cmd: 'park', use: 'park <id> --reason <理由> --note <遗留>' }],
  cost: [{ cmd: 'cost', use: 'cost <id> --agents "<模型:个数,…>" [--tokens <n>]' }],
  title: [{ cmd: 'edit', use: 'edit <id> --title "<技术说明>"' }],
  plainTitle: [{ cmd: 'edit', use: 'edit <id> --plain-title "<人话标题>"' }],
  description: [{ cmd: 'edit', use: 'edit <id> --desc "<一句话>"' }],
  modelHint: [{ cmd: 'edit', use: 'edit <id> --model "<建议档位>"' }],
  wave: [{ cmd: 'edit', use: 'edit <id> --wave <n>' }],
};

/** 这个字段有没有专门命令：先按整条点路径找，再退回第一段（deps.blockedBy → deps）。 */
function dedicatedCommandsFor(field) {
  const hit = FIELD_COMMANDS[field] || FIELD_COMMANDS[String(field).split('.')[0]] || [];
  return hit.filter((c) => typeof module.exports[c.fn || c.cmd] === 'function');
}

function set(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'set <taskId> --field <点路径> --value <json>');
  const field = need(flags.field, '--field <点路径>');
  const raw = need(flags.value, '--value <json>');
  let val; try { val = JSON.parse(raw); } catch { val = raw; }
  const { board, changed } = mutateTask(proj, id, (b) => { setPath(findTask(b, id), field, val); },
    act('note', flags.author, `set ${id}.${field}=${raw}`, id));
  const better = dedicatedCommandsFor(field);
  if (better.length) {
    process.stderr.write(
      `⚠ ${field} 有专门命令，set 只是通用兜底赋值：它不走状态机白名单、不合并数组，` +
      '活动流里只记一条 note —— 看板上看不出你到底干了什么。\n' +
      better.map((c) => `    ${c.use}\n`).join('') +
      '  这次已按你说的写进去了；下次优先用上面的命令。\n');
  }
  return okTask(board, id, changed);
}

// ---------- list / show（只读，读时派生） ----------
// 渲染全在 cli/renderTask.cjs：默认只给"扫一眼要判断的东西"，全量改成显式索取
// （--all / --full / --fields）。旧版把 title（给模型看的技术说明，实测最长 2166 字）整段回吐、
// 且默认含已完工，AI 每问一次看板就被塞上万 token（AUD-CLI-BRIEF-AND-HELP，审计 §4-A4）。
function list(flags) {
  const proj = resolveProj(flags);
  const b = readBoard(proj.board);
  return {
    ok: true,
    text: renderList({
      projName: proj.name,
      statsLine: statsLine(deriveStats(b)),
      tasks: b.tasks || [],
      opts: flags,
    }),
  };
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
  const id = need(flags._[0], 'show <taskId> [--full] | show --pending');
  const task = findTask(b, id);
  return {
    ok: true,
    text: flags.full ? JSON.stringify(task, null, 2) : renderShowCard(task, { pid: proj.id }),
  };
}

// ---------- cost(施工成本登记:每卡记录用了哪些 agent/模型档;BOARD-COST-MONITOR 0901)----------
function cost(flags) {
  const proj = resolveProj(flags);
  const id = need(flags._[0], 'cost <taskId> --agents "<模型:个数,…>" [--tokens <n>] [--note <一句话>]');
  const agentsRaw = need(flags.agents, '--agents "<模型:个数,…>"(如 "sonnet:3,opus:1";纯主对话施工写 "main:1")');
  const agents = {};
  for (const part of String(agentsRaw).split(',')) {
    const m = part.trim().match(/^([A-Za-z0-9._-]+):(\d+)$/);
    if (!m) throw new Error(`--agents 格式非法:「${part.trim()}」应为 模型:个数(如 sonnet:3)`);
    agents[m[1]] = (agents[m[1]] || 0) + parseInt(m[2], 10);
  }
  const tokens = flags.tokens !== undefined ? parseInt(flags.tokens, 10) : undefined;
  if (flags.tokens !== undefined && (!Number.isInteger(tokens) || tokens < 0)) throw new Error('--tokens 应为非负整数');
  const entry = { date: today(), author: flags.author || 'cli', agents };
  if (tokens !== undefined) entry.tokens = tokens;
  if (flags.note) entry.note = String(flags.note);
  const agentsText = Object.entries(agents).map(([k, v]) => `${k}×${v}`).join(' + ');
  const { board, changed } = mutateTask(proj, id, (b) => {
    const t = findTask(b, id);
    t.cost = t.cost || { entries: [] };
    if (!Array.isArray(t.cost.entries)) t.cost.entries = [];
    t.cost.entries.push(entry);
  }, act('cost', flags.author, `登记施工成本 ${id}：${agentsText}${tokens !== undefined ? '，约 ' + tokens + ' tokens' : ''}`, id));
  return okTask(board, id, changed);
}

module.exports = {
  register, add, addBatch, isBatchAdd, claim, unclaim, progress, syncProgress, pending, decide, markLanded,
  park, unpark, block, done, cancel, reopen, note, edit, set, list, show, cost, deriveStats,
};
