'use strict';
/**
 * safePath.cjs —— 路径安全（治本 R4）
 *
 * 1) normalizeReal：用 fs.realpathSync.native 规范化路径（解 junction/symlink、统一
 *    Windows 盘符大小写 f:\game → F:\game）。一切进锁/registry/比对的路径先过它，
 *    避免 F:\Game 与 f:\game 被当成两个 project、两把锁 → 双写。
 * 2) resolveInsideRoot：把用户输入解析进白名单根内，用 realpath + path.relative 判逃逸
 *    （不用 startsWith —— startsWith("F:\game") 会被 F:\game-evil 骗过；且 junction 会
 *    让 startsWith 检查通过、实际指向 root 外）。/api/doc 等按用户输入拼路径的入口必走它。
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * realpath 规范化；对【尚不存在】的路径，逐级向上解析已存在的祖先再拼回
 * （doc 请求的文件可能即将生成，不能因 ENOENT 就误判）。
 */
function normalizeReal(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      const realBase = fs.realpathSync.native(cur);
      return tail.length ? path.join(realBase, ...tail) : realBase;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const parent = path.dirname(cur);
      if (parent === cur) return path.join(cur, ...tail); // 到根仍不存在
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * 把 userRelPath 解析进 root 内；逃逸/非法返回 null。
 * @param {string} root 白名单根（内部会 normalizeReal）
 * @param {string} userRelPath 用户输入的相对路径
 * @returns {string|null} 规范化后的绝对路径，或 null
 */
function resolveInsideRoot(root, userRelPath) {
  if (typeof userRelPath !== 'string' || userRelPath.includes('\0')) return null;
  const realRoot = normalizeReal(root);
  const cleaned = userRelPath.replace(/^[\\/]+/, ''); // 去开头斜杠，避免被当绝对路径
  const joined = path.resolve(realRoot, cleaned);
  const real = normalizeReal(joined);
  const rel = path.relative(realRoot, real);
  const escapes = rel !== '' && (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel));
  return escapes ? null : real;
}

module.exports = { normalizeReal, resolveInsideRoot };
