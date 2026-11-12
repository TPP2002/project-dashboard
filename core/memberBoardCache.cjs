'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { publicJson } = require('./collaborationPublic.cjs');

function groupMessages(activity) {
  const groups = new Map();
  for (const item of activity || []) if (item.kind === 'message') {
    if (!groups.has(item.taskId)) groups.set(item.taskId, []);
    groups.get(item.taskId).push(item);
  }
  return groups;
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function createMemberBoardCache({ read = file => fs.readFileSync(file, 'utf8'), stat = file => fs.statSync(file), summarize, view }) {
  const boards = new Map(), views = new Map();
  function invalidate(file) { for (const [key, entry] of views) if (entry.file === file) views.delete(key); }
  function entry(file) {
    const { size, mtimeMs, ctimeMs } = stat(file);
    const fingerprint = JSON.stringify([size, mtimeMs, ctimeMs]);
    let item = boards.get(file);
    if (!item || item.fingerprint !== fingerprint) {
      invalidate(file);
      const board = freeze(JSON.parse(read(file)));
      item = { fingerprint, board, groups: groupMessages(board.activity) };
    }
    boards.delete(file); boards.set(file, item);
    while (boards.size > 8) { const oldest = boards.keys().next().value; boards.delete(oldest); invalidate(oldest); }
    return item;
  }
  return {
    board: file => entry(file).board,
    summary(file) { const item = entry(file); if (!Object.hasOwn(item, 'summary')) item.summary = summarize(item.board); return item.summary; },
    view(file, user) {
      const item = entry(file);
      const key = JSON.stringify([file, item.fingerprint, user?.id, user?.role, user?.disabled]);
      let result = views.get(key);
      if (!result) {
        const value = view(item.board, user, item.groups);
        const text = JSON.stringify(value, publicJson);
        // 整段文本只用来算版本号，不随结果留在内存里。
        result = { file, value, version: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) };
      }
      views.delete(key); views.set(key, result);
      while (views.size > 64) views.delete(views.keys().next().value);
      return result;
    },
  };
}
module.exports = { createMemberBoardCache, groupMessages };
