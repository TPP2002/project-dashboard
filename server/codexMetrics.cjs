'use strict';

const { attachLiveness } = require('./codexJobHealth.cjs');

function validTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : null;
}

function localDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// 三条线口径与项目仓 stock-rogue 的 scripts/codex/codex-brief.cjs 的 quotaBand 保持一致
// (负责人 2026-09-05 拍板：单位是「已用百分比」，不是剩余额度)。改其中一处务必同步改另一处。
const STOP_DISPATCH_AT_USED = 95;
const REMIND_RESET_AT_USED = 98;
const HANDOVER_AT_USED = 99;

function quotaBand(usedPercent) {
  const value = Number(usedPercent);
  if (!Number.isFinite(value)) return { code: 'unknown', label: '读不到额度,按正常派单处理' };
  if (value >= HANDOVER_AT_USED) return { code: 'handover', label: '🛑 剩 ≤1%:Codex 停工,由 Claude 接手后续施工直到额度恢复' };
  if (value >= REMIND_RESET_AT_USED) return { code: 'remind-reset', label: '🚨 剩 ≤2%:回复第一句先提醒负责人重置 Codex 额度,并往看板写一条项目级 note' };
  if (value >= STOP_DISPATCH_AT_USED) return { code: 'stop-dispatch', label: '⛔ 剩 ≤5%:停止派新单(在跑的照常收)' };
  return { code: 'ok', label: '✅ 正常派单,优先消耗 Codex' };
}

function matchSessionToJob(sessionId, jobs) {
  const job = (jobs || []).find((item) => item && item.threadId === sessionId);
  return job ? { slug: job.slug, title: job.title } : null;
}

function windowStartForDays(nowMs, days) {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - (Math.max(1, days) - 1));
  return date.getTime();
}

function aggregateCodexUsage(sessions, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const days = Math.max(1, Number(options.days) || 30);
  const cutoff = windowStartForDays(nowMs, days);
  const cutoffDay = localDate(cutoff);
  const currentDay = localDate(nowMs);
  const dayMap = new Map();
  const projectMap = new Map();
  let totalTokens = 0;
  let sessionCount = 0;

  for (const session of sessions || []) {
    const project = session.project || '其它';
    let dailyEntries;
    if (session.dailyTokens && typeof session.dailyTokens === 'object') {
      dailyEntries = Object.entries(session.dailyTokens)
        .map(([date, value]) => [date, Number(value)])
        .filter(([date, tokens]) => date >= cutoffDay && date <= currentDay && Number.isFinite(tokens) && tokens >= 0);
    } else {
      const started = validTime(session?.startedAt);
      const tokens = Number(session?.tokensUsed);
      if (started === null || started < cutoff || started > nowMs || !Number.isFinite(tokens) || tokens < 0) continue;
      dailyEntries = [[localDate(started), tokens]];
    }
    if (!dailyEntries.length) continue;

    let sessionTokens = 0;
    for (const [date, tokens] of dailyEntries) {
      const day = dayMap.get(date) || { date, tokens: 0, sessions: 0, projects: {} };
      day.tokens += tokens;
      day.sessions += 1;
      day.projects[project] = (day.projects[project] || 0) + tokens;
      dayMap.set(date, day);
      sessionTokens += tokens;
    }
    const projectUsage = projectMap.get(project) || { project, tokens: 0, sessions: 0 };
    projectUsage.tokens += sessionTokens;
    projectUsage.sessions += 1;
    projectMap.set(project, projectUsage);
    totalTokens += sessionTokens;
    sessionCount += 1;
  }

  const selectedName = options.projectName || '';
  const selectedRows = [...dayMap.values()].map((day) => ({
    date: day.date,
    tokens: day.projects[selectedName] || 0,
  }));
  return {
    byDay: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byProject: [...projectMap.values()].sort((a, b) => b.tokens - a.tokens),
    totals: { tokens: totalTokens, sessions: sessionCount },
    selected: {
      project: selectedName,
      tokens: projectMap.get(selectedName)?.tokens || 0,
      sessions: projectMap.get(selectedName)?.sessions || 0,
      byDay: selectedRows.sort((a, b) => a.date.localeCompare(b.date)),
    },
  };
}

// isAlive / silenceMs / overdueGraceMs 都做成可注入:不注入就走真实进程探测与默认阈值,
// 注入了才能拿假数据把三态逐条测死(否则单测会依赖本机此刻恰好有没有那个进程号)。
function buildCodexReport({
  jobs = [], sessions = [], nowMs = Date.now(), windowMs, quotaUsedPercent = null,
  isAlive, silenceMs, overdueGraceMs,
}) {
  const cutoff = nowMs - Math.max(1, Number(windowMs) || 24 * 60 * 60 * 1000);
  const recentJobs = jobs.filter((job) => {
    const time = validTime(job?.dispatchedAt);
    return time !== null && time >= cutoff && time <= nowMs;
  });
  const recentSessions = sessions.filter((session) => {
    const time = validTime(session?.startedAt);
    return time !== null && time >= cutoff && time <= nowMs;
  });
  const rejectedJobs = recentJobs
    .filter((job) => job.collected && job.passed === false)
    .map((job) => ({ slug: job.slug, title: job.title, reason: job.rejectionReason || '未通过最终验收' }));
  // 失联单**不按时间窗筛**:一具挂了三天的尸体正是最该被看见的那种,按 24 小时窗一筛反而漏掉。
  // 计数类指标仍按窗口口径,不动。
  const livelyAll = attachLiveness(jobs, { nowMs, sessions, isAlive, silenceMs, overdueGraceMs });
  const stalledJobs = livelyAll
    .filter((job) => job.liveness === 'stalled')
    .map((job) => ({
      slug: job.slug,
      title: job.title,
      reason: job.stalledReason || '状态说还在跑，但已经联系不上',
      lastActivityAt: job.lastActivityAt || null,
      dispatchedAt: job.dispatchedAt || null,
    }))
    .sort((a, b) => String(a.dispatchedAt || '').localeCompare(String(b.dispatchedAt || '')));
  const stalledSlugs = new Set(stalledJobs.map((job) => job.slug));
  const activityTimes = [
    ...sessions.map((session) => validTime(session?.lastActivityAt)),
    ...jobs.map((job) => validTime(job?.dispatchedAt)),
  ].filter((time) => time !== null && time <= nowMs);
  return {
    dispatched: recentJobs.length,
    passed: recentJobs.filter((job) => job.collected && job.passed === true).length,
    rejected: rejectedJobs.length,
    // 「还在跑」只数真在跑的:失联的那些 state 也说 running,混进来会让负责人以为活还有人干。
    running: recentJobs.filter((job) => job.running && !stalledSlugs.has(job.slug)).length,
    stalled: stalledJobs.length,
    tokensUsed: recentSessions.reduce((sum, session) => {
      const tokens = Number(session.tokensUsed);
      return sum + (Number.isFinite(tokens) && tokens > 0 ? tokens : 0);
    }, 0),
    quotaUsedPercent: Number.isFinite(Number(quotaUsedPercent)) ? Number(quotaUsedPercent) : null,
    quotaBand: quotaBand(quotaUsedPercent),
    lastActivityAt: activityTimes.length ? new Date(Math.max(...activityTimes)).toISOString() : null,
    rejectedJobs,
    stalledJobs,
  };
}

module.exports = {
  aggregateCodexUsage, buildCodexReport, localDate, matchSessionToJob, quotaBand,
  STOP_DISPATCH_AT_USED, REMIND_RESET_AT_USED, HANDOVER_AT_USED,
};
