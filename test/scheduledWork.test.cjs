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
    exec: async opts => { calls.push(['exec', opts]); return { exitCode: 0 }; },
    cancel: async (id, opts) => { calls.push(['cancel', id, opts]); return { exitCode: 0 }; },
    status: async () => ({ state: 'passed' }),
    ...overrides,
  };
  const opts = { client, signals, log: () => {}, share: '/share', root: '/source', key: 'fixture',
    job: { category: 'unit-test', workType: 'test', cores: 2, title: '全量测试', targets: ['test', 'core'] },
    command: process.execPath, args: ['cli/scheduledWork.cjs', '--granted', 'test'] };
  return { calls, signals, opts };
}

test('一步 exec 带完整挂号参数与真实命令，正常结束不撤单', async () => {
  const { calls, signals, opts } = fixture();
  assert.equal(await runScheduled(opts), 0);
  assert.deepEqual(calls.map(c => c[0]), ['exec']);
  assert.deepEqual(calls[0][1], { share: '/share', root: '/source', project: 'dashboard', key: 'fixture',
    category: 'unit-test', cores: 2, title: '全量测试', workType: 'test', targets: ['test', 'core'],
    engine: 'codex', command: process.execPath,
    args: ['cli/scheduledWork.cjs', '--granted', 'test'] });
  // 不人为钉死机器或版本：codeRef 由 exec 自选（干净仓 commit 快照/脏仓内容指纹），钉死选项一律不传。
  for (const pinned of ['codeRef', 'machines', 'pin', 'local', 'exclusive', 'parent']) {
    assert.equal(pinned in calls[0][1], false, `不得人为传 ${pinned}`);
  }
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});
test('排队失败以异常可见落地：撤单并保留原始退出码', async () => {
  const { calls, opts } = fixture({ exec: async opts => {
    calls.push(['exec', opts]); throw Object.assign(new Error('等待超时'), { exitCode: 4 });
  } });
  await assert.rejects(runScheduled(opts), error => error.exitCode === 4 && /等待超时/.test(error.message));
  assert.deepEqual(calls.map(c => c[0]), ['exec', 'cancel']);
});
test('回执不确定也按确定性单号撤单，不能留僵尸票据', async () => {
  const { calls, opts } = fixture({ exec: async opts => {
    calls.push(['exec', opts]); throw Object.assign(new Error('回执超时'), { exitCode: 4 });
  } });
  await assert.rejects(runScheduled(opts), /回执超时/);
  assert.equal(calls.find(c => c[0] === 'cancel')[1], 'tk-fixture');
});
test('SIGINT 经 cancel 撤单，中断收敛为 130，客户端回报终态后不重复撤单', async () => {
  const { calls, signals, opts } = fixture({ exec: async opts => {
    calls.push(['exec', opts]);
    signals.emit('SIGINT');
    return { exitCode: 5, result: 'cancelled' };
  } });
  assert.equal(await runScheduled(opts), 130);
  assert.equal(calls.filter(c => c[0] === 'cancel').length, 1);
  assert.equal(calls.some(c => c[0] === 'exec'), true);
});
test('排队期中断：客户端以异常落地也返回 130，错误原文可见且撤单只发一次', async () => {
  const warnings = [];
  const { calls, signals, opts } = fixture({ exec: async opts => {
    calls.push(['exec', opts]);
    signals.emit('SIGINT');
    throw Object.assign(new Error('包装进程被中断'), { exitCode: 1 });
  } });
  opts.log = line => warnings.push(line);
  assert.equal(await runScheduled(opts), 130);
  assert.ok(warnings.some(line => line.includes('包装进程被中断')));
  assert.equal(calls.filter(c => c[0] === 'cancel').length, 1);
});
test('被包装任务失败的退出码原样返回；没有有效授予核数就拒跑', async () => {
  const { opts } = fixture({ exec: async () => ({ exitCode: 17 }) });
  assert.equal(await runScheduled(opts), 17);
  assert.equal(checkedCores('2'), 2);
  for (const value of [undefined, '0', '-1', '2.5', 'oops']) assert.throws(() => checkedCores(value), /核数/);
});

test('客户端回报外部已终态（如已被撤单）时透传退出码，不再撤单', async () => {
  const { calls, opts } = fixture({ exec: async opts => {
    calls.push(['exec', opts]); return { exitCode: 5, result: 'cancelled' };
  } });
  assert.equal(await runScheduled(opts), 5);
  assert.deepEqual(calls.map(c => c[0]), ['exec']);
});

test('撤单回执被拒时回查终态；已终态不误报警，仍在跑或读不到状态必须报警', async () => {
  for (const state of ['cancelled', 'passed', 'running', null]) {
    const warnings = [];
    const { opts } = fixture({
      exec: async () => { throw Object.assign(new Error('回执超时'), { exitCode: 4 }); },
      cancel: async () => ({ exitCode: 2, reason: '单子已不在排队中' }),
      status: () => { if (state === null) throw new Error('共享盘不可读'); return { state }; },
    });
    opts.log = line => warnings.push(line);
    await assert.rejects(runScheduled(opts), /回执超时/);
    assert.equal(warnings.some(line => line.includes('撤单未确认')), state === 'running' || state === null);
  }
});

test('全量测试显式列出本仓文件，拒绝覆盖授予并发；构建和类型检查固定单核', () => {
  const root = path.resolve(__dirname, '..');
  const job = scheduledJob('test', root);
  assert.equal(job.args(2)[1], '--test-concurrency=2');
  assert.ok(job.args(2).length > 30);
  assert.ok(job.args(2).slice(2).every(file => /^test\/[^/]+\.test\.cjs$/.test(file)));
  assert.ok(job.targets.includes('packaging'), '打包自检也属于全量测试的受测内容');
  assert.throws(() => scheduledJob('test', root, ['--test-concurrency=20']), /不接受/);
  assert.equal(scheduledJob('typecheck', root).cores, 1);
  assert.equal(scheduledJob('build', root).cores, 1);
  for (const file of ['web/index.html', 'web/env.d.ts', 'web/mock', 'cli']) {
    assert.ok(scheduledJob('build', root).targets.includes(file), `内容指纹不能漏掉构建输入 ${file}`);
  }
});
