'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** 本仓现有重活菜单；新增 e2e/跑分入口时必须在此声明类别、受测路径和并发上限。 */
function scheduledJob(name, root, extra = []) {
  const web = path.join(root, 'web');
  if (name === 'test' && extra.some(arg => arg.startsWith('--test-concurrency'))) {
    throw new Error('测试并发由调度许可控制，不接受 --test-concurrency 覆盖');
  }
  const jobs = {
    test: { category: 'unit-test', workType: 'test', cores: 2, title: '看板全量单测',
      command: process.execPath, args: cores => ['--test', `--test-concurrency=${cores}`, ...(extra.length ? extra :
        fs.readdirSync(path.join(root, 'test')).filter(file => file.endsWith('.test.cjs')).sort().map(file => `test/${file}`))] },
    typecheck: { category: 'other', workType: 'typecheck', cores: 1, title: '看板全量类型检查',
      command: process.execPath, cwd: web, args: () => [path.join(web, 'node_modules/vue-tsc/bin/vue-tsc.js'), '--noEmit', ...extra] },
    build: { category: 'other', workType: 'build', cores: 1, title: '看板前端构建',
      command: process.execPath, cwd: web, args: () => [path.join(web, 'node_modules/vite/bin/vite.js'), 'build', ...extra] },
  };
  const job = jobs[name];
  if (!job) throw new Error(`未知重活 ${name}；支持 test / typecheck / build`);
  // 不把 node_modules、dist、日志和其他工位纳入内容指纹。
  const inputs = ['core', 'web/src', 'web/public', 'web/tests', 'web/package.json', 'web/package-lock.json',
    'web/vite.config.ts', 'web/tsconfig.json', 'web/tsconfig.node.json'];
  if (name === 'test') inputs.push('cli', 'server', 'scripts', 'test', 'package.json', 'package-lock.json');
  return { ...job, targets: inputs.filter(file => fs.existsSync(path.join(root, file))) };
}
module.exports = { scheduledJob };
