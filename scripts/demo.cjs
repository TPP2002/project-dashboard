'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const dir = path.join(os.tmpdir(), `dashboard-demo-${process.pid}`);

console.log('演示实例（示例数据，不碰你的真实看板）');
fs.mkdirSync(dir, { recursive: true });
try {
  execFileSync(process.execPath, ['packaging/demo-seed.cjs', dir], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  });
} catch (error) {
  console.error('演示数据生成失败：' + error.message);
  process.exit(1);
}

const child = spawn(process.execPath, ['server/server.cjs'], {
  cwd: root,
  env: {
    ...process.env,
    DASHBOARD_HOME: dir,
    DASHBOARD_REGISTRY: path.join(dir, 'registry.json'),
    DASHBOARD_PORT: '6099',
    DASHBOARD_MODULES: 'all',
  },
  stdio: 'inherit', windowsHide: true,
});

let stopping = false;
function stop(signal) {
  if (stopping || child.exitCode !== null) return;
  stopping = true;
  child.kill(signal);
}
const interrupt = () => stop('SIGINT');
const terminate = () => stop('SIGTERM');
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
child.once('error', (error) => {
  console.error('演示实例启动失败：' + error.message);
  process.exitCode = 1;
});
child.once('close', (code, signal) => {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
  process.exitCode = stopping ? 0 : (code ?? 1);
});
