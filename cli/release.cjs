'use strict';
/**
 * release.cjs —— 把 origin/<主干> 的运行期代码导出成【发布副本】(HOOK-CLI-POINTS-AT-LIVE-CHECKOUT,治法①)。
 *
 * 全机器各仓的 git hook 只认发布副本(见 core/runtimeRoot.cjs 头注)。本命令是"合进 master 之后让它生效"的那一步:
 * 负责人 0906 拍板走 A(收官序列手动跑;doctor / precheck 落后就提醒),不装计划任务。
 *
 * 【0906 扩容:看板网页服务也从这份副本起】(SERVER-RUNS-ON-LIVE-CHECKOUT,负责人拍板 d1=A)
 * 副本从此还带一份 web/dist:发布时把【同一个 commit 的前端源码】导到临时目录现场构建一次(见 buildWebDist)。
 * 这样界面与后台严格同源,启动器 `启动看板.bat` / `dashboard.sh` 直接从副本起服务,主工位怎么改都影响不到
 * 负责人在用的那份。构建失败 = 整单失败、旧副本原封不动 —— 绝不发出"后台新、界面旧"的半拉子。
 *
 * 治本点(和主工位彻底解耦):
 *   · 来源固定 = fetch 后的 origin/<主干>(主干名探测,不写死 main),**与来源检出此刻在哪条分支、
 *     有没有未提交改动完全无关**;`--commit <sha>` 可钉某个提交(回滚用);
 *   · 导出走【临时索引】(GIT_INDEX_FILE + read-tree + checkout-index --prefix):不碰来源仓的索引与工作区,
 *     也不依赖外部 tar/zip;
 *   · 先写 <dest>.new,再目录级换名(旧的挪 .old 后删)。hook 进程加载完不占文件,换名窗口极小;
 *     Windows 换名偶发被占,重试几次。
 *
 * 用法:node cli/index.cjs release [--commit <sha>] [--no-fetch] [--skip-web] [--source <检出>] [--dest <目录>]
 *   source 默认 = 当前运行的这份代码所在的检出;dest 默认 = ~/.claude/dashboard-release。
 *   代码根不是 git 检出(安装版 / 发布副本自己)→ 友好跳过。
 *   --skip-web:只发后台(紧急 CLI/hook 修复用),印章会记下来;那份副本起不出网页界面。
 *   --print-dest:只打印副本目录路径,什么都不做(启动器拿它当落脚点)。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const {
  CODE_ROOT, STAMP_NAME, RUNTIME_PATHS, WEB_SOURCE_PATHS, WEB_BUILD_DEPS_PATHS, WEB_DIST_REL,
  isGitCheckout, releaseHome, readStamp,
} = require('../core/runtimeRoot.cjs');
const { atomicWriteJsonSync, sleepMs } = require('../core/atomicWrite.cjs');

function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: opts.timeout || 20000,
    stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    input: opts.input, env: opts.env || process.env,
  }).trim();
}
function safeGit(repo, args, opts) { try { return git(repo, args, opts); } catch { return null; } }
const fwd = (p) => p.replace(/\\/g, '/');

/**
 * 探测远程主干分支名:先信 origin/HEAD,读不到再探 main/master(与 cleanup.cjs 同思路;
 * 那个文件此刻被 BOARD-CLEANUP-DELETES-MAIN 占着,不动它,这里自带一份)。
 */
function detectTrunk(repo) {
  const sym = safeGit(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (sym) { const b = sym.replace(/^origin\//, ''); if (b) return b; }
  for (const cand of ['main', 'master']) {
    if (safeGit(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${cand}`]) !== null) return cand;
  }
  return null;
}

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }

/**
 * 把某个 commit 的一批文件导到目标目录(临时索引,不碰来源仓的索引与工作区)。
 * @param {string} source 来源检出
 * @param {string} sha 提交
 * @param {string[]} files `git ls-tree -r --name-only` 出来的仓内相对路径
 * @param {string} destDir 导到哪(必须已存在)
 */
function exportFiles(source, sha, files, destDir) {
  const tmpIndex = path.join(os.tmpdir(), `dashboard-release-index-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    git(source, ['read-tree', sha], { env });
    // -c core.autocrlf=false:按 blob 原字节导出(和 git archive 一个口径),只让仓库自己的 .gitattributes 决定换行;
    // 不吃打包机的全局 autocrlf,免得同一 commit 在不同机器上导出不同字节。
    git(source, ['-c', 'core.autocrlf=false', 'checkout-index', '--stdin', `--prefix=${fwd(destDir)}/`], { env, input: files.join('\n') + '\n', timeout: 60000 });
  } finally {
    try { fs.unlinkSync(tmpIndex); } catch { /* 没建出来就算了 */ }
  }
}

/** 目录里的文件数(递归),只为印章记个数,失败不影响发布。 */
function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name)); else n++;
    }
  };
  try { walk(dir); } catch { /* 数不出来就算了 */ }
  return n;
}

/**
 * 现场构建前端产物(SERVER-RUNS-ON-LIVE-CHECKOUT,负责人 0906 拍板 d1=A)。
 *
 * 为什么要"导到临时目录再建",而不是直接拿主工位 web/dist:
 *   主工位那份 dist 是"谁最后在那儿构建的那份",可能来自任意分支或未提交改动——正是本卡要治的病。
 * 为什么临时树里还要带 core/:
 *   web/vite.config.ts 会 `require('../core/boardSchema.cjs')`(状态枚举单一真相源),缺了它构建直接失败。
 * 为什么依赖用软链而不是拷:
 *   node_modules 上万个文件,拷一次比构建还慢;借来源检出已装好的那份即可(只读消费,不写它)。
 * 为什么不走 `npm run build`:
 *   Windows 上要过 npm.cmd + shell,引号与退出码都不可靠;直接用本进程的 node 跑 vite 的入口最稳。
 *   代价是"构建脚本"这件事被钉死在这里 —— 所以下面加了一道机器闸:web/package.json 的 build 脚本
 *   一旦不再是 `vite build`,发布当场失败并指路,不许它悄悄漂。
 *
 * @param {{source:string, sha:string, outRoot:string}} args outRoot=副本的 .new 目录
 * @returns {{files:number, ms:number, dist:string}}
 */
function buildWebDist({ source, sha, outRoot }) {
  const started = Date.now();
  const wanted = [...WEB_BUILD_DEPS_PATHS, ...WEB_SOURCE_PATHS];
  const files = git(source, ['ls-tree', '-r', '--name-only', sha, '--', ...wanted]).split('\n').filter(Boolean);
  if (!files.includes('web/package.json')) {
    throw new Error(`${sha.slice(0, 12)} 里没有 web/package.json —— 这个提交没有前端源码,发布不出界面。\n  只想发后台(纯 CLI/服务修复)可加 --skip-web,但那份副本起不出网页界面。`);
  }
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-webbuild-')));
  const webRoot = path.join(tmp, 'web');
  const link = path.join(webRoot, 'node_modules');
  try {
    exportFiles(source, sha, files, tmp);

    const pkg = JSON.parse(fs.readFileSync(path.join(webRoot, 'package.json'), 'utf8'));
    const buildScript = (pkg.scripts || {}).build;
    if (buildScript !== 'vite build') {
      throw new Error(`web/package.json 的 build 脚本变成了 ${JSON.stringify(buildScript)},不再是 "vite build"。\n  发布命令是直接用 node 跑 vite 入口的(见 buildWebDist 头注),脚本改了这里必须跟着改,不许悄悄发一份用旧办法建出来的界面。`);
    }
    // 依赖借来源检出的(只读)。它没装 → 明确指路,不擅自 npm ci(装依赖是几分钟的事,不该藏在发布里)。
    const deps = path.join(source, 'web', 'node_modules');
    const viteBin = path.join(deps, 'vite', 'bin', 'vite.js');
    if (!fs.existsSync(viteBin)) {
      throw new Error(`前端依赖没装好(找不到 ${fwd(viteBin)}),建不出界面。\n  先在 ${fwd(path.join(source, 'web'))} 跑一次:npm ci --no-audit --no-fund`);
    }
    fs.symlinkSync(deps, link, process.platform === 'win32' ? 'junction' : 'dir');

    try {
      execFileSync(process.execPath, [viteBin, 'build'], {
        cwd: webRoot, encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      const detail = String((e && (e.stderr || e.stdout || e.message)) || e).trim().split('\n').slice(-8).join('\n');
      throw new Error(`前端构建失败,整单不发(副本保持原样):\n${detail}`);
    }

    const dist = path.join(webRoot, 'dist');
    if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('前端构建跑完了却没有 dist/index.html —— 产物不对,整单不发');
    const outDist = path.join(outRoot, ...WEB_DIST_REL.split('/'));
    fs.mkdirSync(path.dirname(outDist), { recursive: true });
    fs.cpSync(dist, outDist, { recursive: true });
    return { files: countFiles(outDist), ms: Date.now() - started, dist: outDist };
  } finally {
    // 先摘软链再删临时树:junction 若被当普通目录递归删,会把来源检出的 node_modules 一起删掉(skill §14-4)。
    try { fs.unlinkSync(link); } catch { /* 没建出来 / 已摘 */ }
    try { rmrf(tmp); } catch { /* 删不掉就留给系统清临时目录 */ }
  }
}

/** 目录换名,Windows 上被占就重试(hook 进程加载中 / 资源管理器窗口等)。 */
function renameRetry(from, to, tries = 8) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { fs.renameSync(from, to); return; } catch (e) { last = e; sleepMs(150 * (i + 1)); }
  }
  throw new Error(`换名失败 ${from} → ${to}:${last && last.message}`);
}

/**
 * 发布副本现状(只读、不 fetch):存不存在、印章记的 commit、相对本地 origin/<主干> 落后多少。
 * @param {{source?:string, dest?:string}} [opts]
 */
function releaseStatus(opts = {}) {
  const dest = opts.dest ? path.resolve(opts.dest) : releaseHome();
  const stamp = readStamp(dest);
  const exists = !!stamp && fs.existsSync(path.join(dest, 'cli', 'index.cjs'));
  let source = opts.source ? path.resolve(opts.source) : (stamp && stamp.source) || (isGitCheckout(CODE_ROOT) ? CODE_ROOT : null);
  if (source && !isGitCheckout(source)) source = null;
  // 界面产物在不在(SERVER-RUNS-ON-LIVE-CHECKOUT):没有它,从副本起的服务只会给"界面还没构建"的占位页
  const webDist = fs.existsSync(path.join(dest, ...WEB_DIST_REL.split('/'), 'index.html'));
  const out = { dest, exists, stamp, source, webDist, trunk: null, trunkSha: null, behind: null, ahead: null, text: '' };
  if (!exists) {
    out.text = `✖ 发布副本未发布(${dest} 不存在)—— 各仓 hook 与看板服务无处可指,先跑 \`cli release\``;
    return out;
  }
  const webWarn = webDist ? '' : '\n  ⚠ 副本里没有网页界面(web/dist)——从它起的服务只有 API,没有界面;跑一次 `cli release`(别加 --skip-web)';
  if (!source) { out.text = `ℹ 发布副本 @ ${stamp.commit.slice(0, 12)}(来源检出未知,算不出是否落后)` + webWarn; return out; }
  out.trunk = detectTrunk(source);
  if (!out.trunk) { out.text = `ℹ 发布副本 @ ${stamp.commit.slice(0, 12)}(探测不到 ${source} 的远程主干,算不出是否落后)` + webWarn; return out; }
  out.trunkSha = safeGit(source, ['rev-parse', `origin/${out.trunk}`]);
  const behind = safeGit(source, ['rev-list', '--count', `${stamp.commit}..origin/${out.trunk}`]);
  const ahead = safeGit(source, ['rev-list', '--count', `origin/${out.trunk}..${stamp.commit}`]);
  out.behind = behind === null ? null : parseInt(behind, 10);
  out.ahead = ahead === null ? null : parseInt(ahead, 10);
  if (out.behind === null) out.text = `⚠ 发布副本 @ ${stamp.commit.slice(0, 12)},但本地找不到它(fetch 过吗?),算不出是否落后`;
  else if (out.behind === 0) out.text = `✔ 发布副本 = origin/${out.trunk}(${stamp.commit.slice(0, 12)},${stamp.releasedAt})`;
  else out.text = `⚠ 发布副本落后 origin/${out.trunk} ${out.behind} 个提交(副本 ${stamp.commit.slice(0, 12)})—— 合了 master ≠ 生效,跑 \`cli release\``;
  out.text += webWarn;
  return out;
}

/**
 * release:导出 origin/<主干>(或 --commit)的运行期文件到发布副本,并现场构建前端产物。
 * @param {{source?:string, dest?:string, commit?:string, 'no-fetch'?:boolean, 'skip-web'?:boolean, 'print-dest'?:boolean}} flags
 * @param {{buildWeb?:Function}} [deps] 测试注入用(真构建要几十秒,单测只验接线与失败语义)
 */
function release(flags = {}, deps = {}) {
  const source = flags.source && flags.source !== true ? path.resolve(String(flags.source)) : CODE_ROOT;
  const dest = flags.dest && flags.dest !== true ? path.resolve(String(flags.dest)) : releaseHome();
  // 启动器要知道"服务从哪个目录起" —— 给它一条只打印路径、什么都不做的出口(启动看板.bat / dashboard.sh 用)
  if (flags['print-dest']) return { ok: true, dest, text: dest };
  if (!isGitCheckout(source)) {
    return { ok: true, skipped: true, dest, text: `ℹ ${source} 不是 git 检出(安装版 / 发布副本自身),无需发布;hook 直接指向它。` };
  }
  if (path.resolve(dest) === path.resolve(source)) throw new Error('拒绝:发布目标不能是来源检出本身');

  if (!flags['no-fetch']) {
    try { git(source, ['fetch', '--quiet', 'origin'], { timeout: 60000 }); }
    catch (e) { throw new Error(`git fetch 失败(离线?)——宁可不发,也不发一份旧的:${String(e.stderr || e.message).split('\n')[0]}\n  离线且明知本地 origin/主干 是新的,可加 --no-fetch`); }
  }
  const trunk = detectTrunk(source);
  if (!trunk) throw new Error(`探测不到 ${source} 的远程主干(origin/HEAD、origin/main、origin/master 都没有)`);
  const ref = flags.commit && flags.commit !== true ? String(flags.commit) : `origin/${trunk}`;
  let sha;
  try { sha = git(source, ['rev-parse', '--verify', `${ref}^{commit}`]); }
  catch { throw new Error(`解析不到 ${ref}`); }

  // 运行期文件清单来自该 commit 的树,不是工作区
  const files = git(source, ['ls-tree', '-r', '--name-only', sha, '--', ...RUNTIME_PATHS]).split('\n').filter(Boolean);
  if (!files.some((f) => f === 'cli/index.cjs')) throw new Error(`${ref} 里没有 cli/index.cjs,不像看板代码,拒绝发布`);

  const newDir = dest + '.new', oldDir = dest + '.old';
  rmrf(newDir); rmrf(oldDir);
  fs.mkdirSync(newDir, { recursive: true });
  exportFiles(source, sha, files, newDir);

  // 前端:同一个 commit 现场构建(d1=A)。失败 = 整单失败,dest 还没被碰过,旧副本原封不动
  // —— 绝不允许发出一份"后台新、界面旧"的副本,那正是本卡要治的病。
  let web = null;
  if (flags['skip-web']) {
    web = { skipped: true, reason: '--skip-web' };
  } else {
    try {
      const built = (deps.buildWeb || buildWebDist)({ source, sha, outRoot: newDir });
      web = { builtFrom: sha, builtAt: new Date().toISOString(), files: built.files, ms: built.ms };
    } catch (e) {
      rmrf(newDir);
      throw e;
    }
  }

  const stamp = {
    commit: sha, ref, trunk, source, releasedAt: new Date().toISOString(),
    paths: RUNTIME_PATHS, files: files.length, node: process.version, web,
  };
  atomicWriteJsonSync(path.join(newDir, STAMP_NAME), stamp);

  // 换名:dest → .old,.new → dest;第二步失败就把旧的放回去,绝不让 dest 空着
  const had = fs.existsSync(dest);
  if (had) renameRetry(dest, oldDir);
  try { renameRetry(newDir, dest); }
  catch (e) {
    if (had) { try { renameRetry(oldDir, dest); } catch { /* 连回滚都失败,下面的报错会说明 */ } }
    throw e;
  }
  try { rmrf(oldDir); } catch { /* 删不掉的 .old 下次发布会再试 */ }

  const webLine = web && web.skipped
    ? `  ⚠ 前端未构建(${web.reason})——这份副本起不出网页界面,只够 CLI/hook 用\n`
    : `  界面已现场构建:${web.files} 个文件,耗时 ${(web.ms / 1000).toFixed(1)}s(与后台同源于 ${sha.slice(0, 12)})\n`;
  const text =
    `✔ 发布副本已更新 → ${dest}\n` +
    `  来源 ${ref} = ${sha.slice(0, 12)}(${files.length} 个运行期文件:${RUNTIME_PATHS.join(' ')})\n` +
    webLine +
    '  各仓 hook 与看板服务跑的都是这份;主工位切分支 / 未提交改动从此影响不到它们。\n' +
    '  注意:已在跑的服务不会自己换新,下次双击启动器时会自动重起(SERVER-RUNS-ON-LIVE-CHECKOUT d2=A)。';
  return { ok: true, dest, stamp, text };
}

module.exports = { release, releaseStatus, detectTrunk, buildWebDist };
