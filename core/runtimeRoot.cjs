'use strict';
/**
 * runtimeRoot.cjs —— 「代码在哪」的唯一裁判(HOOK-CLI-POINTS-AT-LIVE-CHECKOUT,负责人 0906 拍板走治法①)。
 *
 * 【病根】hooksInstall 原先拿 DASHBOARD_HOME(按 resolveProject 头注它只是"数据根")当"代码根",
 * 把 ~/.claude/dashboard/cli/index.cjs 焊进全机器各仓的 git hook / settings.json。
 * 那个目录是看板仓库的【活的工作检出】:谁在那里切分支、谁改了没提交,全机器的闸门就跟着变;
 * 合进 master 也不等于生效(要等有人把主工位切回 master 并 pull)。
 *
 * 【治法】把"人正在改的那份"(git 检出)和"全机器跑的那份"(发布副本)物理分开:
 *   · 发布副本 = RELEASE_HOME(默认 ~/.claude/dashboard-release),只含运行期文件 + RELEASE.json 印章,
 *     【没有 .git】,由 `cli release` 从 origin/<主干> 导出(见 cli/release.cjs),不许人手改;
 *   · hook 的 CLI 根按 resolveHookCliRoot 取,铁律一句话:**hook 永远不许指进一个 git 检出**。
 *
 * 与 DASHBOARD_HOME 的分工:那个只管数据(registry.json / snapshots),本文件只管代码。两者互不推导。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** 当前正在运行的这份看板代码的根目录(core/ 的上一级)。与 DASHBOARD_HOME 无关。 */
const CODE_ROOT = path.resolve(__dirname, '..');
const STAMP_NAME = 'RELEASE.json';
/** 进发布副本的路径白名单(相对仓库根;目录整拷)。web/dist 被 .gitignore,归 SERVER-RUNS-ON-LIVE-CHECKOUT 卡另议。 */
const RUNTIME_PATHS = ['core', 'cli', 'server', 'package.json'];

/** 目录是不是 git 检出:主仓 .git 是目录、worktree 的 .git 是指针文件,两种都算。 */
function isGitCheckout(dir) {
  try { fs.statSync(path.join(dir, '.git')); return true; } catch { return false; }
}

/** 发布副本目录。环境变量 DASHBOARD_RELEASE_HOME 可改(测试隔离 / 自定义布局),默认 ~/.claude/dashboard-release。 */
function releaseHome(env = process.env) {
  return env.DASHBOARD_RELEASE_HOME ? path.resolve(env.DASHBOARD_RELEASE_HOME) : path.join(os.homedir(), '.claude', 'dashboard-release');
}

/** 读发布印章;没有/坏了 → null(调用方自己决定怎么报)。 */
function readStamp(dir = releaseHome()) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, STAMP_NAME), 'utf8')); } catch { return null; }
}

/**
 * hook 该指向哪份 CLI 代码的根目录。顺序固定、不许回退到检出:
 *   ① 环境变量 DASHBOARD_HOOK_CLI_ROOT —— 测试隔离专用(端到端要验"本检出"的 hook 时用它,别再拿 DASHBOARD_HOME 顶);
 *   ② 自身不是 git 检出(分发版安装目录 / 发布副本自己在跑)→ 指向自己;
 *   ③ 自身是 git 检出 → 指向发布副本;副本不存在 → 拒装并指路 `cli release`。
 * @returns {{root:string, why:'env'|'self'|'release'}}
 */
function resolveHookCliRoot(opts = {}) {
  const env = opts.env || process.env;
  const codeRoot = opts.codeRoot || CODE_ROOT;
  const rel = opts.releaseHome || releaseHome(env);
  if (env.DASHBOARD_HOOK_CLI_ROOT) return { root: path.resolve(env.DASHBOARD_HOOK_CLI_ROOT), why: 'env' };
  if (!isGitCheckout(codeRoot)) return { root: codeRoot, why: 'self' };
  if (fs.existsSync(path.join(rel, 'cli', 'index.cjs'))) return { root: rel, why: 'release' };
  throw new Error(
    `hook 不能指向 git 检出(${codeRoot})——那是"人正在改的那份",全机器闸门跟着它漂(HOOK-CLI-POINTS-AT-LIVE-CHECKOUT)。\n` +
    `  发布副本 ${rel} 还不存在,先跑:node ${path.join(codeRoot, 'cli', 'index.cjs').replace(/\\/g, '/')} release\n` +
    '  (测试隔离可设 DASHBOARD_HOOK_CLI_ROOT 指向要验的那份代码)',
  );
}

module.exports = { CODE_ROOT, STAMP_NAME, RUNTIME_PATHS, isGitCheckout, releaseHome, readStamp, resolveHookCliRoot };
