'use strict';
/**
 * DeepSeek 工单历史成本：只读全部登记代码仓的 .codex/jobs/<slug> 日志。
 * 只取最后一条 result 的顶层 usage；assistant 用量不累加，CLI 的美元字段不参与计价。
 * 按任务 repoRoot（缺省为发起仓）归属项目，路径与登记均复用 core 既有工具。
 * 价格采用 DEEPSEEK-COST-UI 指定的 2026-09 人民币价目，不查询余额；仅使用 Node 内置模块。
 */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { readRegistry, resolveProject } = require('./resolveProject.cjs');
const { normalizeReal } = require('./safePath.cjs');

/** 本地日期口径与 costUsage.cjs 保持一致；该模块为冻结禁区，日期函数就地复制。 */
function localDate(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 单位：人民币 / 百万 token。新写缓存与普通输入同按未命中价计费。
const DEEPSEEK_PRICE = Object.freeze({
  'deepseek-flash': Object.freeze({
    peak: Object.freeze({ cacheHit: 0.04, cacheMiss: 2, output: 8 }),
    offPeak: Object.freeze({ cacheHit: 0.02, cacheMiss: 1, output: 4 }),
  }),
  'deepseek-v4-pro': Object.freeze({
    peak: Object.freeze({ cacheHit: 0.30, cacheMiss: 9, output: 27 }),
    offPeak: Object.freeze({ cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }),
  }),
});

/** 北京时间周一至周五 [09:00,12:00)、[14:00,18:00)；无效时间返回 false。 */
function isPeakBeijing(isoTimestamp) {
  const ms = typeof isoTimestamp === 'string' ? Date.parse(isoTimestamp) : NaN;
  if (!Number.isFinite(ms)) return false;
  const beijing = new Date(ms + 8 * 60 * 60 * 1000);
  const weekday = beijing.getUTCDay(), hour = beijing.getUTCHours();
  return weekday >= 1 && weekday <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
}

/** 未知模型返回 null，不回落到另一档价格。 */
function priceForDeepseek(model, peak) {
  return Object.hasOwn(DEEPSEEK_PRICE, model) ? DEEPSEEK_PRICE[model][peak ? 'peak' : 'offPeak'] : null;
}

function usageBuckets(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)
    || usage.input_tokens === undefined || usage.output_tokens === undefined) return null;
  const cc = usage.cache_creation;
  if (cc != null && (typeof cc !== 'object' || Array.isArray(cc))) return null;
  const values = [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens, cc?.ephemeral_5m_input_tokens, cc?.ephemeral_1h_input_tokens]
    .map((value) => value === undefined ? 0 : value);
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  const [input, output, cacheRead, cw, cw5m, cw1h] = values;
  // 与 addUsage 同口径：有 TTL 细分时用细分；老格式（含全零细分）全部回落 1h。
  const cacheWrite = cw5m || cw1h ? cw5m + cw1h : cw;
  return { input, output, cacheRead, cacheWrite };
}

/** 返回人民币原始精度；缺有效用量/已知模型时返回 null，绝不伪造零元。 */
function costRmbOf(usage, model, peak) {
  const t = usageBuckets(usage), p = priceForDeepseek(model, peak);
  if (!t || !p) return null;
  return (t.cacheRead * p.cacheHit + (t.input + t.cacheWrite) * p.cacheMiss + t.output * p.output) / 1e6;
}

const missing = (error) => error.code === 'ENOENT' || error.code === 'ENOTDIR';
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (missing(error) || error instanceof SyntaxError) return null; // 未完成/损坏的工单没有可用账目。
    throw error;
  }
}

/** 流式保留最后一条 result 和当时的模型名，不把整份执行日志装入内存。 */
function readLastResult(file) {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let last = null, model = null;
    lines.on('line', (line) => {
      let event;
      try { event = JSON.parse(line); } catch (_) { return; } // 忽略尚未写完的行。
      if (event?.type === 'assistant' && typeof event.message?.model === 'string') model = event.message.model;
      if (event?.type === 'result') last = { event, model };
    });
    const onError = (error) => {
      if (missing(error)) resolve(null);
      else reject(error);
      lines.close();
    };
    // readline 会转发输入流错误；两层都接住，缺日志不能变成未处理异常。
    lines.once('error', onError);
    input.once('error', onError);
    lines.once('close', () => resolve(last));
  });
}

function resultModel(last, task) {
  const models = last.event.modelUsage;
  const names = models && typeof models === 'object' && !Array.isArray(models) ? Object.keys(models) : [];
  // 顶层 usage 只能按单一模型计价；多模型时不猜如何拆分。这里只读模型名，不读 costUSD。
  if (names.length) return names.length === 1 ? names[0] : null;
  return last.event.model || last.model || task.model;
}

/**
 * 与 HTTP 无关的只读扫描入口。缺文件/坏 JSON/缺结果或用量的工单跳过；其他 IO 错误向上传递。
 * 每个真实代码仓只扫一次；显式 repoRoot 必须为有效绝对路径，不能误回落发起仓。
 * @returns {Promise<Array<{slug:string,hostRepo:string,dispatchedAt:string,model:string,usage:Object,costRmb:number,peak:boolean}>>}
 */
async function scanDeepseekJobs({ registryPath, currentCodeRepo }) {
  const current = normalizeReal(currentCodeRepo);
  const registry = readRegistry(registryPath), visited = new Set(), jobs = [];
  for (const id of Object.keys(registry.projects || {})) {
    const { codeRepo: hostRepo } = resolveProject(id, { registryPath });
    if (visited.has(hostRepo)) continue;
    visited.add(hostRepo);
    const jobsRoot = path.join(hostRepo, '.codex', 'jobs');
    let entries;
    try { entries = fs.readdirSync(jobsRoot, { withFileTypes: true }); }
    catch (error) { if (missing(error)) continue; throw error; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(jobsRoot, entry.name), task = readJson(path.join(dir, 'task.json'));
      if (!task || task.engine !== 'deepseek') continue;
      const target = Object.hasOwn(task, 'repoRoot') ? task.repoRoot : hostRepo;
      if (typeof target !== 'string' || target.includes('\0') || !path.isAbsolute(target)) continue;
      if (normalizeReal(target) !== current) continue;
      const meta = readJson(path.join(dir, 'meta.json'));
      const dispatchedAt = meta?.dispatchedAt;
      if (typeof dispatchedAt !== 'string' || !Number.isFinite(Date.parse(dispatchedAt))) continue;
      const last = await readLastResult(path.join(dir, 'exec.jsonl'));
      if (!last) continue;
      const model = resultModel(last, task), usage = last.event.usage;
      // 约定近似口径：以派单开始时刻判整单时段，不拆分跨高峰边界的执行过程。
      const peak = isPeakBeijing(dispatchedAt), costRmb = costRmbOf(usage, model, peak);
      if (costRmb === null) continue;
      jobs.push({ slug: entry.name, hostRepo, dispatchedAt, model, usage, costRmb, peak });
    }
  }
  return jobs;
}

/** 最近 days 个本地自然日（含今天）。nowMs 可注入以固定窗口；金额汇总前不逐单舍入。 */
async function getDeepseekUsage({ projectId, days = 30, registryPath, nowMs = Date.now() }) {
  const { codeRepo } = resolveProject(projectId, { registryPath });
  const today = new Date(nowMs), cutoff = new Date(nowMs);
  if (!Number.isFinite(today.getTime())) throw new TypeError('无效的成本统计时间');
  const count = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
  cutoff.setDate(cutoff.getDate() - (count - 1));
  const firstDay = localDate(cutoff), lastDay = localDate(today);
  const daily = new Map(), byModel = {}, totals = { tokens: 0, costRmb: 0, jobs: 0 };
  for (const job of await scanDeepseekJobs({ registryPath, currentCodeRepo: codeRepo })) {
    const date = localDate(job.dispatchedAt);
    if (date < firstDay || date > lastDay) continue;
    const t = usageBuckets(job.usage);
    const tokens = t.input + t.output + t.cacheRead + t.cacheWrite;
    if (!daily.has(date)) daily.set(date, { date, tokens: 0, costRmb: 0 });
    const model = byModel[job.model] ||= { tokens: 0, costRmb: 0 };
    for (const row of [daily.get(date), model, totals]) {
      row.tokens += tokens;
      row.costRmb += job.costRmb;
    }
    totals.jobs++;
  }
  return { byDay: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)), totals, byModel };
}

module.exports = { DEEPSEEK_PRICE, isPeakBeijing, priceForDeepseek, costRmbOf, scanDeepseekJobs, getDeepseekUsage };
