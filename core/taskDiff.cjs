'use strict';
/**
 * taskDiff.cjs —— 比对同一张卡的前后快照,给出"到底动了哪些字段"(AUD-CLI-BRIEF-AND-HELP)。
 *
 * 写命令的 `--json` 只回 {ok,id,status,percent,changed[]};changed 必须是**比出来的**,
 * 不是各命令自己声明的——自报会随实现漂移(改了实现忘了改声明,调用方就被骗)。
 * 纯函数、零依赖,单独成文件是为了能脱离锁与文件系统直接测。
 */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
/** 值相等判定:同一张卡就地改出来的前后快照,键序稳定,序列化比对足够且最简。 */
function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * @param {object|null} before 改之前的卡(卡是本次新建的就传 null)
 * @param {object|null} after 改之后的卡
 * @returns {string[]} 变了的字段名;对象字段下钻一级(如 `dates.start`),数组按整体算一处
 */
function diffTask(before, after) {
  if (!before) return after ? ['created'] : [];
  if (!after) return ['removed'];
  const out = [];
  for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (sameValue(before[k], after[k])) continue;
    if (isPlainObject(before[k]) && isPlainObject(after[k])) {
      const subKeys = [...new Set([...Object.keys(before[k]), ...Object.keys(after[k])])].sort();
      for (const s of subKeys) if (!sameValue(before[k][s], after[k][s])) out.push(`${k}.${s}`);
    } else {
      out.push(k);
    }
  }
  return out;
}

module.exports = { diffTask };
