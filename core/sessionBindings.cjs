'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { BINDINGS_FILE, parseBindings } = require('./sessionAttribution.cjs');

function bindingsPathOf(boardPath) {
  return path.join(path.dirname(boardPath), BINDINGS_FILE);
}

function currentSessionId(env = process.env) {
  const id = env && env.CLAUDE_CODE_SESSION_ID;
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed) ? trimmed : null;
}

function readBindings(boardPath) {
  const file = bindingsPathOf(boardPath);
  try { return parseBindings(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return Object.create(null);
    throw e;
  }
}

function recordBinding({ boardPath, taskId, via, env = process.env, now = () => new Date() }) {
  if (via !== 'claim' && via !== 'done') throw new Error('via 只能是 claim 或 done');
  const sessionId = currentSessionId(env);
  if (!sessionId) return { status: 'skipped', reason: '当前进程没有有效的 Claude 会话 ID' };
  const file = bindingsPathOf(boardPath);
  if ((readBindings(boardPath)[sessionId] || []).includes(taskId)) return { status: 'exists' };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ v: 1, sessionId, taskId, via, at: now().toISOString() }) + '\n');
  return { status: 'recorded' };
}

module.exports = { bindingsPathOf, currentSessionId, recordBinding, readBindings };
