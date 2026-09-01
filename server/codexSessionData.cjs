'use strict';

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})\.jsonl$/i;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 128 * 1024;
const ACTIVE_WINDOW_MS = 120 * 1000;

function isValidSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

function parseSessionIdFromFilename(filename) {
  const match = typeof filename === 'string' ? filename.match(ROLLOUT_RE) : null;
  return match && isValidSessionId(match[1]) ? match[1] : null;
}

function unwrapEvent(event) {
  const outerType = event && typeof event.type === 'string' ? event.type : 'unknown';
  const payload = event && event.payload && typeof event.payload === 'object' ? event.payload : {};
  const type = typeof payload.type === 'string' ? payload.type : outerType;
  return { outerType, type, payload };
}

function parseJsonLines(text, dropFirstLine = false) {
  let source = String(text || '');
  if (dropFirstLine) {
    const newline = source.indexOf('\n');
    source = newline < 0 ? '' : source.slice(newline + 1);
  }
  const events = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') events.push(parsed);
    } catch (_) { /* 文件可能正写到半行；只忽略这一行。 */ }
  }
  return events;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseTailSnapshot(text, startsMidLine = false) {
  const events = parseJsonLines(text, startsMidLine);
  const last = events.length ? events[events.length - 1] : null;
  let tokensUsed = null;
  let quotaSample = null;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    const inner = unwrapEvent(event);
    if (inner.type !== 'token_count') continue;
    if (tokensUsed === null) {
      tokensUsed = finiteNumber(inner.payload.info?.total_token_usage?.total_tokens);
    }
    if (!quotaSample && inner.payload.rate_limits && typeof inner.payload.rate_limits === 'object') {
      quotaSample = { sampledAt: event.timestamp || null, rateLimits: inner.payload.rate_limits };
    }
    if (tokensUsed !== null && quotaSample) break;
  }
  return {
    events,
    lastActivityAt: typeof last?.timestamp === 'string' ? last.timestamp : null,
    lastOrdinal: Number.isFinite(last?.ordinal) ? last.ordinal : null,
    tokensUsed,
    quotaSample,
  };
}

function visitFields(value, visitor) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (visitor(key, child) === false) continue;
    visitFields(child, visitor);
  }
}

function extractModelAndEffort(headText) {
  const limited = Buffer.from(String(headText || ''), 'utf8').subarray(0, HEAD_BYTES).toString('utf8');
  const events = parseJsonLines(limited, false);
  let model = null;
  let reasoningEffort = null;
  for (const event of events) {
    visitFields(event, (key, value) => {
      if (!model && key === 'model' && typeof value === 'string') model = value;
      if (!reasoningEffort && (key === 'reasoning_effort' || key === 'effort') && typeof value === 'string') {
        reasoningEffort = value;
      }
      return !(model && reasoningEffort);
    });
    if (model && reasoningEffort) break;
  }
  return { model: model || '未知', reasoningEffort: reasoningEffort || '未知' };
}

function normalizeWindowsPath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/\/\?\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function pathIsInside(candidate, root) {
  return Boolean(candidate && root && (candidate === root || candidate.startsWith(root + '/')));
}

function inferProjectName(cwd, projects = {}, dashboardRoot = '') {
  const candidate = normalizeWindowsPath(cwd);
  const roots = Object.values(projects || {})
    .filter((project) => project && project.mainRepo)
    .map((project) => ({ name: project.name || '其它', root: normalizeWindowsPath(project.mainRepo) }));
  if (dashboardRoot) roots.push({ name: '项目管理看板', root: normalizeWindowsPath(dashboardRoot) });
  roots.sort((a, b) => b.root.length - a.root.length);
  return roots.find((entry) => pathIsInside(candidate, entry.root))?.name || '其它';
}

function isSessionActive(timestamp, nowMs = Date.now(), thresholdMs = ACTIVE_WINDOW_MS) {
  const then = Date.parse(timestamp || '');
  if (!Number.isFinite(then) || !Number.isFinite(nowMs)) return false;
  const age = nowMs - then;
  return age >= -thresholdMs && age <= thresholdMs;
}

function formatResetLocal(unixSeconds, timeZone) {
  const seconds = finiteNumber(unixSeconds);
  if (seconds === null) return null;
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  const options = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  };
  if (timeZone) options.timeZone = timeZone;
  return new Intl.DateTimeFormat('zh-CN', options).format(date);
}

function eventText(payload) {
  if (typeof payload.text === 'string') return payload.text;
  if (!Array.isArray(payload.content)) return '';
  return payload.content.map((item) => (item && typeof item.text === 'string' ? item.text : '')).filter(Boolean).join('\n');
}

function formatSessionEvent(event) {
  const inner = unwrapEvent(event);
  const base = {
    timestamp: typeof event?.timestamp === 'string' ? event.timestamp : null,
    ordinal: Number.isFinite(event?.ordinal) ? event.ordinal : null,
    outerType: inner.outerType,
    type: inner.type,
  };
  if (inner.type === 'message') {
    return { ...base, role: inner.payload.role || 'unknown', text: eventText(inner.payload).slice(0, 20000) };
  }
  if (inner.type === 'custom_tool_call') {
    return { ...base, toolName: inner.payload.name || 'tool', command: String(inner.payload.input || '').slice(0, 20000) };
  }
  return { ...base, summary: inner.outerType === inner.type ? inner.type : `${inner.outerType} / ${inner.type}` };
}

module.exports = {
  ACTIVE_WINDOW_MS,
  HEAD_BYTES,
  TAIL_BYTES,
  extractModelAndEffort,
  formatResetLocal,
  formatSessionEvent,
  inferProjectName,
  isSessionActive,
  isValidSessionId,
  normalizeWindowsPath,
  parseJsonLines,
  parseSessionIdFromFilename,
  parseTailSnapshot,
  unwrapEvent,
};
