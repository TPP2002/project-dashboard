'use strict';
/**
 * claimCheck.cjs —— commit 前的「你认领了吗」硬闸门(HOOK-CLAIM-GATE-MULTI-PROJECT)。
 *
 * 为什么单独成命令:这套判定原先是 pre-commit hook 里用 shell 拼出来的一段
 * `list --project <写死的id> | grep <分支名>`。0902 看板拆成 rogue/cluster/dashboard
 * 三个项目后,一个仓库里完全可能干别的项目的卡(实证:在 F:\stock-rogue 里干 cluster 项目的
 * CI-SECONDARY-RUNNER-INSTALL,已正经 claim 却一律被拦,只能靠放行口硬闯)。
 * 病根不是「少扫了两个板」,而是判定逻辑焊死在 hook 文本里、没法演进——所以收进 CLI 当一等公民:
 *
 *   · 按分支名扫【registry 里全部已注册项目】的板,而不是安装 hook 时那一个;
 *   · 结构化比对 task.gitBranch(精确相等),不再拿分支名去 grep 整行文本
 *     —— 旧法会被 title 里恰好出现分支名的卡假放行,分支名含 / + 之类正则元字符时还会误判;
 *   · 拦下时把【全部候选项目】和正确的 --project 报出来,不再写死一个 id
 *     —— 照着旧文案去 add,会在错误的项目里造一张重复卡(卡上原话)。
 *
 * 放行口 DASHBOARD_SKIP_CLAIM_CHECK=1 由 hook 侧保留,本命令不管——跨项目场景之外
 * (板挂了、离线、紧急热修)它仍是唯一出路,不许拿掉。
 *
 * 用法:node cli/index.cjs claim-check [--branch <分支>] [--repo <仓库>] [--registry <path>]
 * 只读命令:不写看板、不改仓库。命中 → 退出码 0;都没命中 → 抛错(index.cjs 转退出码 1)。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readRegistry, resolveProject, REGISTRY_PATH } = require('../core/resolveProject.cjs');
const { normalizeReal } = require('../core/safePath.cjs');

// 主干分支免检:直接在主干上提交不是"未认领施工",闸门管的是任务分支。
// 空串 = rev-parse 失败(空仓/游离头),没有分支就无从判定,一律放行不添乱。
const EXEMPT = new Set(['main', 'master', 'HEAD', '']);
// 报错文案里给用户抄的 CLI 路径:走 __dirname(代码真实位置),不走 DASHBOARD_HOME(那是数据根)。
const CLI = path.join(__dirname, 'index.cjs').replace(/\\/g, '/');

function git(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

/**
 * 扫全部已注册项目的板,找"状态=施工中 且 gitBranch 含该分支"的任务。
 * 单个项目出任何问题(未注册路径/板不存在/板损坏)只记进 skipped 跳过,不连坐其它项目的判定。
 * @returns {{hits:Array<{project:string,name:string,taskId:string,percent:number,title:string}>, skipped:Array<{project:string,why:string}>, scanned:string[]}}
 */
function scanAll(registryPath, branch) {
  const reg = readRegistry(registryPath);
  const ids = Object.keys(reg.projects || {});
  const hits = []; const skipped = [];
  for (const id of ids) {
    let proj;
    try { proj = resolveProject(id, { registryPath }); }
    catch (e) { skipped.push({ project: id, soft: false, why: e.message }); continue; }
    let raw;
    try { raw = fs.readFileSync(proj.board, 'utf8'); }
    catch (e) {
      // 「注册了但还没建过板」是正常状态(soft),不该每次 commit 都刷一条警告;
      // 「连仓库目录都不在」才是异常(盘没挂载/仓库搬走)——那种情况下你要找的卡很可能就在那块
      // 读不到的板上,必须吵出来,否则闸门拦了你却给不出理由。
      const soft = e.code === 'ENOENT' && fs.existsSync(proj.mainRepo);
      const why = e.code === 'ENOENT'
        ? (soft ? '板还不存在(未建过卡)' : `仓库目录不在:${proj.mainRepo}`)
        : e.message;
      skipped.push({ project: id, soft, why });
      continue;
    }
    // 便宜的预筛:分支名在整份板文本里都没出现过,就不可能有任务挂着它(rogue 的板已 6MB+,
    // 每次 commit 都全解析 9 个板不划算)。子串命中才真解析,判定仍以结构化比对为准。
    if (!raw.includes(branch)) continue;
    let board;
    try { board = JSON.parse(raw); }
    catch (e) { skipped.push({ project: id, soft: false, why: `板不是合法 JSON:${e.message}` }); continue; }
    for (const t of (board.tasks || [])) {
      if (t.status === '施工中' && (t.gitBranch || []).map(String).includes(branch)) {
        hits.push({ project: id, name: proj.name, taskId: t.id, percent: t.percent || 0, title: t.title });
      }
    }
  }
  return { hits, skipped, scanned: ids };
}

/** 本仓库默认属于哪个项目(按 registry 的 mainRepo 反查);查不到返回 null,不影响判定,只影响文案。 */
function projectOfRepo(registryPath, repo) {
  if (!repo) return null;
  const top = git(repo, ['rev-parse', '--show-toplevel']) || repo;
  let real;
  try { real = normalizeReal(top); } catch { return null; }
  const reg = readRegistry(registryPath);
  for (const [id, entry] of Object.entries(reg.projects || {})) {
    try { if (normalizeReal(entry.mainRepo) === real) return id; } catch { /* 路径没了就跳过 */ }
  }
  return null;
}

function blockedMessage(branch, scanned, repoProj, skipped) {
  const pid = repoProj || '<项目id>';
  const L = [
    `看板 claim 硬闸门:分支 '${branch}' 在【全部 ${scanned.length} 个已注册项目】的板上都没有'施工中'任务`,
    '',
    `  已扫描:${scanned.join(', ') || '(registry 是空的)'}`,
    '',
    '  你在动代码之前应先跑(卡在哪个项目就填哪个 --project):',
    `    node ${CLI} claim <任务id> --project ${pid} --branch ${branch}`,
    '  任务不在看板 → 先 add 一条(建卡必带 --model):',
    `    node ${CLI} add <任务id> --project ${pid} --title "<一句话标题>" --model "opus·中"`,
    '',
  ];
  if (repoProj) {
    L.push(`  提示:本仓库默认属于项目 ${repoProj};但干别的项目的卡就填别的 id,`,
      '       别为了迁就闸门在本项目造一张重复卡(卡该归哪个项目按主题定,不按闸门定)。');
  } else {
    L.push('  提示:本仓库不在 registry 里,上面的 <项目id> 请按卡实际所属的项目填。');
  }
  const hard = skipped.filter((s) => !s.soft);
  if (hard.length) {
    L.push('', '  ⚠ 以下项目的板没能读进来(已跳过,可能正是你那张卡所在的板):');
    for (const s of hard) L.push(`     · ${s.project}:${s.why}`);
  }
  L.push('',
    '  这是 skill §11.9 硬约束(优先级 > 用户启动指令)——启动指令没写不是借口。',
    '  紧急放行:DASHBOARD_SKIP_CLAIM_CHECK=1 git commit ...',
    '');
  return L.join('\n');
}

/**
 * claim-check：分支上有没有"施工中"的卡(扫全部项目)。
 * @param {{branch?:string, repo?:string, registry?:string}} flags
 */
function claimCheck(flags) {
  const registryPath = flags.registry ? path.resolve(String(flags.registry)) : REGISTRY_PATH;
  const repo = flags.repo && flags.repo !== true ? path.resolve(String(flags.repo)) : process.cwd();
  const branch = (flags.branch === undefined || flags.branch === true)
    ? git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
    : String(flags.branch);

  if (EXEMPT.has(branch)) {
    return { ok: true, exempt: true, branch, hits: [], skipped: [], text: `✔ 分支 '${branch}' 免检(主干/无分支)` };
  }

  const { hits, skipped, scanned } = scanAll(registryPath, branch);
  // 读不进来的板写到 stderr:hook 会把 stdout 丢掉,这条警告不能跟着被丢——
  // "板悄悄读不到"正是闸门误拦的下一个病根,必须当场看得见。
  for (const s of skipped.filter((x) => !x.soft)) process.stderr.write(`⚠ claim-check 读不到项目 ${s.project} 的板:${s.why}\n`);

  if (!hits.length) {
    const err = new Error(blockedMessage(branch, scanned, projectOfRepo(registryPath, repo), skipped));
    err.claimCheck = { branch, scanned, skipped };
    throw err;
  }
  const lines = hits.map((h) => `  · ${h.project}(${h.name})· ${h.taskId} ${h.percent}%  ${h.title}`);
  return {
    ok: true, exempt: false, branch, hits, skipped, scanned,
    text: `✔ 分支 '${branch}' 已认领(${hits.length} 张):\n` + lines.join('\n'),
  };
}

module.exports = { claimCheck };
