'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const v8 = require('node:v8');
const vm = require('node:vm');
const { createCiBoardsReader } = require('../core/schedCiBoards.cjs');
const { snapshotBoard, createVersionCache, makeDelta } = require('../core/boardDelta.cjs');

// 取回收函数：开 --expose-gc 后在新上下文里拿 gc；每次读数前连收两次，读 heapUsed + external。
v8.setFlagsFromString('--expose-gc');
const collect = vm.runInNewContext('gc');
const liveHeap = () => {
  collect();
  collect();
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.external;
};

const REMOTE = 'git@github.com:o/r.git';
const BOARD_PATH = '/repo/.dashboard/board.json';
const readerOptions = () => ({
  registryPath: 'registry',
  readRegistry: () => ({ projects: { a: {} } }),
  resolveProject: id => ({ id, board: BOARD_PATH }),
  now: () => 0,
  log: () => {},
  runFile: (_file, _args, _options, callback) => callback(null, REMOTE),
});

test('读板器每项只留仓库名与卡片的标题和分支', async () => {
  const boardText = JSON.stringify({
    project: { id: 'demo' },
    tasks: [
      { plainTitle: '卡甲', gitBranch: ['feature/a', '', 123, 'feature/b'], desc: '说明', steps: ['一步'], notes: '备注' },
      { desc: '卡乙没有标题', gitBranch: ['feature/x'] },
      { plainTitle: '卡丙', gitBranch: 'feature/c' },
      { plainTitle: '', gitBranch: ['feature/d'] },
      { plainTitle: '卡戊', gitBranch: ['feature/c'] },
    ],
    activity: [{ text: '一条流水' }],
  });
  const reader = createCiBoardsReader({ ...readerOptions(),
    fs: { promises: { stat: async () => ({ mtimeMs: 1, size: boardText.length }), readFile: async () => boardText } } });
  assert.deepEqual(await reader.readBoards(), [{
    repository: 'o/r',
    tasks: [
      { plainTitle: '卡甲', gitBranch: ['feature/a', 'feature/b'] },
      { plainTitle: '卡戊', gitBranch: ['feature/c'] },
    ],
  }]);
});

test('读板器读完约 4MB 的整块板不留整块解析结果', async () => {
  const buildText = () => {
    const tasks = [];
    for (let i = 0; i < 1000; i++) {
      const task = { desc: 'd'.repeat(2000), steps: ['步骤一', '步骤二', '步骤三'], notes: 'n'.repeat(200) };
      if (i % 2 === 0) { task.plainTitle = '标题-' + i; task.gitBranch = ['feature/' + i]; }
      tasks.push(task);
    }
    const activity = [];
    for (let i = 0; i < 5000; i++) activity.push({ text: 'a'.repeat(200) });
    return JSON.stringify({ project: { id: 'demo' }, tasks, activity });
  };
  const reader = createCiBoardsReader({ ...readerOptions(),
    fs: { promises: { stat: async () => ({ mtimeMs: 1, size: 4_000_000 }), readFile: async () => buildText() } } });
  const before = liveHeap();
  await reader.readBoards();
  const growth = liveHeap() - before;
  assert.ok(growth <= 400 * 1024, `读板器留存 ${growth} 字节，超过 400KB`);
});

test('版本缓存 8 版合起来只占一条流水摘要链', () => {
  const cache = createVersionCache();
  const buildBoard = (version) => {
    const tasks = [];
    for (let i = 0; i < 2000; i++) {
      tasks.push({ id: 't' + i, title: i === version - 1 ? 'changed-' + version : 'title-' + i, desc: 'd'.repeat(300) });
    }
    const activity = [];
    for (let i = 0; i < 20000; i++) activity.push({ ts: '2026-01-01T00:00:00.000Z', taskId: 't' + (i % 2000), text: 'a'.repeat(160) });
    for (let i = 0; i < version; i++) activity.push({ ts: '2026-02-01T00:00:00.000Z', taskId: 't' + i, text: 'plus-' + i });
    return { project: { id: 'demo' }, tasks, activity };
  };
  const setVersion = (version) => {
    const board = buildBoard(version);
    cache.set('demo', String(version), snapshotBoard(board));
  };
  const before = liveHeap();
  for (let version = 1; version <= 8; version++) setVersion(version);
  const growth = liveHeap() - before;
  assert.ok(growth <= 4 * 1024 * 1024, `版本缓存留存 ${growth} 字节，超过 4MB`);
});

test('压过的版本当 old 或 current 都与现算逐项相等', () => {
  const cache = createVersionCache();
  const buildBase = () => {
    const tasks = [];
    for (let i = 0; i < 60; i++) tasks.push({ id: 'task-' + i, title: 'title-' + i });
    const activity = [];
    for (let i = 0; i < 300; i++) activity.push({ text: 'log-' + i });
    return { project: { id: 'demo' }, tasks, activity };
  };
  const boards = [buildBase()];
  for (let v = 1; v < 8; v++) {
    const previous = boards[v - 1];
    const tasks = previous.tasks.map(task => ({ ...task }));
    tasks[v % tasks.length].title = 'changed-' + v;
    tasks.splice(tasks.length - 1, 1);
    tasks.push({ id: 'task-new-' + v, title: 'new-' + v });
    const activity = previous.activity.concat([{ text: 'log-plus-a-' + v }, { text: 'log-plus-b-' + v }]);
    boards.push({ ...previous, tasks, activity });
  }
  for (let v = 0; v < 8; v++) cache.set('demo', String(v), snapshotBoard(boards[v]));
  for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) {
    const viaCache = makeDelta(cache.get('demo', String(a)), boards[b], cache.get('demo', String(b)));
    const fresh = makeDelta(snapshotBoard(boards[a]), boards[b], snapshotBoard(boards[b]));
    assert.deepEqual(viaCache, fresh, `第 ${a} 版到第 ${b} 版`);
  }
  const cut = Math.floor(boards[3].activity.length / 2);
  const inserted = { ...boards[3], activity: [
    ...boards[3].activity.slice(0, cut),
    { text: 'inserted-in-the-middle' },
    ...boards[3].activity.slice(cut),
  ] };
  assert.equal(makeDelta(snapshotBoard(boards[3]), inserted), null);
  const middleCache = createVersionCache();
  middleCache.set('demo', 'base', snapshotBoard(boards[3]));
  middleCache.set('demo', 'insert', snapshotBoard(inserted));
  middleCache.set('demo', 'newer', snapshotBoard(boards[5]));
  assert.equal(makeDelta(middleCache.get('demo', 'base'), inserted, middleCache.get('demo', 'insert')), null);
});
