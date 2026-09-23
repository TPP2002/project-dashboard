'use strict';
/**
 * costUsage.cjs —— token 成本聚合(BOARD-COST-MONITOR,0901 负责人拍板)。
 *
 * 【数据源】Claude Code 把每个对话的完整流水存在 ~/.claude/projects/<项目目录>/<sessionId>.jsonl,
 * 其中每条 assistant 消息自带 message.usage(输入/输出/缓存 token)+ message.model + isSidechain
 * (true = 子 agent 的消息)。订阅用户看不到美元,但 token 流水是全的——这里聚合的就是它。
 *
 * 【项目目录映射】costRoots 路径按「非字母数字一律变 '-'」编码成目录名(F:\code-repo → F--code-repo);
 * 含 worktree 的目录按边界前缀匹配，归最长登记前缀；同址并列时显式标记共享。
 *
 * 【增量缓存】jsonl 只追加不改写,按 (size, mtimeMs) 判断文件是否变过:没变直接用上次的
 * 按天聚合结果,变了只重扫这一个文件。缓存落数据根 costUsageCache.json(原子写)，发布换代不丢失。
 * 全项目首扫几十 MB 需数秒,之后每次刷新只扫活跃会话的增量。
 *
 * 零依赖(core 纪律),仅 node 内置模块。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { atomicWriteJsonSync } = require('./atomicWrite.cjs');
const { signalTextsOfRow, extractCommandSignals, attributeSession } = require('./sessionAttribution.cjs');
const { DASHBOARD_HOME } = require('./resolveProject.cjs');

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const CACHE_PATH = path.join(DASHBOARD_HOME, 'costUsageCache.json');
// v4: 会话桶新增分支和命令信号；旧缓存必须整份作废。
// v3: 字段 version 改名 schemaVersion(COST-UI-SESSION-DETAIL),且缓存里存的东西结构变了
// (流水按 message.id 去重、新增按会话·按天的明细桶)——读缓存严格 === 比对,对不上整份丢掉重扫。
// 前科:结构改了没升号,旧缓存被照单全收,新字段全空、老字段全对、一个错都不报。
const CACHE_VERSION = 4;

/**
 * Claude API 标准牌价(USD / 百万 token,2026-09-23 核官方表)：
 * https://platform.claude.com/docs/en/about-claude/pricing
 * 已知模型精确匹配；未知模型不借别的型号价格填零或冒充已计价。
 * 写 5 分钟档 = 1.25×input;写 1 小时档 = 2×input。
 * 【口径声明】订阅套餐实付的是订阅费——这里的美元是「同样的量若走 API 直购值多少钱」的等价参考。
 */
const PRICE = {
  'fable-5-1': { in: 10, out: 50, cacheRead: 0.25 },
  'fable-5': { in: 10, out: 50, cacheRead: 1 },
  'mythos-5-1': { in: 10, out: 50, cacheRead: 0.25 },
  'mythos-5': { in: 10, out: 50, cacheRead: 1 },
  'opus-5-5': { in: 4, out: 20, cacheRead: 0.20 },
  'opus-5': { in: 5, out: 25 },
  'opus-4-8': { in: 5, out: 25 },
  'opus-4-7': { in: 5, out: 25 },
  'opus-4-6': { in: 5, out: 25 },
  'opus-4-5': { in: 5, out: 25 },
  'opus-4-1': { in: 15, out: 75 },
  'opus-4': { in: 15, out: 75 },
  'sonnet-5': { in: 2, out: 10 },
  'sonnet-4-6': { in: 3, out: 15 },
  'sonnet-4-5': { in: 3, out: 15 },
  'sonnet-4': { in: 3, out: 15 },
  'haiku-4-5': { in: 1, out: 5 },
  'haiku-3-5': { in: 0.8, out: 4 },
};
function priceFor(model) {
  const m = String(model || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
  return Object.hasOwn(PRICE, m) ? PRICE[m] : null;
}
/** 折算实际成本(缓存价生效;有专门缓存读价用专门价,没有退回 0.1×input) */
function usdActualOf(t, p) {
  const cacheReadPrice = Number.isFinite(p.cacheRead) ? p.cacheRead : 0.1 * p.in;
  return (t.input * p.in + t.cacheRead * cacheReadPrice + (t.cw5m || 0) * 1.25 * p.in + (t.cw1h || 0) * 2 * p.in + t.output * p.out) / 1e6;
}
/** 无缓存假想成本(全部输入按全价) */
function usdNoCacheOf(t, p) {
  return ((t.input + t.cacheRead + t.cacheWrite) * p.in + t.output * p.out) / 1e6;
}

/** Claude 侧所有 token 类别的同期总量，供跨模型平均单价口径复用。 */
function totalClaudeTokens(claudeUsage) {
  const totals = claudeUsage && (claudeUsage.claudeTotals || claudeUsage.totals);
  return totals
    ? Number(totals.input || 0) + Number(totals.output || 0)
      + Number(totals.cacheRead || 0) + Number(totals.cacheWrite || 0)
    : 0;
}

/** Codex token 按同期 Claude 平均 API 等价单价折算；无有效分母时不制造假数字。 */
function estimateCodexSavings(codexTokens, claudeUsage) {
  const tokens = Number(codexTokens);
  const claudeTokens = totalClaudeTokens(claudeUsage);
  const actualUsd = Number(claudeUsage?.usd?.actual);
  if (!Number.isFinite(tokens) || tokens < 0 || claudeTokens <= 0 || !Number.isFinite(actualUsd) || actualUsd <= 0) {
    return null;
  }
  return tokens * (actualUsd / claudeTokens);
}

/** mainRepo 绝对路径 → transcript 目录名前缀(与 Claude Code 的编码规则一致)。 */
function mapRepoToPrefix(mainRepo) {
  return String(mainRepo || '').replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * 纯目录归属仲裁：仅匹配地址自身或其 '-' 后缀，最长登记前缀胜出。
 * 同一最长前缀也属别的项目时仍计入并标 shared；输出按输入目录顺序去重，不做磁盘 IO。
 * @param {string[]} dirNames
 * @param {{prefixes:string[],otherPrefixes:string[]}} options
 * @returns {{dirs:string[],shared:string[]}}
 */
function selectProjectDirs(dirNames, { prefixes, otherPrefixes }) {
  const own = new Set(prefixes);
  const others = new Set(otherPrefixes);
  const all = new Set([...own, ...others]);
  const dirs = [], shared = [];
  for (const d of new Set(dirNames)) {
    let longest = null;
    for (const p of all) {
      if ((d === p || d.startsWith(p + '-')) && (longest === null || p.length > longest.length)) longest = p;
    }
    if (longest === null || !own.has(longest)) continue;
    dirs.push(d);
    if (others.has(longest)) shared.push(d);
  }
  return { dirs, shared };
}

/** 本地时区 YYYY-MM-DD(与看板 CLI 的 today() 同口径,避免 UTC 把凌晨记成前一天)。 */
function localDate(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function emptyTally() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cw5m: 0, cw1h: 0, msgs: 0 };
}

const TALLY_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cw5m', 'cw1h', 'msgs'];

/** 缓存写按 TTL 细分;老格式无细分时全按 1h(2×)记,成本从高、节省从低,保守口径。 */
function cacheWriteSplit(u) {
  const cw = u.cache_creation_input_tokens || 0;
  const cc = u.cache_creation;
  if (cc && (cc.ephemeral_5m_input_tokens || cc.ephemeral_1h_input_tokens)) {
    return { cacheWrite: cw, cw5m: cc.ephemeral_5m_input_tokens || 0, cw1h: cc.ephemeral_1h_input_tokens || 0 };
  }
  return { cacheWrite: cw, cw5m: 0, cw1h: cw };
}

function addUsage(t, u) {
  t.input += u.input_tokens || 0;
  t.output += u.output_tokens || 0;
  t.cacheRead += u.cache_read_input_tokens || 0;
  const split = cacheWriteSplit(u);
  t.cacheWrite += split.cacheWrite;
  t.cw5m += split.cw5m;
  t.cw1h += split.cw1h;
  t.msgs += 1;
}

/** 「上下文」口径(派单方建议,已定档):单轮上下文 = input + 缓存读 + 缓存写(这一轮喂进去的完整提示,不含输出)。 */
const HEAVY_CONTEXT_TOKENS = 400000; // 「超大上下文轮次」的门槛:单轮上下文 > 40 万 token

/** 一个会话某一天的明细桶(缓存存全量时间范围,窗口化推迟到出明细行时)。 */
function emptySessionDay() {
  return {
    turns: 0, ctxSum: 0, ctxPeak: 0, heavyTurns: 0,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cw5m: 0, cw1h: 0,
    firstTs: null, lastTs: null,
    models: {}, // model → { input, output, cacheRead, cw5m, cw1h }(美元折算按模型价,必须分模型存)
  };
}

/**
 * 逐行流式扫一个 jsonl,产出:
 *   days        —— 按天·按模型·主/子agent 聚合(原有口径,一字未改)
 *   sessions    —— 有无 assistant 记录(原有口径)
 *   sessionDays —— 按「会话·按天」的明细桶(COST-UI-SESSION-DETAIL):
 *                  { [sessionId]: { cwd, compactions, days: { [date]: emptySessionDay() } } }
 *
 * 【去重】同一条 message.id 因流式输出会出现多条记录:只有 id 存在且是非空字符串的记录才参与
 * 去重,同 id 只记第一次;没有 id / id 为空 / id 不是字符串的一律各算各的、全部计入 ——
 * 若把 undefined 当成可去重的键,现有夹具里不带 message.id 的行会被塌缩成一条。
 * 【压缩次数】压缩标记行(type=summary 或带 isCompactSummary)通常不含 "assistant",
 * 预筛为此放宽(只放宽,不删:它挡住绝大多数行不做 JSON.parse);压缩标记行常无可靠时间戳,
 * 所以压缩次数按整份流水计数,不做按天窗口。summary 行常常没有 sessionId(只有 leafUuid),
 * 若按文件名回退会另造出一个 0 轮次的幻影会话行、把压缩计数拆散 —— 改为按文件顺序归到
 * 「最近出现过的那个会话」(摘要在真实流水里就写在它所属对话的中间,这是落盘顺序事实,
 * 不是猜);文件一开头就出现标记行的极端情况才退回文件名。
 */
function scanFile(file) {
  return new Promise((resolve) => {
    const days = {};
    const sessionDays = {};
    const seenIds = new Set();
    const fallbackSid = path.basename(file).replace(/\.jsonl$/, '');
    let hadAssistant = false;
    let lastSid = null; // 文件内最近一次出现过的真实 sessionId(压缩标记行的归属用)
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line) return;
      // 便宜的预筛,坏行交给 try/catch;为压缩标记行放宽,但绝不整条删掉(删了扫描明显变慢)。
      if (line.indexOf('"assistant"') === -1
        && line.indexOf('"summary"') === -1
        && line.indexOf('"isCompactSummary"') === -1
        && line.indexOf('claim') === -1
        && line.indexOf('--branch') === -1) return;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { return; }
      if (!obj) return;
      const hasSid = typeof obj.sessionId === 'string' && obj.sessionId;
      const isMarker = obj.type === 'summary' || obj.isCompactSummary === true;
      const sid = hasSid ? obj.sessionId : (isMarker && lastSid ? lastSid : fallbackSid);
      if (hasSid) lastSid = obj.sessionId;
      const session = (sessionDays[sid] = sessionDays[sid] || {
        cwd: null, compactions: 0, branches: [], claimIds: [], branchFlags: [], days: {},
      });
      if (session.cwd === null && typeof obj.cwd === 'string' && obj.cwd) session.cwd = obj.cwd;
      if (typeof obj.gitBranch === 'string' && obj.gitBranch) session.branches.push(obj.gitBranch);
      const signals = extractCommandSignals(signalTextsOfRow(obj));
      session.claimIds.push(...signals.claimIds);
      session.branchFlags.push(...signals.branchFlags);
      if (isMarker) { session.compactions += 1; return; }
      if (obj.type !== 'assistant' || !obj.message || !obj.message.usage) return;
      const date = localDate(obj.timestamp);
      if (!date) return;
      const mid = obj.message.id;
      if (typeof mid === 'string' && mid) {
        if (seenIds.has(mid)) return; // 流式重发的同一条消息,只记第一次
        seenIds.add(mid);
      }
      hadAssistant = true;
      const usage = obj.message.usage;
      const d = (days[date] = days[date] || { models: {}, side: emptyTally(), main: emptyTally() });
      const model = obj.message.model || 'unknown';
      addUsage((d.models[model] = d.models[model] || emptyTally()), usage);
      addUsage(obj.isSidechain ? d.side : d.main, usage);
      // 会话·按天明细桶
      const bucket = (session.days[date] = session.days[date] || emptySessionDay());
      const input = usage.input_tokens || 0;
      const output = usage.output_tokens || 0;
      const cacheRead = usage.cache_read_input_tokens || 0;
      const split = cacheWriteSplit(usage);
      const ctx = input + cacheRead + split.cacheWrite;
      bucket.turns += 1;
      bucket.ctxSum += ctx;
      if (ctx > bucket.ctxPeak) bucket.ctxPeak = ctx;
      if (ctx > HEAVY_CONTEXT_TOKENS) bucket.heavyTurns += 1;
      bucket.input += input;
      bucket.output += output;
      bucket.cacheRead += cacheRead;
      bucket.cacheWrite += split.cacheWrite;
      bucket.cw5m += split.cw5m;
      bucket.cw1h += split.cw1h;
      const mt = (bucket.models[model] = bucket.models[model] || { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 });
      mt.input += input;
      mt.output += output;
      mt.cacheRead += cacheRead;
      mt.cw5m += split.cw5m;
      mt.cw1h += split.cw1h;
      if (typeof obj.timestamp === 'string' && obj.timestamp) {
        if (bucket.firstTs === null || obj.timestamp < bucket.firstTs) bucket.firstTs = obj.timestamp;
        if (bucket.lastTs === null || obj.timestamp > bucket.lastTs) bucket.lastTs = obj.timestamp;
      }
    });
    rl.on('close', () => {
      for (const session of Object.values(sessionDays)) {
        for (const key of ['branches', 'claimIds', 'branchFlags']) session[key] = [...new Set(session[key])].sort();
      }
      resolve({ days, sessions: hadAssistant ? 1 : 0, sessionDays });
    });
    rl.on('error', () => resolve({ days, sessions: 0, sessionDays }));
  });
}

function readCache(cachePath) {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (c && c.schemaVersion === CACHE_VERSION && c.files) return c;
  } catch (_) { /* 无缓存/坏缓存/版本对不上 → 整份丢掉全量重扫 */ }
  return { schemaVersion: CACHE_VERSION, files: {} };
}

/** 把一个文件的 days 聚进总账。 */
function mergeDays(total, days) {
  for (const [date, d] of Object.entries(days || {})) {
    const t = (total[date] = total[date] || { models: {}, side: emptyTally(), main: emptyTally(), sessions: 0 });
    for (const [m, v] of Object.entries(d.models || {})) {
      const mt = (t.models[m] = t.models[m] || emptyTally());
      for (const k of TALLY_KEYS) mt[k] += v[k] || 0;
    }
    for (const bucket of ['side', 'main']) {
      for (const k of TALLY_KEYS) t[bucket][k] += (d[bucket] || {})[k] || 0;
    }
  }
}

/** 会话内某一天明细桶的并集(数值相加、峰值取大、首末时间取小/大、分模型桶相加)。 */
function mergeSessionDay(entry, date, bucket) {
  const target = (entry.days[date] = entry.days[date] || emptySessionDay());
  for (const k of ['turns', 'ctxSum', 'heavyTurns', 'input', 'output', 'cacheRead', 'cacheWrite', 'cw5m', 'cw1h']) {
    target[k] += bucket[k] || 0;
  }
  if ((bucket.ctxPeak || 0) > target.ctxPeak) target.ctxPeak = bucket.ctxPeak || 0;
  if (bucket.firstTs && (target.firstTs === null || bucket.firstTs < target.firstTs)) target.firstTs = bucket.firstTs;
  if (bucket.lastTs && (target.lastTs === null || bucket.lastTs > target.lastTs)) target.lastTs = bucket.lastTs;
  for (const [m, v] of Object.entries(bucket.models || {})) {
    const mt = (target.models[m] = target.models[m] || { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 });
    mt.input += v.input || 0;
    mt.output += v.output || 0;
    mt.cacheRead += v.cacheRead || 0;
    mt.cw5m += v.cw5m || 0;
    mt.cw1h += v.cw1h || 0;
  }
}

/** 把一个文件(实扫或缓存命中)的会话明细并进总账(跨文件同会话 id 时逐桶合并)。 */
function mergeSessionFiles(acc, sessionDays) {
  for (const [sid, file] of Object.entries(sessionDays || {})) {
    if (!acc.has(sid)) acc.set(sid, { cwd: null, compactions: 0, branches: [], claimIds: [], branchFlags: [], days: {} });
    const entry = acc.get(sid);
    if (entry.cwd === null && file && file.cwd) entry.cwd = file.cwd;
    entry.compactions += (file && file.compactions) || 0;
    for (const key of ['branches', 'claimIds', 'branchFlags']) {
      entry[key] = [...new Set([...entry[key], ...((file && file[key]) || [])])].sort();
    }
    for (const [date, bucket] of Object.entries((file && file.days) || {})) {
      mergeSessionDay(entry, date, bucket);
    }
  }
}

/**
 * 由会话账出明细行。只收窗口内(cutoffStr 之后)日期的桶 —— 明细行与顶层合计同一窗口口径,
 * 「所有明细行四类 token 相加 === 顶层合计」这条对账断言因此恒成立(漏进桶/重复进桶/旧缓存
 * 没作废三类病都会被它当场抓住)。压缩次数不窗口化(标记行常无时间戳,见 scanFile)。
 */
function buildSessionRows(sessionAcc, cutoffStr, cards, bindings) {
  const rows = [];
  for (const [sessionId, entry] of sessionAcc) {
    const attribution = attributeSession({ sessionId, branches: entry.branches,
      claimIds: entry.claimIds, branchFlags: entry.branchFlags }, cards, bindings);
    const row = {
      sessionId, cwd: entry.cwd,
      card: attribution.status === 'attributed' ? attribution.cardIds[0] : null,
      attribution,
      models: [], startedAt: null, endedAt: null,
      turns: 0, peakContext: 0, avgContext: 0, heavyTurns: 0,
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      compactions: entry.compactions || 0, usd: 0,
    };
    const perModel = new Map();
    let ctxSum = 0;
    for (const [date, bucket] of Object.entries(entry.days)) {
      if (date < cutoffStr) continue;
      row.turns += bucket.turns || 0;
      row.heavyTurns += bucket.heavyTurns || 0;
      ctxSum += bucket.ctxSum || 0;
      if ((bucket.ctxPeak || 0) > row.peakContext) row.peakContext = bucket.ctxPeak || 0;
      row.input += bucket.input || 0;
      row.output += bucket.output || 0;
      row.cacheRead += bucket.cacheRead || 0;
      row.cacheWrite += bucket.cacheWrite || 0;
      if (bucket.firstTs && (row.startedAt === null || bucket.firstTs < row.startedAt)) row.startedAt = bucket.firstTs;
      if (bucket.lastTs && (row.endedAt === null || bucket.lastTs > row.endedAt)) row.endedAt = bucket.lastTs;
      for (const [m, v] of Object.entries(bucket.models || {})) {
        if (!perModel.has(m)) perModel.set(m, { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 });
        const mt = perModel.get(m);
        mt.input += v.input || 0;
        mt.output += v.output || 0;
        mt.cacheRead += v.cacheRead || 0;
        mt.cw5m += v.cw5m || 0;
        mt.cw1h += v.cw1h || 0;
      }
    }
    if (!row.turns && !row.compactions) continue; // 只有杂行、没有任何实际内容的会话不上明细
    row.avgContext = row.turns > 0 ? ctxSum / row.turns : 0;
    const ranked = [...perModel.entries()].sort((a, b) => (b[1].output - a[1].output) || a[0].localeCompare(b[0]));
    row.models = ranked.map(([m]) => m);
    for (const [m, v] of ranked) {
      const p = priceFor(m);
      if (p) row.usd += usdActualOf(v, p); // 未知模型不计价,与顶层 usd 同口径
    }
    rows.push(row);
  }
  rows.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  return rows;
}

/**
 * 聚合一个项目(按目录前缀清单)最近 days 天的 token 消耗。
 * prefixes 未给时兼容旧 prefix；无有效本项目前缀仍抛错。sharedDirs 暴露最长前缀并列的目录。
 * cards 与 bindings 供会话明细按开工绑定、分支和命令文字逐级判卡。
 * @returns {Promise<{byDay:Array, totals:Object, models:Object, dirs:string[], sharedDirs:string[],
 *   scanned:number, cachedFiles:number, sessions:number,
 *   sessionRows:Array, context:{turns,avgContext,load,heavyTurns,heavyRatio}}>}
 */
async function getUsage({ prefix, prefixes = [prefix], otherPrefixes = [], days = 30, projectsRoot = PROJECTS_ROOT, cachePath = CACHE_PATH, cards = [], bindings = null, warn = console.warn }) {
  prefixes = prefixes.filter(Boolean);
  if (!prefixes.length) throw new Error('缺 prefix(由 mainRepo 映射)');
  let allDirNames = [];
  try {
    allDirNames = fs.readdirSync(projectsRoot);
  } catch (_) { /* projects 根不存在 → 空结果 */ }
  const { dirs: dirNames, shared: sharedDirs } = selectProjectDirs(allDirNames, { prefixes, otherPrefixes });

  const cache = readCache(cachePath);
  const totalDays = {};
  const sessionAcc = new Map(); // sessionId → { cwd, compactions, branches, claimIds, branchFlags, days }
  let scanned = 0, cachedFiles = 0, sessions = 0;

  for (const dir of dirNames) {
    const dirAbs = path.join(projectsRoot, dir);
    let files = [];
    try { files = fs.readdirSync(dirAbs).filter((f) => f.endsWith('.jsonl')); } catch (_) { continue; }
    for (const f of files) {
      const abs = path.join(dirAbs, f);
      let st;
      try { st = fs.statSync(abs); } catch (_) { continue; }
      const key = abs;
      const hit = cache.files[key];
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
        cachedFiles++;
        mergeDays(totalDays, hit.days);
        sessions += hit.sessions || 0;
        mergeSessionFiles(sessionAcc, hit.sessionDays);
        continue;
      }
      const r = await scanFile(abs);
      scanned++;
      cache.files[key] = { size: st.size, mtimeMs: st.mtimeMs, days: r.days, sessions: r.sessions, sessionDays: r.sessionDays };
      mergeDays(totalDays, r.days);
      sessions += r.sessions;
      mergeSessionFiles(sessionAcc, r.sessionDays);
    }
  }

  if (scanned > 0) {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      atomicWriteJsonSync(cachePath, cache);
    } catch (error) {
      warn(`[costUsage] 成本缓存写入失败：${cachePath}；${error.message}`);
    }
  }

  // 最近 N 天窗口(含今天),按日期升序
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffStr = localDate(cutoff);
  const byDay = Object.keys(totalDays)
    .filter((d) => d >= cutoffStr)
    .sort()
    .map((date) => ({ date, ...totalDays[date] }));

  // 窗口内合计 + 按模型合计
  const totals = { ...emptyTally(), sideOutput: 0, mainOutput: 0 };
  const models = {};
  for (const d of byDay) {
    for (const [m, v] of Object.entries(d.models)) {
      const mt = (models[m] = models[m] || emptyTally());
      for (const k of TALLY_KEYS) { mt[k] += v[k] || 0; totals[k] += v[k] || 0; }
    }
    totals.sideOutput += d.side.output;
    totals.mainOutput += d.main.output;
  }
  const denom = totals.cacheRead + totals.cacheWrite + totals.input;
  totals.cacheHitRate = denom > 0 ? totals.cacheRead / denom : 0;

  // Claude Code 的日志目录也会收录通过同一 CLI 运行的 GLM。不能把 GLM 的
  // token 算进 Claude 的 API 等价费用或“Claude + Codex”合计。
  const claudeTotals = emptyTally(), glmTotals = emptyTally(), unclassifiedTotals = emptyTally(), unpricedModels = [];
  for (const [model, value] of Object.entries(models)) {
    const isGlm = /^glm(?:-|$)/i.test(model);
    const target = isGlm ? glmTotals : (model.startsWith('claude-') || priceFor(model)
      ? claudeTotals : unclassifiedTotals);
    for (const key of TALLY_KEYS) target[key] += value[key] || 0;
    if (!isGlm && !priceFor(model)
      && ['input', 'output', 'cacheRead', 'cacheWrite'].some((key) => value[key] > 0)) unpricedModels.push(model);
  }

  // 美元折算(API 牌价等价参考;订阅实付为订阅费):按模型算再汇总,byDay 各给折算实际
  const usd = { actual: 0, noCache: 0, saved: 0, byModel: {} };
  for (const [m, v] of Object.entries(models)) {
    const p = priceFor(m);
    if (!p) continue;
    const a = usdActualOf(v, p), n = usdNoCacheOf(v, p);
    usd.byModel[m] = { actual: a, noCache: n, saved: n - a };
    usd.actual += a; usd.noCache += n;
  }
  usd.saved = usd.noCache - usd.actual;
  for (const d of byDay) {
    let a = 0;
    for (const [m, v] of Object.entries(d.models)) { const p = priceFor(m); if (p) a += usdActualOf(v, p); }
    d.usdActual = a;
  }

  // 会话明细行(与合计同一时间窗口)与两项新指标:
  // 「轮次 × 平均上下文」量这个区间一共驮了多少上下文过河(load = Σ 轮次×该会话平均上下文);
  // 「上下文 > 40 万的轮次占比」量有多少轮是在超大上下文里烧的(heavyRatio)。
  const sessionRows = buildSessionRows(sessionAcc, cutoffStr, Array.isArray(cards) ? cards : [], bindings);
  const ctx = { turns: 0, ctxSum: 0, heavyTurns: 0 };
  for (const row of sessionRows) {
    ctx.turns += row.turns;
    ctx.ctxSum += row.turns * row.avgContext;
    ctx.heavyTurns += row.heavyTurns;
  }
  const context = {
    turns: ctx.turns,
    avgContext: ctx.turns > 0 ? ctx.ctxSum / ctx.turns : 0,
    load: ctx.ctxSum,
    heavyTurns: ctx.heavyTurns,
    heavyRatio: ctx.turns > 0 ? ctx.heavyTurns / ctx.turns : 0,
  };

  return { byDay, totals, claudeTotals, glmTotals, unclassifiedTotals, unpricedModels,
    models, usd, dirs: dirNames, sharedDirs, scanned, cachedFiles, sessions, sessionRows, context };
}

module.exports = {
  estimateCodexSavings,
  getUsage,
  mapRepoToPrefix,
  selectProjectDirs,
  priceFor,
  totalClaudeTokens,
  usdActualOf,
  usdNoCacheOf,
  HEAVY_CONTEXT_TOKENS,
  PROJECTS_ROOT,
};
