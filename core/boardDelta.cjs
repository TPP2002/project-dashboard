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
      versions.set(version, record);
      if (versions.size > 8) versions.delete(versions.keys().next().value);
    },
  };
}

function makeDelta(old, board, current = snapshotBoard(board)) {
  if (current.activityCount < old.activityCount || current.prefixes[old.activityCount] !== old.prefixes[old.activityCount]) return null;
  const { tasks, activity, _commandReceipts, ...rest } = board;
  return { rest, order: current.order, tasks: tasks.filter(task => old.taskHashes.get(task.id) !== current.taskHashes.get(task.id)), activityAppend: (activity || []).slice(old.activityCount) };
}

module.exports = { versionOf, snapshotBoard, createVersionCache, makeDelta };
