'use strict';
/**
 * releaseWeb.test.cjs —— 发布副本带上网页界面(SERVER-RUNS-ON-LIVE-CHECKOUT,负责人 0906 拍板 d1=A「发布时现场构建」)。
 *
 * 要钉死的行为:
 *   · 默认发布会现场构建前端,产物落进副本 web/dist,印章记 web.builtFrom = 那个 commit;
 *   · 构建失败 = 整单失败:旧副本原封不动、不留 .new 残渣(绝不发出"后台新、界面旧"的半拉子);
 *   · --skip-web 只发后台,印章记下来,输出明确警告"这份副本起不出界面";
 *   · 真构建器的两道机器闸:build 脚本不再是 `vite build` → 当场失败指路;前端依赖没装 → 指路 npm ci;
 *   · 构建树里必须有 core/(web/vite.config.ts 会 require('../core/boardSchema.cjs'));
 *   · 收尾摘软链而不是递归删:来源检出的 node_modules 一根毫毛都不能少(skill §14-4)。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { release, releaseStatus, buildWebDist } = require('../cli/release.cjs');

function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts }).trim();
}
function write(root, rel, s) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), s); }
const read = (p) => fs.readFileSync(p, 'utf8');
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } };

/**
 * 一个"带前端的看板代码仓":seed(master)→ bare origin → work 克隆。
 * web/package.json 的 build 脚本照真仓写成 `vite build`;vite.config 照真仓 require ../core。
 */
function setup() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'relweb-')));
  const seed = path.join(dir, 'seed'); fs.mkdirSync(seed);
  git(seed, ['init', '-q', '-b', 'master']);
  git(seed, ['config', 'user.email', 't@t.t']); git(seed, ['config', 'user.name', 't']); git(seed, ['config', 'commit.gpgsign', 'false']);
  write(seed, 'core/x.cjs', "module.exports = 'v1';\n");
  write(seed, 'core/boardSchema.cjs', "module.exports = { STATUS: ['未开工'] };\n");
  write(seed, 'cli/index.cjs', "console.log('cli v1');\n");
  write(seed, 'server/server.cjs', '// server v1\n');
  write(seed, 'package.json', '{"name":"demo","version":"1.0.0"}\n');
  write(seed, 'web/package.json', '{"name":"demo-web","private":true,"scripts":{"build":"vite build"}}\n');
  write(seed, 'web/vite.config.ts', "// 真仓这里 require('../core/boardSchema.cjs')\n");
  write(seed, 'web/src/main.ts', "console.log('app v1')\n");
  git(seed, ['add', '-A']); git(seed, ['commit', '-q', '-m', 'v1']);
  const origin = path.join(dir, 'origin.git');
  git(dir, ['clone', '-q', '--bare', seed, origin]);
  const work = path.join(dir, 'work');
  git(dir, ['clone', '-q', origin, work]);
  git(work, ['config', 'user.email', 't@t.t']); git(work, ['config', 'user.name', 't']); git(work, ['config', 'commit.gpgsign', 'false']);
  return { dir, seed, origin, work, dest: path.join(dir, 'release') };
}

/** 在来源检出里装一个"假 vite":跑起来就把构建树的实情写进 dist,供断言复查。 */
function installStubVite(work, body) {
  const bin = path.join(work, 'web', 'node_modules', 'vite', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'vite.js'), body);
  return path.join(bin, 'vite.js');
}

const STUB_VITE_OK = `
'use strict';
// 假 vite:验证构建树的样子,再产出 dist。真 vite 的行为不在本测试范围。
const fs = require('node:fs'), path = require('node:path');
if (process.argv[2] !== 'build') { console.error('期望 build 子命令'); process.exit(2); }
const cwd = process.cwd();
const info = {
  cwd,
  hasCoreSibling: fs.existsSync(path.join(cwd, '..', 'core', 'boardSchema.cjs')),
  hasNodeModules: fs.existsSync(path.join(cwd, 'node_modules', 'vite', 'bin', 'vite.js')),
  hasSrc: fs.existsSync(path.join(cwd, 'src', 'main.ts')),
};
fs.mkdirSync(path.join(cwd, 'dist', 'assets'), { recursive: true });
fs.writeFileSync(path.join(cwd, 'dist', 'index.html'), '<!doctype html><title>built</title>');
fs.writeFileSync(path.join(cwd, 'dist', 'assets', 'app.js'), '// built');
fs.writeFileSync(path.join(cwd, 'dist', 'build-info.json'), JSON.stringify(info));
`;

/** 假构建器(注入给 release,替掉真 buildWebDist):只写一个产物,快。 */
function fakeBuilder(outRoot) {
  const dist = path.join(outRoot, 'web', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>fake</title>');
  return { files: 1, ms: 1, dist };
}

test('release 默认带界面:产物进副本 web/dist,印章记它同源于哪个 commit', () => {
  const t = setup();
  let sawSha = null;
  const r = release({ source: t.work, dest: t.dest }, {
    buildWeb: ({ sha, outRoot }) => { sawSha = sha; return fakeBuilder(outRoot); },
  });
  const head = git(t.work, ['rev-parse', 'origin/master']);
  assert.equal(r.ok, true);
  assert.equal(sawSha, head, '构建用的必须是发布的那个 commit,不是工作区');
  assert.ok(fs.existsSync(path.join(t.dest, 'web', 'dist', 'index.html')), '副本里应有网页界面');
  const stamp = JSON.parse(read(path.join(t.dest, 'RELEASE.json')));
  assert.equal(stamp.web.builtFrom, head);
  assert.ok(!stamp.web.skipped);
  assert.match(r.text, /界面已现场构建/);
  clean(t.dir);
});

test('构建失败 = 整单失败:旧副本原封不动,不留 .new 残渣', () => {
  const t = setup();
  release({ source: t.work, dest: t.dest }, { buildWeb: ({ outRoot }) => fakeBuilder(outRoot) });
  const before = JSON.parse(read(path.join(t.dest, 'RELEASE.json')));
  fs.writeFileSync(path.join(t.dest, 'web', 'dist', 'index.html'), '<!doctype html><title>上一版界面</title>');

  assert.throws(
    // force:同一个提交连发两次,默认会走【已是这一版就不重发】的快路径(AD-20260907-LAUNCH-SKIP-REBUILD),
    // 那样就压根构建不到、也就验不到构建失败=整单失败。本例要的正是那次构建,所以强制重发。
    () => release({ source: t.work, dest: t.dest, 'no-fetch': true, force: true }, { buildWeb: () => { throw new Error('前端构建失败,整单不发(副本保持原样):Boom'); } }),
    /前端构建失败/,
  );
  const after = JSON.parse(read(path.join(t.dest, 'RELEASE.json')));
  assert.deepEqual(after, before, '发布失败不许动旧副本的印章');
  assert.match(read(path.join(t.dest, 'web', 'dist', 'index.html')), /上一版界面/, '旧界面必须原封不动');
  assert.ok(!fs.existsSync(t.dest + '.new'), '失败要清掉 .new,不留残渣');
  clean(t.dir);
});

test('--skip-web:只发后台,印章记下来,输出明确说这份副本起不出界面', () => {
  const t = setup();
  let called = false;
  const r = release({ source: t.work, dest: t.dest, 'skip-web': true }, { buildWeb: () => { called = true; return fakeBuilder(t.dest); } });
  assert.equal(called, false, '--skip-web 就不该去构建');
  const stamp = JSON.parse(read(path.join(t.dest, 'RELEASE.json')));
  assert.equal(stamp.web.skipped, true);
  assert.match(r.text, /前端未构建/);
  assert.ok(!fs.existsSync(path.join(t.dest, 'web', 'dist')), '没构建就不该有界面产物');

  // 体检口径:副本缺界面要被明说,别让人以为"发了就能看"
  const st = releaseStatus({ source: t.work, dest: t.dest });
  assert.equal(st.webDist, false);
  assert.match(st.text, /没有网页界面/);
  clean(t.dir);
});

test('真构建器:构建树里带 core/、依赖走软链、产物进副本;收尾只摘软链不删来源依赖', () => {
  const t = setup();
  const viteBin = installStubVite(t.work, STUB_VITE_OK);
  const outRoot = path.join(t.dir, 'out'); fs.mkdirSync(outRoot);
  const head = git(t.work, ['rev-parse', 'origin/master']);

  const got = buildWebDist({ source: t.work, sha: head, outRoot });
  assert.ok(got.files >= 3, '产物文件应被拷全');

  const info = JSON.parse(read(path.join(outRoot, 'web', 'dist', 'build-info.json')));
  assert.equal(info.hasCoreSibling, true, '构建树必须带 core/(vite.config 要 require ../core/boardSchema.cjs)');
  assert.equal(info.hasNodeModules, true, '构建树里要能看到来源检出的依赖(软链)');
  assert.equal(info.hasSrc, true, '前端源码要来自那个 commit');
  assert.ok(!info.cwd.startsWith(t.work), '构建必须在临时目录里进行,不许在来源检出里就地建');

  assert.ok(fs.existsSync(viteBin), '来源检出的 node_modules 必须毫发无损(软链只能摘,不能递归删)');
  clean(t.dir);
});

test('真构建器的两道机器闸:build 脚本漂了 / 依赖没装,都当场失败并指路', () => {
  const t = setup();
  const head = git(t.work, ['rev-parse', 'origin/master']);
  const outRoot = path.join(t.dir, 'out'); fs.mkdirSync(outRoot);

  // ① 依赖没装
  assert.throws(() => buildWebDist({ source: t.work, sha: head, outRoot }), /npm ci/);

  // ② 依赖装了,但 build 脚本改了口径
  installStubVite(t.work, STUB_VITE_OK);
  write(t.work, 'web/package.json', '{"name":"demo-web","private":true,"scripts":{"build":"rollup -c"}}\n');
  git(t.work, ['add', '-A']); git(t.work, ['commit', '-q', '-m', '换构建工具']); git(t.work, ['push', '-q', 'origin', 'master']);
  const head2 = git(t.work, ['rev-parse', 'origin/master']);
  assert.throws(() => buildWebDist({ source: t.work, sha: head2, outRoot }), /build 脚本变成了/);
  clean(t.dir);
});

test('那个 commit 根本没有前端源码 → 明确报错并指路 --skip-web', () => {
  const t = setup();
  const head = git(t.work, ['rev-parse', 'origin/master']);
  git(t.work, ['rm', '-r', '-q', 'web']);
  git(t.work, ['commit', '-q', '-m', '删掉前端']); git(t.work, ['push', '-q', 'origin', 'master']);
  const head2 = git(t.work, ['rev-parse', 'origin/master']);
  assert.notEqual(head2, head);
  const outRoot = path.join(t.dir, 'out'); fs.mkdirSync(outRoot);
  assert.throws(() => buildWebDist({ source: t.work, sha: head2, outRoot }), /没有前端源码|没有 web\/package\.json/);
  clean(t.dir);
});
