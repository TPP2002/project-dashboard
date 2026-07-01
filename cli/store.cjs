'use strict';
/**
 * store.cjs —— board 读写底座（治本 R1 / R9c）
 * 所有写命令统一走 mutate：抢锁 → 锁内重读最新 → 改 → 刷 updatedAt → 追 activity → 写前校验 → 原子写。
 * 字段级合并：累加数组用 union-by-key 去重（unionBy），标量显式覆盖 —— 绝不整对象覆盖（防并发丢更新）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { withLock } = require('../core/lock.cjs');
const { atomicWriteJsonSync } = require('../core/atomicWrite.cjs');
const { assertValid, emptyBoard } = require('../core/boardSchema.cjs');

function readBoard(boardPath) {
  return JSON.parse(fs.readFileSync(boardPath, 'utf8'));
}
function readBoardOrNull(boardPath) {
  try { return readBoard(boardPath); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/**
 * 锁内 read-modify-write。
 * @param {{id,name,mainRepo,board,lock}} proj resolveProject 结果
 * @param {(board:object)=>void} mutator 就地改 board
 * @param {object|null} [activityEntry] 追加到 activity（push，天然无冲突）
 * @returns {object} 写入后的 board
 */
function mutate(proj, mutator, activityEntry) {
  fs.mkdirSync(path.dirname(proj.board), { recursive: true });
  return withLock(proj.lock, () => {
    const board = readBoardOrNull(proj.board)
      || emptyBoard({ id: proj.id, name: proj.name, mainRepo: proj.mainRepo });
    mutator(board);
    if (activityEntry) {
      board.activity = board.activity || [];
      board.activity.push(activityEntry);
    }
    board.project.updatedAt = new Date().toISOString();
    assertValid(board); // 写前校验，坏数据绝不落盘
    atomicWriteJsonSync(proj.board, board);
    return board;
  });
}

/** 找 task，找不到抛错 */
function findTask(board, taskId) {
  const t = (board.tasks || []).find((x) => x.id === taskId);
  if (!t) throw new Error(`任务 ${taskId} 不存在（先用 add 或 import 建）`);
  return t;
}

/** union-by-key 合并（累加字段用，抗并发丢失） */
function unionBy(arr, keyFn) {
  const seen = new Set(); const out = [];
  for (const x of arr) { const k = keyFn(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}

module.exports = { readBoard, readBoardOrNull, mutate, findTask, unionBy };
