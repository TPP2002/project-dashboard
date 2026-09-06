'use strict';
/** 代码搬离配置目录的回归门禁；所有行为夹具只写系统 TEMP。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execSync } = require('node:child_process');
const rt = require('../core/runtimeRoot.cjs');
const dispatch = require('../cli/dispatchPrompt.cjs');
const { inbox } = require('../cli/inboxCmd.cjs');

const ROOT = path.resolve(__dirname, '..');
const slash = (p) => p.replace(/\\/g, '/');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.ifError(result.error);
  return result;
}
function tracked() {
  const result = git(['ls-files', '-z']);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\0').filter(Boolean);
}
function temp(t) {
  const base = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(base, 'display-cli-'));
  t.after(() => {
    assert.equal(path.dirname(dir), base, '只清理本测试直接创建的 TEMP 子目录');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
function cliEnv(t, release) {
  const keys = ['DASHBOARD_HOOK_CLI_ROOT', 'DASHBOARD_RELEASE_HOME'];
  const original = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, i) => {
    if (original[i] === undefined) delete process.env[key];
    else process.env[key] = original[i];
  }));
  delete process.env.DASHBOARD_HOOK_CLI_ROOT;
  process.env.DASHBOARD_RELEASE_HOME = release;
}
function fixture(dir) {
  const decision = { id: 'd1', question: '示例问题', answer: '示例答案', decidedAt: '2026-01-01' };
  const task = { id: 'DEMO-1', title: '示例任务', decisions: [decision] };
  const board = path.join(dir, 'board.json');
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(board, JSON.stringify({ project: { name: '示例项目' }, tasks: [task] }));
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: '1.0', projects: {
    example: { name: '示例项目', mainRepo: dir, board },
  } }));
  return { task, registry };
}
const consumers = {
  'dispatch shortTrigger': () => dispatch.shortTrigger('example', 'DEMO-1'),
  'dispatch task prompt': ({ task }) => dispatch.buildTaskDispatchPrompt('example', '示例项目', task, task.decisions),
  'inbox list': ({ registry }) => inbox({ project: 'example', registry }).text,
  'inbox task': ({ registry }) => inbox({ project: 'example', registry, tid: 'DEMO-1' }).text,
};

test('A2(a): local-only files are not tracked', () => {
  const files = tracked();
  const forbidden = ['registry.json', 'astock-launch-prompt.txt', 'debug-notes.md'];
  assert.deepEqual(files.filter((file) => forbidden.includes(file)), []);
});
test('A2(b): tracked CLI/server code has no hardcoded checkout CLI', () => {
  const headerWhitelist = new Set(['core/runtimeRoot.cjs']);
  for (const file of tracked().filter((p) => /^(cli|server|core)\/.*\.cjs$/.test(p))) {
    let source = read(file);
    if (headerWhitelist.has(file)) {
      assert.ok(source.startsWith("'use strict';\n/**"), '豁免只允许文件头注');
      source = source.slice(source.indexOf('*/') + 2);
    }
    assert.ok(!source.includes('~/.claude/dashboard/cli'), file);
  }
});
test('A2(c): ignore only root registry and keep example visible', () => {
  assert.ok(read('.gitignore').split(/\r?\n/).includes('/registry.json'));
  const root = git(['check-ignore', '--no-index', 'registry.json']);
  assert.equal(root.status, 0, root.stderr);
  for (const file of ['registry.example.json', 'example/registry.json']) {
    const result = git(['check-ignore', '--no-index', '-v', file]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '', `${file} 不得被忽略`);
  }
});
test('A2(d): example registry is valid, complete and anonymous', () => {
  const raw = read('registry.example.json');
  const example = JSON.parse(raw);
  assert.equal(example.schemaVersion, '1.0');
  assert.match(example._comment, /registry\.json.*DASHBOARD_HOME/);
  assert.doesNotMatch(raw, /F:\\|Administrator|\.claude/i);
  const projects = Object.values(example.projects);
  assert.ok(projects.length >= 3);
  assert.ok(projects.some((p) => Object.keys(p).sort().join(',') === 'board,mainRepo,name'));
  assert.ok(projects.some((p) => p.codeRepo && p.codeRepo !== p.mainRepo));
  assert.ok(projects.some((p) => p.costRoots?.length && p.index && p.docsRoot));
  for (const project of projects) {
    for (const [key, value] of Object.entries(project)) {
      if (key === 'name') continue;
      for (const p of Array.isArray(value) ? value : [value]) assert.match(p, /^(C:\\path\\to\\|\/path\/to\/)/);
    }
  }
});

for (const [name, render] of Object.entries(consumers)) {
  test(`A3 env: ${name} uses current override after module load`, (t) => {
    const dir = temp(t), data = fixture(dir);
    cliEnv(t, path.join(dir, 'missing-release'));
    for (const leaf of ['first cli', 'second cli']) {
      const root = path.join(dir, leaf);
      fs.mkdirSync(root);
      process.env.DASHBOARD_HOOK_CLI_ROOT = root;
      const expected = `node "${slash(root)}/cli/index.cjs"`;
      assert.ok(render(data).includes(expected), `${name} must include ${expected}`);
    }
  });
  test(`A3 fallback: ${name} uses current code root without a release`, (t) => {
    const dir = temp(t), data = fixture(dir);
    cliEnv(t, path.join(dir, 'missing-release'));
    const cliPath = `${slash(ROOT)}/cli/index.cjs`;
    const expected = `node ${/\s/.test(cliPath) ? `"${cliPath}"` : cliPath}`;
    assert.ok(render(data).includes(expected), `${name} must include ${expected}`);
  });
}

test('display resolver: env > installed self > release > checkout fallback; hook still rejects', (t) => {
  const dir = temp(t), installed = path.join(dir, 'installed'), release = path.join(dir, 'release');
  fs.mkdirSync(installed);
  for (const kind of ['directory', 'file']) {
    const checkout = path.join(dir, kind);
    fs.mkdirSync(checkout);
    if (kind === 'directory') fs.mkdirSync(path.join(checkout, '.git'));
    else fs.writeFileSync(path.join(checkout, '.git'), 'gitdir: /path/to/metadata\n');
    const opts = { env: {}, codeRoot: checkout, releaseHome: path.join(dir, 'missing') };
    assert.deepEqual(rt.resolveDisplayCliRoot(opts), { root: slash(checkout), why: 'fallback' });
    assert.throws(() => rt.resolveHookCliRoot(opts), /release/);
    fs.mkdirSync(path.join(release, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(release, 'cli', 'index.cjs'), '');
    const released = { ...opts, releaseHome: release };
    assert.deepEqual(rt.resolveDisplayCliRoot(released), { root: slash(release), why: 'release' });
    assert.equal(rt.displayCliCommand(released), `node ${/\s/.test(release) ? `"${slash(release)}/cli/index.cjs"` : `${slash(release)}/cli/index.cjs`}`);
    assert.deepEqual(rt.resolveDisplayCliRoot({ ...released, codeRoot: installed }), { root: slash(installed), why: 'self' });
    assert.deepEqual(rt.resolveDisplayCliRoot({ ...released, env: { DASHBOARD_HOOK_CLI_ROOT: installed } }), { root: slash(installed), why: 'env' });
    assert.deepEqual(rt.resolveDisplayCliRoot({ ...opts, releaseHome: undefined, env: { DASHBOARD_RELEASE_HOME: release } }), { root: slash(release), why: 'release' });
  }
});
test('display command: a quoted path with spaces is executable', (t) => {
  const dir = temp(t), root = path.join(dir, 'cli with spaces');
  fs.mkdirSync(path.join(root, 'cli'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cli', 'index.cjs'), "console.log('display-cli-ok');\n");
  const opts = { env: { DASHBOARD_HOOK_CLI_ROOT: root }, codeRoot: ROOT, releaseHome: path.join(dir, 'missing') };
  const command = rt.displayCliCommand(opts);
  assert.equal(command, `node "${slash(root)}/cli/index.cjs"`);
  assert.equal(execSync(command, { encoding: 'utf8', windowsHide: true }).trim(), 'display-cli-ok');
});
