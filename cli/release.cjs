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
 * 【0907 扩容:自举发布】(AD-20260907-RELEASE-SELF-BOOTSTRAP)
 * 发布这条命令按 AGENTS.md 是【用副本自己的 CLI 跑】的,所以只要改的是发布工具本身,起头的永远是【旧工具】:
 * 它把新代码铺进副本,但新代码带来的发布行为这一次一次都没作用过——非得再跑一次才出现
 * (0907 实测:新加的 board/kb 短别名垫片,第一次发布的输出里没有、副本根也没有,第二次才有)。
 * 这比"忘了跑 release"更隐蔽:跑了、也成功了,却没生效。
 * 治法:发布前先比对【本次运行的发布工具】与【目标 commit 里的那份】,不一致就自举——
 *   ① 把目标 commit 的运行期文件铺到暂存目录 <dest>.boot(**全程不碰副本**);
 *   ② 用暂存目录里的【目标 commit 自带的那份 CLI】去发布真正的副本,--commit 钉死同一个 sha。
 * 说"目标自带的那份"而不是"新版":`--commit` 回滚时它反而比手头这份更老,而规矩是一样的 ——
 * 副本长什么样,只能由【副本里那份工具】说了算。
 * 副本因此从头到尾只被它铺一次;它跑挂了副本连碰都没碰过,旧副本原封不动(与构建失败同一个口径)。
 * 不递归的两道保险见 release() 里 staleReleaseLogic 那段注释。--no-bootstrap 可关(应急),
 * 代价是新发布逻辑要等下一次才生效——那一次的输出会明说这件事,不让人以为白改了。
 *
 * 【0907 扩容:已经是这一版就不重发】(AD-20260907-LAUNCH-SKIP-REBUILD)
 * 启动器每次双击都跑一遍 release,而绝大多数双击时 origin/主干 根本没动 —— 重导 50 个运行期文件
 * 再现场建一次界面,实测 6.2s(其中 vite 5.2s),纯属让人干等。所以发之前先看副本新不新鲜:
 * 印章的 commit 就是这次要发的 sha、副本还是个能用的副本、要界面时界面真在、且【铺出这份副本的
 * 发布工具】与本次运行的一致(印章里的 logic 指纹),四条都成立就直接返回"已是最新",不导也不建。
 * 第四条不能省:文件是新的、发布行为却是旧工具留下的,正是上面那段自举要治的病 ——
 * 老印章没有 logic 字段一律当不一致,先老实重发一次把它补上。--force 强制重发。
 *
 * 用法:node cli/index.cjs release [--commit <sha>] [--no-fetch] [--skip-web] [--source <检出>] [--dest <目录>]
 *                                [--no-bootstrap] [--force]
 *   source 默认 = 当前运行的这份代码所在的检出;dest 默认 = ~/.claude/dashboard-release。
 *   代码根不是 git 检出(安装版 / 发布副本自己)→ 友好跳过。
 *   --skip-web:只发后台(紧急 CLI/hook 修复用),印章会记下来;那份副本起不出网页界面。
 *   --print-dest:只打印副本目录路径,什么都不做(启动器拿它当落脚点)。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  CODE_ROOT, STAMP_NAME, RUNTIME_PATHS, WEB_SOURCE_PATHS, WEB_BUILD_DEPS_PATHS, WEB_DIST_REL,
  CLI_SHIMS, shimExt, isGitCheckout, releaseHome, readStamp,
} = require('../core/runtimeRoot.cjs');
const { atomicWriteJsonSync, sleepMs } = require('../core/atomicWrite.cjs');

/**
 * 【发布逻辑文件】——改了它们,同一个 commit 发出来的副本内容就会不一样,所以它们是自举的判据。
 * 只收"决定产物长什么样"的那几个:release 的流程本身、runtimeRoot 的路径/垫片/印章名、印章的写法。
 * **故意不含 cli/index.cjs**:它只做路由,却因为别的命令天天在改——收进来等于几乎每次发布都白跑一遍自举。
 */
const RELEASE_LOGIC_PATHS = ['cli/release.cjs', 'core/runtimeRoot.cjs', 'core/atomicWrite.cjs'];
/** 自举标记兼开关:'child' = 我就是自举起来的那一层,不许再生一层;'0' = 这台机器别自举。 */
const BOOTSTRAP_ENV = 'DASHBOARD_RELEASE_BOOTSTRAP';

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

/**
 * 在副本根写 CLI 短别名垫片(AUD-CLI-BATCH-AND-AUTOPROJECT ④,审计 A11)。
 *
 * 治的病:每条看板命令行都以 `node "<副本>/cli/index.cjs"` 开头,~90 字符里有 55 个是纯样板,
 * 而这句话出现在每份 CLAUDE.md 锚段、每条派单指令、每次 inbox 输出里。有了垫片,
 * core/runtimeRoot.displayCliCommand 会自动改用短名,那些文本一起变短,不用各自改。
 *
 * 为什么是"垫片文件"而不是 npm bin / PATH:副本【没有 .git 也没有 node_modules】,
 * 是 release 直接铺出来的一棵树(见头注);往用户 PATH 里塞东西又是另一件要负责人点头的事。
 * 两个字节的文件放在副本根,谁都能拿绝对路径直接跑,零安装、零副作用。
 *
 * 两个名字内容一样:board 是正名,kb 更短。
 * .cmd 给 Windows(cmd / PowerShell / Git Bash 都能直接跑),.sh 给其余平台(带可执行位)。
 * 两种都写:一份副本可能被跨平台共享的目录(网络盘/同步盘)引用,少写一个就等于那边用不了。
 * @param {string} root 副本根(发布中是 <dest>.new)
 * @returns {string[]} 写出来的文件名
 */
function writeCliShims(root) {
  const cmd = [
    '@echo off',
    'rem 看板 CLI 短别名 —— 由 `cli release` 生成,勿手改(改了下次发布会被覆盖)。',
    'rem 等价于: node "<本目录>\\cli\\index.cjs" <参数...>',
    'node "%~dp0cli\\index.cjs" %*',
    '',
  ].join('\r\n');
  const sh = [
    '#!/bin/sh',
    '# 看板 CLI 短别名 —— 由 `cli release` 生成,勿手改(改了下次发布会被覆盖)。',
    '# 等价于: node "<本目录>/cli/index.cjs" "$@"',
    'exec node "$(dirname "$0")/cli/index.cjs" "$@"',
    '',
  ].join('\n');
  const written = [];
  for (const name of CLI_SHIMS) {
    fs.writeFileSync(path.join(root, name + '.cmd'), cmd);
    written.push(name + '.cmd');
    const shPath = path.join(root, name + '.sh');
    fs.writeFileSync(shPath, sh);
    // 可执行位:Windows 上 chmod 是空操作,不必分平台;失败也不该拖垮整单发布。
    try { fs.chmodSync(shPath, 0o755); } catch { /* 文件系统不支持权限位就算了 */ }
    written.push(name + '.sh');
  }
  return written;
}

/** 源码指纹:先抹平换行再算,免得 autocrlf 把同一份代码判成两份(判错就是每次发布白跑一遍自举)。 */
function sourceDigest(text) {
  // 两头都 trim:git() 的输出是 trim 过的、这边读盘的没有 —— 不对齐就会永远判成不一致,每次发布白跑一趟
  return crypto.createHash('sha256').update(String(text).replace(/\r\n/g, '\n').trim()).digest('hex');
}

/**
 * 【本次运行用的发布工具】与【目标 commit 里的那份】差在哪几个文件。
 * 空数组 = 这次发布的行为就是新代码的行为,发一次就够。
 *
 * 目标 commit 里压根没有 cli/release.cjs(极老的提交 / 回滚到发布工具诞生之前 / 根本不是本仓)
 * → 没有"新发布逻辑"可言,也铺不出一个能自举的暂存目录,直接当一致处理:不自举、也不提醒。
 *
 * @param {string} runningRoot 本次运行的代码根(CODE_ROOT)
 * @param {string} source 来源检出
 * @param {string} sha 要发的提交
 * @returns {string[]} 不一致的仓内相对路径
 */
/**
 * 一个代码根里【整套发布逻辑】的合并指纹。进印章,用来回答"这份副本是哪个版本的发布工具铺的"。
 * 缺文件也要算进去(用空串占位),否则"少了一个文件"和"那个文件是空的"会撞成同一个指纹。
 * @param {string} root 代码根
 */
function releaseLogicDigest(root) {
  const parts = RELEASE_LOGIC_PATHS.map((rel) => {
    let body = '';
    try { body = fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8'); } catch { /* 缺就当空 */ }
    return rel + ':' + sourceDigest(body);
  });
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/**
 * 副本还新鲜吗 —— 新鲜就不用重发(AD-20260907-LAUNCH-SKIP-REBUILD)。四条全中才算新鲜:
 *   ① 印章记的 commit 就是这次要发的 sha;
 *   ② 副本还是个能用的副本(cli/index.cjs 与印章记下的垫片都在);
 *   ③ 这次要界面的话,副本里的界面得真在(--skip-web 发出来的副本没有 dist);
 *   ④ 铺出这份副本的发布工具与本次运行的是同一版(老印章没有 logic 字段 → 不新鲜,重发一次补上)。
 * @returns {object|null} 新鲜就回那份印章,否则 null
 */
function freshCopy({ dest, sha, logic, wantWeb }) {
  const stamp = readStamp(dest);
  if (!stamp || stamp.commit !== sha || stamp.logic !== logic) return null;
  if (!fs.existsSync(path.join(dest, 'cli', 'index.cjs'))) return null;
  for (const name of stamp.shims || []) if (!fs.existsSync(path.join(dest, name))) return null;
  if (wantWeb && !fs.existsSync(path.join(dest, ...WEB_DIST_REL.split('/'), 'index.html'))) return null;
  return stamp;
}

function staleReleaseLogic(runningRoot, source, sha) {
  if (safeGit(source, ['cat-file', '-e', `${sha}:cli/release.cjs`]) === null) return [];
  const changed = [];
  for (const rel of RELEASE_LOGIC_PATHS) {
    let mine = null;
    try { mine = sourceDigest(fs.readFileSync(path.join(runningRoot, ...rel.split('/')), 'utf8')); }
    catch { /* 老副本可能压根没这个文件 —— 那就是"不一致",按缺失比 */ }
    const blob = safeGit(source, ['show', `${sha}:${rel}`]);
    const theirs = blob === null ? null : sourceDigest(blob);
    if (mine !== theirs) changed.push(rel);
  }
  return changed;
}

/**
 * 自举发布:先把目标 commit 的代码铺到【暂存目录】,再用它自己的发布工具去发布真正的副本。
 *
 * 为什么要过一遍暂存目录,而不是"先按旧逻辑发一版、再让副本自己重发一次":
 *   后者会让副本先落成一份【旧逻辑铺的半成品】,中途挂了就停在那份半成品上(界面/垫片可能是缺的),
 *   而且前端要白建一遍(几十秒)。走暂存目录则是:副本只被新版铺一次,新版挂了副本一下都没碰过。
 * 为什么钉 --commit + --no-fetch:
 *   父进程刚 fetch 过、也已经把 sha 定下来了;子进程要是自己再解析一次 origin/主干,
 *   期间有人推了新提交就会发出另一个 commit —— 同一次发布必须落在同一个 sha 上。
 *
 * @param {{source:string, sha:string, refLabel:string, dest:string, files:string[], flags:object, changed:string[]}} a
 */
function bootstrapRelease({ source, sha, refLabel, dest, files, flags, changed }) {
  const stage = dest + '.boot';
  rmrf(stage);
  fs.mkdirSync(stage, { recursive: true });
  try {
    exportFiles(source, sha, files, stage);
    const args = [
      path.join(stage, 'cli', 'index.cjs'), 'release',
      '--source', source, '--dest', dest, '--commit', sha, '--ref-label', refLabel, '--no-fetch', '--json',
    ];
    if (flags['skip-web']) args.push('--skip-web');
    let stdout;
    try {
      stdout = execFileSync(process.execPath, args, {
        encoding: 'utf8', windowsHide: true, timeout: 20 * 60 * 1000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, [BOOTSTRAP_ENV]: 'child' },
      });
    } catch (e) {
      const detail = String((e && (e.stderr || e.stdout || e.message)) || e).trim().split('\n').slice(-8).join('\n');
      throw new Error(
        `目标 commit 自带的发布工具没跑通,整单不发(副本保持原样):\n${detail}\n` +
        `  变了的发布逻辑:${changed.join(' ')}\n` +
        '  实在要先发一份应急,加 --no-bootstrap —— 但那一次新逻辑不会生效。');
    }
    // 子进程走的是 --json,末行就是结构化结果;真解析不出来也不判错,退回用它的原文
    let child = null;
    try { child = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { /* 老版本 CLI 可能没有 --json */ }
    const note =
      `\n⟳ 自举:起头的发布工具和目标 commit 里的那份不是同一版(${changed.join(' ')} 有出入),` +
      '已改用【目标 commit 自带的那份】重跑 —— 上面这份副本就是它一次铺成的。\n' +
      '  ——不必再手动跑第二次;要关掉加 --no-bootstrap。';
    const text = (child && child.text ? child.text : String(stdout).trim()) + note;
    return { ok: true, dest, stamp: (child && child.stamp) || null, bootstrapped: changed, text };
  } finally {
    try { rmrf(stage); } catch { /* 删不掉留给下次发布清 */ }
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
 * 在跑的看板服务是哪份代码(SERVER-RUNS-ON-LIVE-CHECKOUT)。
 *
 * 服务是常驻进程:合进主干 + `cli release` 之后,它要等下次启动才换新 —— 体检必须能说出这件事,
 * 不然又回到"合了却一直不生效、谁也不知道"的老路。
 * 探活走子进程(CLI 是同步的,Node 没有同步 HTTP);探不到就当没在跑,绝不因此判红。
 * @param {{portBase?:number, portRange?:number, dest?:string}} [opts]
 */
function serviceStatus(opts = {}) {
  const base = opts.portBase || 6060;
  const range = opts.portRange === undefined ? 8 : opts.portRange;
  const probe = `
    const http = require('http');
    const get = (port) => new Promise((res) => {
      const r = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 400 }, (s) => {
        let d = ''; s.on('data', (c) => d += c); s.on('end', () => { try { res(JSON.parse(d)); } catch { res(null); } });
      });
      r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); });
    });
    (async () => {
      for (let p = ${base}; p <= ${base + range}; p++) {
        const h = await get(p);
        if (h && h.service === 'claude-dashboard') { process.stdout.write(JSON.stringify(h)); return; }
      }
      process.stdout.write('null');
    })();
  `;
  let health = null;
  try { health = JSON.parse(execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8', timeout: 15000, windowsHide: true }) || 'null'); }
  catch { health = null; }

  const stamp = readStamp(opts.dest ? path.resolve(opts.dest) : releaseHome());
  const out = { running: !!health, health, text: '' };
  if (!health) { out.text = `ℹ 看板服务没在跑(探了 ${base}~${base + range})`; return out; }
  if (health.codeRoot === undefined) {
    out.text = `⚠ 看板服务在跑(pid ${health.pid}),但它是老版本、报不出自己跑的是哪份代码——双击启动器换新`;
    return out;
  }
  if (health.mode === 'dev') {
    out.text = `⚠ 在 ${health.port} 上跑的是【开发实例】(代码根 ${health.codeRoot})——负责人日常用的那份该从发布副本起`;
    return out;
  }
  const same = stamp && stamp.commit === health.releaseCommit;
  out.text = same
    ? `✔ 看板服务在跑 @ ${String(health.releaseCommit).slice(0, 12)}(= 发布副本,端口 ${health.port})`
    : `⚠ 看板服务跑的是旧代码 @ ${String(health.releaseCommit || '?').slice(0, 12)},发布副本已是 ${stamp ? stamp.commit.slice(0, 12) : '?'}——下次双击启动器会自动换新`;
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
  // 自举子进程用 --commit 把 sha 钉死了,来源标签仍报父进程本来要发的那个 ref(印章与文案才读得懂)。
  // 内部管道参数,不进 help —— 手动传也无害,它只影响显示。
  const refLabel = flags['ref-label'] && flags['ref-label'] !== true ? String(flags['ref-label']) : ref;
  let sha;
  try { sha = git(source, ['rev-parse', '--verify', `${ref}^{commit}`]); }
  catch { throw new Error(`解析不到 ${ref}`); }

  // 运行期文件清单来自该 commit 的树,不是工作区
  const files = git(source, ['ls-tree', '-r', '--name-only', sha, '--', ...RUNTIME_PATHS]).split('\n').filter(Boolean);
  if (!files.some((f) => f === 'cli/index.cjs')) throw new Error(`${ref} 里没有 cli/index.cjs,不像看板代码,拒绝发布`);

  // 【自举】改的要是发布工具自己,这一次跑的还是旧工具 —— 让新工具自己去铺副本(见头注)。
  // 不递归的两道保险:
  //   ① 子进程带 BOOTSTRAP_ENV=child,见了标记就绝不再生一层(硬上限:最多多跑一次);
  //   ② 就算标记丢了也收敛 —— 子进程的代码根就是刚从这个 sha 导出的那份,和它要发的 commit 同源,
  //      指纹必然相等,staleReleaseLogic 返回空,压根走不到这里。
  const changed = staleReleaseLogic(CODE_ROOT, source, sha);
  const bootMark = process.env[BOOTSTRAP_ENV];
  if (changed.length && !flags['no-bootstrap'] && bootMark !== 'child' && bootMark !== '0') {
    return bootstrapRelease({ source, sha, refLabel, dest, files, flags, changed });
  }

  // 【已是这一版就不重发】启动器每次双击都跑这条命令,而主干多半没动 —— 见头注 0907 那段。
  // 放在自举闸【之后】:发布工具变了的那次必须真发,轮不到走这条快路径。
  const logic = releaseLogicDigest(CODE_ROOT);
  const fresh = flags.force ? null : freshCopy({ dest, sha, logic, wantWeb: !flags['skip-web'] });
  if (fresh) {
    const w = fresh.web && !fresh.web.skipped ? `,界面 ${fresh.web.files} 个文件` : '';
    return {
      ok: true, dest, stamp: fresh, upToDate: true,
      text:
        `✔ 发布副本已经是这一版,本次没重发 → ${dest}\n` +
        `  ${refLabel} = ${sha.slice(0, 12)} —— 与副本印章同一个提交,发布工具也没变;重导重建纯属白等\n` +
        `  上次发布于 ${fresh.releasedAt}${w}\n` +
        '  真要强制重发(怀疑副本被人动过)加 --force。',
    };
  }

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

  // 短别名垫片(A11):跟印章一样是"生成物"、不来自 git 树,所以在导出之后单独写
  const shims = writeCliShims(newDir);

  const stamp = {
    commit: sha, ref: refLabel, trunk, source, releasedAt: new Date().toISOString(),
    // 这份副本是哪个版本的发布工具铺的 —— 下次发布靠它判断"能不能跳过"(AD-20260907-LAUNCH-SKIP-REBUILD)
    paths: RUNTIME_PATHS, files: files.length, node: process.version, web, shims, logic,
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
  // 走到这里还对不上,只可能是自举被关掉了(或自举完仍不一致)。宁可话难听,也别让人以为已经发完
  const staleLine = !changed.length ? '' : (bootMark === 'child'
    ? `\n  ⚠ 自举跑完发布工具仍对不上(${changed.join(' ')})——这不该发生,请手动再跑一次 release 并查这几个文件`
    : `\n  ⚠ 起头的发布工具和目标 commit 里的那份不是同一版(${changed.join(' ')} 有出入),这一次是用【起头那份】发的,` +
      '\n    目标 commit 里的发布逻辑本次一点没作用到副本上;' +
      `\n    再跑一次同样的命令才会作用到副本上(本次自举被关掉了:--no-bootstrap 或 ${BOOTSTRAP_ENV})`);
  const text =
    `✔ 发布副本已更新 → ${dest}\n` +
    `  来源 ${refLabel} = ${sha.slice(0, 12)}(${files.length} 个运行期文件:${RUNTIME_PATHS.join(' ')})\n` +
    webLine +
    `  短别名垫片:${shims.join(' ')} —— 命令行可写 ${fwd(path.join(dest, CLI_SHIMS[0] + shimExt()))} <命令>,代替 node <长路径>\n` +
    '  各仓 hook 与看板服务跑的都是这份;主工位切分支 / 未提交改动从此影响不到它们。\n' +
    '  注意:已在跑的服务不会自己换新,下次双击启动器时会自动重起(SERVER-RUNS-ON-LIVE-CHECKOUT d2=A)。' +
    staleLine;
  return { ok: true, dest, stamp, text };
}

module.exports = {
  release, releaseStatus, serviceStatus, detectTrunk, buildWebDist, writeCliShims,
  staleReleaseLogic, releaseLogicDigest, RELEASE_LOGIC_PATHS, BOOTSTRAP_ENV,
};
