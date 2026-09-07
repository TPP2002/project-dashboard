'use strict';
/**
 * brief.cjs —— "一条命令拿全开工信息"(AUD-CLI-BRIEF-AND-HELP,审计 §4-A3)。
 *
 * 【病根】开工前要读 CLAUDE.md 锚段 + skill + `precheck` + `show`(整卡 JSON)+ `inbox --tid`
 * (还只在有待落地决策时可用):信息散在五处、没有一处齐全,新对话每次都要自己拼,拼漏了就白干。
 * 【治法】一份 markdown 任务书,把"能不能开工、要干什么、会碰哪些文件、上游好了没、
 * 负责人已经拍过什么"一次给全。三个入口共用这一个生成器:
 *   · `brief <卡号>`          —— 新对话开工先跑它
 *   · `claim <卡号> --brief`  —— 认领即打印
 *   · `inbox --tid <卡号>`    —— 派单任务书 = 本正文 + 落地流程段(见 dispatchPrompt.cjs)
 * 三处同源,才不会出现"派单说的和自己查的不一样"。
 */
const path = require('node:path');
const { readBoard, findTask } = require('./store.cjs');
const { resolveProject, REGISTRY_PATH } = require('../core/resolveProject.cjs');
const { humanTitle, specText, missingPlainTitle } = require('../core/taskTitle.cjs');
const { displayCliCommand } = require('../core/runtimeRoot.cjs');

function need(v, usage) { if (v === undefined || v === true || v === '') throw new Error('缺参数。用法: ' + usage); return v; }
function getRegistryPath(flags) { return flags.registry ? path.resolve(flags.registry) : REGISTRY_PATH; }

/** 这些状态算"上游已经交付了",依赖指向它们就不必再警告。 */
const SETTLED = ['已完工', '收官'];

function unanswered(task) {
  return (task.decisions || []).filter((d) => d.answer === null || d.answer === undefined);
}
function unlanded(task) {
  return (task.decisions || []).filter((d) => d.answer !== null && d.answer !== undefined && !d.landed);
}

/** 依赖那一行:卡号 + 它此刻的状态 + 人话标题;板上没有这张卡时如实说,不假装它就绪。 */
function depLine(depId, byId, { warnUnsettled }) {
  const dep = byId.get(depId);
  if (!dep) return `  - \`${depId}\` （板上没有这张卡，卡号可能写错了）`;
  const done = SETTLED.includes(dep.status);
  const tail = warnUnsettled && !done ? ' ← 还没完工，现在开工可能白干' : '';
  return `  - \`${depId}\` ${dep.status} · ${humanTitle(dep)}${tail}`;
}

/** 一条留言最多显示这么长；再长就截，免得有人把整份方案粘进 note 又把任务书撑爆。 */
const NOTE_MAX = 200;

/**
 * 活动流里挂在这张卡上的留言（最近 N 条，新的在前）。
 * 只认 `note` 命令写的（kind='message'）：add / set / mark-landed 的记账流水也记成 type:'note'，
 * 其中「新建任务 …」那条会把整段技术说明再吐一遍——正是本卡要消灭的浪费。
 */
function recentNotes(board, taskId, limit = 3) {
  return ((board && board.activity) || [])
    .filter((a) => a && a.type === 'note' && a.kind === 'message' && a.taskId === taskId && a.text)
    .slice(-limit)
    .reverse()
    .map((a) => ({
      ts: a.ts,
      author: a.author,
      text: String(a.text).length > NOTE_MAX ? String(a.text).slice(0, NOTE_MAX) + '…（截断）' : String(a.text),
    }));
}

/**
 * 开工任务书正文。
 * @param {object} input
 * @param {string} input.pid 项目 id
 * @param {string} [input.projName] 项目显示名
 * @param {object} [input.board] 整块板（算依赖状态与留言要用；派单夹具可能没有，缺了也不炸）
 * @param {object} input.task 这张卡
 * @param {string} [input.cli] CLI 调用前缀
 * @param {boolean} [input.includeNextSteps=true] 带不带"下一步命令"段（派单任务书自己有落地流程，不重复）
 */
function buildBrief({ pid, projName, board, task, cli, includeNextSteps = true }) {
  const CLI = cli || displayCliCommand();
  const b = board || {};
  const byId = new Map(((b.tasks) || []).map((t) => [t.id, t]));
  const t = task || {};
  const proj = ` --project ${pid}`;
  const L = [];

  L.push(`# ${t.id} · ${humanTitle(t) || '（这张卡还没写标题）'}`);
  L.push('');
  L.push(`**项目**：${projName || pid}（\`${pid}\`）　**状态**：${t.status || '未知'} ${t.percent || 0}%`
    + `　**建议档位**：${t.modelHint || '没登记'}　**波次**：${t.wave === undefined ? '-' : t.wave}`);
  L.push(`**分支**：${(t.gitBranch || []).join('、') || '还没人建'}`
    + `　**开工日**：${(t.dates && t.dates.start) || '-'}`
    + (t.nextMilestone ? `　**上一次报的下一步**：${t.nextMilestone}` : ''));
  if (missingPlainTitle(t)) {
    L.push(`> 这张卡还没写人话标题，负责人在看板上只看得到技术说明的前 60 字。`
      + `顺手补一句：\`${CLI} set ${t.id}${proj} --field plainTitle --value "<一句人话>"\``);
  }
  if (t.blockReason) L.push(`> 🚧 卡在：${t.blockReason}`);

  // ⛔ 闸门放在最前面：没拍完板就动代码，是本流程最贵的一种白干。
  const open = unanswered(t);
  if (open.length) {
    L.push('');
    L.push(`> ⛔ **禁止开工**：这张卡还有 ${open.length} 条没答的待拍板问题（见下方「待拍板」）。`
      + '先请负责人拍板，拿到答案再动代码。');
  }

  L.push('');
  L.push('## 技术说明（给模型的详细说明，正本）');
  L.push('');
  L.push(specText(t) || '（空）');

  L.push('');
  L.push('## 会改哪些文件');
  L.push('');
  if ((t.fileScope || []).length) {
    for (const s of t.fileScope) L.push(`- \`${s}\``);
    L.push('');
    L.push('（只动这些；要动别的先说一声——看板靠这份范围算"哪几张卡能同时派"。）');
  } else {
    L.push('- 没登记。看板据此判并行，空着等于放任撞车。');
    L.push(`  认领时顺手补：\`${CLI} claim ${t.id}${proj} --branch <分支> --scope "<glob>"\`（可重复）`);
  }

  L.push('');
  L.push('## 依赖');
  L.push('');
  const deps = t.deps || {};
  const dependsOn = deps.dependsOn || [];
  const blockedBy = deps.blockedBy || [];
  if (!dependsOn.length && !blockedBy.length) {
    L.push('- 没登记依赖。');
  } else {
    if (dependsOn.length) {
      L.push('- 要等的上游（dependsOn）：');
      for (const d of dependsOn) L.push(depLine(d, byId, { warnUnsettled: true }));
    }
    if (blockedBy.length) {
      L.push('- 正挡着它的卡（blockedBy）：');
      for (const d of blockedBy) L.push(depLine(d, byId, { warnUnsettled: true }));
    }
  }

  if (open.length) {
    L.push('');
    L.push('## 待拍板（没拍完不许开工）');
    L.push('');
    for (const d of open) {
      L.push(`### ${d.id} ${d.question}`);
      L.push('');
      L.push(`- 选项：${(d.options || []).join(' / ')}`);
      L.push(`- 看板推荐：${d.recommended || '-'}`);
      if (d.recommendReason) L.push(`- 推荐理由：${d.recommendReason}`);
      L.push('');
    }
    L.push(`拍板由负责人在看板上做；命令行等价写法：\`${CLI} decide ${t.id}${proj} --did <dN> --answer "<答案>"\``);
  }

  const landing = unlanded(t);
  if (landing.length) {
    L.push('');
    L.push(`## 已拍板 · 要落地的答案（${landing.length} 条）`);
    L.push('');
    for (const d of landing) {
      L.push(`### ${d.id}（拍于 ${d.decidedAt || '?'}）${d.question}`);
      L.push('');
      L.push('**负责人拍的答案**：');
      L.push('');
      L.push('```');
      L.push(String(d.answer));
      L.push('```');
      if (d.recommendReason) L.push(`（当时看板给的推荐理由，仅供参考，以答案为准：${d.recommendReason}）`);
      L.push('');
    }
  }

  L.push('');
  L.push('## 参考文档');
  L.push('');
  if ((t.docs || []).length) for (const d of t.docs) L.push(`- ${d}`);
  else L.push('- 没登记。');

  const notes = recentNotes(b, t.id);
  L.push('');
  L.push('## 最近留言');
  L.push('');
  if (notes.length) for (const n of notes) L.push(`- ${String(n.ts || '').slice(0, 10)} ${n.author || 'cli'}：${n.text}`);
  else L.push('- 无。');

  if (includeNextSteps) {
    const working = t.status === '施工中';
    L.push('');
    L.push('## 下一步命令');
    L.push('');
    L.push('```bash');
    if (!working) L.push(`${CLI} claim ${t.id}${proj} --branch <你的分支名> --scope "<会改的文件>"`);
    L.push(`${CLI} progress ${t.id}${proj} --percent <n> --next "<下一步>"`);
    L.push(`${CLI} pending ${t.id}${proj} --json-file pending.json   # 中途冒出新的拍板点`);
    L.push(`${CLI} done ${t.id}${proj} --pr <PR号> --commit <sha>`);
    L.push('```');
  }
  return L.join('\n');
}

/** `brief <卡号> --project <id>` */
function brief(flags) {
  const proj = resolveProject(need(flags.project, 'brief <卡号> --project <id>'), { registryPath: getRegistryPath(flags) });
  const board = readBoard(proj.board);
  const id = need((flags._ || [])[0], 'brief <卡号> --project <id>');
  const task = findTask(board, id);
  return { ok: true, text: buildBrief({ pid: proj.id, projName: proj.name, board, task }) };
}

module.exports = { brief, buildBrief, unanswered, unlanded, SETTLED };
