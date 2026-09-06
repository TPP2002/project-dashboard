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
 * @param {object|((board:object)=>(object|null))|null} [activityEntry] 追加到 activity（push，天然无冲突）。
 *   传【函数】时在锁内、mutator 跑完之后才求值 —— 「这次改了几条」这种只有改完才知道的信息
 *   必须走函数形态：直接传对象会在调用 mutate【之前】就把实参算完（JS 求值顺序），拿到的是改动前的旧值。
 *   sync-from-git 的流水就栽在这上面：写的是 `changed ? {...} : null`，而那一刻 changed 恒为 0，
 *   于是这条流水一次都没落过盘（DOCTOR-FIX-MISSING-NEVER-CLEARS 施工中发现）。
 * @returns {object} 写入后的 board
 */
function mutate(proj, mutator, activityEntry) {
  fs.mkdirSync(path.dirname(proj.board), { recursive: true });
  return withLock(proj.lock, () => {
    const board = readBoardOrNull(proj.board)
      || emptyBoard({ id: proj.id, name: proj.name, mainRepo: proj.mainRepo });
    mutator(board);
    const entry = typeof activityEntry === 'function' ? activityEntry(board) : activityEntry;
    if (entry) {
      board.activity = board.activity || [];
      board.activity.push(entry);
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

/**
 * 两个哈希是不是同一个提交 = 忽略大小写的前缀关系。
 * 【唯一口径】：unionShas 的归并、doctor 判「这条提交记没记进板」都必须走它。
 * 两处一旦分家就会死循环：doctor 只认「恰好 12 位或恰好 7 位」时，`done --commit` 存下的
 * 40 位全哈希被判成漏记 → --fix 调 sync → unionShas 认出是同一个提交、什么也不加 →
 * 下次 doctor 照报，备份文件每跑一次多攒一份（DOCTOR-FIX-MISSING-NEVER-CLEARS：
 * 2026-09-07 只读探针实测 rogue 恒报 11 条 / cluster 5 条，逐条比对后真缺 0 条）。
 */
function sameCommit(a, b) {
  const x = String(a).trim().toLowerCase();
  const y = String(b).trim().toLowerCase();
  if (!x || !y) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/** 这个提交是否已记在这串哈希里（口径同 unionShas）。 */
function hasCommit(list, sha) {
  return (list || []).some((k) => sameCommit(k, sha));
}

/**
 * commitShas 专用 union：前缀相同的长短哈希 = 同一个提交，只留信息更全的那份。
 * 两个写入点存的长度本就不同（自动扫描存 12 位、done --commit 存用户手写的短写），
 * 纯字符串去重会让同一个提交以两种格式并存。
 */
function unionShas(arr) {
  const kept = [];
  for (const raw of arr) {
    const s = String(raw).trim();
    if (!s) continue;
    const i = kept.findIndex((k) => sameCommit(k, s));
    if (i === -1) kept.push(s);
    else if (s.length > kept[i].length) kept[i] = s;
  }
  return kept;
}

module.exports = { readBoard, readBoardOrNull, mutate, findTask, unionBy, unionShas, sameCommit, hasCommit };
