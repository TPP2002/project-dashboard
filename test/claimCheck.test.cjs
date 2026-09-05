'use strict';
/**
 * claimCheck.test.cjs —— commit 前的「你认领了吗」闸门(HOOK-CLAIM-GATE-MULTI-PROJECT)。
 *
 * 本卡治的病:0902 看板拆成 rogue/cluster/dashboard 三个项目后,闸门仍写死单一 --project,
 * 「在 A 仓库里干 B 项目的卡」哪怕已正经 claim 也一律被拦。
 * 覆盖:跨项目命中 / 全都没有才拦 / 主干分支免检 / 精确匹配不被 title 假阳性骗过 /
 *      坏板不连坐 / 报错文案给全候选项目 / 端到端 git commit(含放行口)。
 */
// hooksInstall 把 DASHBOARD_HOME 下的 CLI 路径焊进 hook。测试要验的是【本检出】的闸门,
// 不是机器上已安装的那份,所以在 require 之前就把数据根指到本仓库(registry 仍逐个显式传)。
process.env.DASHBOARD_HOME = require('node:path').resolve(__dirname, '..');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { claimCheck } = require('../cli/claimCheck.cjs');
const { hooksInstall } = require('../cli/hooksInstall.cjs');
const cmds = require('../cli/commands.cjs');

function git(repo, args, env) {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore', env: env ? { ...process.env, ...env } : process.env });
}

/** 造 N 个各自独立的 registry 项目(各自 repo + 各自 board),模拟 0902 拆板后的真实布局。 */
function setup(ids = ['alpha', 'beta']) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'claimchk-')));
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const repos = {};
  for (const id of ids) {
    const repo = path.join(dir, id);
    fs.mkdirSync(repo);
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 't@t.t']);
    git(repo, ['config', 'user.name', 't']);
    git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
    cmds.register({ id, name: `demo-${id}`, root: repo, registry: reg });
    repos[id] = repo;
  }
  return { dir, reg, repos };
}
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } };

test('跨项目:卡 claim 在 beta 板上,在 alpha 仓库里干活也应放行(本卡核心)', () => {
  const t = setup();
  cmds.add({ _: ['CLUSTER-1'], title: '跨项目的卡', project: 'beta', registry: t.reg });
  cmds.claim({ _: ['CLUSTER-1'], branch: 'claude/ci-secondary-runner-9c02g1', project: 'beta', registry: t.reg });

  const r = claimCheck({ branch: 'claude/ci-secondary-runner-9c02g1', registry: t.reg, repo: t.repos.alpha });
  assert.equal(r.ok, true);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].project, 'beta', '应报出命中的是 beta 项目');
  assert.equal(r.hits[0].taskId, 'CLUSTER-1');
  clean(t.dir);
});

test('全部项目都没有该分支的施工中任务 → 拦下,且文案列出全部候选项目', () => {
  const t = setup();
  cmds.add({ _: ['A-1'], title: '别的分支的卡', project: 'alpha', registry: t.reg });
  cmds.claim({ _: ['A-1'], branch: 'feat-other', project: 'alpha', registry: t.reg });

  assert.throws(
    () => claimCheck({ branch: 'feat-none', registry: t.reg, repo: t.repos.alpha }),
    (e) => {
      assert.match(e.message, /feat-none/);
      assert.match(e.message, /alpha/, '候选项目应含 alpha');
      assert.match(e.message, /beta/, '候选项目应含 beta');
      assert.match(e.message, /DASHBOARD_SKIP_CLAIM_CHECK=1/, '放行口必须留在文案里');
      assert.match(e.message, /--model/, 'add 建议须带 --model(CLI 有建卡标档硬闸)');
      return true;
    },
  );
  clean(t.dir);
});

test('主干分支(main/master/HEAD/空)免检', () => {
  const t = setup(['alpha']);
  for (const br of ['main', 'master', 'HEAD', '']) {
    const r = claimCheck({ branch: br, registry: t.reg, repo: t.repos.alpha });
    assert.equal(r.ok, true, `${br} 应免检`);
    assert.equal(r.exempt, true);
  }
  clean(t.dir);
});

test('精确匹配 gitBranch:title 里恰好含分支名不算 claim(旧 grep 会假通过)', () => {
  const t = setup(['alpha']);
  cmds.add({ _: ['A-2'], title: '顺手修一下 feat-ghost 分支留下的问题', project: 'alpha', registry: t.reg });
  cmds.claim({ _: ['A-2'], branch: 'feat-real', project: 'alpha', registry: t.reg });

  assert.throws(() => claimCheck({ branch: 'feat-ghost', registry: t.reg, repo: t.repos.alpha }),
    /feat-ghost/, 'title 里出现分支名不构成认领');
  assert.equal(claimCheck({ branch: 'feat-real', registry: t.reg, repo: t.repos.alpha }).ok, true);
  clean(t.dir);
});

test('某个项目的板损坏/根本没建,都不连坐其它项目的判定', () => {
  const t = setup(['alpha', 'beta', 'gamma']);
  // beta 的板是坏 JSON,且文本里含分支名 → 必须走到 JSON.parse 才发现坏,应记进 skipped
  const betaBoard = path.join(t.repos.beta, '.dashboard', 'board.json');
  fs.mkdirSync(path.dirname(betaBoard), { recursive: true });
  fs.writeFileSync(betaBoard, '{ 这不是 JSON,但含 feat-ok');
  // gamma 的板文件被删掉(仓库还在)→ 属"软"跳过:记进 skipped 供诊断,但不该每次 commit 刷警告
  fs.rmSync(path.join(t.repos.gamma, '.dashboard', 'board.json'), { force: true });
  cmds.add({ _: ['A-3'], title: '正经卡', project: 'alpha', registry: t.reg });
  cmds.claim({ _: ['A-3'], branch: 'feat-ok', project: 'alpha', registry: t.reg });

  const r = claimCheck({ branch: 'feat-ok', registry: t.reg, repo: t.repos.alpha });
  assert.equal(r.ok, true, '坏板应被跳过而不是让整个闸门炸掉');
  assert.equal(r.hits[0].project, 'alpha');
  const why = Object.fromEntries(r.skipped.map((x) => [x.project, x.why]));
  assert.match(why.beta || '', /JSON/, '坏板应记进 skipped 供诊断');
  assert.match(why.gamma || '', /板还不存在/, '缺板的项目也应记进 skipped');
  const soft = Object.fromEntries(r.skipped.map((x) => [x.project, x.soft]));
  assert.equal(soft.beta, false, '坏板 = 硬跳过,要吵出来');
  assert.equal(soft.gamma, true, '仓库还在、只是没建板 = 软跳过,不刷警告');
  clean(t.dir);
});

test('端到端:alpha 仓库 commit,卡却 claim 在 beta 板上 —— pre-commit 应放行', () => {
  const t = setup();
  hooksInstall({ project: 'alpha', registry: t.reg });
  git(t.repos.alpha, ['checkout', '-q', '-b', 'feat-cross']);
  cmds.add({ _: ['B-9'], title: '在 beta 项目里的卡', project: 'beta', registry: t.reg });
  cmds.claim({ _: ['B-9'], branch: 'feat-cross', project: 'beta', registry: t.reg });

  fs.writeFileSync(path.join(t.repos.alpha, 'x.txt'), 'hi');
  git(t.repos.alpha, ['add', 'x.txt']);
  git(t.repos.alpha, ['commit', '-q', '-m', 'feat(B-9): 跨项目提交应被放行']);

  const log = execFileSync('git', ['-C', t.repos.alpha, 'log', '--oneline'], { encoding: 'utf8' });
  assert.match(log, /跨项目提交应被放行/);
  clean(t.dir);
});

test('端到端:哪个板都没 claim 仍被拦;放行口仍然有效', () => {
  const t = setup();
  hooksInstall({ project: 'alpha', registry: t.reg });
  git(t.repos.alpha, ['checkout', '-q', '-b', 'feat-nobody']);
  fs.writeFileSync(path.join(t.repos.alpha, 'y.txt'), 'hi');
  git(t.repos.alpha, ['add', 'y.txt']);

  assert.throws(() => git(t.repos.alpha, ['commit', '-q', '-m', 'no claim']),
    /Command failed/, '三个板都没有就该拦');
  git(t.repos.alpha, ['commit', '-q', '-m', 'urgent'], { DASHBOARD_SKIP_CLAIM_CHECK: '1' });
  const log = execFileSync('git', ['-C', t.repos.alpha, 'log', '--oneline'], { encoding: 'utf8' });
  assert.match(log, /urgent/, '放行口必须保留(跨项目场景没修好前它是唯一出路)');
  clean(t.dir);
});
