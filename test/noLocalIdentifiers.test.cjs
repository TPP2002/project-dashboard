'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TextDecoder } = require('node:util');
const { DASHBOARD_HOME } = require('../core/resolveProject.cjs');

const ROOT = path.resolve(__dirname, '..');
const BINARY_EXTENSIONS = new Set(['.png', '.pdf', '.ico', '.exe']);
const FORBIDDEN_FILE = path.join(DASHBOARD_HOME, 'opensource-forbidden.txt');
const MAIN_TEST = 'A2: 全部被 git 跟踪的文本文件不含本机路径、项目显示名或主机名';
// 合成无命中夹具，避免扫描测试自身时命中夹具的源码字面量。
const ABSENT_TOKEN = ['zzz', 'not-in-this-repo', 'zzz'].join('-');
const TEXT_ALLOWLIST = new Map([
  // 本仓的公开 clone 地址保留；只放行地址本身，README 的其它内容仍扫描。
  ['README.md', ['https://github.com/TPP2002/project-dashboard.git']],
]);

function readForbiddenTokens(file = FORBIDDEN_FILE) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
    return text.split(/\r?\n/).map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch {
    // 名单为可选的本机数据；读取或解码失败统一交由主用例 skip。
    return [];
  }
}

function readTrackedTextFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const files = result.stdout.split('\0').filter(Boolean);
  assert.ok(files.length > 0, 'git ls-files 必须实际返回被跟踪文件');
  return files.filter((file) => !BINARY_EXTENSIONS.has(path.extname(file).toLowerCase()))
    .map((file) => ({ file, content: fs.readFileSync(path.join(ROOT, file), 'utf8') }));
}

function findViolations(tokens, files) {
  const violations = [];
  for (let { file, content } of files) {
    for (const allowed of TEXT_ALLOWLIST.get(file) || []) content = content.replaceAll(allowed, '');
    // 同时识别源码/JSON 中的反斜杠转义，不让同一路径换个写法就绕过断言。
    const normalized = content.replace(/\\+/g, '\\').toLowerCase();
    for (const identifier of tokens) {
      if (normalized.includes(identifier.toLowerCase())) violations.push(`${file}: ${identifier}`);
    }
  }
  return violations;
}

test(MAIN_TEST, (t) => {
  const tokens = readForbiddenTokens();
  if (tokens.length === 0) {
    t.diagnostic(`期望名单文件：${FORBIDDEN_FILE}；名单本身就是要防的东西，写进公开仓等于把它发布出去。`);
    t.skip('名单不存在、为空、不可读或不是有效 UTF-8');
    return;
  }
  const files = readTrackedTextFiles();
  const violations = findViolations(tokens, files);
  t.diagnostic(`scanned text files: ${files.length}`);
  assert.deepEqual(violations, [], `本机标识不得进入公开仓：\n${violations.join('\n')}`);
});

test('A2 正向：确定存在的标识必须命中，且测试自身也参与扫描', () => {
  const violations = findViolations(['dashboard'], readTrackedTextFiles());
  assert.ok(violations.length > 0, '扫描必须能发现真实命中，不能恒返回空数组');
  assert.ok(violations.includes('test/noLocalIdentifiers.test.cjs: dashboard'));
});

test('A2 反向：不存在的合成标识必须无命中', () => {
  assert.deepEqual(findViolations([ABSENT_TOKEN], readTrackedTextFiles()), []);
});

function temporaryHome(t) {
  const base = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(base, 'opensource-forbidden-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), base, '只清理本测试创建的 TEMP 子目录');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('A2 名单加载：TEMP 中有名单时主用例执行并通过，不得 skip', (t) => {
  const dir = temporaryHome(t);
  fs.writeFileSync(path.join(dir, 'opensource-forbidden.txt'), `# 合成测试标识\r\n\r\n ${ABSENT_TOKEN} \r\n`, 'utf8');
  const env = { ...process.env, DASHBOARD_HOME: dir };
  // 独立测试运行器不能继承父级的递归检测标记，否则会退出成功却不运行用例。
  delete env.NODE_TEST_CONTEXT;
  // 用真实子进程验证环境变量与模块初始化，按名称只运行主用例，避免递归启动本测试。
  const result = spawnSync(process.execPath, [
    '--test', '--test-reporter=tap', `--test-name-pattern=^${MAIN_TEST}$`, __filename,
  ], {
    cwd: ROOT, env,
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(`ok 1 - ${MAIN_TEST}`), result.stdout + result.stderr);
  assert.match(result.stdout, /^# tests 1\r?$/m);
  assert.match(result.stdout, /^# pass 1\r?$/m);
  assert.match(result.stdout, /^# fail 0\r?$/m);
  assert.match(result.stdout, /^# skipped 0\r?$/m);
  assert.match(result.stdout, /^# scanned text files: [1-9]\d*\r?$/m);
  t.diagnostic(result.stdout.trim());
});

test('名单读取：兼容注释与空行，缺失、空内容、不可读或解码失败均返回空名单', (t) => {
  const dir = temporaryHome(t);
  const file = path.join(dir, 'opensource-forbidden.txt');
  assert.deepEqual(readForbiddenTokens(file), []);
  assert.deepEqual(readForbiddenTokens(dir), []);
  for (const content of ['', '\r\n # 只有注释\r\n\t', Buffer.from([0xc3, 0x28])]) {
    fs.writeFileSync(file, content, 'utf8');
    assert.deepEqual(readForbiddenTokens(file), []);
  }
  fs.writeFileSync(file, '\ufeff# 注释\r\n\r\n dashboard \r\nDASHBOARD\r\n', 'utf8');
  assert.deepEqual(readForbiddenTokens(file), ['dashboard', 'DASHBOARD']);
});
