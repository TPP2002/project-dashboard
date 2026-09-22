'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { runScheduled, checkedCores } = require('../core/scheduledWork.cjs');
const { scheduledJob } = require('../core/scheduledJobs.cjs');
const path = require('node:path');

function fixture(overrides = {}) {
  const calls = [], signals = new EventEmitter();
  const client = {
    deriveTicketId: () => 'tk-fixture',
    submit: async opts => { calls.push(['submit', opts]); return { ticketId: 'tk-fixture', exitCode: 0 }; },
    waitFor: async (id, opts) => { calls.push(['wait', id, opts]); return { exitCode: 0 }; },
    run: async (id, opts) => { calls.push(['run', id, opts]); return { exitCode: 0 }; },
    cancel: async (id, opts) => { calls.push(['cancel', id, opts]); return { exitCode: 0 }; },
    ...overrides,
  };
  const opts = { client, signals, log: () => {}, share: '/share', root: '/source', key: 'fixture',
    job: { category: 'unit-test', workType: 'test', cores: 2, title: '全量测试', targets: ['test', 'core'] },
    command: process.execPath, args: ['cli/scheduledWork.cjs', '--granted', 'test'] };
  return { calls, signals, opts };
}

test('完整挂号参数、授予后包装运行，正常结束不撤单', async () => {
  const { calls, signals, opts } = fixture();
  assert.equal(await runScheduled(opts), 0);
  assert.deepEqual(calls.map(c => c[0]), ['submit', 'wait', 'run']);
  assert.deepEqual(calls[0][1], { share: '/share', root: '/source', project: 'dashboard', key: 'fixture',
    category: 'unit-test', cores: 2, title: '全量测试', workType: 'test', targets: ['test', 'core'], codeRef: 'content:auto', engine: 'codex' });
  assert.equal(calls[1][2].until, 'granted');
  assert.equal(signals.listenerCount('SIGINT'), 0);
});
test('未获授予绝不开跑，超时或失败撤单并保留原始退出码', async () => {
  const { calls, opts } = fixture({ waitFor: async () => ({ exitCode: 4 }) });
  assert.equal(await runScheduled(opts), 4);
  assert.deepEqual(calls.map(c => c[0]), ['submit', 'cancel']);
});
test('回执不确定也按确定性单号撤单，不能留僵尸票据', async () => {
  const { calls, opts } = fixture({ submit: async () => { throw Object.assign(new Error('回执超时'), { exitCode: 4 }); } });
  await assert.rejects(runScheduled(opts), /回执超时/);
  assert.equal(calls[0][0], 'cancel');
  assert.equal(calls[0][1], 'tk-fixture');
});
test('SIGINT 经 cancel 撤单，授予返回后也不开跑', async () => {
  const { calls, signals, opts } = fixture();
  opts.client.waitFor = async () => { signals.emit('SIGINT'); return { exitCode: 5 }; };
  assert.equal(await runScheduled(opts), 130);
  assert.equal(calls.filter(c => c[0] === 'cancel').length, 1);
  assert.equal(calls.some(c => c[0] === 'run'), false);
});
test('被包装任务失败的退出码原样返回；没有有效授予核数就拒跑', async () => {
  const { opts } = fixture({ run: async () => ({ exitCode: 17 }) });
  assert.equal(await runScheduled(opts), 17);
  assert.equal(checkedCores('2'), 2);
  for (const value of [undefined, '0', '-1', '2.5', 'oops']) assert.throws(() => checkedCores(value), /核数/);
});

test('全量测试显式列出本仓文件，拒绝覆盖授予并发；构建和类型检查固定单核', () => {
  const root = path.resolve(__dirname, '..');
  const job = scheduledJob('test', root);
  assert.equal(job.args(2)[1], '--test-concurrency=2');
  assert.ok(job.args(2).length > 30);
  assert.ok(job.args(2).slice(2).every(file => /^test\/[^/]+\.test\.cjs$/.test(file)));
  assert.throws(() => scheduledJob('test', root, ['--test-concurrency=20']), /不接受/);
  assert.equal(scheduledJob('typecheck', root).cores, 1);
  assert.equal(scheduledJob('build', root).cores, 1);
});
