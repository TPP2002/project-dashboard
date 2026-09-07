'use strict';
/**
 * resolveProject.cjs —— 项目定位（治本 R4）
 *
 * 本函数只认显式 id，绝不自己按 cwd 猜——server 与一切编程调用都必须把 id 说清楚。
 * 读全局 registry.json，把 id 映射到 { mainRepo, codeRepo, costRoots, board, lock, docsRoot }，路径全部 realpath 规范化。
 *
 * 【cwd → id 的反查放在哪】(AUD-CLI-BATCH-AND-AUTOPROJECT ③)
 * 反查本身由 detectProjectIds 提供，且【只在 cli/index.cjs 这一个入口】被调用一次、把结果填进 --project
 * 再往下传。分层的理由：反查会跑 git 子进程、还可能"一个仓属于多个项目"而歧义，这两件事都该在
 * 人能看见的命令行入口一次性了断；让 resolveProject 自己偷偷猜，等于把不确定性摊进每个消费方
 * （server 收到空 id 时会变成"按服务进程的 cwd 猜"，那是纯粹的错）。
 *
 * 【mainRepo 与 codeRepo 为什么要分家】(CLUSTER-BOARD-REPO-PATH-WRONG，2026-09-06)
 * 原先 mainRepo 一个字段扛两个语义——「板放哪」和「代码在哪」。绝大多数项目两者同址，
 * 直到出现「板自成一家、代码住在别人仓里」的项目：cluster 的板在 F:\board-repo，
 * 而它 93 张卡改的全是 F:\code-repo\scripts\bot\* 的代码。此时那一个字段必然自相矛盾：
 * 指板则一切 git 动作落在非仓目录上 fatal（precheck 第一查「新鲜度」直接半瘫、
 * doctor 恒报「hook 未安装」），指代码则找不着板。
 * 拆法：mainRepo 仍是「板的家」（board/lock 缺省都从它推），新增可选 codeRepo =「代码的家」，
 * 凡是要跑 git / 找正本的消费方一律读 codeRepo；不写就回落 mainRepo，老项目零改动。
 *
 * 【费用为什么单列 costRoots】(SERVER-CODEX-COST-USES-MAINREPO，2026-09-06)
 * 对话可能开在板目录、共享盘或专用工位，费用归属要认登记的对话目录清单，不能靠代码仓猜。
 * 缺省仍只用 mainRepo：这是保留所有未登记项目原有数字的兼容承诺，不能顺带加入 codeRepo。
 * 显式清单按登记顺序规范化、去重；尚未建出的工位也可登记，由 normalizeReal 解析已有祖先。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { normalizeReal } = require('./safePath.cjs');

// DASHBOARD_HOME = 看板"数据根"（registry.json + snapshots/ 落此处）。
// 默认仍是 ~/.claude/dashboard，仅存数据；代码检出已迁出，位置由使用者自定。
// standalone 分发版由启动器
// 把 DASHBOARD_HOME 指向安装目录，从而脱离 ~/.claude 耦合、在任意社区机器上可写。
// 注意：代码定位（core/cli/server/web 的 require）一律走 __dirname 相对路径，
// 不受本变量影响——DASHBOARD_HOME 只决定"数据往哪读/写"。
const DASHBOARD_HOME = process.env.DASHBOARD_HOME
  ? path.resolve(process.env.DASHBOARD_HOME)
  : path.join(os.homedir(), '.claude', 'dashboard');
const REGISTRY_PATH = path.join(DASHBOARD_HOME, 'registry.json');

function readRegistry(registryPath = REGISTRY_PATH) {
  try {
    return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { schemaVersion: '1.0', projects: {} };
    throw new Error(`registry.json 读取/解析失败：${err.message}`);
  }
}

/**
 * 按 cwd 所在的 git 仓，反查它属于【哪些】已注册看板项目（返回 id 数组，按 registry 登记顺序）。
 *
 * 关键一：worktree 的 `--git-common-dir` 指向【主仓】的 .git，所以并行 worktree 和主工位认到同一项目
 *（否则每开一个工位就得重新登记一次）。git 把这个路径按 cwd 相对给出，故一律 resolve 回绝对路径。
 * 关键二：mainRepo（板的家）和 codeRepo（代码的家）都要比。cluster 那种"板自成一家、代码住别人仓里"
 * 的项目，干活的对话站在 codeRepo 里，只比 mainRepo 等于永远认不出来（审计 A10）。
 * 关键三：返回【全部】命中而不是第一个。共仓时"首匹配胜出"是靠 JSON 插入顺序决胜，脆得没法用；
 * 调用方拿到 2 个以上就该停下来要求人显式指定，而不是替人猜（CLUSTER-BOARD-REPO-PATH-WRONG 的教训）。
 *
 * 任何一步失败（不在 git 仓里、没有 git、registry 坏了）都返回空数组：这是"认不出来"，不是错误。
 * @param {{registryPath?:string, cwd?:string}} [opts]
 * @returns {string[]}
 */
function detectProjectIds(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  let repoRoot;
  try {
    const commonDir = require('node:child_process')
      .execFileSync('git', ['rev-parse', '--git-common-dir'], {
        cwd, encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    if (!commonDir) return [];
    repoRoot = path.dirname(path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir));
  } catch { return []; }
  const norm = (p) => { try { return normalizeReal(p); } catch { return path.resolve(p); } };
  const target = norm(repoRoot);
  let registry;
  try { registry = readRegistry(opts.registryPath); } catch { return []; }
  const hits = [];
  for (const [id, entry] of Object.entries((registry && registry.projects) || {})) {
    if (!entry) continue;
    // codeRepo 缺省 = mainRepo（见头注），这里照样只比登记了的字段，不推导——推导只会多命中不会少。
    if (['mainRepo', 'codeRepo'].some((k) => entry[k] && norm(entry[k]) === target)) hits.push(id);
  }
  return hits;
}

/**
 * 解析 projectId → 路径集合。
 * @param {string} projectId
 * @param {{registryPath?: string}} [opts]
 * @returns {{id:string,name:string,mainRepo:string,codeRepo:string,costRoots:string[],board:string,lock:string,docsRoot:string,indexPath:string|null}}
 */
function resolveProject(projectId, opts = {}) {
  if (!projectId || projectId === true) throw new Error('必须指定 --project <id>（本函数不按 cwd 猜；CLI 入口已先替你反查过一次，反查不到才会落到这句）');
  const registry = readRegistry(opts.registryPath);
  const entry = registry.projects && registry.projects[projectId];
  if (!entry) {
    const known = Object.keys(registry.projects || {}).join(', ') || '（空）';
    throw new Error(`未注册的项目 "${projectId}"。已注册：${known}。请先 cli register。`);
  }
  const mainRepo = normalizeReal(entry.mainRepo);
  const costRoots = Array.isArray(entry.costRoots) && entry.costRoots.length
    ? [...new Set(entry.costRoots.filter((root) => typeof root === 'string' && root.trim()).map(normalizeReal))]
    : [mainRepo];
  if (!costRoots.length) costRoots.push(mainRepo);
  const board = entry.board ? normalizeReal(entry.board) : path.join(mainRepo, '.dashboard', 'board.json');
  return {
    id: projectId,
    name: entry.name || projectId,
    mainRepo,
    // codeRepo：跑 git / 找正本的消费方读这个（缺省 = mainRepo，见文件头注）。
    codeRepo: entry.codeRepo ? normalizeReal(entry.codeRepo) : mainRepo,
    costRoots,
    board,
    lock: board + '.lock',
    docsRoot: entry.docsRoot ? normalizeReal(entry.docsRoot) : mainRepo,
    // indexPath：render-index 目标台账（治本——docsRoot 被 web 白名单占用，不能挪去指子目录，
    // 故单列一个 index 让 render-index 落进真台账；缺省回落 docsRoot/INDEX.md，向后兼容）。
    indexPath: entry.index ? normalizeReal(entry.index) : null,
  };
}

module.exports = { resolveProject, readRegistry, detectProjectIds, DASHBOARD_HOME, REGISTRY_PATH };
