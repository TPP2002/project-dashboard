'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { isDeepStrictEqual } = require('node:util');
const { atomicWriteFileSync } = require('./atomicWrite.cjs');

const OUTBOX_VERSION = 1;
let context = null;
let recorded = false;
let patchNumber = 0;
let disabled = 0;
let recordingError = null;
function setOpContext(ctx) { context = ctx; recorded = false; patchNumber = 0; recordingError = null; }
function clearOpContext() { context = null; recorded = false; patchNumber = 0; recordingError = null; }
function getOpContext() { return context; }
function getRecordingError() { return recordingError; }
// Excluded CLI commands and replay are scopes, not synthetic operation contexts.
function withoutRecording(fn) { disabled++; try { return fn(); } finally { disabled--; } }

function readOutbox(proj) {
  let raw;
  try { raw = fs.readFileSync(path.join(proj.syncDir, 'outbox.jsonl'), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line)).sort((a, b) => a.seq - b.seq);
}

// Caller holds the board lock. Append first, then persist the counter. On a failed
// append/counter write restore both, so a failed command cannot consume a sequence.
function appendRecords(proj, rows) {
  if (!rows.length) return;
  fs.mkdirSync(proj.syncDir, { recursive: true });
  const file = path.join(proj.syncDir, 'outbox.jsonl');
  const counter = path.join(proj.syncDir, 'outbox.seq');
  let previous = null;
  try { previous = fs.readFileSync(counter, 'utf8'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const seq = previous === null ? 0 : Number(previous.trim());
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('outbox.seq 无效');
  const fd = fs.openSync(file, 'a+');
  const size = fs.fstatSync(fd).size;
  try {
    const data = rows.map((row, i) => JSON.stringify({ ...row, seq: seq + i + 1 })).join('\n') + '\n';
    fs.appendFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
    atomicWriteFileSync(counter, String(seq + rows.length) + '\n');
  } catch (e) {
    try {
      fs.ftruncateSync(fd, size);
      fs.fsyncSync(fd);
      if (previous !== null) atomicWriteFileSync(counter, previous);
      else if (fs.existsSync(counter)) fs.unlinkSync(counter);
    } catch (rollback) {
      throw new Error(`队列写入失败：${e.message}；回退失败：${rollback.message}`);
    }
    throw e;
  } finally { fs.closeSync(fd); }
}

const META = ['commitShas', 'prNumbers', 'gitBranch'];
function changedTasks(before, after) {
  const a = new Map((before.tasks || []).map(t => [t.id, t]));
  const b = new Map((after.tasks || []).map(t => [t.id, t]));
  return [...new Set([...a.keys(), ...b.keys()])].filter(id => !isDeepStrictEqual(a.get(id), b.get(id)));
}
function recordInLock(proj, beforeBoard, afterBoard) {
  if (!proj.cloud || disabled) return;
  const { REPLAY_COMMANDS, PATCH_COMMANDS } = require('./syncReplay.cjs');
  const base = { v: OUTBOX_VERSION, project: proj.id, remoteProjectId: proj.cloud.remoteProjectId };
  const op = (command, flags, opId) => ({ ...base, kind: 'op', opId, command,
    flags, files: context.files, author: context.author, clientTs: context.clientTs, device: context.device });
  const untracked = taskIds => ({ ...base, kind: 'untracked', taskIds,
    source: context ? context.command : 'unknown', clientTs: new Date().toISOString(), device: os.hostname() });
  const rows = [];
  if (context && REPLAY_COMMANDS.includes(context.command)) {
    if (!recorded) rows.push(op(context.command, context.flags, context.opId));
  } else if (context && PATCH_COMMANDS.includes(context.command)) {
    const oldTasks = new Map((beforeBoard.tasks || []).map(t => [t.id, t]));
    const remainder = [];
    for (const id of changedTasks(beforeBoard, afterBoard)) {
      const before = oldTasks.get(id);
      const after = (afterBoard.tasks || []).find(t => t.id === id);
      if (!before || !after) { remainder.push(id); continue; }
      const add = Object.fromEntries(META.map(k => [k, (after[k] || []).filter(v => !(before[k] || []).includes(v))]));
      if (META.some(k => add[k].length)) {
        rows.push({ ...op('patch-ai-meta', { taskId: id, add }, `${context.opId}:${++patchNumber}`), files: {} });
      }
      // Only changes outside the three additive metadata fields are untracked.
      const semanticBefore = { ...before }, semanticAfter = { ...after };
      for (const k of META) { delete semanticBefore[k]; delete semanticAfter[k]; }
      if (!isDeepStrictEqual(semanticBefore, semanticAfter)) remainder.push(id);
    }
    if (remainder.length) rows.push(untracked(remainder));
  } else if (!context) {
    const ids = changedTasks(beforeBoard, afterBoard);
    if (ids.length) rows.push(untracked(ids));
  }
  try { appendRecords(proj, rows); }
  catch (e) { recordingError = e; throw e; }
  if (rows.length && context && REPLAY_COMMANDS.includes(context.command)) recorded = true;
}

module.exports = { OUTBOX_VERSION, setOpContext, clearOpContext, getOpContext, recordInLock,
  readOutbox, withoutRecording, getRecordingError };
