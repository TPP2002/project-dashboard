'use strict';
/**
 * hooksInstall.test.cjs —— 装同步 hook（治本 R2）。
 * 覆盖：新装内容正确 / 幂等不重复 / 不覆盖用户已有内容 / 端到端(git commit→board 自动更新, doctor 不再报未装)。
 */
// hook 根「永不指进 git 检出」(HOOK-CLI-POINTS-AT-LIVE-CHECKOUT):生产装的是发布副本的路径。
// 端到端用例要验的是【本检出】的 hook,不是机器上的发布副本(否则那份旧 CLI 会决定测试红绿),
// 故用测试隔离专用变量显式指过来。registry 仍逐个显式传。
process.env.DASHBOARD_HOOK_CLI_ROOT = require('node:path').resolve(__dirname, '..');

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

test('CLAUDE.md 协议段里手敲命令的 CLI 路径与 git hook 焊的一致,不再写死 ~/.claude/dashboard/cli/index.cjs（CLAUDE-MD-ANCHOR-CLI-PATH）', () => {
  const t = setup();
  hooksInstall({ ...t.P });

  const pc = read(t.pc);
  const cliMatch = pc.match(/node "([^"]+cli\/index\.cjs)"/);
  assert.ok(cliMatch, '应能从 git hook 里提取焊入的 CLI 绝对路径');
  const cliPath = cliMatch[1];

  const claudeMd = read(path.join(t.repo, 'CLAUDE.md'));
  assert.doesNotMatch(claudeMd, /~\/\.claude\/dashboard\/cli\/index\.cjs/, '不许再写死指向"活检出"的路径(HOOK-CLI-POINTS-AT-LIVE-CHECKOUT 同族问题)');
  // 锚段的写法由 runtimeRoot.displayCliCommand 决定:副本里有短别名垫片就用 `<根>/board.cmd`,
  // 没有就回落 `node <根>/cli/index.cjs`(路径带空白才加引号)。所以这里不钉死字面量,
  // 只钉死本条要守的那件事——【与 hook 焊的是同一个 CLI 根】,而不是另外硬编码一条路径。
  const cliRoot = cliPath.slice(0, cliPath.length - '/cli/index.cjs'.length);
  const line = claudeMd.split('\n').find((l) => l.includes('protocol --project t'));
  assert.ok(line, '锚段里应有 protocol 入口');
  assert.ok(line.includes(cliRoot), 'protocol 入口应与 hook 焊的是同一份 CLI(同一个根)');
  clean(t.dir);
});

test('CLAUDE.md 锚段含首尾不超过 25 行，只指向 protocol 并保留三条硬规则', () => {
  const t = setup();
  try {
    hooksInstall({ ...t.P });
    const text = read(path.join(t.repo, 'CLAUDE.md'));
    const block = text.match(/<!-- dashboard-protocol:t begin -->[\s\S]*?<!-- dashboard-protocol:t end -->/);
    assert.ok(block, '保留按项目分段的首尾锚');
    assert.ok(block[0].split(/\r?\n/).length <= 25);
    assert.match(block[0], /protocol --project t/);
    assert.match(block[0], /先 claim 再改代码/);
    assert.match(block[0], /--model 与 --plain-title/);
    assert.match(block[0], /pending --json-file.*background.*optionPros.*recommendReason/);
    assert.match(block[0], /done --pr --commit/);
    assert.match(block[0], /progress \/ park \/ block \/ note/);
    assert.doesNotMatch(block[0], /\p{Extended_Pictographic}/u);
    hooksInstall({ ...t.P });
    assert.equal(read(path.join(t.repo, 'CLAUDE.md')), text, '重装后锚段及周围内容完全相同');
  } finally { clean(t.dir); }
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

test('两个项目共用同一个 codeRepo（如 rogue/cluster 都在 F:\\code-repo）时，各自装的 hook/settings/CLAUDE.md 共存，互不顶替（CLUSTER-CODEREPO-HOOK-COLLISION）', () => {
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

// ───────── HOOK-CLI-POINTS-AT-LIVE-CHECKOUT:hook 永不指进 git 检出 ─────────
const { hooksTrunkGuard } = require('../cli/hooksInstall.cjs');
const gitOut = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

test('settings.json 里旧路径(主工位)的我方条目在重装时被识别并替换,不累积成两套', () => {
  const t = setup();
  fs.mkdirSync(path.dirname(t.settings), { recursive: true });
  const OLD = 'C:/Users/someone/.claude/dashboard/cli/index.cjs';
  fs.writeFileSync(t.settings, JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: `node "${OLD}" doctor --project "t" --quiet || true` }] }],
      PostToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: `node -e "require('child_process').execFileSync('node',['${OLD}','sync-from-git','--project','t'],{stdio:'ignore'});" || true` }] },
        { matcher: 'TodoWrite', hooks: [{ type: 'command', command: `node -e "require('child_process').execFileSync('node',['${OLD}','sync-progress','--project','t','--percent','1'],{stdio:'ignore'});" || true` }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-own-bash-hook' }] },
      ],
    },
  }));
  hooksInstall({ ...t.P });
  const st = readJson(t.settings);
  assert.equal(st.hooks.Stop.length, 1, '旧路径的 Stop 条目应被替换而不是并存');
  assert.doesNotMatch(st.hooks.Stop[0].hooks[0].command, /someone/, '新条目不再含旧路径');
  const mine = st.hooks.PostToolUse.filter((e) => /sync-from-git|sync-progress/.test(e.hooks[0].command));
  assert.equal(mine.length, 2, '我方 PostToolUse 仍是两条(Bash + TodoWrite),旧路径的被换掉');
  assert.ok(mine.every((e) => !/someone/.test(e.hooks[0].command)));
  assert.ok(st.hooks.PostToolUse.some((e) => e.hooks[0].command === 'echo user-own-bash-hook'), '用户自己的 Bash 钩子原样保留');
  clean(t.dir);
});

test('hook 根永不指进 git 检出:本检出 + 无发布副本 → 拒装并指路 release;有发布副本 → 焊发布副本路径', () => {
  const t = setup();
  const saved = process.env.DASHBOARD_HOOK_CLI_ROOT;
  const rel = path.join(t.dir, 'fake-release');
  delete process.env.DASHBOARD_HOOK_CLI_ROOT;
  process.env.DASHBOARD_RELEASE_HOME = rel;
  try {
    assert.throws(() => hooksInstall({ ...t.P }), /release/, '本检出就是 git 检出,又没发布副本 → 必须拒装');
    assert.ok(!fs.existsSync(t.pc), '拒装时一个 hook 都不该写');
    fs.mkdirSync(path.join(rel, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(rel, 'cli', 'index.cjs'), 'process.exit(0);\n');
    hooksInstall({ ...t.P });
    const pc = read(t.pc);
    const fwd = (p) => p.split(path.sep).join('/');
    assert.ok(pc.includes(fwd(rel)), 'hook 焊的是发布副本路径');
    assert.ok(!pc.includes(fwd(path.resolve(__dirname, '..'))), 'hook 不许含本检出路径');
    const st = readJson(t.settings);
    assert.ok(st.hooks.Stop[0].hooks[0].command.includes(fwd(rel)), 'settings 同样指发布副本');
  } finally {
    process.env.DASHBOARD_HOOK_CLI_ROOT = saved;
    delete process.env.DASHBOARD_RELEASE_HOME;
  }
  clean(t.dir);
});

test('hooks-trunk-guard:主工位切离主干只提醒不拦;worktree 里切分支不提醒;幂等', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-')));
  const seed = path.join(dir, 'seed'); fs.mkdirSync(seed);
  git(seed, ['init', '-q', '-b', 'master']);
  git(seed, ['config', 'user.email', 't@t.t']); git(seed, ['config', 'user.name', 't']);
  git(seed, ['commit', '-q', '--allow-empty', '-m', 'init']);
  const origin = path.join(dir, 'origin.git');
  git(dir, ['clone', '-q', '--bare', seed, origin]);
  const work = path.join(dir, 'work');
  git(dir, ['clone', '-q', origin, work]);

  const r = hooksTrunkGuard({ repo: work });
  assert.match(r.text, /master/);
  const hook = read(path.join(work, '.git', 'hooks', 'post-checkout'));
  assert.match(hook, /#dashboard-trunk-guard:begin/);
  assert.match(hook, /"master"/, '主干名焊进 hook');
  hooksTrunkGuard({ repo: work });
  assert.equal((read(path.join(work, '.git', 'hooks', 'post-checkout')).match(/#dashboard-trunk-guard:begin/g) || []).length, 1, '幂等');

  // 主工位切离主干 → stderr 有提醒,但命令成功(退出码 0);切回主干不吵。stderr 用 spawnSync 拿。
  gitOut(work, ['branch', 'feat/off-trunk']);
  const sp2 = require('node:child_process').spawnSync('git', ['-C', work, 'checkout', 'feat/off-trunk'], { encoding: 'utf8' });
  assert.equal(sp2.status, 0, '只提醒不拦');
  assert.match(sp2.stderr, /主工位已切到/, '切离主干要吵一声');
  const sp = require('node:child_process').spawnSync('git', ['-C', work, 'checkout', 'master'], { encoding: 'utf8' });
  assert.equal(sp.status, 0);
  assert.doesNotMatch(sp.stderr, /主工位已切到/, '切回主干不吵');

  // worktree 里切分支:不提醒(git-dir ≠ git-common-dir)
  const wt = path.join(dir, 'wt');
  const sp3 = require('node:child_process').spawnSync('git', ['-C', work, 'worktree', 'add', '-q', wt, '-b', 'feat/in-wt'], { encoding: 'utf8' });
  assert.equal(sp3.status, 0);
  const sp4 = require('node:child_process').spawnSync('git', ['-C', wt, 'checkout', '-b', 'feat/in-wt-2'], { encoding: 'utf8' });
  assert.equal(sp4.status, 0);
  assert.doesNotMatch(sp3.stderr + sp4.stderr, /主工位已切到/, 'worktree 里切分支不该提醒');
  clean(dir);
});
