'use strict';
/**
 * release.cjs —— 把 origin/<主干> 的运行期代码导出成【发布副本】(HOOK-CLI-POINTS-AT-LIVE-CHECKOUT,治法①)。
 *
 * 全机器各仓的 git hook 只认发布副本(见 core/runtimeRoot.cjs 头注)。本命令是"合进 master 之后让它生效"的那一步:
 * 负责人 0906 拍板走 A(收官序列手动跑;doctor / precheck 落后就提醒),不装计划任务。
 *
 * 治本点(和主工位彻底解耦):
 *   · 来源固定 = fetch 后的 origin/<主干>(主干名探测,不写死 main),**与来源检出此刻在哪条分支、
 *     有没有未提交改动完全无关**;`--commit <sha>` 可钉某个提交(回滚用);
 *   · 导出走【临时索引】(GIT_INDEX_FILE + read-tree + checkout-index --prefix):不碰来源仓的索引与工作区,
 *     也不依赖外部 tar/zip;
 *   · 先写 <dest>.new,再目录级换名(旧的挪 .old 后删)。hook 进程加载完不占文件,换名窗口极小;
 *     Windows 换名偶发被占,重试几次。
 *
 * 用法:node cli/index.cjs release [--commit <sha>] [--no-fetch] [--source <检出>] [--dest <目录>]
 *   source 默认 = 当前运行的这份代码所在的检出;dest 默认 = ~/.claude/dashboard-release。
 *   代码根不是 git 检出(安装版 / 发布副本自己)→ 友好跳过。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { CODE_ROOT, STAMP_NAME, RUNTIME_PATHS, isGitCheckout, releaseHome, readStamp } = require('../core/runtimeRoot.cjs');
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
  const out = { dest, exists, stamp, source, trunk: null, trunkSha: null, behind: null, ahead: null, text: '' };
  if (!exists) {
    out.text = `✖ 发布副本未发布(${dest} 不存在)—— 各仓 hook 无处可指,先跑 \`cli release\``;
    return out;
  }
  if (!source) { out.text = `ℹ 发布副本 @ ${stamp.commit.slice(0, 12)}(来源检出未知,算不出是否落后)`; return out; }
  out.trunk = detectTrunk(source);
  if (!out.trunk) { out.text = `ℹ 发布副本 @ ${stamp.commit.slice(0, 12)}(探测不到 ${source} 的远程主干,算不出是否落后)`; return out; }
  out.trunkSha = safeGit(source, ['rev-parse', `origin/${out.trunk}`]);
  const behind = safeGit(source, ['rev-list', '--count', `${stamp.commit}..origin/${out.trunk}`]);
  const ahead = safeGit(source, ['rev-list', '--count', `origin/${out.trunk}..${stamp.commit}`]);
  out.behind = behind === null ? null : parseInt(behind, 10);
  out.ahead = ahead === null ? null : parseInt(ahead, 10);
  if (out.behind === null) out.text = `⚠ 发布副本 @ ${stamp.commit.slice(0, 12)},但本地找不到它(fetch 过吗?),算不出是否落后`;
  else if (out.behind === 0) out.text = `✔ 发布副本 = origin/${out.trunk}(${stamp.commit.slice(0, 12)},${stamp.releasedAt})`;
  else out.text = `⚠ 发布副本落后 origin/${out.trunk} ${out.behind} 个提交(副本 ${stamp.commit.slice(0, 12)})—— 合了 master ≠ 生效,跑 \`cli release\``;
  return out;
}

/**
 * release:导出 origin/<主干>(或 --commit)的运行期文件到发布副本。
 * @param {{source?:string, dest?:string, commit?:string, 'no-fetch'?:boolean}} flags
 */
function release(flags = {}) {
  const source = flags.source && flags.source !== true ? path.resolve(String(flags.source)) : CODE_ROOT;
  const dest = flags.dest && flags.dest !== true ? path.resolve(String(flags.dest)) : releaseHome();
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
  // 临时索引:导出不碰来源仓自己的 index
  const tmpIndex = path.join(os.tmpdir(), `dashboard-release-index-${process.pid}-${Date.now().toString(36)}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    git(source, ['read-tree', sha], { env });
    // -c core.autocrlf=false:按 blob 原字节导出(和 git archive 一个口径),只让仓库自己的 .gitattributes 决定换行;
    // 不吃打包机的全局 autocrlf,免得同一 commit 在不同机器上导出不同字节。
    git(source, ['-c', 'core.autocrlf=false', 'checkout-index', '--stdin', `--prefix=${fwd(newDir)}/`], { env, input: files.join('\n') + '\n', timeout: 60000 });
  } finally {
    try { fs.unlinkSync(tmpIndex); } catch { /* 没建出来就算了 */ }
  }
  const stamp = {
    commit: sha, ref, trunk, source, releasedAt: new Date().toISOString(),
    paths: RUNTIME_PATHS, files: files.length, node: process.version,
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

  const text =
    `✔ 发布副本已更新 → ${dest}\n` +
    `  来源 ${ref} = ${sha.slice(0, 12)}(${files.length} 个运行期文件:${RUNTIME_PATHS.join(' ')})\n` +
    '  各仓 hook 指向的就是这份;主工位切分支 / 未提交改动从此影响不到闸门。';
  return { ok: true, dest, stamp, text };
}

module.exports = { release, releaseStatus, detectTrunk };
