'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  HEAD_BYTES,
  TAIL_BYTES,
  extractModelAndEffort,
  formatResetLocal,
  formatSessionEvent,
  inferProjectName,
  isSessionActive,
  parseJsonLines,
  parseSessionIdFromFilename,
  parseTailSnapshot,
} = require('./codexSessionData.cjs');
const { aggregateCodexUsage, buildCodexReport, localDate, matchSessionToJob, quotaBand } = require('./codexMetrics.cjs');
const { scanTokenTotalsByDay } = require('./codexCostUsage.cjs');
const { listSessionFiles: listFiles, readRange } = require('./codexSessionFiles.cjs');

const DEFAULT_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');
const DEFAULT_SCAN_DAYS = 30;
const FIRST_LINE_MAX_BYTES = 512 * 1024;
const DETAIL_CHUNK_BYTES = 128 * 1024;
const DETAIL_MAX_BYTES = 16 * 1024 * 1024;
const identityCache = new Map();
const tailCache = new Map();

function listSessionFiles(sessionsRoot = DEFAULT_SESSIONS_ROOT, options = {}) {
  return listFiles(sessionsRoot, options);
}

function readHead(file, size) {
  return readRange(file, 0, Math.min(size, HEAD_BYTES)).toString('utf8');
}

function readFirstLine(file, size, headText) {
  const newline = headText.indexOf('\n');
  if (newline >= 0) return headText.slice(0, newline).replace(/\r$/, '');
  if (size <= HEAD_BYTES) return headText.replace(/\r$/, '');
  const fd = fs.openSync(file, 'r');
  const chunks = [];
  let position = 0;
  try {
    while (position < Math.min(size, FIRST_LINE_MAX_BYTES)) {
      const length = Math.min(64 * 1024, size - position, FIRST_LINE_MAX_BYTES - position);
      const buffer = Buffer.allocUnsafe(length);
      const bytesRead = fs.readSync(fd, buffer, 0, length, position);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      const split = chunk.indexOf(10);
      chunks.push(split >= 0 ? chunk.subarray(0, split) : chunk);
      position += split >= 0 ? split : bytesRead;
      if (split >= 0) break;
    }
  } finally { fs.closeSync(fd); }
  return Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
}

function readTail(file, size) {
  const cached = tailCache.get(file);
  if (cached && cached.size === size) return cached.snapshot;
  const position = Math.max(0, size - TAIL_BYTES);
  const text = readRange(file, position, size - position).toString('utf8');
  const parsed = parseTailSnapshot(text, position > 0);
  const snapshot = {
    lastActivityAt: parsed.lastActivityAt,
    lastOrdinal: parsed.lastOrdinal,
    tokensUsed: parsed.tokensUsed,
    quotaSample: parsed.quotaSample,
  };
  tailCache.set(file, { size, snapshot });
  return snapshot;
}

function readIdentity(file, size, projects, dashboardRoot) {
  const cached = identityCache.get(file);
  const sampledBytes = Math.min(size, HEAD_BYTES);
  if (cached && cached.sampledBytes === sampledBytes) {
    return { ...cached.identity, project: inferProjectName(cached.identity.cwd, projects, dashboardRoot) };
  }
  const headText = readHead(file, size);
  const firstLine = readFirstLine(file, size, headText);
  let sessionMeta = null;
  try { sessionMeta = JSON.parse(firstLine); } catch (_) { /* 缺失或坏首行按空身份处理。 */ }
  const payload = sessionMeta?.type === 'session_meta' && sessionMeta.payload && typeof sessionMeta.payload === 'object'
    ? sessionMeta.payload : {};
  const fields = extractModelAndEffort(headText);
  const identity = {
    sessionMeta,
    startedAt: typeof payload.timestamp === 'string' ? payload.timestamp
      : (typeof sessionMeta?.timestamp === 'string' ? sessionMeta.timestamp : null),
    cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
    originator: typeof payload.originator === 'string' ? payload.originator : null,
    cliVersion: typeof payload.cli_version === 'string' ? payload.cli_version : null,
    model: fields.model,
    reasoningEffort: fields.reasoningEffort,
  };
  identityCache.set(file, { sampledBytes, identity });
  return { ...identity, project: inferProjectName(identity.cwd, projects, dashboardRoot) };
}

function scanSessionFile(file, context) {
  const stat = fs.statSync(file);
  const sessionId = parseSessionIdFromFilename(path.basename(file));
  const identity = readIdentity(file, stat.size, context.projects, context.dashboardRoot);
  const tail = readTail(file, stat.size);
  return {
    file,
    sessionMeta: identity.sessionMeta,
    quotaSample: tail.quotaSample,
    summary: {
      sessionId,
      startedAt: identity.startedAt,
      cwd: identity.cwd,
      project: identity.project,
      active: isSessionActive(tail.lastActivityAt, context.nowMs),
      lastActivityAt: tail.lastActivityAt,
      sizeBytes: stat.size,
      lastOrdinal: tail.lastOrdinal,
      tokensUsed: tail.tokensUsed,
      model: identity.model,
      reasoningEffort: identity.reasoningEffort,
      originator: identity.originator,
      cliVersion: identity.cliVersion,
    },
  };
}

function scanFiles(files, context) {
  const scanned = [];
  for (const file of files) {
    try { scanned.push(scanSessionFile(file, context)); }
    catch (_) { /* 单个会话正在轮转或损坏，不拖垮整张列表。 */ }
  }
  return scanned;
}

function contextWithDefaults(options = {}) {
  return {
    sessionsRoot: options.sessionsRoot || DEFAULT_SESSIONS_ROOT,
    projects: options.projects || {},
    dashboardRoot: options.dashboardRoot || '',
    nowMs: Number.isFinite(options.nowMs) ? options.nowMs : Date.now(),
  };
}

function listSessions(options = {}) {
  const context = contextWithDefaults(options);
  const days = Math.max(1, Number(options.days) || DEFAULT_SCAN_DAYS);
  const files = listSessionFiles(context.sessionsRoot, { days, nowMs: context.nowMs });
  const jobs = options.jobs || [];
  const summaries = scanFiles(files, context).map((item) => {
    const job = matchSessionToJob(item.summary.sessionId, jobs);
    return job ? { ...item.summary, job } : item.summary;
  });
  summaries.sort((a, b) => Number(b.active) - Number(a.active)
    || String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  const limit = Math.max(1, Math.min(500, Number(options.limit) || 50));
  return summaries.slice(0, limit);
}

function findSessionFile(sessionId, sessionsRoot = DEFAULT_SESSIONS_ROOT) {
  return listSessionFiles(sessionsRoot).find((file) => parseSessionIdFromFilename(path.basename(file)) === sessionId) || null;
}

function readLastEvents(file, limit) {
  const size = fs.statSync(file).size;
  let position = size;
  let totalBytes = 0;
  let newlineCount = 0;
  const chunks = [];
  while (position > 0 && newlineCount <= limit && totalBytes < DETAIL_MAX_BYTES) {
    const length = Math.min(DETAIL_CHUNK_BYTES, position, DETAIL_MAX_BYTES - totalBytes);
    position -= length;
    const chunk = readRange(file, position, length);
    chunks.unshift(chunk);
    totalBytes += chunk.length;
    for (const byte of chunk) if (byte === 10) newlineCount++;
  }
  const events = parseJsonLines(Buffer.concat(chunks).toString('utf8'), position > 0);
  return events.slice(-limit).map(formatSessionEvent);
}

function getSessionDetail(sessionId, options = {}) {
  const context = contextWithDefaults(options);
  const file = findSessionFile(sessionId, context.sessionsRoot);
  if (!file) return null;
  const scanned = scanSessionFile(file, context);
  const job = matchSessionToJob(sessionId, options.jobs || []);
  return {
    ...scanned.summary,
    ...(job ? { job } : {}),
    sessionMeta: scanned.sessionMeta,
    events: readLastEvents(file, Math.max(1, Math.min(1000, Number(options.tail) || 200))),
  };
}

function getLatestQuota(options = {}) {
  const context = contextWithDefaults(options);
  let latest = null;
  for (const file of listSessionFiles(context.sessionsRoot)) {
    try {
      const size = fs.statSync(file).size;
      const sample = readTail(file, size).quotaSample;
      if (sample && (!latest || String(sample.sampledAt || '') > String(latest.sampledAt || ''))) latest = sample;
    } catch (_) { /* 单个坏文件不影响其它会话的额度快照。 */ }
  }
  const usedPercent = latest ? Number(latest.rateLimits?.primary?.used_percent) : NaN;
  const resetsAt = latest?.rateLimits?.primary?.resets_at;
  return {
    rate_limits: latest?.rateLimits || null,
    sampledAt: latest?.sampledAt || null,
    usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
    band: quotaBand(usedPercent),
    resetsAtLocal: formatResetLocal(resetsAt),
  };
}

async function getCodexUsage(options = {}) {
  const context = contextWithDefaults(options);
  const days = Math.max(1, Number(options.days) || 30);
  const files = listSessionFiles(context.sessionsRoot, { days: days + 1, nowMs: context.nowMs });
  const scanned = scanFiles(files, context);
  const sessions = [];
  for (const item of scanned) {
    const startDay = localDate(item.summary.startedAt);
    const endDay = localDate(item.summary.lastActivityAt);
    if (startDay && endDay && startDay !== endDay) {
      const cost = await scanTokenTotalsByDay(item.file);
      sessions.push({ ...item.summary, ...cost });
    } else {
      sessions.push(item.summary);
    }
  }
  return aggregateCodexUsage(sessions, { days, nowMs: context.nowMs, projectName: options.projectName });
}

function getCodexReport(options = {}) {
  const context = contextWithDefaults(options);
  const days = Number(options.days) === 7 ? 7 : 1;
  const files = listSessionFiles(context.sessionsRoot, { days: days + 1, nowMs: context.nowMs });
  const sessions = scanFiles(files, context).map((item) => item.summary);
  const quota = options.quota || getLatestQuota(options);
  return buildCodexReport({
    jobs: options.jobs || [], sessions, nowMs: context.nowMs,
    windowMs: days * 24 * 60 * 60 * 1000, quotaUsedPercent: quota.usedPercent,
  });
}

module.exports = {
  DEFAULT_SCAN_DAYS,
  DEFAULT_SESSIONS_ROOT,
  findSessionFile,
  getCodexReport,
  getCodexUsage,
  getLatestQuota,
  getSessionDetail,
  listSessionFiles,
  listSessions,
  readLastEvents,
  scanTokenTotalsByDay,
};
