'use strict';
/**
 * 两道闸必须共存：外置名单拦项目名、主机名等非路径标识，缺名单时仅该用例 skip；
 * 路径形状闸不依赖本机数据，只允许仓内已有的占位符及标准软件安装路径，在本机和 CI 都执行。
 * 中文项目名等非路径标识仍由名单闸负责，不能为补覆盖把真实标识写回公开仓。
 */
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

// 来自被跟踪文本的占位符清点；相似名字的示例也单列，不能用模糊前缀放行。
const PATH_PLACEHOLDERS = [
  'c:/path/to', 'c:/users/demo', 'c:/users/t', 'c:/users/someone', 'c:/users/你的用户名',
  'c:/正斜杠/绝对', 'd:/work', 'd:/code', 'd:/unrelated',
  'f:/code-repo', 'f:/board-repo', 'f:/app-repo', 'f:/app-repo-evil', 'f:/quest-repo',
  'f:/legacy-repo', 'f:/quant-repo', 'f:/shop-repo', 'f:/myapp', 'f:/docs-site', 'f:/projects',
];

// 这四条标准 Windows 浏览器安装路径不含个人、账号或项目信息，因此仅按完整路径放行，禁止扩大为安装目录前缀。
const STANDARD_WINDOWS_SOFTWARE_PATHS = new Set([
  'c:/program files/google/chrome/application/chrome.exe',
  'c:/program files (x86)/google/chrome/application/chrome.exe',
  'c:/program files (x86)/microsoft/edge/application/msedge.exe',
  'c:/program files/microsoft/edge/application/msedge.exe',
]);

/** 纯扫描：输入 { file, content } 数组，返回「文件:行号: 路径」，不读盘、不依赖名单。 */
function findBadPaths(files) {
  const violations = [];
  for (const { file, content } of files) {
    for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
      // 源码/JSON 的多重反斜杠先归一化；词边界排除 URL、STDOUT 和 ref 的末字母。
      const line = rawLine.replace(/\\+/g, '\\');
      for (const match of line.matchAll(/(?<![A-Za-z0-9_])[A-Za-z]:[\\/]+/g)) {
        const tail = line.slice(match.index + match[0].length);
        const quote = line[match.index - 1];
        // 紧挨引号的路径保留空格和括号；其余按文档/注释中的词及标点边界取路径。
        const end = quote && ['"', "'", '`'].includes(quote) ? tail.indexOf(quote) : -1;
        const segment = end >= 0 ? tail.slice(0, end) : tail.split(/[\s"'`<>|,;:()[\]{}，。、；：（）]/)[0];
        const hit = match[0] + segment;
        // 裸盘符没有有效段；孤立的单字符控制转义是假路径，不跳过正常 n/r/t 开头目录。
        if (!segment || /^[A-Za-z]:\\[nrtbfv0]$/.test(hit)) continue;
        const normalized = hit.replace(/\\/g, '/').toLowerCase();
        const allowed = STANDARD_WINDOWS_SOFTWARE_PATHS.has(normalized)
          || PATH_PLACEHOLDERS.some((prefix) => normalized === prefix || normalized.startsWith(prefix + '/'));
        if (!allowed) violations.push(`${file}:${index + 1}: ${hit}`);
      }
    }
  }
  return violations;
}

test('路径形状闸：正向，合成非占位符路径必须违规并给出文件行号', () => {
  // 动态拼接避免违规夹具的源码字面量使真实仓库扫描永远报红。
  const parts = ['F:', 'definitely-not-a-placeholder', 'x'];
  for (const separator of ['\\', '\\\\', '\\\\\\\\', '/']) {
    const hit = parts.join(separator);
    const content = `// fixture\r\nconst p = '${hit}';`;
    assert.deepEqual(findBadPaths([{ file: 'fixture.cjs', content }]), [
      `fixture.cjs:2: ${hit.replace(/\\+/g, '\\')}`,
    ]);
  }
  for (const segment of ['code-repo-unlisted', 'notes', '中文夹具', 'folder with spaces']) {
    const hit = ['F:', segment, 'x'].join('\\');
    assert.deepEqual(findBadPaths([{ file: 'fixture.cjs', content: `const p = '${hit}';` }]), [
      `fixture.cjs:1: ${hit}`,
    ]);
  }
});

test('路径形状闸：反向，占位符及其子路径必须全部放行', () => {
  const content = PATH_PLACEHOLDERS.flatMap((prefix) => [
    `"${prefix}"`, `"${prefix}/子目录/x"`, `"${prefix.toUpperCase().replace(/\//g, '\\\\')}"`,
  ]).join('\n');
  assert.deepEqual(findBadPaths([{ file: 'placeholders.cjs', content }]), []);
  assert.deepEqual(findBadPaths([]), []);
  assert.deepEqual(findBadPaths([{ file: 'empty.txt', content: '' }]), []);
});

test('路径形状闸：转义，孤立控制转义与日志标签不得误报', () => {
  const content = String.raw`"T:\n" "R:\r" "STDOUT:\nnext" "STDERR:\nnext" "ref:\s+" "https://example.invalid/x"`;
  assert.deepEqual(findBadPaths([{ file: 'escapes.cjs', content }]), []);
});

test('路径形状闸：标准软件，仅放行完整安装路径', () => {
  for (const allowed of STANDARD_WINDOWS_SOFTWARE_PATHS) {
    const content = `"${allowed}" "${allowed.toUpperCase().replace(/\//g, '\\\\')}"`;
    assert.deepEqual(findBadPaths([{ file: 'software.cjs', content }]), []);
    for (const hit of [allowed + '/unlisted', allowed.slice(0, allowed.lastIndexOf('/')) + '/unlisted.exe']) {
      assert.deepEqual(findBadPaths([{ file: 'software.cjs', content: `"${hit}"` }]), [`software.cjs:1: ${hit}`]);
    }
  }
});

test('路径形状闸：仓库，全部被跟踪文本的路径必须属于白名单', (t) => {
  const files = readTrackedTextFiles();
  const violations = findBadPaths(files);
  t.diagnostic(`shape scanned text files: ${files.length}; violations: ${violations.length}`);
  assert.deepEqual(violations, [], `不允许白名单以外的盘符路径：\n${violations.join('\n')}`);
});
