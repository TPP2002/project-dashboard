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
 *   · hook 的 CLI 根取值规则「永不指进 git 检出」:环境变量 > 自身非检出 > 发布副本 > 拒装;
 *   · 副本根带 board/kb 短别名垫片,displayCliCommand 有垫片就用短名(AUD-CLI-BATCH-AND-AUTOPROJECT ④/审计 A11);
 *   · 【自举】改的要是发布工具本身,起头的旧工具不许自己铺副本 —— 要把新版导到暂存目录、由新版一次铺成
 *     (AD-20260907-RELEASE-SELF-BOOTSTRAP:病是"连跑两次才真生效",跑了也可能没生效,比忘了跑更隐蔽);
 *   · 【快路径】副本已经是这一版(同一个提交 + 同一版发布工具)就不重发 —— 启动器每次双击都跑 release,
 *     白重建一次界面实测 5.2s(AD-20260907-LAUNCH-SKIP-REBUILD)。
 *
 * 【0906 口径变更】release 默认会现场构建前端(SERVER-RUNS-ON-LIVE-CHECKOUT d1=A)。本文件的临时仓没有前端源码,
 * 关心的也不是界面,所以调用一律显式加 `skip-web`——不是绕过闸门,是这些用例本来就只验后台那半边。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { release, releaseStatus, detectTrunk, staleReleaseLogic, RELEASE_LOGIC_PATHS, BOOTSTRAP_ENV } = require('../cli/release.cjs');
const REPO_ROOT = path.resolve(__dirname, '..');
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

/** 从另一个克隆往 origin/master 推一批文件(一个提交),返回其 sha。 */
function pushFilesFromElsewhere(t, files, msg) {
  const w2 = path.join(t.dir, 'work2-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
  git(t.dir, ['clone', '-q', t.origin, w2]);
  git(w2, ['config', 'user.email', 't@t.t']); git(w2, ['config', 'user.name', 't']); git(w2, ['config', 'commit.gpgsign', 'false']);
  for (const [rel, content] of Object.entries(files)) write(w2, rel, content);
  git(w2, ['add', '-A']); git(w2, ['commit', '-q', '-m', msg]); git(w2, ['push', '-q', 'origin', 'master']);
  return git(w2, ['rev-parse', 'HEAD']);
}
/** 单文件版(老用例用的就是它)。 */
function pushFromElsewhere(t, rel, content, msg) { return pushFilesFromElsewhere(t, { [rel]: content }, msg); }

/**
 * 假的"新版 CLI":不真发布,只把收到的参数和自举标记写进 --dest。
 * 它就是证据 —— 副本里出现 BY-NEW-TOOL.json,说明【铺副本的是新版工具】,不是起头那个旧的。
 */
const FAKE_NEW_CLI = [
  "const fs = require('node:fs'); const path = require('node:path');",
  "const args = process.argv.slice(2);",
  "const get = (k) => { const i = args.indexOf('--' + k); return i < 0 ? null : args[i + 1]; };",
  "const dest = get('dest');",
  "fs.mkdirSync(dest, { recursive: true });",
  "fs.writeFileSync(path.join(dest, 'BY-NEW-TOOL.json'),",
  "  JSON.stringify({ args, boot: process.env.DASHBOARD_RELEASE_BOOTSTRAP }));",
  "process.stdout.write(JSON.stringify({ ok: true, dest,",
  "  stamp: { commit: get('commit'), byNewTool: true }, text: '✔ 新版发布工具把副本铺好了' }));",
].join('\n') + '\n';

test('detectTrunk:按 origin/HEAD 认主干,不写死 main', () => {
  const t = setup();
  assert.equal(detectTrunk(t.work), 'master');
  clean(t.dir);
});

test('release:只导出运行期文件 + RELEASE.json 记 origin/master 的 commit', () => {
  const t = setup();
  const r = release({ source: t.work, dest: t.dest, 'skip-web': true });
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

  const r = release({ source: t.work, dest: t.dest, 'skip-web': true });
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
  release({ source: t.work, dest: t.dest, 'skip-web': true });
  release({ source: t.work, dest: t.dest, 'skip-web': true });
  assert.ok(!fs.existsSync(t.dest + '.new'), '无 .new 残渣');
  assert.ok(!fs.existsSync(t.dest + '.old'), '无 .old 残渣');
  assert.ok(!fs.existsSync(t.dest + '.boot'), '无 .boot 残渣');

  const sha2 = pushFromElsewhere(t, 'cli/index.cjs', "console.log('cli v2');\n", 'v2');
  const r2 = release({ source: t.work, dest: t.dest, 'skip-web': true });
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
  const r = release({ source: t.work, dest: t.dest, commit: sha1, 'skip-web': true });
  assert.equal(r.stamp.commit, sha1);
  assert.equal(read(path.join(t.dest, 'cli', 'index.cjs')), "console.log('cli v1');\n");
  clean(t.dir);
});

test('release:代码根不是 git 检出(安装版/发布副本自身)→ 友好跳过,不报错', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rel-nogit-')));
  const r = release({ source: dir, dest: path.join(dir, 'out'), 'skip-web': true });
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

test('release:副本根写出 board/kb 短别名垫片,印章记下来,垫片真能当命令跑(A11)', () => {
  const t = setup();
  const out = release({ source: t.work, dest: t.dest, 'no-fetch': true, 'skip-web': true });
  assert.deepEqual(out.stamp.shims, ['board.cmd', 'board.sh', 'kb.cmd', 'kb.sh']);
  for (const f of out.stamp.shims) assert.ok(fs.existsSync(path.join(t.dest, f)), `缺垫片 ${f}`);
  // 内容必须指向【本目录】的 cli/index.cjs —— 写死绝对路径的话,副本一挪就废
  assert.match(read(path.join(t.dest, 'board.cmd')), /%~dp0cli/);
  assert.match(read(path.join(t.dest, 'kb.sh')), /dirname "\$0"/);

  // 真跑一遍:垫片转发参数、退出码照传(种子仓的 cli/index.cjs 只 console.log 一行)
  const shim = path.join(t.dest, process.platform === 'win32' ? 'board.cmd' : 'board.sh');
  // Windows 上 .cmd 得由 cmd.exe 起(execFileSync 直接跑 .cmd 会 ENOEXEC);别用 shell:true,那是拼字符串
  const ran = process.platform === 'win32'
    ? execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', shim, 'whatever'], { encoding: 'utf8', windowsHide: true })
    : execFileSync(shim, ['whatever'], { encoding: 'utf8', windowsHide: true });
  assert.match(ran, /cli v1/);
  clean(t.dir);
});

test('displayCliCommand:有垫片就用短名,没垫片回落 node 长写法,路径带空白一律不用垫片', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shim-')));
  const checkout = path.join(dir, 'checkout'); fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
  const rel = path.join(dir, 'rel');
  fs.mkdirSync(path.join(rel, 'cli'), { recursive: true }); fs.writeFileSync(path.join(rel, 'cli', 'index.cjs'), '');
  const opts = { env: {}, codeRoot: checkout, releaseHome: rel };

  // 没垫片 → 老的 node 长写法一字不变(旧副本、安装版都还是这个形态)
  assert.equal(rt.displayCliCommand(opts), `node ${rel.replace(/\\/g, '/')}/cli/index.cjs`);
  assert.equal(rt.findCliShim(rel), null);

  // 有垫片 → 短名(平台各认各的后缀)
  fs.writeFileSync(path.join(rel, 'board.cmd'), '');
  fs.writeFileSync(path.join(rel, 'board.sh'), '');
  const ext = process.platform === 'win32' ? '.cmd' : '.sh';
  assert.equal(rt.shimExt(), ext);
  assert.equal(rt.displayCliCommand(opts), `${rel.replace(/\\/g, '/')}/board${ext}`);
  assert.equal(rt.shimExt('linux'), '.sh');
  assert.equal(rt.shimExt('win32'), '.cmd');

  // 路径带空白 → 宁可长也不给一个"PowerShell 里粘不动"的命令(引号包起来就成了字符串,不是命令)
  const spaced = path.join(dir, 'My Stuff');
  fs.mkdirSync(path.join(spaced, 'cli'), { recursive: true }); fs.writeFileSync(path.join(spaced, 'cli', 'index.cjs'), '');
  fs.writeFileSync(path.join(spaced, 'board.cmd'), ''); fs.writeFileSync(path.join(spaced, 'board.sh'), '');
  assert.equal(rt.displayCliCommand({ env: {}, codeRoot: checkout, releaseHome: spaced }),
    `node "${spaced.replace(/\\/g, '/')}/cli/index.cjs"`);
  clean(dir);
});

// ——— 自举发布(AD-20260907-RELEASE-SELF-BOOTSTRAP)———
// 病:发布命令是【副本自己的 CLI】跑的,所以改了发布工具本身时,起头的永远是旧工具 ——
// 它把新代码铺进副本,新代码带来的发布行为却一次都没作用过,得连跑两次才真生效。

test('自举:目标 commit 的发布工具变了 → 旧工具不自己铺副本,改由【新版】一次铺成', () => {
  const t = setup();
  // 主干上换了一份发布工具(cli/release.cjs 是判据;cli/index.cjs 换成会留证据的假 CLI)
  const sha = pushFilesFromElsewhere(t, { 'cli/release.cjs': '// 新版发布工具 v2\n', 'cli/index.cjs': FAKE_NEW_CLI }, 'v2:换发布工具');
  const out = release({ source: t.work, dest: t.dest, 'skip-web': true });

  // 副本是新版铺的 —— 旧工具连碰都没碰(它自己发的话这里会是 RELEASE.json)
  assert.ok(fs.existsSync(path.join(t.dest, 'BY-NEW-TOOL.json')), '副本必须由新版发布工具铺出来');
  assert.ok(!fs.existsSync(path.join(t.dest, 'RELEASE.json')), '旧工具不许抢先把副本铺了');
  const rec = JSON.parse(read(path.join(t.dest, 'BY-NEW-TOOL.json')));
  assert.equal(rec.args[0], 'release');
  assert.equal(rec.boot, 'child', '子进程必须带自举标记 —— 否则可能一层套一层');
  assert.equal(rec.args[rec.args.indexOf('--commit') + 1], sha, '同一次发布必须钉死在同一个 sha 上');
  assert.equal(rec.args[rec.args.indexOf('--ref-label') + 1], 'origin/master', '来源标签照传,印章别退化成一串 sha');
  assert.ok(rec.args.includes('--no-fetch'), '父进程刚 fetch 过,子进程不该再 fetch 一遍');
  assert.ok(rec.args.includes('--skip-web'), '父进程的 --skip-web 要传下去,不然子进程会去建界面');

  // 种子仓只有 core/x.cjs,runtimeRoot/atomicWrite 本来就不在里头,一并算"对不上"——判据是"有没有差",不是"差几个"
  assert.ok(out.bootstrapped.includes('cli/release.cjs'), '要报出到底哪个发布逻辑变了,不然人不知道该看哪');
  assert.match(out.text, /新版发布工具把副本铺好了/, '输出该是新版的原话,不是旧工具编的');
  assert.match(out.text, /自举/, '得告诉人这次为什么多跑了一趟');
  assert.ok(!fs.existsSync(t.dest + '.boot'), '暂存目录用完要清掉');
  clean(t.dir);
});

test('自举:新版发布工具跑挂 → 整单失败,旧副本原封不动(和构建失败一个口径)', () => {
  const t = setup();
  release({ source: t.work, dest: t.dest, 'skip-web': true });   // 先有一份能用的旧副本
  const stampBefore = read(path.join(t.dest, 'RELEASE.json'));

  pushFilesFromElsewhere(t, { 'cli/release.cjs': '// v2\n', 'cli/index.cjs': "process.stderr.write('新工具炸了'); process.exit(1);\n" }, 'v2:新工具是坏的');
  assert.throws(() => release({ source: t.work, dest: t.dest, 'skip-web': true }), /新版发布工具没跑通/);
  assert.equal(read(path.join(t.dest, 'RELEASE.json')), stampBefore, '副本必须原封不动 —— 宁可不发,也不发半拉子');
  assert.ok(!fs.existsSync(t.dest + '.boot'), '失败了也不许留暂存目录');
  clean(t.dir);
});

test('--no-bootstrap:照旧用旧工具发,但结尾明说【新逻辑这次没生效、要再跑一次】', () => {
  const t = setup();
  pushFilesFromElsewhere(t, { 'cli/release.cjs': '// 新版发布工具 v2\n' }, 'v2:换发布工具');
  const out = release({ source: t.work, dest: t.dest, 'skip-web': true, 'no-bootstrap': true });
  assert.equal(out.ok, true);
  assert.ok(fs.existsSync(path.join(t.dest, 'RELEASE.json')), '关掉自举就该照旧发');
  assert.match(out.text, /旧版发布工具/);
  assert.match(out.text, /再跑一次/, '不提醒的话,人看见 ✔ 就以为发完了 —— 这正是本卡要治的病');
  clean(t.dir);
});

test('不递归:进程带了自举标记就绝不再生一层(硬上限=最多多跑一次)', () => {
  const t = setup();
  pushFilesFromElsewhere(t, { 'cli/release.cjs': '// v2\n', 'cli/index.cjs': FAKE_NEW_CLI }, 'v2:换发布工具');
  const saved = process.env[BOOTSTRAP_ENV];
  process.env[BOOTSTRAP_ENV] = 'child';
  try {
    const out = release({ source: t.work, dest: t.dest, 'skip-web': true });
    assert.ok(!fs.existsSync(path.join(t.dest, 'BY-NEW-TOOL.json')), '带标记时绝不许再起子进程');
    assert.ok(fs.existsSync(path.join(t.dest, 'RELEASE.json')), '不自举就自己把这一单发完,别撂挑子');
    assert.match(out.text, /自举跑完发布工具仍对不上/, '这种反常状态要喊出来,不能闷声发完');
  } finally {
    if (saved === undefined) delete process.env[BOOTSTRAP_ENV]; else process.env[BOOTSTRAP_ENV] = saved;
  }
  clean(t.dir);
});

test('收敛证据:发布工具与目标 commit 一模一样 → 不自举、一次发完(不会没完没了地重跑)', () => {
  const t = setup();
  // 把【本仓真实的发布逻辑文件】推上主干 —— 这就是自举子进程眼里的世界:它跑的和它要发的同源
  const real = {};
  for (const rel of RELEASE_LOGIC_PATHS) real[rel] = read(path.join(REPO_ROOT, ...rel.split('/')));
  const sha = pushFilesFromElsewhere(t, real, '把真实发布工具推上主干');

  assert.deepEqual(staleReleaseLogic(REPO_ROOT, t.work, sha), [], '同一份代码不该被判成两份(判错=每次发布白跑一趟)');
  const out = release({ source: t.work, dest: t.dest, 'skip-web': true });
  assert.equal(out.bootstrapped, undefined, '一致就不该自举');
  assert.ok(fs.existsSync(path.join(t.dest, 'RELEASE.json')));
  assert.ok(!/自举|旧版发布工具/.test(out.text), '一致时不该说这些话,免得每次发布都刷一遍噪音');
  clean(t.dir);
});

test('目标 commit 里没有发布工具(极老提交 / 回滚到它诞生之前)→ 不比、不自举、也不提醒', () => {
  const t = setup();
  const sha = git(t.work, ['rev-parse', 'origin/master']);
  assert.deepEqual(staleReleaseLogic(REPO_ROOT, t.work, sha), []);
  const out = release({ source: t.work, dest: t.dest, 'skip-web': true });
  assert.ok(fs.existsSync(path.join(t.dest, 'RELEASE.json')));
  assert.ok(!/自举|旧版发布工具/.test(out.text));
  clean(t.dir);
});

// ——— 已经是这一版就不重发(AD-20260907-LAUNCH-SKIP-REBUILD)———
// 启动器每次双击都无条件跑一遍 release,而绝大多数双击时主干根本没动:重导 50 个文件 + 重建界面
// 实测 6.2s,纯属让人干等。快路径要能省掉这一遍,又不能把"该发的"也省掉。

/** 假的界面构建:只数被叫了几次、顺手把 dist 落出来(真 vite 要五秒,单测不跑它)。 */
function countingBuild(counter) {
  return ({ outRoot }) => {
    counter.n++;
    write(outRoot, 'web/dist/index.html', '<html>假界面</html>');
    return { files: 1, ms: 1, dist: path.join(outRoot, 'web', 'dist') };
  };
}

test('快路径:副本已经是这一版 → 不重导、不重建;主干一动就照发不误', () => {
  const t = setup();
  const c = { n: 0 };
  const deps = { buildWeb: countingBuild(c) };

  const r1 = release({ source: t.work, dest: t.dest }, deps);
  assert.equal(c.n, 1);
  assert.ok(!r1.upToDate, '头一次当然要发');
  assert.ok(r1.stamp.logic, '印章要记下【是哪版发布工具铺的】,快路径全靠它');

  // 留个记号:真重发是目录级换名,记号必然跟着旧目录一起没
  write(t.dest, 'MARK.txt', 'still here');
  const r2 = release({ source: t.work, dest: t.dest }, deps);
  assert.equal(r2.upToDate, true, '同一个提交 + 同一版发布工具 → 不该重发');
  assert.equal(c.n, 1, '界面不许再建一遍 —— 这一遍就是启动器让人干等的那五秒');
  assert.ok(fs.existsSync(path.join(t.dest, 'MARK.txt')), '副本目录压根没被换过');
  assert.match(r2.text, /没重发/);

  // 主干动了 → 老老实实重发
  pushFromElsewhere(t, 'core/x.cjs', "module.exports = 'v2';\n", 'v2');
  const r3 = release({ source: t.work, dest: t.dest }, deps);
  assert.ok(!r3.upToDate, '主干动了还跳过,就等于合了却不生效');
  assert.equal(c.n, 2);
  assert.ok(!fs.existsSync(path.join(t.dest, 'MARK.txt')), '真发布会把目录整个换掉');
  assert.equal(read(path.join(t.dest, 'core', 'x.cjs')), "module.exports = 'v2';\n");
  clean(t.dir);
});

test('快路径:--force 照发;印章来路不明(老版本没记发布工具指纹)也照发', () => {
  const t = setup();
  release({ source: t.work, dest: t.dest, 'skip-web': true });

  write(t.dest, 'MARK.txt', 'x');
  const rf = release({ source: t.work, dest: t.dest, 'skip-web': true, force: true });
  assert.ok(!rf.upToDate, '--force 就是要重发');
  assert.ok(!fs.existsSync(path.join(t.dest, 'MARK.txt')));

  // 0907 之前发出去的副本,印章里没有 logic —— 不知道是哪版工具铺的,一律重发一次补上
  const stampPath = path.join(t.dest, 'RELEASE.json');
  const stamp = JSON.parse(read(stampPath)); delete stamp.logic;
  fs.writeFileSync(stampPath, JSON.stringify(stamp));
  write(t.dest, 'MARK.txt', 'x');
  const r = release({ source: t.work, dest: t.dest, 'skip-web': true });
  assert.ok(!r.upToDate, '来路不明的副本不许跳过 —— 文件是新的、发布行为却可能是旧工具留下的');
  assert.ok(!fs.existsSync(path.join(t.dest, 'MARK.txt')));
  assert.ok(JSON.parse(read(stampPath)).logic, '重发后印章要把指纹补上,下次才跳得掉');
  clean(t.dir);
});

test('快路径:上一份是 --skip-web 发的(副本里没有界面),这次要界面 → 不许跳过', () => {
  const t = setup();
  const c = { n: 0 };
  release({ source: t.work, dest: t.dest, 'skip-web': true });
  const r = release({ source: t.work, dest: t.dest }, { buildWeb: countingBuild(c) });
  assert.ok(!r.upToDate, '副本里没界面还跳过,负责人打开看板只会看到占位页');
  assert.equal(c.n, 1);
  assert.ok(fs.existsSync(path.join(t.dest, 'web', 'dist', 'index.html')));
  clean(t.dir);
});
