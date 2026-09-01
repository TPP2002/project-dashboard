'use strict';
/**
 * costUsage.cjs —— token 成本聚合(BOARD-COST-MONITOR,0901 负责人拍板)。
 *
 * 【数据源】Claude Code 把每个对话的完整流水存在 ~/.claude/projects/<项目目录>/<sessionId>.jsonl,
 * 其中每条 assistant 消息自带 message.usage(输入/输出/缓存 token)+ message.model + isSidechain
 * (true = 子 agent 的消息)。订阅用户看不到美元,但 token 流水是全的——这里聚合的就是它。
 *
 * 【项目目录映射】mainRepo 路径按「非字母数字一律变 '-'」编码成目录名(F:\stock-rogue → F--stock-rogue);
 * 该项目的 worktree 会话目录以同前缀开头(…--claude-worktrees-xxx),用前缀匹配一并算进项目。
 *
 * 【增量缓存】jsonl 只追加不改写,按 (size, mtimeMs) 判断文件是否变过:没变直接用上次的
 * 按天聚合结果,变了只重扫这一个文件。缓存落 data/costUsageCache.json(原子写)。
 * 全项目首扫几十 MB 需数秒,之后每次刷新只扫活跃会话的增量。
 *
 * 零依赖(core 纪律),仅 node 内置模块。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { atomicWriteJsonSync } = require('./atomicWrite.cjs');

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const CACHE_PATH = path.join(__dirname, '..', 'data', 'costUsageCache.json');
const CACHE_VERSION = 2; // v2: 缓存写按 TTL 分桶(cw5m/cw1h),供美元折算

/**
 * API 牌价(USD / 百万 token,缓存自 claude-api skill 2026-06 牌价表;官方变价改这张表)。
 * 缓存价规则:读 = 0.1×input;写 5 分钟档 = 1.25×input;写 1 小时档 = 2×input。
 * 【口径声明】订阅套餐实付的是订阅费——这里的美元是「同样的量若走 API 直购值多少钱」的等价参考。
 */
const PRICE = {
  fable: { in: 10, out: 50 },
  opus: { in: 5, out: 25 },
  'sonnet-4-6': { in: 3, out: 15 },
  sonnet: { in: 2, out: 10 },
  haiku: { in: 1, out: 5 },
};
function priceFor(model) {
  const m = String(model || '');
  if (m.includes('fable') || m.includes('mythos')) return PRICE.fable;
  if (m.includes('opus')) return PRICE.opus;
  if (m.includes('sonnet-4-6')) return PRICE['sonnet-4-6'];
  if (m.includes('sonnet')) return PRICE.sonnet;
  if (m.includes('haiku')) return PRICE.haiku;
  return null; // 未知模型(如 <synthetic>)不计价
}
/** 折算实际成本(缓存价生效) */
function usdActualOf(t, p) {
  return (t.input * p.in + t.cacheRead * 0.1 * p.in + (t.cw5m || 0) * 1.25 * p.in + (t.cw1h || 0) * 2 * p.in + t.output * p.out) / 1e6;
}
/** 无缓存假想成本(全部输入按全价) */
function usdNoCacheOf(t, p) {
  return ((t.input + t.cacheRead + t.cacheWrite) * p.in + t.output * p.out) / 1e6;
}

/** mainRepo 绝对路径 → transcript 目录名前缀(与 Claude Code 的编码规则一致)。 */
function mapRepoToPrefix(mainRepo) {
  return String(mainRepo || '').replace(/[^A-Za-z0-9]/g, '-');
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

function addUsage(t, u) {
  t.input += u.input_tokens || 0;
  t.output += u.output_tokens || 0;
  t.cacheRead += u.cache_read_input_tokens || 0;
  const cw = u.cache_creation_input_tokens || 0;
  t.cacheWrite += cw;
  const cc = u.cache_creation;
  if (cc && (cc.ephemeral_5m_input_tokens || cc.ephemeral_1h_input_tokens)) {
    t.cw5m += cc.ephemeral_5m_input_tokens || 0;
    t.cw1h += cc.ephemeral_1h_input_tokens || 0;
  } else {
    t.cw1h += cw; // 老格式无 TTL 细分:全按 1h(2×)记,成本从高、节省从低,保守口径
  }
  t.msgs += 1;
}

/** 逐行流式扫一个 jsonl,产出 { days: { date: { models:{m:tally}, side:tally, main:tally } }, sessions } */
function scanFile(file) {
  return new Promise((resolve) => {
    const days = {};
    let hadAssistant = false;
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line || line.indexOf('"assistant"') === -1) return; // 便宜的预筛,坏行交给 try/catch
      let obj;
      try { obj = JSON.parse(line); } catch (_) { return; }
      if (!obj || obj.type !== 'assistant' || !obj.message || !obj.message.usage) return;
      const date = localDate(obj.timestamp);
      if (!date) return;
      hadAssistant = true;
      const d = (days[date] = days[date] || { models: {}, side: emptyTally(), main: emptyTally() });
      const model = obj.message.model || 'unknown';
      addUsage((d.models[model] = d.models[model] || emptyTally()), obj.message.usage);
      addUsage(obj.isSidechain ? d.side : d.main, obj.message.usage);
    });
    rl.on('close', () => resolve({ days, sessions: hadAssistant ? 1 : 0 }));
    rl.on('error', () => resolve({ days, sessions: 0 }));
  });
}

function readCache(cachePath) {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (c && c.version === CACHE_VERSION && c.files) return c;
  } catch (_) { /* 无缓存/坏缓存 → 全量重扫 */ }
  return { version: CACHE_VERSION, files: {} };
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

/**
 * 聚合一个项目(按目录前缀)最近 days 天的 token 消耗。
 * @returns {Promise<{byDay:Array, totals:Object, models:Object, dirs:string[], scanned:number, cachedFiles:number}>}
 */
async function getUsage({ prefix, days = 30, projectsRoot = PROJECTS_ROOT, cachePath = CACHE_PATH }) {
  if (!prefix) throw new Error('缺 prefix(由 mainRepo 映射)');
  let dirNames = [];
  try {
    dirNames = fs.readdirSync(projectsRoot).filter(
      (n) => n === prefix || n.startsWith(prefix + '-'),
    );
  } catch (_) { /* projects 根不存在 → 空结果 */ }

  const cache = readCache(cachePath);
  const totalDays = {};
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
        continue;
      }
      const r = await scanFile(abs);
      scanned++;
      cache.files[key] = { size: st.size, mtimeMs: st.mtimeMs, days: r.days, sessions: r.sessions };
      mergeDays(totalDays, r.days);
      sessions += r.sessions;
    }
  }

  if (scanned > 0) {
    try { atomicWriteJsonSync(cachePath, cache); } catch (_) { /* 缓存写失败不影响本次结果 */ }
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

  return { byDay, totals, models, usd, dirs: dirNames, scanned, cachedFiles, sessions };
}

module.exports = { getUsage, mapRepoToPrefix, priceFor, usdActualOf, usdNoCacheOf, PROJECTS_ROOT };
