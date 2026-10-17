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
const { diffTask } = require('../core/taskDiff.cjs');
let transaction = null;
function guardLocal(boardPath) {
  require('../core/resolveProject.cjs').assertLocalBoard(boardPath);
}
function rawBoard(boardPath) { return JSON.parse(fs.readFileSync(boardPath, 'utf8')); }
function sameBoard(a, b) { return path.resolve(a) === path.resolve(b); }
function syncOnly(result) {
  if (result && typeof result.then === 'function') throw new Error('board 事务禁止 Promise');
  return result;
}

function readBoard(boardPath) {
  if (transaction && sameBoard(transaction.proj.board, boardPath)) return transaction.board;
  guardLocal(boardPath);
  return require('../core/boardCommand.cjs').publicResult(rawBoard(boardPath));
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
  guardLocal(proj.board);
  if (transaction) {
    if (!sameBoard(transaction.proj.board, proj.board)) throw new Error('禁止跨 board 嵌套事务');
    const board = transaction.board;
    syncOnly(mutator(board));
    const entry = typeof activityEntry === 'function' ? syncOnly(activityEntry(board)) : activityEntry;
    if (entry) { board.activity = board.activity || []; board.activity.push(entry); }
    board.project.updatedAt = new Date().toISOString();
    return board;
  }
  fs.mkdirSync(path.dirname(proj.board), { recursive: true });
  return withLock(proj.lock, () => {
    const board = fs.existsSync(proj.board) ? rawBoard(proj.board)
      : emptyBoard({ id: proj.id, name: proj.name, mainRepo: proj.mainRepo });
    syncOnly(mutator(board));
    const entry = typeof activityEntry === 'function' ? syncOnly(activityEntry(board)) : activityEntry;
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

/** Business mutation, revision and immutable receipt share the existing lock and one atomic write. */
function commandTransaction(proj, identity, fn) {
  if (transaction) throw new Error('禁止嵌套 commandTransaction');
  guardLocal(proj.board);
  fs.mkdirSync(path.dirname(proj.board), { recursive: true });
  return withLock(proj.lock, () => {
    const board = fs.existsSync(proj.board) ? rawBoard(proj.board) : emptyBoard(proj);
    const { request, subject, inputHash } = identity;
    const key = require('../core/boardCommand.cjs').inputHash([subject, proj.id, request.requestId]);
    const receipts = board._commandReceipts || {};
    const old = receipts[key];
    if (old) {
      if (old.inputHash !== inputHash) throw new Error('requestId 已用于不同内容');
      return old.result;
    }
    // Prototype retains receipts forever. Refuse NEW work at capacity; never forget a replay.
    if (Object.keys(receipts).length >= 10000) throw new Error('回执容量已满；停止新写入，需升级容量/过老请求拒绝机制');
    transaction = { proj, board, subject };
    try {
      const raw = syncOnly(fn()) || { ok: true };
      const result = require('../core/boardCommand.cjs').publicResult(raw);
      if (result.task) result.task = { id: result.task.id, status: result.task.status, percent: result.task.percent || 0 };
      if (result.tasks) result.tasks = result.tasks.map(t => ({ id: t.id, status: t.status, percent: t.percent || 0 }));
      delete result.board;
      if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024) throw new Error('稳定回执超过上限');
      board.revision = (board.revision || 0) + 1;
      board._commandReceipts = { ...receipts, [key]: { inputHash, revision: board.revision, result } };
      assertValid(board);
      atomicWriteJsonSync(proj.board, board);
      return result;
    } finally { transaction = null; }
  });
}
function inCommandTransaction() { return !!transaction; }
function commandSubject() { return transaction ? transaction.subject : null; }

/**
 * mutate 的"带变更清单"版本：锁内、mutator 前后各抓一次目标卡的快照，比出 changed[]。
 * 写命令的 `--json` 靠它只回变更摘要而不是整卡（AUD-CLI-BRIEF-AND-HELP，审计 §4-A4）。
 * 为什么在锁内比：进程外若有并发写，锁外读到的"改前"根本不是本次动作的起点，changed 会撒谎。
 * @param {object} proj resolveProject 结果
 * @param {string} taskId 这次动的是哪张卡（本次新建的卡也传它，改前快照自然是 null）
 * @param {(board:object)=>void} mutator
 * @param {object|((board:object)=>(object|null))|null} [activityEntry] 同 mutate
 * @returns {{board:object, changed:string[]}}
 */
function mutateTask(proj, taskId, mutator, activityEntry) {
  let changed = [];
  const board = mutate(proj, (b) => {
    const before = snapshotTask(b, taskId);
    syncOnly(mutator(b));
    changed = diffTask(before, snapshotTask(b, taskId));
  }, activityEntry);
  return { board, changed };
}

/** 卡的深拷贝快照；卡不存在返回 null（新建场景）。 */
function snapshotTask(board, taskId) {
  const t = (board.tasks || []).find((x) => x.id === taskId);
  return t ? JSON.parse(JSON.stringify(t)) : null;
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

module.exports = { readBoard, readBoardOrNull, mutate, mutateTask, snapshotTask, findTask, unionBy, unionShas, sameCommit, hasCommit, commandTransaction, inCommandTransaction, commandSubject };
