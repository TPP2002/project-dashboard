'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CODEX_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const EXEC_TAIL_LINES = 80;
const TAIL_CHUNK_BYTES = 64 * 1024;
const EXEC_TAIL_MAX_BYTES = 2 * 1024 * 1024;

/** 用户提供的 slug 只能是单个安全目录名，不能含分隔符或大小写变体。 */
function isValidSlug(value) {
  return typeof value === 'string' && CODEX_SLUG_RE.test(value);
}

function parseTaskJson(text) {
  if (typeof text !== 'string') throw new TypeError('taskText 必须是 JSON 文本');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) { throw new SyntaxError('工单 JSON 不合法：' + error.message); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('工单 JSON 顶层必须是对象');
  }
  return parsed;
}

function readJsonOptional(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function requiredAcceptancePassed(task, verdict) {
  if (!verdict || !Array.isArray(verdict.acceptance)) return false;
  const declared = task && Array.isArray(task.acceptance) ? task.acceptance : [];
  const results = verdict.acceptance;
  const requiredIds = declared.length
    ? declared.filter((item) => item && item.required === true).map((item) => item.id)
    : results.filter((item) => item && item.required !== false).map((item) => item.id);
  return requiredIds.every((id) => results.some((item) => item && item.id === id && item.passed === true));
}

function isRedispatchBlocked(state, dispatchInFlight = false) {
  return dispatchInFlight || !state || state.finishedAt === null || state.finishedAt === undefined;
}

function rejectedReason(task, verdict, state) {
  if (typeof verdict?.selfReport?.summary === 'string' && verdict.selfReport.summary.trim()) {
    return verdict.selfReport.summary.trim();
  }
  const failed = (verdict?.acceptance || []).filter((item) => item && item.passed === false).map((item) => item.id);
  if (failed.length) return `验收未过：${failed.join('、')}`;
  if (Array.isArray(verdict?.forbiddenTouched) && verdict.forbiddenTouched.length) {
    return `触碰禁区：${verdict.forbiddenTouched.join('、')}`;
  }
  if (verdict?.forbiddenTouched) return '触碰了禁区';
  if (verdict?.selfReport?.status) return `Codex 自述：${verdict.selfReport.status}`;
  if (Number.isFinite(state?.exitCode)) return `进程退出码 ${state.exitCode}`;
  return '未通过最终验收';
}

/** 纯状态推导：不读盘、不看 PID，只按工单落盘契约生成列表摘要。 */
function summarizeJob(files) {
  const task = files.task || {};
  const meta = files.meta || {};
  const state = files.state || {};
  const collected = files.verdictExists === true;
  const summary = {
    slug: files.slug,
    title: typeof task.title === 'string' && task.title.trim() ? task.title : files.slug,
    taskId: typeof task.taskId === 'string' && task.taskId ? task.taskId : null,
    dispatchedAt: typeof meta.dispatchedAt === 'string' ? meta.dispatchedAt : null,
    running: state.finishedAt === null || state.finishedAt === undefined,
    collected,
    passed: collected ? requiredAcceptancePassed(task, files.verdict) : null,
    exitCode: typeof state.exitCode === 'number' ? state.exitCode : null,
  };
  if (typeof state.threadId === 'string' && state.threadId) summary.threadId = state.threadId;
  if (collected && summary.passed === false) summary.rejectionReason = rejectedReason(task, files.verdict, state);
  return summary;
}

function readJobFiles(jobsRoot, slug) {
  const dir = path.join(jobsRoot, slug);
  const verdictPath = path.join(dir, 'verdict.json');
  return {
    slug,
    dir,
    task: readJsonOptional(path.join(dir, 'task.json')),
    meta: readJsonOptional(path.join(dir, 'meta.json')),
    state: readJsonOptional(path.join(dir, 'state.json')),
    verdict: readJsonOptional(verdictPath),
    verdictExists: fs.existsSync(verdictPath),
  };
}

/** 工单根目录不存在等同“尚无工单”；只枚举合法的子目录。 */
function listJobs(jobsRoot) {
  let entries;
  try { entries = fs.readdirSync(jobsRoot, { withFileTypes: true }); }
  catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && isValidSlug(entry.name))
    .map((entry) => summarizeJob(readJobFiles(jobsRoot, entry.name)))
    .sort((a, b) => String(b.dispatchedAt || '').localeCompare(String(a.dispatchedAt || '')));
}

function readChat(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const chat = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      if (item && typeof item === 'object') chat.push(item);
    } catch (_) { /* 单条写到一半不拖垮整个详情页。 */ }
  }
  return chat;
}

/** 从文件末尾逆向分块，只保留最后 N 行原始字节，绝不整份加载大型 exec.jsonl。 */
function readTailLines(filePath, lineLimit = EXEC_TAIL_LINES) {
  let fd;
  try { fd = fs.openSync(filePath, 'r'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return '';
    throw error;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return '';
    const limit = Math.max(1, Math.floor(lineLimit));
    const chunks = [];
    let position = size;
    let newlines = 0;
    let totalBytes = 0;
    while (position > 0 && newlines <= limit && totalBytes < EXEC_TAIL_MAX_BYTES) {
      const length = Math.min(TAIL_CHUNK_BYTES, position, EXEC_TAIL_MAX_BYTES - totalBytes);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      fs.readSync(fd, chunk, 0, length, position);
      chunks.unshift(chunk);
      totalBytes += length;
      for (const byte of chunk) if (byte === 10) newlines++;
    }

    let data = Buffer.concat(chunks);
    if (position > 0) {
      const firstNewline = data.indexOf(10);
      data = firstNewline >= 0 ? data.subarray(firstNewline + 1) : Buffer.alloc(0);
    }
    if (!data.length) return '';
    let cursor = data.length - 1;
    if (data[cursor] === 10) cursor--;
    let separators = 0;
    let start = 0;
    for (; cursor >= 0; cursor--) {
      if (data[cursor] !== 10) continue;
      separators++;
      if (separators === limit) { start = cursor + 1; break; }
    }
    return data.subarray(start).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function getJobDetail(jobsRoot, slug) {
  const dir = path.join(jobsRoot, slug);
  let stat;
  try { stat = fs.statSync(dir); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isDirectory()) return null;
  const files = readJobFiles(jobsRoot, slug);
  const verdict = files.verdict || {};
  return {
    ...summarizeJob(files),
    acceptance: Array.isArray(verdict.acceptance) ? verdict.acceptance : [],
    selfReport: verdict.selfReport && typeof verdict.selfReport === 'object' ? verdict.selfReport : null,
    chat: readChat(path.join(dir, 'chat.jsonl')),
    tail: readTailLines(path.join(dir, 'exec.jsonl')),
  };
}

module.exports = {
  EXEC_TAIL_LINES,
  EXEC_TAIL_MAX_BYTES,
  getJobDetail,
  isRedispatchBlocked,
  isValidSlug,
  listJobs,
  parseTaskJson,
  readTailLines,
  summarizeJob,
};
