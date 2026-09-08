'use strict';
/**
 * inboxCmd.cjs —— 新对话"读看板接单"的入口(派单的可靠兜底/主路)。
 * 用户在【桌面端 Claude Code】新开一个对话,粘贴短触发指令(内含 `cli inbox`),
 * 那对话跑本命令,从看板读出【完整任务书】(纯文本打印),然后照它施工。
 *
 * 用法:
 *   cli inbox --project <id>            列出该项目所有待落地任务(供挑选)
 *   cli inbox --project <id> --tid <t>  打印某任务的完整任务书(对话读它开干)
 */
const { readBoard } = require('./store.cjs');
const { resolveProject } = require('../core/resolveProject.cjs');
const { buildTaskDispatchPrompt } = require('./dispatchPrompt.cjs');
const { displayCliCommand } = require('../core/runtimeRoot.cjs');
const { humanTitle } = require('../core/taskTitle.cjs');
const { unlandedOf, presumedLandedOf } = require('../core/decisionLanding.cjs');

function need(v, msg) { if (v === undefined || v === true || v === '') throw new Error(msg); return v; }

function getRegistryPath(flags) {
  const { REGISTRY_PATH } = require('../core/resolveProject.cjs');
  return flags.registry ? require('node:path').resolve(flags.registry) : REGISTRY_PATH;
}

/**
 * 列表态默认只列这么多张(AUD-CLI-BRIEF-AND-HELP,审计 §4-A4)。
 * 【为什么要封顶】列表态的用途只是"挑一张接手"。实测某项目待落地 171 张 = 25KB≈14k token,
 * 一屏根本挑不动,还每次都烧一整轮额度。封顶 + `--all` 兜底,和 `list` 默认藏已完工同一个契约。
 * 待落地口径由 core/decisionLanding.cjs 统一；这里仅控制列表一次给多少行。
 */
const DEFAULT_LIST_LIMIT = 30;

function listLimit(flags) {
  const n = flags.limit !== undefined && flags.limit !== true ? parseInt(flags.limit, 10) : NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_LIST_LIMIT;
}

/** 一张卡里"最近一次拍板"的日期;都没有就给空串(排到最后)。 */
function latestDecidedAt(decisions) {
  return decisions.reduce((max, d) => (d.decidedAt && d.decidedAt > max ? d.decidedAt : max), '');
}

function inbox(flags) {
  const id = need(flags.project, '--project <id>');
  const proj = resolveProject(id, { registryPath: getRegistryPath(flags) });
  const board = readBoard(proj.board);
  const projName = (board.project && board.project.name) || id;

  // 收集所有"有待落地决策"的任务
  const tasks = (board.tasks || [])
    .map((t) => ({ task: t, decisions: unlandedOf(t) }))
    .filter((x) => x.decisions.length > 0);

  const tid = flags.tid ? String(flags.tid) : '';
  if (!tid) {
    // 没指定任务 → 列出候选,给下一步命令
    if (!tasks.length) {
      return { ok: true, text: `📭 项目 ${projName}(${id})没有待落地任务——拍板都已落地或还没拍板。` };
    }
    // 新拍的板排前面:这一屏是"挑一张接手",最近拍的最可能是负责人正等着落地的那张。
    const ranked = tasks
      .map((x, i) => ({ ...x, order: i, latest: latestDecidedAt(x.decisions) }))
      .sort((a, b) => (a.latest === b.latest ? a.order - b.order : (a.latest < b.latest ? 1 : -1)));
    const shown = flags.all ? ranked : ranked.slice(0, listLimit(flags));

    const lines = [
      `📥 项目 ${projName}(${id})待落地任务(共 ${tasks.length} 个):`,
      '',
    ];
    // 列表态只给"挑哪张"要的三样:卡号 + 人话标题 + 待落地条数。
    // 旧版打 `task.title`(给模型看的技术说明,实测最长 2166 字)——rogue 一次列表 25KB≈14k token,
    // 而这一步只是让人/AI 挑一张(AUD-CLI-BRIEF-AND-HELP,审计 §4-A4)。挑完 --tid 才给完整任务书。
    shown.forEach((x) => {
      lines.push(`  · ${x.task.id}  ${humanTitle(x.task)}  (${x.decisions.length} 条待落地)`);
    });
    lines.push('');
    if (shown.length < tasks.length) {
      lines.push(`（新拍的板排前面，只列了 ${shown.length} 个，还有 ${tasks.length - shown.length} 个没列——`
        + '`--all` 全列，`--limit <n>` 改条数）');
    }
    lines.push('挑一个接手,运行:');
    lines.push(`  ${displayCliCommand()} inbox --project ${id} --tid <上面某任务id>`);
    return { ok: true, text: lines.join('\n') };
  }

  // 指定了任务 → 打印完整任务书
  const found = tasks.find((x) => x.task.id === tid);
  if (!found) {
    const t = (board.tasks || []).find((x) => x.id === tid);
    if (!t) throw new Error(`任务 ${tid} 不存在于项目 ${id}`);
    const presumed = presumedLandedOf(t);
    if (presumed.length) {
      return { ok: true, text: `✅ 任务 ${tid} ${t.status}，其 ${presumed.length} 条未标记的拍板视为随卡落地，无需接手。` };
    }
    return { ok: true, text: `✅ 任务 ${tid} 没有待落地决策(可能都已落地)。无需接手。` };
  }
  const prompt = buildTaskDispatchPrompt(id, projName, found.task, found.decisions, board);
  return { ok: true, text: prompt };
}

module.exports = { inbox };
