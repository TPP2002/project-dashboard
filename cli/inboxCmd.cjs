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

function need(v, msg) { if (v === undefined || v === true || v === '') throw new Error(msg); return v; }

function getRegistryPath(flags) {
  const { REGISTRY_PATH } = require('../core/resolveProject.cjs');
  return flags.registry ? require('node:path').resolve(flags.registry) : REGISTRY_PATH;
}

function unlandedOf(task) {
  return (task.decisions || []).filter((d) => d.answer !== null && d.answer !== undefined && !d.landed);
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
    const lines = [
      `📥 项目 ${projName}(${id})待落地任务(共 ${tasks.length} 个):`,
      '',
    ];
    tasks.forEach((x) => {
      lines.push(`  · ${x.task.id}  ${x.task.title}  (${x.decisions.length} 条已拍板决策)`);
    });
    lines.push('');
    lines.push('挑一个接手,运行:');
    lines.push(`  node ~/.claude/dashboard/cli/index.cjs inbox --project ${id} --tid <上面某任务id>`);
    return { ok: true, text: lines.join('\n') };
  }

  // 指定了任务 → 打印完整任务书
  const found = tasks.find((x) => x.task.id === tid);
  if (!found) {
    const t = (board.tasks || []).find((x) => x.id === tid);
    if (!t) throw new Error(`任务 ${tid} 不存在于项目 ${id}`);
    return { ok: true, text: `✅ 任务 ${tid} 没有待落地决策(可能都已落地)。无需接手。` };
  }
  const prompt = buildTaskDispatchPrompt(id, projName, found.task, found.decisions);
  return { ok: true, text: prompt };
}

module.exports = { inbox };
