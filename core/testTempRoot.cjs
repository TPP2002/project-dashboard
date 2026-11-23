'use strict';
/**
 * testTempRoot.cjs —— 重活跑测试时的「本轮临时根」。
 *
 * 病根（TEMP-LEAK-DASH-1123）：各仓测试在系统临时文件夹里建目录却不删，一天能攒几百万个，
 * Windows 登录时逐个过一遍用户配置文件，卡在「请稍候」半小时到几小时。
 *
 * 治法：整套测试的入口给每个重活发一个 <系统临时文件夹>/dash-tr-XXXXXX，
 * 把 TEMP/TMP/TMPDIR 指过去，跑完整个删掉；开跑前顺手清掉六个小时以前的残留
 * （进程被强杀时来不及删的那批）。
 */
const fs = require('node:fs');
const path = require('node:path');

const TEST_TMP_PREFIX = 'dash-tr-';
const TEST_TMP_ENV = 'DASH_TEST_TMP_ROOT';
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** 从目录项里挑出「名字是本轮临时根、且已超过保留期」的，按名字字典序返回名字。 */
function staleRunRoots(entries, nowMs) {
  return (entries || [])
    .filter((entry) => entry && typeof entry.name === 'string'
      && entry.name.startsWith(TEST_TMP_PREFIX)
      && nowMs - entry.mtimeMs > STALE_AFTER_MS)
    .map((entry) => entry.name)
    .sort();
}

/** 在 base 原有键之上，把四个临时目录环境变量指到 root；不改入参。 */
function tempEnv(base, root) {
  return { ...(base || {}), TEMP: root, TMP: root, TMPDIR: root, [TEST_TMP_ENV]: root };
}

/** 删一个本轮临时根；删不掉只回报原因，不抛。 */
function removeRunRoot(dir, rm) {
  const remove = rm || ((target) => fs.rmSync(target, {
    recursive: true, force: true, maxRetries: 10, retryDelay: 200,
  }));
  try {
    remove(dir);
    return { removed: true };
  } catch (error) {
    return { removed: false, error: error && error.message ? error.message : String(error) };
  }
}

/** 清掉 base 下超过保留期的本轮临时根；返回没删掉的 [{ path, error }]。 */
function sweepStaleRunRoots(base) {
  let entries = [];
  try {
    for (const item of fs.readdirSync(base, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const full = path.join(base, item.name);
      try {
        entries.push({ name: item.name, mtimeMs: fs.statSync(full).mtimeMs });
      } catch { /* 刚被别的进程删掉，不算残留 */ }
    }
  } catch { /* base 读不到就当没有残留 */ }
  const failed = [];
  for (const name of staleRunRoots(entries, Date.now())) {
    const full = path.join(base, name);
    const result = removeRunRoot(full);
    if (!result.removed) failed.push({ path: full, error: result.error });
  }
  return failed;
}

/** 在 base 下建一个本轮临时根。 */
function createRunRoot(base) {
  return fs.mkdtempSync(path.join(base, TEST_TMP_PREFIX));
}

module.exports = {
  TEST_TMP_PREFIX,
  TEST_TMP_ENV,
  STALE_AFTER_MS,
  staleRunRoots,
  tempEnv,
  removeRunRoot,
  sweepStaleRunRoots,
  createRunRoot,
};
