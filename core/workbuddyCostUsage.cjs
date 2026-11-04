'use strict';
/**
 * workbuddyCostUsage.cjs —— WorkBuddy 命令行积分账（只读）。
 *
 * 【数据源】各登记代码仓的 .codex/workbuddy-ledger.json，由派单侧逐请求写入；
 * 本模块不重算积分、不读工人会话记录，只把这份账按项目/模型/自然日归并。
 * 同一请求号可能被多个仓的账本各自记一遍（同一台机器共用账本），按请求号只算一次。
 *
 * 零依赖（core 纪律），仅 Node 内置模块 + 本仓 core 的项目解析与路径规范化。
 */
const fs = require('node:fs');
const path = require('node:path');
const { readRegistry, resolveProject } = require('./resolveProject.cjs');
const { normalizeReal } = require('./safePath.cjs');

/** 读一份账本；缺失、损坏、权限不足一律当没有这份账（成本页不能被一份坏文件拖垮）。 */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function localDate(timestamp) {
  const date = new Date(timestamp), pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** credits 只认非负数或 null（null = 定不出价），其余整行进不了账。 */
function safeCredits(value) {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeRepo(raw) {
  if (typeof raw !== 'string' || !raw || raw.includes('\0') || !path.isAbsolute(raw)) return null;
  try { return normalizeReal(raw); } catch (_) { return raw; } // 规范化失败留原值，不丢整行
}

/** 账本里的一行；形状不对返回 null。 */
function toRequest(id, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))) return null;
  const credits = safeCredits(record.credits);
  if (credits === undefined) return null;
  return {
    id,
    at: record.at,
    model: typeof record.model === 'string' && record.model ? record.model : '未知',
    credits,
    source: typeof record.source === 'string' ? record.source : null,
    slug: typeof record.slug === 'string' && record.slug ? record.slug : null,
    taskId: typeof record.taskId === 'string' && record.taskId ? record.taskId : null,
    repo: safeRepo(record.repo),
    label: typeof record.label === 'string' && record.label ? record.label : null,
    reason: typeof record.reason === 'string' ? record.reason : null,
  };
}

/**
 * 从全部登记代码仓搜 WorkBuddy 账本；仓按 codeRepo 去重，请求号跨仓只算一次。
 * @returns {{requests:Array, lastCheck:object|null, updatedAt:string|null}}
 */
function scanWorkbuddyLedgers({ registryPath } = {}) {
  const registry = readRegistry(registryPath), hosts = new Set(), seen = new Set(), requests = [];
  let lastCheck = null, updatedAt = null, bestAt = -Infinity;
  for (const id of Object.keys(registry.projects || {})) {
    let host;
    try { host = resolveProject(id, { registryPath }).codeRepo; }
    catch (_) { continue; } // 其他项目登记坏了，不拖垮本项目的只读账。
    if (hosts.has(host)) continue;
    hosts.add(host);
    const data = readJson(path.join(host, '.codex', 'workbuddy-ledger.json'));
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.schemaVersion !== 1) continue;
    if (data.requests && typeof data.requests === 'object' && !Array.isArray(data.requests)) {
      for (const [requestId, record] of Object.entries(data.requests)) {
        if (seen.has(requestId)) continue;
        const row = toRequest(requestId, record);
        if (!row) continue;
        seen.add(requestId);
        requests.push(row);
      }
    }
    const at = typeof data.updatedAt === 'string' ? Date.parse(data.updatedAt) : NaN;
    const rank = Number.isFinite(at) ? at : -Infinity;
    if (data.lastCheck && typeof data.lastCheck === 'object' && !Array.isArray(data.lastCheck)) {
      if (!lastCheck || rank > bestAt) { lastCheck = data.lastCheck; bestAt = rank; }
    }
    if (!updatedAt || rank > (Number.isFinite(Date.parse(updatedAt)) ? Date.parse(updatedAt) : -Infinity)) {
      if (typeof data.updatedAt === 'string') updatedAt = data.updatedAt;
    }
  }
  return { requests, lastCheck, updatedAt };
}

function emptyTotals() {
  return { requests: 0, credits: 0, jobCredits: 0, nonJobCredits: 0,
    estimateCredits: 0, unpricedRequests: 0, jobs: 0 };
}

/**
 * 时间窗口与 glmCostUsage.summarizeGlmJobs 同口径（本机时区按天，at 晚于 nowMs 的不算）。
 * 没走工单的行（slug 为 null）只进全机汇总；给定 projectRepo 时它们不归任何项目，不出现。
 */
function summarizeWorkbuddyRequests(data, { projectRepo = null, days = 30, nowMs = Date.now() } = {}) {
  const cutoff = new Date(nowMs), clampDays = Math.max(1, Math.min(365, days));
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (clampDays - 1));
  const totals = emptyTotals();
  const byModel = new Map(), byDay = new Map(), slugs = new Set();
  const list = data && Array.isArray(data.requests) ? data.requests : [];
  for (const row of list) {
    if (!row) continue;
    if (projectRepo && (row.repo !== projectRepo || row.slug === null)) continue;
    const at = Date.parse(row.at);
    if (!Number.isFinite(at) || at < cutoff.getTime() || at > nowMs) continue;
    totals.requests++;
    if (row.credits === null) totals.unpricedRequests++;
    else totals.credits += row.credits;
    if (row.slug === null) {
      if (row.credits !== null) totals.nonJobCredits += row.credits;
    } else {
      slugs.add(row.slug);
      if (row.credits !== null) totals.jobCredits += row.credits;
    }
    if (row.credits !== null && row.source === 'estimate') totals.estimateCredits += row.credits;
    const model = byModel.get(row.model) || { requests: 0, credits: 0 };
    model.requests++;
    if (row.credits !== null) model.credits += row.credits;
    byModel.set(row.model, model);
    const day = localDate(at);
    const bucket = byDay.get(day) || { requests: 0, credits: 0 };
    bucket.requests++;
    if (row.credits !== null) bucket.credits += row.credits;
    byDay.set(day, bucket);
  }
  totals.credits = round2(totals.credits);
  totals.jobCredits = round2(totals.jobCredits);
  totals.nonJobCredits = round2(totals.nonJobCredits);
  totals.estimateCredits = round2(totals.estimateCredits);
  totals.jobs = slugs.size;
  const models = {};
  for (const [name, row] of byModel) models[name] = { requests: row.requests, credits: round2(row.credits) };
  return {
    totals,
    byModel: models,
    byDay: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([date, row]) => ({ date, requests: row.requests, credits: round2(row.credits) })),
    lastCheck: data?.lastCheck && typeof data.lastCheck === 'object' ? data.lastCheck : null,
    updatedAt: typeof data?.updatedAt === 'string' ? data.updatedAt : null,
  };
}

function getWorkbuddyUsage({ projectId, days = 30, registryPath, nowMs = Date.now() }) {
  const repo = resolveProject(projectId, { registryPath }).codeRepo;
  return summarizeWorkbuddyRequests(scanWorkbuddyLedgers({ registryPath }), { projectRepo: repo, days, nowMs });
}

module.exports = { getWorkbuddyUsage, scanWorkbuddyLedgers, summarizeWorkbuddyRequests };
