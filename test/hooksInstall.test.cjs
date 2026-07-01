'use strict';
/**
 * hooksInstall.test.cjs —— 装同步 hook（治本 R2）。
 * 覆盖：新装内容正确 / 幂等不重复 / 不覆盖用户已有内容 / 端到端(git commit→board 自动更新, doctor 不再报未装)。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { hooksInstall } = require('../cli/hooksInstall.cjs');
const cmds = require('../cli/commands.cjs');
const { doctor } = require('../cli/gitSync.cjs');

function git(repo, args) { execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' }); }

function setup() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-')));
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 't@t.t']);
  git(repo, ['config', 'user.name', 't']);
  cmds.register({ id: 't', name: 'demo', root: repo, registry: reg });
  return {
    dir, repo, reg, P: { project: 't', registry: reg },
    pc: path.join(repo, '.git', 'hooks', 'post-commit'),
    pm: path.join(repo, '.git', 'hooks', 'post-merge'),
    settings: path.join(repo, '.claude', 'settings.json'),
    board: path.join(repo, '.dashboard', 'board.json'),
  };
}
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } };
const read = (p) => fs.readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(read(p));

test('新装：git hooks 带锚 + || true，settings 有 Stop/PostToolUse(Bash)', () => {
  const t = setup();
  hooksInstall({ ...t.P });

  const pc = read(t.pc);
  assert.match(pc, /^#!\/bin\/sh/, 'post-commit 应有 shebang');
  assert.match(pc, /#dashboard-hook:begin/);
  assert.match(pc, /#dashboard-hook:end/);
  assert.match(pc, /sync-from-git/);
  assert.match(pc, /render-index/);
  assert.ok((pc.match(/\|\| true/g) || []).length >= 2, 'post-commit 每行调用都 || true');

  const pm = read(t.pm);
  assert.match(pm, /sync-from-git/);
  assert.doesNotMatch(pm, /render-index/, 'post-merge 只 sync-from-git');
  assert.match(pm, /\|\| true/);

  const st = readJson(t.settings);
  assert.equal(st.hooks.Stop.length, 1);
  assert.match(st.hooks.Stop[0].hooks[0].command, /doctor/);
  assert.match(st.hooks.Stop[0].hooks[0].command, /--quiet/);
  assert.match(st.hooks.Stop[0].hooks[0].command, /\|\| true/);
  assert.equal(st.hooks.PostToolUse[0].matcher, 'Bash');
  assert.match(st.hooks.PostToolUse[0].hooks[0].command, /git commit/);
  assert.match(st.hooks.PostToolUse[0].hooks[0].command, /sync-from-git/);
  assert.match(st.hooks.PostToolUse[0].hooks[0].command, /\|\| true/);
  clean(t.dir);
});

test('幂等：装两次不重复锚块 / 不重复 settings 条目', () => {
  const t = setup();
  hooksInstall({ ...t.P });
  hooksInstall({ ...t.P });

  const pc = read(t.pc);
  assert.equal((pc.match(/#dashboard-hook:begin/g) || []).length, 1, 'git hook 锚块唯一');
  const pm = read(t.pm);
  assert.equal((pm.match(/#dashboard-hook:begin/g) || []).length, 1);

  const st = readJson(t.settings);
  assert.equal(st.hooks.Stop.length, 1, 'Stop 不累积');
  assert.equal(st.hooks.PostToolUse.length, 1, 'PostToolUse 不累积');
  clean(t.dir);
});

test('不覆盖用户已有内容：无锚 git hook 追加、settings 既有键与条目保留', () => {
  const t = setup();
  // 用户已有 post-commit（无锚）
  fs.writeFileSync(t.pc, '#!/bin/sh\necho USER-OWN-HOOK\n');
  // 用户已有 settings：自定义 permissions 键 + 自己的一条 Stop hook
  fs.mkdirSync(path.dirname(t.settings), { recursive: true });
  fs.writeFileSync(t.settings, JSON.stringify({
    permissions: { allow: ['Bash(git status:*)'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop' }] }] },
  }));

  hooksInstall({ ...t.P });

  const pc = read(t.pc);
  assert.match(pc, /echo USER-OWN-HOOK/, '用户原 hook 内容保留');
  assert.match(pc, /#dashboard-hook:begin/, '我方锚块已追加');
  assert.equal((pc.match(/#!\/bin\/sh/g) || []).length, 1, '不添第二个 shebang');

  const st = readJson(t.settings);
  assert.deepEqual(st.permissions, { allow: ['Bash(git status:*)'] }, '非 hooks 键原样保留');
  assert.equal(st.hooks.Stop.length, 2, '用户 Stop 条目 + 我方 = 2');
  assert.ok(st.hooks.Stop.some((e) => e.hooks[0].command === 'echo user-stop'), '用户 Stop 保留');
  assert.ok(st.hooks.Stop.some((e) => /doctor/.test(e.hooks[0].command)), '我方 Stop 已加');

  // 再装一次：用户条目仍在、我方仍只 1 条（幂等 + 不误删用户）
  hooksInstall({ ...t.P });
  const st2 = readJson(t.settings);
  assert.equal(st2.hooks.Stop.length, 2);
  assert.equal(st2.hooks.Stop.filter((e) => /doctor/.test(e.hooks[0].command)).length, 1);
  clean(t.dir);
});

test('端到端：git commit 后 board 被 hook 自动更新、doctor 不再报未装', () => {
  const t = setup();
  cmds.add({ _: ['P01'], title: 'e2e', ...t.P });
  hooksInstall({ ...t.P });

  fs.writeFileSync(path.join(t.repo, 'x.txt'), 'hi');
  git(t.repo, ['add', 'x.txt']);
  git(t.repo, ['commit', '-q', '-m', 'feat(P01): e2e hook 验证']);

  const board = readJson(t.board);
  const task = board.tasks.find((x) => x.id === 'P01');
  assert.ok(task.commitShas.length >= 1, 'commit 应被 post-commit hook 自动记入 board');

  const rep = doctor({ ...t.P });
  assert.doesNotMatch(rep.text, /未安装|未装/, 'doctor 不再报 hook 未装');
  clean(t.dir);
});
