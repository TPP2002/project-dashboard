'use strict';
const { createHash } = require('node:crypto');

const hash = value => createHash('sha1').update(value).digest('hex');
const versionOf = snapshotVersion => hash(snapshotVersion).slice(0, 16);

function snapshotBoard(board) {
  const taskHashes = new Map(board.tasks.map(task => [task.id, hash(JSON.stringify(task))]));
  const activity = board.activity || [];
  const prefixes = [hash('')];
  for (const item of activity) prefixes.push(hash(prefixes[prefixes.length - 1] + JSON.stringify(item)));
  return { taskHashes, order: board.tasks.map(task => task.id), activityCount: activity.length, prefixes };
}

function createVersionCache() {
  const paths = new Map();
  return {
    get(path, version) { return paths.get(path)?.get(version); },
    set(path, version, record) {
      let versions = paths.get(path);
      if (!versions) paths.set(path, versions = new Map());
      if (versions.has(version)) return;
      // 相邻版本里没变的卡共用同一个摘要字符串，省掉各版重复的长字符串。
      const previous = [...versions.values()].at(-1);
      if (previous) for (const [id, digest] of record.taskHashes) {
        const shared = previous.taskHashes.get(id);
        if (shared === digest) record.taskHashes.set(id, shared);
      }
      // 只让最新一版留着完整的流水摘要链；更早的版本压成 activityCount 加末尾那一个摘要，
      // makeDelta 把它当 old 用只需要 activityCount、taskHashes 和这个摘要。
      for (const [key, older] of [...versions.entries()]) {
        if (older.compressed) continue;
        const prefixes = [];
        prefixes[older.activityCount] = older.prefixes[older.activityCount];
        versions.set(key, { taskHashes: older.taskHashes, order: older.order,
          activityCount: older.activityCount, prefixes, compressed: true });
      }
      versions.set(version, record);
      if (versions.size > 8) versions.delete(versions.keys().next().value);
    },
  };
}

function makeDelta(old, board, current = snapshotBoard(board)) {
  // 被压过的旧版当 current 传进来时没有完整摘要链，按 board 现算一份再比对。
  if (!current || current.compressed) current = snapshotBoard(board);
  if (current.activityCount < old.activityCount || current.prefixes[old.activityCount] !== old.prefixes[old.activityCount]) return null;
  const { tasks, activity, _commandReceipts, ...rest } = board;
  return { rest, order: current.order, tasks: tasks.filter(task => old.taskHashes.get(task.id) !== current.taskHashes.get(task.id)), activityAppend: (activity || []).slice(old.activityCount) };
}

module.exports = { versionOf, snapshotBoard, createVersionCache, makeDelta };
