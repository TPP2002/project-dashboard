'use strict';
/** AUD-HOOKS-DEDUP-COST：只在临时 registry、git 仓和全局设置文件上验证。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { atomicWriteFileSync, atomicWriteJsonSync } = require('../core/atomicWrite.cjs');
const { hooksInstall, hooksGlobal } = require('../cli/hooksInstall.cjs');
const { doctor } = require('../cli/gitSync.cjs');
const cmds = require('../cli/commands.cjs');
const { readBoard } = require('../cli/store.cjs');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'index.cjs');
const read = (p) => fs.readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(read(p));
function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  atomicWriteJsonSync(p, value);
}
function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  }).trim();
}
function inRepo(repo, fn) {
  const before = process.cwd();
  try { process.chdir(repo); return fn(); }
  finally { process.chdir(before); }
}
function setup(t, split = false) {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempRoot, 'hooks-dedup-'));
  const repo = path.join(dir, 'repo');
  const reg = path.join(dir, 'registry.json');
  const globalSettings = path.join(dir, 'global-settings.json');
  const overrides = { DASHBOARD_GLOBAL_SETTINGS: globalSettings, DASHBOARD_HOOK_CLI_ROOT: ROOT,
    DASHBOARD_RELEASE_HOME: path.join(dir, 'release') };
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.equal(path.dirname(dir), tempRoot, '清理只限本次创建的临时目录');
    assert.ok(path.basename(dir).startsWith('hooks-dedup-'));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'aud-hooks-dedup', '--template=']);
  git(repo, ['config', 'user.email', 't@example.invalid']);
  git(repo, ['config', 'user.name', 'tester']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  git(repo, ['-c', 'core.hooksPath=' + path.join(dir, 'no-hooks'), 'commit', '--allow-empty', '-q', '-m', 'init']);
  writeJson(reg, { schemaVersion: '1.0', projects: {} });
  function addProject(id, mainRepo = path.join(dir, 'board-' + id), codeRepo = repo) {
    fs.mkdirSync(mainRepo, { recursive: true });
    const registered = cmds.register({ id, name: id, root: mainRepo, registry: reg });
    if (codeRepo !== mainRepo) {
      const registry = readJson(reg);
      registry.projects[id].codeRepo = codeRepo;
      writeJson(reg, registry);
    }
    return { P: { project: id, registry: reg }, board: registered.board, mainRepo };
  }
  const project = addProject('t', split ? path.join(dir, 'board-home') : repo);
  return { dir, repo, reg, globalSettings, addProject, ...project,
    branch: git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
    settings: path.join(repo, '.claude', 'settings.json'),
    pc: path.join(repo, '.git', 'hooks', 'post-commit') };
}
function workingCard(f, id, P = f.P, branch = f.branch) {
  cmds.add({ ...P, _: [id], title: '临时施工卡' });
  cmds.claim({ ...P, _: [id], branch });
}
function cli(f, args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--registry', f.reg], {
    cwd: f.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30000,
  });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  return r.stdout;
}
const oldProgress = (id) => ({ type: 'command', command: `node "D:/old/cli/index.cjs" sync-progress --project "${id}"` });

test('全局已有同步：重装项目摘掉旧 TodoWrite，保留 Bash，Stop 改用快速安静体检', (t) => {
  const f = setup(t);
  hooksInstall(f.P);
  const bash = readJson(f.settings).hooks.PostToolUse.find((entry) => entry.matcher === 'Bash');
  writeJson(f.globalSettings, { hooks: { PostToolUse: [{ matcher: 'TodoWrite', hooks: [oldProgress('t')] }] } });
  const globalBefore = read(f.globalSettings);
  const result = hooksInstall(f.P);
  const settings = readJson(f.settings);
  assert.equal(result.skippedTodoWrite, true);
  assert.match(result.text, /全局已装待办同步钩子，本项目不再重复装/);
  assert.deepEqual(settings.hooks.PostToolUse, [bash]);
  assert.equal(settings.hooks.Stop.length, 1);
  assert.match(settings.hooks.Stop[0].hooks[0].command, /doctor.*--quick --quiet/);
  assert.equal(read(f.globalSettings), globalBefore, '装项目不修改全局设置');
});

test('全局没有我方同步：照旧装 TodoWrite，重复安装不累积', (t) => {
  const f = setup(t);
  assert.equal(hooksInstall(f.P).skippedTodoWrite, false, '全局文件不存在时照旧安装');
  writeJson(f.globalSettings, { hooks: { PostToolUse: [
    { matcher: 'TodoWrite', hooks: [{ type: 'command', command: 'echo sync-progress' }] },
  ] } });
  assert.equal(hooksInstall(f.P).skippedTodoWrite, false, '用户自己的同名命令不算我方钩子');
  const entries = readJson(f.settings).hooks.PostToolUse;
  assert.deepEqual(entries.map((entry) => entry.matcher), ['Bash', 'TodoWrite']);
  assert.match(entries[1].hooks[0].command, /sync-progress/);
});

test('补装全局清理 codeRepo 及 mainRepo 重复项，保留用户键、混合命令和坏文件', (t) => {
  const f = setup(t, true);
  hooksInstall(f.P);
  const settings = readJson(f.settings);
  const userHook = { type: 'command', command: 'echo user-todo', timeout: 17 };
  const userEntry = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-bash' }] };
  settings.permissions = { allow: ['Bash(git status:*)'] };
  settings.hooks.PostToolUse[1].hooks.push(userHook);
  settings.hooks.PostToolUse.push(userEntry);
  writeJson(f.settings, settings);
  const fallbackRepo = path.join(f.dir, 'fallback-repo');
  f.addProject('fallback', fallbackRepo, fallbackRepo);
  const fallbackPath = path.join(fallbackRepo, '.claude', 'settings.json');
  writeJson(fallbackPath, { permissions: { deny: ['Bash(rm:*)'] }, hooks: { PostToolUse: [
    { matcher: 'TodoWrite', hooks: [oldProgress('fallback')] }, userEntry,
  ] } });
  const corruptRepo = path.join(f.dir, 'corrupt-repo');
  f.addProject('corrupt', corruptRepo, corruptRepo);
  const corruptPath = path.join(corruptRepo, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(corruptPath));
  atomicWriteFileSync(corruptPath, '{broken json');
  const absentRepo = path.join(f.dir, 'absent-repo');
  f.addProject('absent', absentRepo, absentRepo);
  writeJson(f.globalSettings, { theme: 'user-theme', hooks: { PostToolUse: [userEntry] } });

  const result = hooksGlobal({ registry: f.reg });
  assert.deepEqual(result.removed, [{ projectId: 't', path: f.settings }, { projectId: 'fallback', path: fallbackPath }]);
  assert.match(result.text, /已摘掉 2 处/);
  const after = readJson(f.settings);
  assert.deepEqual(after.permissions, settings.permissions);
  assert.deepEqual(after.hooks.Stop, settings.hooks.Stop);
  assert.deepEqual(after.hooks.PostToolUse, [settings.hooks.PostToolUse[0], { matcher: 'TodoWrite', hooks: [userHook] }, userEntry]);
  assert.deepEqual(readJson(fallbackPath), { permissions: { deny: ['Bash(rm:*)'] }, hooks: { PostToolUse: [userEntry] } });
  assert.equal(read(corruptPath), '{broken json');
  assert.equal(fs.existsSync(path.join(absentRepo, '.claude', 'settings.json')), false);
  assert.equal(readJson(f.globalSettings).theme, 'user-theme');
  assert.deepEqual(readJson(f.globalSettings).hooks.PostToolUse[0], userEntry);
  assert.deepEqual(hooksGlobal({ registry: f.reg }).removed, [], '重复补装不重复报告删除');
  assert.equal(readJson(f.globalSettings).hooks.PostToolUse.length, 2);
});

test('doctor quick 跳过漏记提交、修复及分支审计，quiet 在真实入口不输出成功标记', (t) => {
  const f = setup(t);
  workingCard(f, 'D01');
  git(f.repo, ['-c', 'core.hooksPath=' + path.join(f.dir, 'no-hooks'), 'commit', '--allow-empty', '-q', '-m', 'D01 unrecorded']);
  hooksInstall(f.P);
  const before = read(f.board);
  const full = doctor({ ...f.P, quiet: true });
  assert.equal(full.ok, false);
  assert.match(full.text, /未记入/);
  assert.doesNotMatch(full.text, /✔|快速体检/);
  const quick = doctor({ ...f.P, quick: true, fix: true, branches: true });
  assert.equal(quick.ok, true);
  assert.match(quick.text, /^快速体检/);
  assert.doesNotMatch(quick.text, /未记入/);
  assert.equal(quick.branchAudit, undefined);
  assert.equal(read(f.board), before, 'quick --fix 不写板');
  assert.equal(fs.readdirSync(path.dirname(f.board)).some((name) => name.includes('.bak-')), false);
  assert.deepEqual(doctor({ ...f.P, quick: true, quiet: true }), { ok: true, text: '', silent: true });
  assert.equal(cli(f, ['doctor', '--project', 't', '--quick', '--quiet']), '');
});

test('doctor quiet 干净时静默，quick 保留 hook 与待拍板三件套检查', (t) => {
  const f = setup(t);
  workingCard(f, 'D02');
  hooksInstall(f.P);
  assert.deepEqual(doctor({ ...f.P, quiet: true }), { ok: true, text: '', silent: true });
  assert.equal(cli(f, ['doctor', '--project', 't', '--quiet']), '');
  // 造符合板结构、但不符合待拍板质量要求的旧数据，仍经命令写板。
  cmds.set({ ...f.P, _: ['D02'], field: 'decisions', value: JSON.stringify([
    { id: 'd1', question: '旧问题', options: ['A', 'B'], recommended: 'A', answer: null },
  ]) });
  atomicWriteFileSync(f.pc, '#!/bin/sh\n');
  for (const quick of [false, true]) {
    const result = doctor({ ...f.P, quick, quiet: true });
    assert.equal(result.ok, false);
    assert.match(result.text, /同步块未装/);
    assert.match(result.text, /D02·d1.*background<60字.*recommendReason<30字.*optionPros/);
    assert.doesNotMatch(result.text, /✔|快速体检/);
  }
  fs.unlinkSync(f.board);
  assert.match(doctor({ ...f.P, quick: true }).text, /^快速体检\n• board.json 不存在$/);
  assert.equal(doctor({ ...f.P, quick: true, quiet: true }).text, '• board.json 不存在');
  assert.equal(doctor(f.P).text, '✖ board.json 不存在', '普通模式保留原提示');
});

test('doctor quick 不探测 hook 指向的发布副本', (t) => {
  const f = setup(t);
  hooksInstall(f.P);
  const release = process.env.DASHBOARD_RELEASE_HOME;
  atomicWriteFileSync(f.pc, `#!/bin/sh\n#dashboard-hook:begin:t\nnode "${release.replace(/\\/g, '/')}/cli/index.cjs"\n#dashboard-hook:end\n`);
  const readFile = fs.readFileSync;
  let probes = 0;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (String(file) === path.join(release, 'RELEASE.json')) probes++;
    return readFile.call(this, file, ...args);
  });
  assert.equal(doctor({ ...f.P, quick: true }).ok, true);
  assert.equal(probes, 0, 'quick 不读发布印章');
  doctor(f.P);
  assert.ok(probes > 0, '普通体检仍探测发布副本，证明夹具指向检测路径');
});

test('syncProgress 在分家的 codeRepo 中识别项目并更新板，板目录自身不猜项目', (t) => {
  const f = setup(t, true);
  workingCard(f, 'S01');
  assert.equal(fs.existsSync(path.join(f.mainRepo, '.git')), false);
  const outside = inRepo(f.mainRepo, () => cmds.syncProgress({ registry: f.reg, percent: 50 }));
  assert.equal(outside.skipped, '当前目录不属于任何看板项目');
  assert.equal(cli({ ...f, repo: f.mainRepo }, ['sync-progress', '--project', 't', '--percent', '50']), '', '非 git 目录不向 stderr 泄露 git 错误');
  const result = inRepo(f.repo, () => cmds.syncProgress({ registry: f.reg, percent: 50 }));
  assert.equal(result.task.id, 'S01');
  assert.equal(readBoard(f.board).tasks[0].percent, 50);
  assert.equal(readBoard(f.board).activity.at(-1).author, 'todo-hook');
});

test('syncProgress 共仓按唯一施工板消歧，多张匹配卡仍是一块板，两块都有则静默', (t) => {
  const f = setup(t, true);
  const other = f.addProject('other');
  workingCard(f, 'S02', f.P, 'another-branch');
  workingCard(f, 'S03', other.P);
  workingCard(f, 'S04', other.P);
  const firstBefore = read(f.board);
  const result = inRepo(f.repo, () => cmds.syncProgress({ registry: f.reg, percent: 50 }));
  assert.equal(result.task.id, 'S03', '选唯一命中的板，不能选登记顺序第一块');
  assert.equal(read(f.board), firstBefore);
  assert.equal(readBoard(other.board).tasks[0].percent, 50);
  cmds.claim({ ...f.P, _: ['S02'], branch: f.branch });
  const snapshots = [read(f.board), read(other.board)];
  const ambiguous = inRepo(f.repo, () => cmds.syncProgress({ registry: f.reg, percent: 70 }));
  assert.equal(ambiguous.ok, true);
  assert.match(ambiguous.skipped, /歧义.*2 块板/);
  assert.equal(cli(f, ['sync-progress', '--percent', '70']), '', '歧义在 CLI 入口同样安静');
  assert.deepEqual([read(f.board), read(other.board)], snapshots);
  const explicit = inRepo(f.repo, () => cmds.syncProgress({ ...other.P, percent: 70 }));
  assert.equal(explicit.task.id, 'S03', '显式项目优先于共仓消歧');
});

test('syncProgress 共仓无施工匹配及异常都返回跳过，不写进度或向 stderr 报错', (t) => {
  const f = setup(t, true);
  const other = f.addProject('other');
  workingCard(f, 'S05', f.P, 'other-branch');
  cmds.add({ ...other.P, _: ['S06'], title: '未开工卡' });
  const snapshots = [read(f.board), read(other.board)];
  const noMatch = inRepo(f.repo, () => cmds.syncProgress({ registry: f.reg, percent: 50 }));
  assert.equal(noMatch.ok, true);
  assert.match(noMatch.skipped, /歧义.*0 块板/);
  assert.deepEqual([read(f.board), read(other.board)], snapshots);
  const unknown = cmds.syncProgress({ ...f.P, project: 'missing', branch: f.branch, percent: 50 });
  assert.equal(unknown.ok, true);
  assert.match(unknown.skipped, /未注册/);
  assert.equal(cli(f, ['sync-progress', '--project', 'missing', '--percent', '50']), '');
  fs.unlinkSync(f.board);
  const missingBoard = cmds.syncProgress({ ...f.P, branch: f.branch, percent: 50 });
  assert.equal(missingBoard.ok, true);
  assert.ok(missingBoard.skipped);
  assert.equal(fs.existsSync(f.board), false, '读取失败不能新建一块空板');
});
