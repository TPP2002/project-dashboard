'use strict';
/** 每次对完整输入计算SHA256，只复用已验证的内容指纹。单目录、64文件/2048字节指纹上限。 */
const { createHash } = require('node:crypto');
const MAX_BYTES = 64 * 32, MAX_FILES = 64;
const fingerprint = raw => createHash('sha256').update(raw).digest();
function createVerifiedBytesCache({ maxBytes = MAX_BYTES, maxFiles = MAX_FILES } = {}) {
  const entries = new Map();
  let directory = null, bytes = 0;
  function remove(file) {
    const old = entries.get(file);
    if (old) { bytes -= old.length; entries.delete(file); }
  }
  return {
    begin(nextDirectory, files) {
      if (directory !== nextDirectory) { entries.clear(); bytes = 0; directory = nextDirectory; }
      const names = new Set(files);
      for (const file of entries.keys()) if (!names.has(file)) remove(file);
    },
    has(file, raw) {
      const old = entries.get(file);
      if (!old || !old.equals(fingerprint(raw))) return false;
      entries.delete(file); entries.set(file, old);
      return true;
    },
    remember(file, raw) {
      remove(file);
      const hash = fingerprint(raw);
      if (hash.length > maxBytes || maxFiles === 0) return;
      while (entries.size >= maxFiles || bytes + hash.length > maxBytes) remove(entries.keys().next().value);
      entries.set(file, hash); bytes += hash.length;
    },
    stats: () => ({ files: entries.size, bytes, maxFiles, maxBytes }),
  };
}
module.exports = { createVerifiedBytesCache, MAX_BYTES, MAX_FILES };
