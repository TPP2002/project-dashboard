'use strict';
/**
 * lock.cjs —— 跨进程文件锁（治本 R9c / R9e）
 *
 * 为什么：多个对话/进程可能同时写同一个 board.json。锁只保证"不写坏 JSON"还不够，
 * 还要保证"不丢逻辑更新"——所以调用方必须【锁内重读 → 改 → 原子写】（见 cli 各命令）。
 * 本模块只负责"同一时刻只有一个进程进临界区"。
 *
 * 实现：fs.openSync(lockPath, 'wx')（O_CREAT|O_EXCL）原子创建锁文件；已存在=有人持锁 →
 * 指数退避重试；锁文件写 pid+ts，检测到【陈旧锁】（持有进程已死或严重超时）则抢占，
 * 避免崩溃残留把大家永久卡死。杀软/OneDrive 抖动由退避吸收。
 */
const fs = require('node:fs');
const { sleepMs } = require('./atomicWrite.cjs');

const STALE_MS = 30_000; // 锁超过此时长且持有进程不在 → 视为陈旧可抢占

/** 进程是否存活（signal 0 只探测不发信号） */
function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM=存在但无权限；ESRCH=不存在
}

/** 判定锁是否陈旧（可抢占） */
function isStaleLock(lockPath) {
  try {
    const { pid, ts } = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (pidAlive(pid)) return (Date.now() - ts) > STALE_MS * 4; // 持有者还活着：仅严重超时才算卡死
    return true; // 持有进程已死 → 陈旧
  } catch {
    // 锁文件读不出/坏了：用 mtime 兜底
    try { return (Date.now() - fs.statSync(lockPath).mtimeMs) > STALE_MS; }
    catch { return true; } // 连 stat 都失败（可能刚被别人删）→ 当可重试
  }
}

/**
 * 在锁保护下同步执行 fn。
 * @param {string} lockPath 锁文件绝对路径（约定 = board 路径 + '.lock'，与 board 同目录同盘）
 * @param {() => any} fn 临界区函数
 * @param {{retries?: number, baseMs?: number}} [opts]
 * @returns fn 的返回值
 */
function withLock(lockPath, fn, opts = {}) {
  const { retries = 100, baseMs = 20 } = opts;
  let fd;
  for (let i = 0; i < retries; i++) {
    try {
      fd = fs.openSync(lockPath, 'wx'); // 原子排他创建
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (isStaleLock(lockPath)) {
        try { fs.unlinkSync(lockPath); } catch { /* 别人抢先删了，继续 */ }
        continue; // 立刻再试
      }
      if (i === retries - 1) break;
      sleepMs(baseMs * Math.min(i + 1, 8) + Math.floor(Math.random() * 10)); // 退避 + 抖动
    }
  }
  if (fd === undefined) {
    throw new Error(`withLock: 获取锁超时（${lockPath}），可能有其他对话正在写入`);
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
  }
}

module.exports = { withLock, isStaleLock, pidAlive };
