'use strict';
/**
 * testTempRoot.test.cjs —— 重活跑测试的「本轮临时根」（TEMP-LEAK-DASH-1123）。
 *
 * 要钉死的行为：
 *   · 只挑名字以 dash-tr- 开头、且超过六小时的残留来清，按名字字典序；
 *   · tempEnv 把四个临时目录环境变量指到本轮根上，且不改入参；
 *   · removeRunRoot 删不掉只回报原因，不把测试搞红；
 *   · execute 给子进程一个 dash-tr- 开头的本轮根，跑完就把它整个删掉（成功失败都一样）。
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  TEST_TMP_PREFIX, TEST_TMP_ENV, STALE_AFTER_MS,
  staleRunRoots, tempEnv, removeRunRoot,
} = require('../core/testTempRoot.cjs');
const { execute } = require('../cli/scheduledWork.cjs');

const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } };
const tempDirs = [];
const mkTmp = (p) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  tempDirs.push(dir);
  return dir;
};
after(() => { for (const dir of tempDirs.splice(0)) clean(dir); });

test('常量与本轮临时根的命名口径', () => {
  assert.equal(TEST_TMP_PREFIX, 'dash-tr-');
  assert.equal(TEST_TMP_ENV, 'DASH_TEST_TMP_ROOT');
  assert.equal(STALE_AFTER_MS, 6 * 60 * 60 * 1000, '保留期是六小时');
});

test('staleRunRoots：只挑前缀对且超期的，按名字字典序；边界与无前缀都不算', () => {
  const now = 100 * STALE_AFTER_MS;
  const entries = [
    { name: 'dash-tr-bbbbbb', mtimeMs: now - STALE_AFTER_MS - 1 },   // 超期 → 挑
    { name: 'dash-tr-aaaaaa', mtimeMs: now - STALE_AFTER_MS - 5000 }, // 超期 → 挑
    { name: 'dash-tr-cccccc', mtimeMs: now - 1000 },                  // 还新 → 不挑
    { name: 'dash-tr-dddddd', mtimeMs: now - STALE_AFTER_MS },        // 正好六小时 → 不挑
    { name: 'other-eeeeee', mtimeMs: now - STALE_AFTER_MS - 1 },      // 前缀不对 → 不挑
  ];
  assert.deepEqual(staleRunRoots(entries, now), ['dash-tr-aaaaaa', 'dash-tr-bbbbbb']);
  assert.deepEqual(staleRunRoots([], now), []);
});

test('tempEnv：四个键都指到本轮根上，且不改入参', () => {
  const base = {};
  const root = path.join(os.tmpdir(), 'dash-tr-env-sample');
  const out = tempEnv(base, root);
  assert.deepEqual(Object.keys(out).sort(), ['DASH_TEST_TMP_ROOT', 'TEMP', 'TMP', 'TMPDIR'].sort());
  for (const key of ['TEMP', 'TMP', 'TMPDIR', TEST_TMP_ENV]) assert.equal(out[key], root);
  assert.deepEqual(base, {}, '入参必须原样不动');
});

test('removeRunRoot：删除抛错时回报 removed:false 与原因，不往外抛', () => {
  const result = removeRunRoot(path.join(os.tmpdir(), 'not-a-real-dir'), () => { throw new Error('句柄没放'); });
  assert.equal(result.removed, false);
  assert.match(result.error, /句柄没放/);
});

test('execute：子进程拿到 dash-tr- 开头的本轮临时根，返回后整个被删掉', async () => {
  const box = mkTmp('ttr-');
  const resultFile = path.join(box, 'probe.txt');
  const root = path.resolve(__dirname, '..');
  const script = [
    "const fs = require('node:fs');",
    "const os = require('node:os');",
    "const path = require('node:path');",
    `const out = ${JSON.stringify(resultFile)};`,
    "const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));",
    "fs.writeFileSync(path.join(dir, 'x.txt'), 'ok');",
    "fs.writeFileSync(out, dir);",
  ].join('\n');
  const job = { command: process.execPath, args: () => ['-e', script] };
  const code = await execute(job, root, 1);
  assert.equal(code, 0, '假作业应正常退出');
  const childDir = fs.readFileSync(resultFile, 'utf8');
  const runRoot = path.dirname(childDir);
  assert.ok(path.basename(runRoot).startsWith(TEST_TMP_PREFIX), `本轮临时根名应以 ${TEST_TMP_PREFIX} 开头:${runRoot}`);
  assert.equal(fs.existsSync(runRoot), false, 'execute 返回后本轮临时根必须已经删掉');
});
