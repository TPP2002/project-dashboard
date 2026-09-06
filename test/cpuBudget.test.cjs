'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function temporaryHome(t) {
  const base = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(base, 'cpu-budget-'));
  t.after(() => {
    assert.equal(path.dirname(dir), base, '只清理本测试直接创建的 TEMP 子目录');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** 独立进程隔离模块缓存与本机配置；固定硬件输入，只调用真实模块的只读接口。 */
function readBudget(dataRoot, overrides = {}, hostname = 'worker-b') {
  const configKeys = ['DASHBOARD_HOME', 'CPU_LEASE_DIR', 'CPU_DEDICATED_HOSTS', 'CPU_QUOTA_PCT'];
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !configKeys.includes(key.toUpperCase())));
  const source = `
    const os = require('node:os');
    os.hostname = () => ${JSON.stringify(hostname)};
    os.availableParallelism = () => 20;
    const budget = require('./core/cpuBudget.cjs');
    console.log(JSON.stringify({ leaseDir: budget.LEASE_DIR, quota: budget.cpuStatus().quota }));
  `;
  const result = spawnSync(process.execPath, ['-e', source], {
    cwd: ROOT,
    env: { ...env, DASHBOARD_HOME: dataRoot, ...overrides },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('CPU_LEASE_DIR: 环境变量优先，未设或空值时使用数据根的通用默认目录', (t) => {
  const dataRoot = temporaryHome(t);
  const custom = path.join(dataRoot, 'custom-leases');
  assert.equal(readBudget(dataRoot, { CPU_LEASE_DIR: custom }).leaseDir, custom);
  assert.equal(readBudget(dataRoot).leaseDir, path.join(dataRoot, '.cpu-leases'));
  assert.equal(readBudget(dataRoot, { CPU_LEASE_DIR: '' }).leaseDir, path.join(dataRoot, '.cpu-leases'));
});

test('CPU_DEDICATED_HOSTS: 默认空集，分号或逗号分隔且主机名比对忽略大小写和空白', (t) => {
  const dataRoot = temporaryHome(t);
  assert.equal(readBudget(dataRoot).quota, 17);
  assert.equal(readBudget(dataRoot, { CPU_DEDICATED_HOSTS: '' }).quota, 17);
  assert.equal(readBudget(dataRoot, { CPU_DEDICATED_HOSTS: ' ; , ' }).quota, 17);
  assert.equal(readBudget(dataRoot, { CPU_DEDICATED_HOSTS: 'worker-other' }).quota, 17);
  for (const hosts of [' worker-a ; WoRkEr-B ', ' worker-a , WoRkEr-B ', ' ; worker-a, WoRkEr-B ;, ']) {
    assert.equal(readBudget(dataRoot, { CPU_DEDICATED_HOSTS: hosts }, ' wOrKeR-b ').quota, 20);
  }
});
