'use strict';
/** GLM Coding Plan 工单账：积分是套餐额度，不是人民币；并行时差值仅供参考。 */
const fs = require('node:fs');
const path = require('node:path');
const { readRegistry, resolveProject } = require('./resolveProject.cjs');
const { normalizeReal } = require('./safePath.cjs');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error instanceof SyntaxError) return null;
    throw error;
  }
}

function tally() {
  return { jobs: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    credits: 0, creditJobs: 0, uncertainCredits: 0, missingUsageJobs: 0 };
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function localDate(timestamp) {
  const date = new Date(timestamp), pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function add(row, record) {
  row.jobs++;
  const usage = record.usage;
  if (usage && ['input', 'output', 'cacheRead', 'cacheWrite'].every((key) => safeCount(usage[key]) !== null)) {
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) row[key] += usage[key];
    row.tokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  } else row.missingUsageJobs++;
  // 续聊用量在独立的 resumeUsage 桶里，首轮 usage 不含它。
  const resume = record.resumeUsage;
  if (resume && ['input', 'output', 'cacheRead', 'cacheWrite'].every((key) => safeCount(resume[key]) !== null)) {
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) row[key] += resume[key];
    row.tokens += resume.input + resume.output + resume.cacheRead + resume.cacheWrite;
  } else if (record.resumeRounds > 0) row.missingUsageJobs++;
  const credits = safeCount(record.glmQuota?.weeklyDelta);
  if (credits !== null) {
    row.credits += credits;
    row.creditJobs++;
    if (record.attribution?.attributable !== true) row.uncertainCredits += credits;
  }
}

/** 从全部登记代码仓搜 GLM 工单；显式 repoRoot 决定归属，host + slug 去重。 */
function scanGlmJobs({ registryPath }) {
  const registry = readRegistry(registryPath), hosts = new Set(), jobs = [];
  for (const id of Object.keys(registry.projects || {})) {
    let host;
    try { host = resolveProject(id, { registryPath }).codeRepo; }
    catch (_) { continue; } // 其他项目登记坏了，不拖垮本项目的只读账。
    if (hosts.has(host)) continue;
    hosts.add(host);
    let dirs;
    try { dirs = fs.readdirSync(path.join(host, '.codex', 'jobs'), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; throw error; }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const jobDir = path.join(host, '.codex', 'jobs', dir.name);
      const task = readJson(path.join(jobDir, 'task.json'));
      if (task?.engine !== 'glm') continue;
      const rawTarget = Object.hasOwn(task, 'repoRoot') ? task.repoRoot : host;
      if (typeof rawTarget !== 'string' || rawTarget.includes('\0') || !path.isAbsolute(rawTarget)) continue;
      const cost = readJson(path.join(jobDir, 'cost.json'));
      if (cost?.engine !== 'glm') continue;
      const meta = readJson(path.join(jobDir, 'meta.json'));
      const at = meta?.dispatchedAt || cost.recordedAt;
      if (!Number.isFinite(Date.parse(at || ''))) continue;
      jobs.push({ host, slug: dir.name, repo: normalizeReal(rawTarget), at, model: cost.model || task.model || '未知', cost });
    }
  }
  return jobs;
}

function summarizeGlmJobs(jobs, { projectRepo = null, days = 30, nowMs = Date.now() } = {}) {
  const cutoff = new Date(nowMs);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (Math.max(1, Math.min(365, days)) - 1));
  const totals = tally(), byModel = {}, byDay = {};
  for (const job of jobs) {
    if (projectRepo && job.repo !== projectRepo) continue;
    const at = Date.parse(job.at);
    if (!Number.isFinite(at) || at < cutoff.getTime() || at > nowMs) continue;
    add(totals, job.cost);
    add((byModel[job.model] ||= tally()), job.cost);
    add((byDay[localDate(at)] ||= tally()), job.cost);
  }
  return { totals, byModel, byDay: Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b))
    .map(([date, row]) => ({ date, ...row })) };
}

function getGlmUsage({ projectId, days = 30, registryPath, nowMs = Date.now() }) {
  const repo = resolveProject(projectId, { registryPath }).codeRepo;
  return summarizeGlmJobs(scanGlmJobs({ registryPath }), { projectRepo: repo, days, nowMs });
}

module.exports = { getGlmUsage, scanGlmJobs, summarizeGlmJobs };
