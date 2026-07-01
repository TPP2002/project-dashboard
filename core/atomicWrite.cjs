'use strict';
/**
 * atomicWrite.cjs —— 全项目唯一的"写盘"函数（治本 R1 / R9e）
 *
 * 为什么存在：Windows 的 fs.renameSync 在【目标已存在】时会抛 EPERM/EEXIST
 * （POSIX 的 rename 覆盖原子语义在 Windows 上不成立）。而 board.json 每次更新时
 * 目标都已存在 —— 直接 fs.renameSync 会"第一次写就崩"。这里用
 *   写临时文件 → fsync → rename（失败则 unlink 目标后重试）→ 指数退避
 * 把它做稳，并在杀软/OneDrive/编辑器短暂持句柄（EBUSY/EPERM/EACCES）下靠重试兜底。
 *
 * 铁律（方案第七节）：全项目【禁止裸 fs.writeFileSync】写 board/registry/派生文件，
 * 一律走本函数；临时文件必须与目标【同目录同盘】（跨卷 rename 非原子）。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 同步忙等 sleep（CLI 是短命进程，无事件循环压力，忙等最简单可靠） */
function sleepMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

/**
 * 原子写文件（写临时文件再 rename 覆盖）。
 * @param {string} destPath 目标绝对路径
 * @param {string|Buffer} data 要写入的内容
 * @param {{fsyncData?: boolean, retries?: number}} [opts]
 *   fsyncData: 是否 fsync 数据（board 是账本，默认 true 防崩溃残半 JSON）
 *   retries:   rename 失败重试次数（默认 5）
 */
function atomicWriteFileSync(destPath, data, opts = {}) {
  const { fsyncData = true, retries = 5 } = opts;
  const dir = path.dirname(destPath);
  const base = path.basename(destPath);
  // 临时名：同目录 + pid + 高精度时间 + 随机，避免多进程/多对话 tmp 互踩；前缀 . 便于 doctor 扫遗孤
  const tmp = path.join(
    dir,
    `.${base}.tmp-${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
  );

  let lastErr;
  try {
    // 1) 写临时文件并 fsync（保证数据真正落盘，崩溃不残半包）
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, data);
      if (fsyncData) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    // 2) rename 到目标；Windows 目标已存在会抛 EPERM/EEXIST → unlink 后重试 + 指数退避
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        fs.renameSync(tmp, destPath);
        return; // 成功
      } catch (err) {
        lastErr = err;
        if (['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
          // 唯一写者（board 单点写 + 文件锁串行，见 lock.cjs）→ 删目标再 rename 安全
          try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch { /* 下轮再试 */ }
          if (attempt < retries - 1) {
            sleepMs(15 * (2 ** attempt) + Math.floor(Math.random() * 10)); // 15/30/60/120ms + 抖动
          }
          continue;
        }
        throw err; // 非占用类错误直接抛
      }
    }
    throw lastErr;
  } finally {
    // 3) 清理残留临时文件（rename 成功后 tmp 已不存在；失败路径要清掉）
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** 原子写 JSON（统一 2 空格缩进 + 末尾换行）。 */
function atomicWriteJsonSync(destPath, obj, opts) {
  atomicWriteFileSync(destPath, JSON.stringify(obj, null, 2) + '\n', opts);
}

module.exports = { atomicWriteFileSync, atomicWriteJsonSync, sleepMs };
