'use strict';
/**
 * release.test.cjs —— 发布副本(HOOK-CLI-POINTS-AT-LIVE-CHECKOUT,负责人 0906 拍板走治法①)。
 *
 * 要钉死的行为:
 *   · `release` 只从 origin/<主干> 导出运行期文件,与来源检出【此刻在哪条分支、有没有未提交改动】无关
 *     ——这是治本的直接证据(病根就是 hook 跑着"某个对话此刻恰好检出"的代码);
 *   · 导出不碰来源仓的索引与工作区;
 *   · 目录级换名,连发两次不留 .new/.old 残渣,印章 RELEASE.json 记来源 commit;
 *   · 安装版/发布副本(代码根没有 .git)跑 release 友好跳过;
 *   · hook 的 CLI 根取值规则「永不指进 git 检出」:环境变量 > 自身非检出 > 发布副本 > 拒装。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { release, releaseStatus, detectTrunk } = require('../cli/release.cjs');
const rt = require('../core/runtimeRoot.cjs');

function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts }).trim();
}
function write(root, rel, s) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), s); }
const read = (p) => fs.readFileSync(p, 'utf8');
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } };

/** seed 仓(master)→ bare origin → work 克隆;返回各路径。 */
function setup() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rel-')));
  const seed = path.join(dir, 'seed'); fs.mkdirSync(seed);
  git(seed, ['init', '-q', '-b', 'master']);
  git(seed, ['config', 'user.email', 't@t.t']); git(seed, ['config', 'user.name', 't']); git(seed, ['config', 'commit.gpgsign', 'false']);
  write(seed, 'core/x.cjs', "module.exports = 'v1';\n");
  write(seed, 'cli/index.cjs', "console.log('cli v1');\n");
  write(seed, 'server/server.cjs', "// server v1\n");
  write(seed, 'package.json', '{"name":"demo","version":"1.0.0"}\n');
  write(seed, 'test/t.cjs', "// 测试文件不该进发布副本\n");
  write(seed, 'docs/a.md', '# 文档不该进发布副本\n');
  git(seed, ['add', '-A']); git(seed, ['commit', '-q', '-m', 'v1']);
  const origin = path.join(dir, 'origin.git');
  git(dir, ['clone', '-q', '--bare', seed, origin]);
  const work = path.join(dir, 'work');
  git(dir, ['clone', '-q', origin, work]);
  git(work, ['config', 'user.email', 't@t.t']); git(work, ['config', 'user.name', 't']); git(work, ['config', 'commit.gpgsign', 'false']);
  return { dir, seed, origin, work, dest: path.join(dir, 'release') };
}

/** 从另一个克隆往 origin/master 推一个新提交,返回其 sha。 */
function pushFromElsewhere(t, rel, content, msg) {
  const w2 = path.join(t.dir, 'work2-' + Date.now().toString(36));
  git(t.dir, ['clone', '-q', t.origin, w2]);
  git(w2, ['config', 'user.email', 't@t.t']); git(w2, ['config', 'user.name', 't']); git(w2, ['config', 'commit.gpgsign', 'false']);
  write(w2, rel, content);
  git(w2, ['add', '-A']); git(w2, ['commit', '-q', '-m', msg]); git(w2, ['push', '-q', 'origin', 'master']);
  return git(w2, ['rev-parse', 'HEAD']);
}

test('detectTrunk:按 origin/HEAD 认主干,不写死 main', () => {
  const t = setup();
  assert.equal(detectTrunk(t.work), 'master');
  clean(t.dir);
});

test('release:只导出运行期文件 + RELEASE.json 记 origin/master 的 commit', () => {
  const t = setup();
  const r = release({ source: t.work, dest: t.dest });
  assert.equal(r.ok, true);
  for (const f of ['core/x.cjs', 'cli/index.cjs', 'server/server.cjs', 'package.json', 'RELEASE.json']) {
    assert.ok(fs.existsSync(path.join(t.dest, f)), `发布副本应含 ${f}`);
  }
  assert.ok(!fs.existsSync(path.join(t.dest, 'test')), '测试目录不进发布副本');
  assert.ok(!fs.existsSync(path.join(t.dest, 'docs')), '文档目录不进发布副本');
  assert.ok(!fs.existsSync(path.join(t.dest, '.git')), '发布副本绝不能是 git 检出');
  const stamp = JSON.parse(read(path.join(t.dest, 'RELEASE.json')));
  assert.equal(stamp.commit, git(t.work, ['rev-parse', 'origin/master']));
  assert.equal(stamp.trunk, 'master');
  assert.match(stamp.releasedAt, /^\d{4}-\d{2}-\d{2}T/);
  clean(t.dir);
});

test('治本证据:来源检出切到功能分支 + 留未提交改动,发布副本仍等于 origin/master;来源仓索引与工作区分毫不动', () => {
  const t = setup();
  // 主工位被某个对话切到功能分支、改了 cli、还留着没提交的 core 改动 —— 病根现场
  git(t.work, ['checkout', '-q', '-b', 'feat/x']);
  write(t.work, 'cli/index.cjs', "console.log('cli BROKEN on feature branch');\n");
  git(t.work, ['add', '-A']); git(t.work, ['commit', '-q', '-m', 'feat: 改坏 cli(未推)']);
  write(t.work, 'core/x.cjs', "module.exports = 'DIRTY uncommitted';\n");
  const statusBefore = git(t.work, ['status', '--porcelain']);
  assert.match(statusBefore, /core\/x\.cjs/, '前置:工作区确实脏');

  const r = release({ source: t.work, dest: t.dest });
  assert.equal(r.ok, true);
  assert.equal(read(path.join(t.dest, 'cli', 'index.cjs')), "console.log('cli v1');\n", '发布副本必须是 origin/master 的版本,不是分支上改坏的');
  assert.equal(read(path.join(t.dest, 'core', 'x.cjs')), "module.exports = 'v1';\n", '未提交改动不得漏进发布副本');

  // 来源仓一根毛都没动
  assert.equal(git(t.work, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feat/x', '不许把主工位切走');
  assert.equal(git(t.work, ['status', '--porcelain']), statusBefore, '工作区状态原样');
  assert.equal(git(t.work, ['diff', '--cached', '--name-only']), '', '不许污染来源仓的索引(临时索引导出)');
  clean(t.dir);
});

test('release:连发两次不留 .new/.old 残渣;推了新 master 后再发布,副本跟上;releaseStatus 能算落后', () => {
  const t = setup();
  release({ source: t.work, dest: t.dest });
  release({ source: t.work, dest: t.dest });
  assert.ok(!fs.existsSync(t.dest + '.new'), '无 .new 残渣');
  assert.ok(!fs.existsSync(t.dest + '.old'), '无 .old 残渣');

  const sha2 = pushFromElsewhere(t, 'cli/index.cjs', "console.log('cli v2');\n", 'v2');
  const r2 = release({ source: t.work, dest: t.dest });
  assert.equal(r2.stamp.commit, sha2, 'release 自带 fetch,发布的是远程最新主干');
  assert.equal(read(path.join(t.dest, 'cli', 'index.cjs')), "console.log('cli v2');\n");
  const s0 = releaseStatus({ source: t.work, dest: t.dest });
  assert.equal(s0.exists, true); assert.equal(s0.behind, 0);

  pushFromElsewhere(t, 'core/x.cjs', "module.exports = 'v3';\n", 'v3');
  git(t.work, ['fetch', '-q', 'origin']);
  const s1 = releaseStatus({ source: t.work, dest: t.dest });
  assert.equal(s1.behind, 1, '副本落后 origin/master 1 个提交');
  assert.match(s1.text, /落后/);
  clean(t.dir);
});

test('release --commit <sha>:钉死某个提交(回滚用)', () => {
  const t = setup();
  const sha1 = git(t.work, ['rev-parse', 'origin/master']);
  pushFromElsewhere(t, 'cli/index.cjs', "console.log('cli v2');\n", 'v2');
  git(t.work, ['fetch', '-q', 'origin']);
  const r = release({ source: t.work, dest: t.dest, commit: sha1 });
  assert.equal(r.stamp.commit, sha1);
  assert.equal(read(path.join(t.dest, 'cli', 'index.cjs')), "console.log('cli v1');\n");
  clean(t.dir);
});

test('release:代码根不是 git 检出(安装版/发布副本自身)→ 友好跳过,不报错', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rel-nogit-')));
  const r = release({ source: dir, dest: path.join(dir, 'out') });
  assert.equal(r.ok, true); assert.equal(r.skipped, true);
  assert.match(r.text, /无需发布/);
  assert.ok(!fs.existsSync(path.join(dir, 'out')));
  clean(dir);
});

test('releaseStatus:副本不存在 → exists=false 且文案说未发布', () => {
  const t = setup();
  const s = releaseStatus({ source: t.work, dest: t.dest });
  assert.equal(s.exists, false);
  assert.match(s.text, /未发布/);
  clean(t.dir);
});

test('resolveHookCliRoot:环境变量 > 自身非检出 > 发布副本 > 拒装(永不指进 git 检出)', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hookroot-')));
  const checkout = path.join(dir, 'checkout'); fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
  const installed = path.join(dir, 'installed'); fs.mkdirSync(installed);
  const rel = path.join(dir, 'rel');

  // ① 环境变量最优先(测试隔离专用)
  const e = rt.resolveHookCliRoot({ env: { DASHBOARD_HOOK_CLI_ROOT: installed }, codeRoot: checkout, releaseHome: rel });
  assert.equal(e.root, installed); assert.equal(e.why, 'env');
  // ② 自身不是检出(安装版 / 发布副本自己)→ 指向自己
  const s = rt.resolveHookCliRoot({ env: {}, codeRoot: installed, releaseHome: rel });
  assert.equal(s.root, installed); assert.equal(s.why, 'self');
  // ③ 自身是检出 + 发布副本不存在 → 拒装并指路 release
  assert.throws(() => rt.resolveHookCliRoot({ env: {}, codeRoot: checkout, releaseHome: rel }), /release/);
  // ④ 自身是检出 + 发布副本存在 → 指向发布副本
  fs.mkdirSync(path.join(rel, 'cli'), { recursive: true }); fs.writeFileSync(path.join(rel, 'cli', 'index.cjs'), '');
  const r = rt.resolveHookCliRoot({ env: {}, codeRoot: checkout, releaseHome: rel });
  assert.equal(r.root, rel); assert.equal(r.why, 'release');
  clean(dir);
});
