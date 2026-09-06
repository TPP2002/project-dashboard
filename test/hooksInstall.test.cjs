'use strict';
/**
 * hooksInstall.test.cjs —— 装同步 hook（治本 R2）。
 * 覆盖：新装内容正确 / 幂等不重复 / 不覆盖用户已有内容 / 端到端(git commit→board 自动更新, doctor 不再报未装)。
 */
// hooksInstall 把 DASHBOARD_HOME 下的 CLI 路径焊进 hook。端到端用例要验的是【本检出】的 hook,
// 不是机器上已安装的那份(否则本地装的旧 CLI 会决定测试红绿)。registry 仍逐个显式传。
process.env.DASHBOARD_HOME = require('node:path').resolve(__dirname, '..');

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
  // PostToolUse 固定两条(Bash·git commit 同步 + TodoWrite·自动进度),装两次仍是两条
  assert.equal(st.hooks.PostToolUse.length, 2, 'PostToolUse 不累积(Bash+TodoWrite 各一)');
  assert.ok(st.hooks.PostToolUse.some((e) => e.matcher === 'TodoWrite'), '含 TodoWrite 自动进度钩子');
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

test('pre-commit 闸门调 claim-check（扫全部项目），不再写死单项目 grep（HOOK-CLAIM-GATE-MULTI-PROJECT）', () => {
  const t = setup();
  hooksInstall({ ...t.P });
  const pre = read(path.join(t.repo, '.git', 'hooks', 'pre-commit'));
  assert.match(pre, /claim-check --branch "\$__BR"/, '判定走 CLI 的 claim-check');
  assert.doesNotMatch(pre, /list --project/, '不许再按安装时那一个项目 id 查板');
  assert.doesNotMatch(pre, /grep -E/, '不许再拿分支名 grep 整行文本');
  assert.match(pre, /DASHBOARD_SKIP_CLAIM_CHECK/, '放行口必须保留');
  assert.match(pre, /__RC=\$\?/, '按退出码分流,而不是一刀切');
  assert.match(pre, /exit 1/, '判定为"没认领"时要真的拦下 commit');
  assert.match(pre, /rc=2\/3|"\$__RC" = "2"/, 'CLI 里还没有 claim-check 的过渡期要放行,别堵死全机器');
  clean(t.dir);
});

test('pre-commit 硬闸门：未 claim 直接 commit 应被拒（skill §11.9 优先级 > 启动指令）', () => {
  const t = setup();
  cmds.add({ _: ['P01'], title: 'e2e', ...t.P });
  git(t.repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
  hooksInstall({ ...t.P });
  git(t.repo, ['checkout', '-q', '-b', 'feat-no-claim']);

  fs.writeFileSync(path.join(t.repo, 'a.txt'), 'hi');
  git(t.repo, ['add', 'a.txt']);
  assert.throws(() => git(t.repo, ['commit', '-q', '-m', 'add a']),
    /Command failed/, '未 claim 的分支应被 pre-commit 拦下');

  // 紧急放行：DASHBOARD_SKIP_CLAIM_CHECK=1 应允许
  execFileSync('git', ['-C', t.repo, 'commit', '-q', '-m', 'urgent'], {
    stdio: 'ignore', env: { ...process.env, DASHBOARD_SKIP_CLAIM_CHECK: '1' },
  });
  const log = execFileSync('git', ['-C', t.repo, 'log', '--oneline'], { encoding: 'utf8' });
  assert.match(log, /urgent/, '紧急放行应生效');
  clean(t.dir);
});

test('mainRepo 非 git 仓、codeRepo 才是真仓时，hooks-install 应落进 codeRepo 而非 mainRepo（CLUSTER-BOARD-REPO-PATH-WRONG）', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-split-')));
  const reg = path.join(dir, 'registry.json');
  const boardHome = path.join(dir, 'board-home'); fs.mkdirSync(boardHome);
  const codeRepo = path.join(dir, 'code-repo'); fs.mkdirSync(codeRepo);
  git(codeRepo, ['init', '-q']);
  git(codeRepo, ['config', 'user.email', 't@t.t']);
  git(codeRepo, ['config', 'user.name', 't']);
  fs.writeFileSync(reg, JSON.stringify({
    schemaVersion: '1.0',
    projects: { split: { name: '拆分', mainRepo: boardHome, codeRepo } },
  }));
  const P = { project: 'split', registry: reg };

  assert.doesNotThrow(() => hooksInstall({ ...P }), 'mainRepo 不是 git 仓时，hooks-install 不该再因此报错');

  assert.ok(fs.existsSync(path.join(codeRepo, '.git', 'hooks', 'post-commit')), 'git hook 应装进 codeRepo（代码的家）');
  assert.ok(fs.existsSync(path.join(codeRepo, '.claude', 'settings.json')), 'settings.json 应落进 codeRepo');
  assert.ok(fs.existsSync(path.join(codeRepo, 'CLAUDE.md')), 'CLAUDE.md 锚段应落进 codeRepo');
  assert.ok(!fs.existsSync(path.join(boardHome, '.claude')), 'settings.json 不该落进 mainRepo（板的家）');
  assert.ok(!fs.existsSync(path.join(boardHome, 'CLAUDE.md')), 'CLAUDE.md 不该落进 mainRepo');
  clean(dir);
});

test('两个项目共用同一个 codeRepo（如 rogue/cluster 都在 F:\\stock-rogue）时，各自装的 hook/settings/CLAUDE.md 共存，互不顶替（CLUSTER-CODEREPO-HOOK-COLLISION）', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-shared-')));
  const reg = path.join(dir, 'registry.json');
  const codeRepo = path.join(dir, 'shared-repo'); fs.mkdirSync(codeRepo);
  git(codeRepo, ['init', '-q']);
  git(codeRepo, ['config', 'user.email', 't@t.t']);
  git(codeRepo, ['config', 'user.name', 't']);
  fs.writeFileSync(reg, JSON.stringify({
    schemaVersion: '1.0',
    projects: {
      alpha: { name: 'Alpha', mainRepo: path.join(dir, 'alpha-board'), codeRepo },
      beta: { name: 'Beta', mainRepo: path.join(dir, 'beta-board'), codeRepo },
    },
  }));
  fs.mkdirSync(path.join(dir, 'alpha-board'));
  fs.mkdirSync(path.join(dir, 'beta-board'));

  hooksInstall({ project: 'alpha', registry: reg });
  hooksInstall({ project: 'beta', registry: reg });

  const pc = read(path.join(codeRepo, '.git', 'hooks', 'post-commit'));
  assert.match(pc, /#dashboard-hook:begin:alpha/, 'alpha 的 post-commit 块应还在');
  assert.match(pc, /#dashboard-hook:begin:beta/, 'beta 的 post-commit 块不该把 alpha 的顶掉');
  // 每块自带 sync-from-git + render-index 两行，各含一次 --project "<id>"，故一块正常就是 2 次。
  assert.equal((pc.match(/#dashboard-hook:begin:alpha/g) || []).length, 1, 'alpha 块只出现一次，没被重复安装');
  assert.equal((pc.match(/#dashboard-hook:begin:beta/g) || []).length, 1, 'beta 块只出现一次');
  assert.equal((pc.match(/--project "alpha"/g) || []).length, 2, 'alpha 块内 sync-from-git/render-index 各一次');
  assert.equal((pc.match(/--project "beta"/g) || []).length, 2, 'beta 块内 sync-from-git/render-index 各一次');

  const pre = read(path.join(codeRepo, '.git', 'hooks', 'pre-commit'));
  assert.equal((pre.match(/#dashboard-hook:begin/g) || []).length, 1,
    'pre-commit 内容与项目 id 无关，应保持单例，不因两个项目各装一次而重复');

  const st = readJson(path.join(codeRepo, '.claude', 'settings.json'));
  assert.equal(st.hooks.Stop.length, 2, 'alpha/beta 的 Stop 兜底应共存，不是互相顶替');
  assert.ok(st.hooks.Stop.some((e) => /--project "alpha"/.test(e.hooks[0].command)));
  assert.ok(st.hooks.Stop.some((e) => /--project "beta"/.test(e.hooks[0].command)));
  const bashEntries = st.hooks.PostToolUse.filter((e) => e.matcher === 'Bash');
  assert.equal(bashEntries.length, 2, 'alpha/beta 的 PostToolUse(Bash) 应共存');

  const claudeMd = read(path.join(codeRepo, 'CLAUDE.md'));
  assert.match(claudeMd, /dashboard-protocol:alpha begin/, 'alpha 的 CLAUDE.md 协议段应还在');
  assert.match(claudeMd, /dashboard-protocol:beta begin/, 'beta 的协议段不该把 alpha 的顶掉');

  // 重装 alpha：只刷新 alpha 自己那份，不影响 beta 已装的部分（幂等 + 隔离同时成立）。
  hooksInstall({ project: 'alpha', registry: reg });
  const pc2 = read(path.join(codeRepo, '.git', 'hooks', 'post-commit'));
  assert.equal((pc2.match(/#dashboard-hook:begin:alpha/g) || []).length, 1, '重装 alpha 不重复自己的块');
  assert.equal((pc2.match(/#dashboard-hook:begin:beta/g) || []).length, 1, '重装 alpha 不影响 beta 的块');
  const st2 = readJson(path.join(codeRepo, '.claude', 'settings.json'));
  assert.equal(st2.hooks.Stop.length, 2, '重装 alpha 后 Stop 仍是两条（各自一条），不是 3 条或 1 条');

  clean(dir);
});

test('端到端：git commit 后 board 被 hook 自动更新、doctor 不再报未装', () => {
  const t = setup();
  cmds.add({ _: ['P01'], title: 'e2e', ...t.P });
  // 建初始 commit + 切业务分支(空仓 checkout -b 会让 rev-parse 返回 HEAD、pre-commit 无法识别分支名)
  git(t.repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
  hooksInstall({ ...t.P });
  git(t.repo, ['checkout', '-q', '-b', 'feat-e2e']);
  cmds.claim({ _: ['P01'], branch: 'feat-e2e', ...t.P });

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
