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
let untrackedSource = 'unknown';
function setOpContext(ctx) { context = ctx; recorded = false; patchNumber = 0; recordingError = null; }
function clearOpContext() { context = null; recorded = false; patchNumber = 0; recordingError = null; }
function getOpContext() { return context; }
function getRecordingError() { return recordingError; }
// Replay alone suppresses recording. Other CLI commands identify nested writes
// without pretending those writes can be replayed as the outer command.
function withoutRecording(fn) { disabled++; try { return fn(); } finally { disabled--; } }
function withUntrackedSource(source, fn) {
  const previous = untrackedSource;
  untrackedSource = source;
  try { return fn(); } finally { untrackedSource = previous; }
}

function readOutbox(proj) {
  let raw;
  try { raw = fs.readFileSync(path.join(proj.syncDir, 'outbox.jsonl'), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line)).sort((a, b) => a.seq - b.seq);
}

// Read backwards in bounded chunks, retaining only the final record. A complete
// but unterminated JSON record survives; only an incomplete trailing JSON is cut.
function recoverTail(fd) {
  const size = fs.fstatSync(fd).size;
  if (!size) return { seq: 0, size: 0, separator: '' };
  const lastByte = Buffer.alloc(1);
  fs.readSync(fd, lastByte, 0, 1, size - 1);
  const terminated = lastByte[0] === 10;
  let position = size - (terminated ? 1 : 0);
  let start = 0;
  const chunks = [];
  while (position > 0) {
    const count = Math.min(4096, position);
    position -= count;
    const chunk = Buffer.alloc(count);
    fs.readSync(fd, chunk, 0, count, position);
    const newline = chunk.lastIndexOf(10);
    chunks.push(chunk.subarray(newline + 1));
    if (newline !== -1) { start = position + newline + 1; break; }
  }
  let row;
  try { row = JSON.parse(Buffer.concat(chunks.reverse()).toString('utf8')); }
  catch (e) {
    if (terminated) throw new Error(`outbox.jsonl 最后一条完整行损坏：${e.message}`);
    fs.ftruncateSync(fd, start);
    fs.fsyncSync(fd);
    return recoverTail(fd);
  }
  if (!Number.isSafeInteger(row?.seq) || row.seq < 1) throw new Error('outbox.jsonl 尾记录 seq 无效');
  return { seq: row.seq, size, separator: terminated ? '' : '\n' };
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
  const counterSeq = previous === null ? 0 : Number(previous.trim());
  if (!Number.isSafeInteger(counterSeq) || counterSeq < 0) throw new Error('outbox.seq 无效');
  // Windows append-only handles cannot ftruncate. Keep a read/write handle for
  // repair/rollback and append through appendFileSync's own append handle.
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT);
  let tail;
  try {
    tail = recoverTail(fd);
    const seq = Math.max(counterSeq, tail.seq);
    const data = rows.map((row, i) => JSON.stringify({ ...row, seq: seq + i + 1 })).join('\n') + '\n';
    fs.appendFileSync(file, tail.separator + data, 'utf8');
    fs.fsyncSync(fd);
    atomicWriteFileSync(counter, String(seq + rows.length) + '\n');
  } catch (e) {
    if (!tail) throw e; // No append occurred; never erase corrupt committed data.
    try {
      fs.ftruncateSync(fd, tail.size);
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
    source: context ? context.command : untrackedSource, clientTs: new Date().toISOString(), device: os.hostname() });
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
      const remove = Object.fromEntries(META.map(k => [k, (before[k] || []).filter(v => !(after[k] || []).includes(v))]));
      if (META.some(k => add[k].length || remove[k].length)) {
        rows.push({ ...op('patch-ai-meta', { taskId: id, add, remove }, `${context.opId}:${++patchNumber}`), files: {} });
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
  readOutbox, withoutRecording, withUntrackedSource, getRecordingError };
