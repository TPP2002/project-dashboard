'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCiBoardsReader } = require('../core/schedCiBoards.cjs');

test('板未变不重读，远端缓存十分钟，变更后读取', async () => {
  let time = 0, mtimeMs = 1, reads = 0, calls = 0;
  const reader = createCiBoardsReader({ registryPath: 'registry', readRegistry: () => ({ projects: { a: {} } }),
    resolveProject: id => ({ id, board: '/repo/.dashboard/board.json' }), now: () => time,
    fs: { promises: { stat: async () => ({ mtimeMs, size: 10 }), readFile: async () => { reads++; return '{"tasks":[]}'; } } },
    runFile: (_file, _args, options, cb) => { calls++; assert.equal(options.windowsHide, true); cb(null, 'git@github.com:o/r.git'); }, log: () => {} });
  assert.equal((await reader.readBoards())[0].repository, 'o/r');
  await reader.readBoards(); assert.equal(reads, 1); assert.equal(calls, 1);
  mtimeMs++; await reader.readBoards(); assert.equal(reads, 2); assert.equal(calls, 1);
  time = 600000; await reader.readBoards(); assert.equal(calls, 2);
});

test('没有 origin 的结果和日志去重', async () => {
  let time = 0, calls = 0; const logs = [];
  const reader = createCiBoardsReader({ registryPath: 'registry', readRegistry: () => ({ projects: { a: {} } }),
    resolveProject: id => ({ id, board: '/repo/.dashboard/board.json' }), now: () => time,
    fs: { promises: { stat: async () => ({ mtimeMs: 1, size: 1 }), readFile: async () => '{"tasks":[]}' } },
    runFile: (_file, _args, _options, cb) => { calls++; cb(new Error('No such remote')); }, log: message => logs.push(message) });
  await reader.readBoards(); await reader.readBoards(); assert.equal(calls, 1); assert.equal(logs.length, 1);
  time = 600000; await reader.readBoards(); assert.equal(calls, 2); assert.equal(logs.length, 1);
});
