'use strict';
// schedEtaModelFile.test.cjs —— 只读共享盘的估时模型文件(AD-20261116-SCHED-ETA-LEARN 第三张单)。
// 文件不存在、读坏、不是合法模型都只降级成 { loaded:false, reason },永不抛;按 mtime+大小缓存。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readEtaModelFile } = require('../core/schedEtaModelFile.cjs');
const { createModel, learn, serializeModel, accuracySummary } = require('../core/schedEtaModel.cjs');

const ENDED = '2026-11-16T00:00:00.000Z';

function temporary(t) {
  const base = fs.realpathSync.native(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(base, 'sched-eta-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), base);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
function modelFile(share) {
  return path.join(share, 'sched', '_stats', 'eta-model.json');
}
function writeModel(share, durations) {
  const model = createModel();
  durations.forEach((durationMs, index) => {
    assert.equal(learn(model, { ticketId: `tk-${String(index + 1).padStart(20, '0')}`, attemptId: 'a1',
      project: 'sample', usageKey: null, category: 'unit-test', workType: 'test', args: null,
      machine: 'fixture-worker', cores: 4, durationMs, startMs: null, endedAt: ENDED, ciAware: false }).learned, true);
  });
  fs.mkdirSync(path.dirname(modelFile(share)), { recursive: true });
  fs.writeFileSync(modelFile(share), serializeModel(model));
  return model;
}

test('文件不存在时给出「还没生成」,不抛也不伪装成已加载', t => {
  const share = temporary(t);
  const result = readEtaModelFile(share);
  assert.equal(result.loaded, false);
  assert.match(result.reason, /还没生成/);
  assert.doesNotThrow(() => readEtaModelFile(path.join(share, 'missing-share')));
});

test('读到合法模型:桶数与准确度来自模型本身', t => {
  const share = temporary(t);
  const model = writeModel(share, [8000, 10000, 12000]);
  const result = readEtaModelFile(share);
  assert.equal(result.loaded, true);
  assert.equal(result.buckets, Object.keys(model.buckets).length);
  assert.deepEqual(result.accuracy, accuracySummary(model));
  assert.equal(result.updatedAt, model.updatedAt);
  assert.deepEqual(result.model, model);
});

test('文件没变时返回同一个已解析对象,改了文件才重读', t => {
  const share = temporary(t);
  writeModel(share, [8000, 10000, 12000]);
  const first = readEtaModelFile(share), again = readEtaModelFile(share);
  assert.equal(first.loaded, true);
  assert.equal(again, first, '没变时必须复用上次解析结果');
  const bigger = writeModel(share, [8000, 10000, 12000, 20000]);
  const third = readEtaModelFile(share);
  assert.notEqual(third, first);
  assert.equal(third.buckets, Object.keys(bigger.buckets).length);
  assert.deepEqual(third.accuracy, accuracySummary(bigger));
});

test('坏 JSON 只降级成「读不了」,不抛', t => {
  const share = temporary(t);
  fs.mkdirSync(path.dirname(modelFile(share)), { recursive: true });
  fs.writeFileSync(modelFile(share), '{"schema":1,');
  let result;
  assert.doesNotThrow(() => { result = readEtaModelFile(share); });
  assert.equal(result.loaded, false);
  assert.match(result.reason, /读不了/);
  // 结构对但校验不过(桶样本超过窗口)同样读不了,不冒充合法模型。
  fs.writeFileSync(modelFile(share), JSON.stringify({ schema: 1, updatedAt: null, scale: 1, buckets: {}, starts: {}, recent: [], seen: [] }));
  assert.equal(readEtaModelFile(share).loaded, true);
  fs.writeFileSync(modelFile(share), JSON.stringify({ schema: 2, updatedAt: null, scale: 1, buckets: {}, starts: {}, recent: [], seen: [], format: 'future' }));
  assert.match(readEtaModelFile(share).reason, /读不了/);
});

test('两个共享盘路径的缓存互不串', t => {
  const first = temporary(t), second = temporary(t);
  writeModel(first, [8000, 10000, 12000]);
  const firstRead = readEtaModelFile(first);
  assert.equal(firstRead.loaded, true);
  const secondRead = readEtaModelFile(second);
  assert.equal(secondRead.loaded, false);
  assert.match(secondRead.reason, /还没生成/);
  assert.equal(readEtaModelFile(first), firstRead);
});
