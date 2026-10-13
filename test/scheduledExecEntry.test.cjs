'use strict';
// 正式工作入口迁移回归：core/cli 的 scheduledWork 必须经现行客户端 exec 一步挂号执行，
// 旧 submit/waitFor/run 生命周期不复存在。mock 只抓边界，不复制客户端实现；
// 真实共享盘、真实许可与退出码由主控独立验收。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { runScheduled } = require('../core/scheduledWork.cjs');
const { main } = require('../cli/scheduledWork.cjs');

const repoRoot = path.resolve(__dirname, '..');
const FIXED_ID = 'tk-entryfixed0000000000';

const MOCK_CLIENT_FILE = [
  "'use strict';",
  'const mock = globalThis.__dashSchedExecMock;',
  'module.exports = {',
  '  deriveTicketId: (project, key) => mock.deriveTicketId(project, key),',
  '  validatePermit: options => mock.validatePermit(options),',
  '  exec: options => mock.exec(options),',
  '  cancel: (id, options) => mock.cancel(id, options),',
  '  status: (id, options) => mock.status(id, options),',
  '  // 旧生命周期接口只在 mock 里保留：新实现不得调用；旧代码要在其上完整跑通，',
  '  // 迁移行为断言（exec 已被调用、参数/退出码迁移）才能真实报红，而不是 mock 缺字段炸掉。',
  '  submit: options => mock.submit(options),',
  '  waitFor: (id, options) => mock.waitFor(id, options),',
  '  run: (id, options) => mock.run(id, options),',
  '};',
].join('\n');

/** 每个用例独立的假共享盘；客户端模块把调用转投给 globalThis 上的 mock，便于逐用例断言。 */
function writeMockShare() {
  const share = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-sched-exec-'));
  fs.mkdirSync(path.join(share, 'sched', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(share, 'sched', 'bin', 'sched.cjs'), MOCK_CLIENT_FILE);
  return share;
}

function mockFor(calls, overrides = {}) {
  const mock = {
    deriveTicketId: (project, key) => { calls.push(['deriveTicketId', project, key]); return FIXED_ID; },
    validatePermit: options => { calls.push(['validatePermit', options]); return { ok: true }; },
    exec: async options => { calls.push(['exec', options]); return { exitCode: 0 }; },
    cancel: async (id, options) => { calls.push(['cancel', id, options]); return { exitCode: 0 }; },
    status: () => ({ state: 'queued' }),
    // 旧生命周期接口：仅供旧源码在其上完整跑通（可正常运行、留调用记录），新实现不会调用它们。
    submit: async options => { calls.push(['submit', options]); return { ticketId: FIXED_ID, exitCode: 0 }; },
    waitFor: async (id, options) => { calls.push(['waitFor', id, options]); return { exitCode: 0 }; },
    run: async (id, options) => { calls.push(['run', id, options]); return { exitCode: 0 }; },
    ...overrides,
  };
  globalThis.__dashSchedExecMock = mock;
  return mock;
}

/** 只动本用例需要的环境变量，结束后一律还原；值为 undefined 表示删除。 */
function withEnv(patch, fn) {
  const saved = {};
  for (const key of Object.keys(patch)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

test('正式入口把真实命令参数经 exec 一步下发：process.execPath + 参数数组，退出码透传', () => {
  const calls = [];
  const share = writeMockShare();
  return withEnv({ SCHED_SHARE: share, SCHED_GRANTED_CORES: undefined, GITHUB_ACTIONS: undefined,
    RUNNER_ENVIRONMENT: undefined }, async () => {
    try {
      mockFor(calls, { exec: async options => { calls.push(['exec', options]); return { exitCode: 17 }; } });
      assert.equal(await main(['typecheck']), 17);
      assert.deepEqual(calls.map(c => c[0]), ['deriveTicketId', 'exec']);
      const options = calls[1][1];
      assert.match(options.key, /^dashboard-typecheck-/);
      assert.deepEqual(calls[0].slice(1), ['dashboard', options.key]);
      assert.equal(options.share, share);
      assert.equal(options.root, repoRoot);
      assert.equal(options.project, 'dashboard');
      assert.equal(options.category, 'other');
      assert.equal(options.workType, 'typecheck');
      assert.equal(options.cores, 1);
      assert.equal(options.title, '看板全量类型检查');
      // 不人为钉死机器或版本：codeRef 由 exec 自选（干净仓 commit 快照/脏仓内容指纹），
      // 任何钉本机/钉版本的选项都不得由入口代传。
      for (const pinned of ['codeRef', 'machines', 'pin', 'local', 'exclusive', 'parent']) {
        assert.equal(pinned in options, false, `不得人为传 ${pinned}`);
      }
      assert.equal(options.engine, 'codex');
      // Windows 下必须 process.execPath + 数组传参，绝不 shell 拼接。
      assert.equal(options.command, process.execPath);
      assert.ok(Array.isArray(options.args) && options.args.every(arg => typeof arg === 'string'));
      assert.deepEqual(options.args,
        [path.join(repoRoot, 'cli', 'scheduledWork.cjs'), '--granted', '--root', repoRoot, 'typecheck']);
      assert.ok(options.targets.includes('web/src'));
      assert.ok(options.targets.includes('web/vite.config.ts'));
    } finally { fs.rmSync(share, { recursive: true, force: true }); }
  });
});

test('没有授予核数就不开跑：--granted 缺 SCHED_GRANTED_CORES 当场拒绝', () => {
  const calls = [];
  const share = writeMockShare();
  return withEnv({ SCHED_SHARE: share, SCHED_GRANTED_CORES: undefined, GITHUB_ACTIONS: undefined,
    RUNNER_ENVIRONMENT: undefined }, async () => {
    try {
      mockFor(calls);
      await assert.rejects(main(['--granted', 'typecheck']), /调度授予核数无效，拒绝开跑/);
      assert.ok(!calls.some(c => c[0] === 'validatePermit' || c[0] === 'exec'));
    } finally { fs.rmSync(share, { recursive: true, force: true }); }
  });
});

test('许可校验拒绝就不开跑；校验参数按 job 类别与授予核数对齐', () => {
  const calls = [];
  const share = writeMockShare();
  return withEnv({ SCHED_SHARE: share, SCHED_GRANTED_CORES: '2', GITHUB_ACTIONS: undefined,
    RUNNER_ENVIRONMENT: undefined }, async () => {
    try {
      mockFor(calls, { validatePermit: options => {
        calls.push(['validatePermit', options]); return { ok: false, reason: '许可核数不够' };
      } });
      await assert.rejects(main(['--granted', 'typecheck']), /调度许可拒绝：许可核数不够/);
      assert.deepEqual(calls.find(c => c[0] === 'validatePermit')[1],
        { share, category: 'other', workTypes: ['typecheck'], cores: 2 });
      assert.ok(!calls.some(c => c[0] === 'exec'));
    } finally { fs.rmSync(share, { recursive: true, force: true }); }
  });
});

test('入口回执不明也按确定性单号撤单，异常带着退出码上抛', () => {
  const calls = [];
  const share = writeMockShare();
  return withEnv({ SCHED_SHARE: share, SCHED_GRANTED_CORES: undefined, GITHUB_ACTIONS: undefined,
    RUNNER_ENVIRONMENT: undefined }, async () => {
    try {
      mockFor(calls, { exec: async () => { throw Object.assign(new Error('回执超时'), { exitCode: 4 }); } });
      await assert.rejects(main(['typecheck']), error => error.exitCode === 4 && /回执超时/.test(error.message));
      assert.deepEqual(calls.filter(c => c[0] === 'cancel'),
        [['cancel', FIXED_ID, { share, reason: '看板任务中断或未能开跑' }]]);
    } finally { fs.rmSync(share, { recursive: true, force: true }); }
  });
});

test('排队/授予间隙收到 SIGINT：撤单只发一次，入口收敛 130，异常原文可见', async () => {
  const calls = [];
  const signals = new EventEmitter(), warnings = [];
  const client = {
    deriveTicketId: (project, key) => { calls.push(['deriveTicketId', project, key]); return FIXED_ID; },
    // 旧生命周期接口仅供旧源码完整跑通（旧路径到不了 exec，信号无从受理，返回值落在 0 ≠ 130）。
    submit: async options => { calls.push(['submit', options]); return { ticketId: FIXED_ID, exitCode: 0 }; },
    waitFor: async (id, options) => { calls.push(['waitFor', id, options]); return { exitCode: 0 }; },
    run: async (id, options) => { calls.push(['run', id, options]); return { exitCode: 0 }; },
    exec: async () => { signals.emit('SIGINT'); throw Object.assign(new Error('包装进程被中断'), { exitCode: 1 }); },
    cancel: async (id, options) => { calls.push(['cancel', id, options]); return { exitCode: 0 }; },
    status: () => ({ state: 'queued' }),
  };
  const code = await runScheduled({ client, signals, log: line => warnings.push(line),
    share: '/share', root: repoRoot, key: 'dashboard-test-sig',
    job: { category: 'unit-test', workType: 'test', cores: 2, title: '看板全量单测', targets: ['test'] },
    command: process.execPath, args: ['cli/scheduledWork.cjs', '--granted', 'test'] });
  assert.equal(code, 130);
  assert.deepEqual(calls.map(c => c[0]), ['deriveTicketId', 'cancel']);
  assert.deepEqual(calls[0].slice(1), ['dashboard', 'dashboard-test-sig']);
  assert.ok(warnings.some(line => line.includes('包装进程被中断')));
});

test('入口拿到客户端回报的外部终态时透传退出码且不再撤单', () => {
  const calls = [];
  const share = writeMockShare();
  return withEnv({ SCHED_SHARE: share, SCHED_GRANTED_CORES: undefined, GITHUB_ACTIONS: undefined,
    RUNNER_ENVIRONMENT: undefined }, async () => {
    try {
      mockFor(calls, { exec: async options => { calls.push(['exec', options]); return { exitCode: 5, result: 'cancelled' }; } });
      assert.equal(await main(['typecheck']), 5);
      assert.deepEqual(calls.map(c => c[0]), ['deriveTicketId', 'exec']);
    } finally { fs.rmSync(share, { recursive: true, force: true }); }
  });
});
