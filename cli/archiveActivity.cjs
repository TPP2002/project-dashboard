'use strict';
/** 手动按本地月份归档；板的写入仍只经过 store.mutate 的锁、校验与原子写。 */
const fs = require('node:fs');
const path = require('node:path');
const { resolveProject, REGISTRY_PATH } = require('../core/resolveProject.cjs');
const { atomicWriteJsonSync } = require('../core/atomicWrite.cjs');
const { assertValid } = require('../core/boardSchema.cjs');
const { mutate, unionBy } = require('./store.cjs');

function monthStart(before) {
  if (typeof before !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(before)) {
    throw new Error('必须指定 --before <YYYY-MM>，例如 2026-09');
  }
  const [year, month] = before.split('-').map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, 1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function monthOf(date) {
  return String(date.getFullYear()).padStart(4, '0') + String(date.getMonth() + 1).padStart(2, '0');
}

function readArchive(file) {
  let items;
  try { items = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  if (!Array.isArray(items)) throw new Error(`归档应为 JSON 数组：${file}`);
  return items;
}

/** 先写归档再删板内旧条目；中途失败板仍保留原记录，重跑以同一去重键安全续写。 */
function archiveActivity(flags) {
  const cutoff = monthStart(flags.before);
  const proj = resolveProject(flags.project, {
    registryPath: flags.registry ? path.resolve(flags.registry) : REGISTRY_PATH,
  });
  // mutate 正常返回一定会刷 updatedAt；仅此私有哨兵退出可避免无操作时改写板。
  const noActivity = Symbol('no activity to archive');
  let moved = 0;
  let files = [];
  try {
    mutate(proj, (board) => {
      assertValid(board);
      const months = new Map();
      const kept = [];
      for (const item of board.activity || []) {
        const date = new Date(item.ts);
        if (!item.ts || !(date.getTime() < cutoff)) { kept.push(item); continue; }
        const month = monthOf(date);
        if (!months.has(month)) months.set(month, []);
        months.get(month).push(item);
        moved++;
      }
      if (!moved) throw noActivity;
      // 先读齐并校验所有目标文件，坏归档不触发任何内容写入。
      const plans = [...months.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, items]) => {
        const file = path.join(path.dirname(proj.board), `activity-${month}.json`);
        const merged = unionBy([...readArchive(file), ...items], (a) => JSON.stringify([a.ts, a.taskId, a.text]));
        merged.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
        return { file, items: merged, count: items.length };
      });
      for (const plan of plans) atomicWriteJsonSync(plan.file, plan.items);
      files = plans.map(({ file, count }) => ({ path: file, count }));
      board.activity = kept;
    });
  } catch (e) {
    if (e !== noActivity) throw e;
  }
  return {
    ok: true, moved, files,
    text: moved
      ? `已归档 ${moved} 条活动：\n` + files.map((f) => `  ${f.path}（搬入 ${f.count} 条）`).join('\n')
      : '没有可归档的活动，未改动任何文件。',
  };
}

module.exports = { archiveActivity };
