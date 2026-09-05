'use strict';
/**
 * releaseWiring.test.cjs —— 发布副本新鲜度接进 doctor / precheck(HOOK-CLI-POINTS-AT-LIVE-CHECKOUT T3,负责人 0906 拍板 d2=A:
 * 收官手动 `cli release`,体检落后就提醒)。
 *
 *   · doctor:本仓 hook 确实指着发布副本、且副本落后 origin/主干 → 报「发布副本落后」;
 *            hook 不指发布副本(测试隔离 / 未迁移)→ 不报(别拿机器上碰巧存在的副本决定别的测试红绿);
 *   · precheck:副本不存在 → 报「未发布」;落后 → 报「落后」;齐 → ✔。
 */
process.env.DASHBOARD_HOOK_CLI_ROOT = require('node:path').resolve(__dirname, '..');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const cmds = require('../cli/commands.cjs');
const { hooksInstall } = require('../cli/hooksInstall.cjs');
const { doctor } = require('../cli/gitSync.cjs');
const { precheck } = require('../cli/precheck.cjs');
const { release } = require('../cli/release.cjs');

function git(repo, args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim(); }
function write(root, rel, s) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), s); }
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } };

/** 一个"看板代码仓"(seed→origin→work)+ 一个被看板管理的项目仓 + registry。 */
function setup() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'relwire-')));
  const seed = path.join(dir, 'seed'); fs.mkdirSync(seed);
  git(seed, ['init', '-q', '-b', 'master']);
  git(seed, ['config', 'user.email', 't@t.t']); git(seed, ['config', 'user.name', 't']); git(seed, ['config', 'commit.gpgsign', 'false']);
  write(seed, 'cli/index.cjs', 'process.exit(0);\n'); write(seed, 'core/x.cjs', ''); write(seed, 'package.json', '{}');
  git(seed, ['add', '-A']); git(seed, ['commit', '-q', '-m', 'v1']);
  const origin = path.join(dir, 'origin.git'); git(dir, ['clone', '-q', '--bare', seed, origin]);
  const work = path.join(dir, 'work'); git(dir, ['clone', '-q', origin, work]);
  git(work, ['config', 'user.email', 't@t.t']); git(work, ['config', 'user.name', 't']); git(work, ['config', 'commit.gpgsign', 'false']);

  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  git(repo, ['init', '-q']); git(repo, ['config', 'user.email', 't@t.t']); git(repo, ['config', 'user.name', 't']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', 'init']);
  cmds.register({ id: 't', name: 'demo', root: repo, registry: reg });
  cmds.add({ _: ['P01'], title: 'x', project: 't', registry: reg });
  return { dir, work, origin, repo, reg, dest: path.join(dir, 'release'), P: { project: 't', registry: reg } };
}
function pushFromElsewhere(t) {
  const w2 = path.join(t.dir, 'w2-' + Date.now().toString(36));
  git(t.dir, ['clone', '-q', t.origin, w2]);
  git(w2, ['config', 'user.email', 't@t.t']); git(w2, ['config', 'user.name', 't']); git(w2, ['config', 'commit.gpgsign', 'false']);
  write(w2, 'core/y.cjs', ''); git(w2, ['add', '-A']); git(w2, ['commit', '-q', '-m', 'v2']); git(w2, ['push', '-q', 'origin', 'master']);
}
/** 在 env 覆盖下跑 fn,跑完恢复。 */
function withEnv(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) { saved[k] = process.env[k]; if (patch[k] === undefined) delete process.env[k]; else process.env[k] = patch[k]; }
  try { return fn(); } finally { for (const k of Object.keys(patch)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

test('doctor:hook 指着发布副本且副本落后 → 报「发布副本落后」;hook 不指发布副本 → 不报', () => {
  const t = setup();
  release({ source: t.work, dest: t.dest });
  pushFromElsewhere(t); git(t.work, ['fetch', '-q', 'origin']);

  // hook 指本检出(测试隔离默认)→ 哪怕副本落后也不报,别连坐别的测试
  hooksInstall({ ...t.P });
  const quiet = withEnv({ DASHBOARD_RELEASE_HOME: t.dest }, () => doctor({ ...t.P }));
  assert.doesNotMatch(quiet.text, /发布副本/, 'hook 没指发布副本时不该报');

  // hook 指发布副本 → 报落后
  withEnv({ DASHBOARD_HOOK_CLI_ROOT: undefined, DASHBOARD_RELEASE_HOME: t.dest }, () => hooksInstall({ ...t.P }));
  const rep = withEnv({ DASHBOARD_RELEASE_HOME: t.dest }, () => doctor({ ...t.P }));
  assert.equal(rep.ok, false);
  assert.match(rep.text, /发布副本落后 origin\/master 1 个提交/);
  assert.match(rep.text, /cli release/, '要指路怎么修');

  // 重新发布后不再报
  release({ source: t.work, dest: t.dest });
  const rep2 = withEnv({ DASHBOARD_RELEASE_HOME: t.dest }, () => doctor({ ...t.P }));
  assert.doesNotMatch(rep2.text, /落后/);
  clean(t.dir);
});

test('precheck:副本不存在 → 「未发布」;落后 → 「落后」;齐 → ✔', () => {
  const t = setup();
  // 来源检出不用另指:未发布时文案与来源无关;发布后印章里记着来源(t.work)。
  const run = () => withEnv({ DASHBOARD_RELEASE_HOME: t.dest }, () => precheck({ ...t.P, 'no-fetch': true }).text);
  assert.match(run(), /发布副本未发布/);
  release({ source: t.work, dest: t.dest });
  assert.match(run(), /✔ 发布副本 = origin\/master/);
  pushFromElsewhere(t); git(t.work, ['fetch', '-q', 'origin']);
  assert.match(run(), /发布副本落后 origin\/master 1 个提交/);
  clean(t.dir);
});
