'use strict';
/**
 * temp-leak-check.cjs —— 验「指定测试文件跑完，系统临时文件夹里一项都不剩」（TEMP-LEAK-DASH-1123）。
 *
 * 用法：node test/tools/temp-leak-check.cjs <测试文件...>
 *
 * 做法：给这一趟单独建一个空沙箱当 TEMP/TMP/TMPDIR，直跑 `node --test`（不经 scheduledWork，
 * 所以验的是各测试文件自己补的删除）；跑完沙箱里还有东西就算漏。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const files = process.argv.slice(2);
if (files.length < 1) {
  console.log('用法:node test/tools/temp-leak-check.cjs <测试文件...>');
  process.exit(2);
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tlc-'));

/** 删沙箱；删不掉只打一行警告，不改退出码。 */
function dropSandbox() {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    console.log(`[temp-leak-check] 警告:沙箱没删掉:${sandbox} ${error && error.message ? error.message : error}`);
  }
}

const run = spawnSync(process.execPath, ['--test', ...files], {
  cwd: process.cwd(),
  env: { ...process.env, TEMP: sandbox, TMP: sandbox, TMPDIR: sandbox },
  stdio: 'inherit',
  windowsHide: true,
  timeout: 900000,
});

if (run.status !== 0) {
  console.log(`[temp-leak-check] 测试本身没过,退出码 ${run.status === null ? 'null' : run.status}`);
  dropSandbox();
  process.exit(1);
}

const left = fs.readdirSync(sandbox);
if (left.length > 0) {
  console.log(`[temp-leak-check] 测试跑完临时文件夹还剩 ${left.length} 项:`);
  for (const name of left.slice(0, 30)) console.log(name);
  dropSandbox();
  process.exit(1);
}

console.log(`[temp-leak-check] 通过:${files.length} 个测试文件跑完临时文件夹为空`);
dropSandbox();
process.exit(0);
