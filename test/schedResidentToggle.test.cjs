'use strict';
// schedResidentToggle.test.cjs —— npm test/Windows CI 的包装入口(AD-20261116-SCHED-HIDE-RESIDENT)。
// 前端断言正文在 web/tests/schedResidentToggle.check.mts(node --import tsx --test 直跑,写法对齐
// test/schedTicketLabel.test.cjs);这里按本仓 node:test 包装 TS 的既有形式(spawnSync + tsx)
// 把那份断言真正接进全量单测。内层定向跑显式 --test-concurrency=1,遵守本仓定向检查的并发规矩。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const CHECK = path.join(REPO_ROOT, 'web', 'tests', 'schedResidentToggle.check.mts');

test('调度台「显示常驻占用」开关前端断言(默认收起常驻单 + 选择记在浏览器)在 tsx 下全部成立', () => {
  // 本文件本身就是 node --test 的子进程;继承下来的 NODE_TEST_CONTEXT 会把内层跑法表的报告
  // 拐进不存在的父通道(stdout 空、退出码却为 0)。摘掉它,并把报告器钉死成 tap,
  // 内层才是一次真正独立、输出可断言的全绿判定。
  const env = { ...process.env, NODE_NO_WARNINGS: '1' };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath,
    ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', CHECK], {
      cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true, timeout: 120_000, env,
    });
  const output = (result.stdout || '') + (result.stderr || '');
  assert.equal(result.status, 0,
    'web/tests/schedResidentToggle.check.mts 未全绿:\n' + (result.error?.message || '') + '\n' + output);
  const pass = /# pass (\d+)/.exec(output);
  assert.ok(pass !== null && Number(pass[1]) >= 8, '前端断言没有真正跑起来(tap 未见通过数):\n' + output);
});
