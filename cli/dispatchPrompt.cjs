'use strict';
/**
 * dispatchPrompt.cjs —— 派单"任务书"生成器(server 与 cli inbox 共用,零依赖纯字符串)。
 * 单一事实源:无论看板界面派单、还是新对话跑 `cli inbox` 读看板,都用同一份生成器,
 * 保证对话拿到的任务书一致。
 */
const CLI = 'node ~/.claude/dashboard/cli/index.cjs';

/**
 * 短触发指令——给新对话粘贴用(避开命令行长度/转义,funnel through cli inbox)。
 * 用户在【桌面端 Claude Code】新开一个对话,粘贴这一句,那对话自己去读看板拿完整任务书。
 */
function shortTrigger(pid, tid) {
  return [
    `你被【项目管理看板】指派接手任务 ${tid}(项目 ${pid})。`,
    `请立刻运行下面命令拿到完整任务书,然后严格按它执行(先 cli claim 再动代码):`,
    '',
    `${CLI} inbox --project ${pid} --tid ${tid}`,
  ].join('\n');
}

/** 任务级任务书:一个任务的所有 unlanded decisions 打包,一个对话统一施工。 */
function buildTaskDispatchPrompt(pid, projName, task, decisions) {
  const lines = [
    `# 【看板派单】此对话负责落地任务 ${task.id} 的全部已拍板决策`,
    '',
    `你是被【项目管理看板】指派来落地一条/几条已拍板决策的。这条内容就是完整任务书,你不需要问用户"要做什么"。`,
    '',
    `**项目**:${projName || pid} (项目 id: \`${pid}\`,已接入看板)`,
    `**任务**:${task.id} · ${task.title}`,
    `**本任务有 ${decisions.length} 条已拍板决策要落地**(都是这一个任务的决策,由你一个对话统一施工):`,
    '',
    '---',
    '',
  ];
  decisions.forEach((d, i) => {
    lines.push(`## 决策 ${i + 1}/${decisions.length}:#${d.id}(用户拍于 ${d.decidedAt})`);
    lines.push('');
    lines.push(`**问题**:${d.question}`);
    lines.push('');
    lines.push('**用户拍的答案**:');
    lines.push('');
    lines.push('```');
    lines.push(d.answer);
    lines.push('```');
    lines.push('');
    if (d.recommendReason) {
      lines.push(`**当时看板给的推荐理由**(参考,以用户答案为准):${d.recommendReason}`);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  });
  lines.push('## 你的施工职责');
  lines.push('');
  lines.push('**读了再动手**:');
  lines.push('1. 项目根 `CLAUDE.md`——本项目的看板同步纪律(pre-commit 硬闸门会拦你不 claim 就 commit)');
  lines.push('2. skill `project-build-workflow` §11.2 认领协议 + §11.9 看板同步 + §6.2 拍板话术');
  lines.push(`3. 本任务的设计文档(见 board.json 里 ${task.id}.docs 字段)`);
  lines.push('');
  lines.push('**落地流程(整个任务一次 claim,把上面所有决策一起做)**:');
  lines.push('');
  lines.push('```');
  lines.push('# 先核对新鲜度 + 建分支');
  lines.push('git fetch');
  lines.push('# 认领本任务(整个任务只 claim 一次,不 claim git commit 会被 pre-commit 硬闸门拦)');
  lines.push(`${CLI} claim ${task.id} --project ${pid} --branch <你的分支名>`);
  lines.push('');
  lines.push('# 按上面每条决策的答案落地实现...(施工)');
  lines.push('');
  lines.push('# 施工完成');
  lines.push(`${CLI} done ${task.id} --project ${pid} --pr <PR号> --commit <sha>`);
  lines.push('# 逐条标记决策已落地:');
  decisions.forEach((d) => {
    lines.push(`${CLI} mark-landed ${task.id} --did ${d.id} --project ${pid}`);
  });
  lines.push('```');
  lines.push('');
  lines.push('4. 达标自动 push + gh pr create + auto-merge to main(见 skill §11.7)');
  lines.push('5. 中途冒出新的待拍板点 → `cli pending --json` 登记(背景/利弊/推荐理由三件套,skill §6.2)');
  lines.push('');
  lines.push('**⚠ 若本任务要求你新建任务(cli add)**:');
  lines.push('- 新任务的 **wave(波次)默认留 0、别传 --wave、更别继承本任务的 wave**——新任务从 0 起,');
  lines.push('  波次编号只属于项目原始计划的批次,新冒出来的任务不该塞进已有的高波次里。');
  lines.push('- 新任务若要拍板点,同样走 `cli pending --json` 三件套。');
  lines.push('');
  const hasDesignAnswer = decisions.some((d) => /暂缓|编写一套|设计方案|联网|对抗审查/.test(d.answer || ''));
  if (hasDesignAnswer) {
    lines.push('**注意本任务含"去设计"类答案**(不是照代码改,而是启动新方案设计):');
    lines.push('- 不是现在动代码,而是新起一份设计方案文档(放 `docs/plans/` 下,沿用项目编号规则)');
    lines.push('- 按 skill §3 阶段①对账 + §4 阶段②建议 + §5 阶段③分解 走完,最后停下等用户拍板才能开工');
    lines.push('- 联网搜索/对抗审查/对齐现有代码这些用户提到的都要做完');
    lines.push('');
  }
  lines.push('## 现在开始');
  lines.push('');
  lines.push('别问"要不要开始"、别问"具体做什么"——上面就是完整任务书。请从决策 1 开始,先做本任务的阶段①对账。');
  return lines.join('\n');
}

module.exports = { buildTaskDispatchPrompt, shortTrigger, CLI };
