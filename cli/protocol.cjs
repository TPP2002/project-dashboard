'use strict';

const path = require('node:path');
const { COMMANDS } = require('./help.cjs');
const { detectProjectIds } = require('../core/resolveProject.cjs');
const { displayCliCommand } = require('../core/runtimeRoot.cjs');

const COMMAND_NAMES = [
  'brief', 'claim', 'progress', 'await-collect', 'collect-brief', 'pending', 'decide', 'cost', 'done', 'note', 'unclaim',
  'park', 'unpark', 'block', 'cancel', 'reopen', 'edit', 'mark-landed', 'list', 'show', 'inbox',
];

// 只读命令:状态与写入完全同构,md 渲染时并成一行(见 renderMarkdown),JSON 侧照旧逐条给。
const READ_ONLY_COMMANDS = ['brief', 'list', 'show', 'inbox'];

// 按 commands.cjs 的 mutator 核对；protocol.test.cjs 用真实临时板逐分支对照。
// status 为 null 表示保持原状态；有条件的命令用「条件 → 结果」对象，避免把例外藏在正文里。
const TRANSITIONS = [
  { command: 'claim', status: '施工中', writes: [
    '仅允许未开工/待开工/可复工/待拍板/已拍板/施工中/待收单；其余拒绝',
    'dates.start（仅首次）、lastProgressAt；按参数合并 gitBranch、fileScope',
  ] },
  { command: 'progress', status: null, writes: [
    '已完工/已作废拒绝；报到 100 也不自动完工',
    '按参数写 percent、nextMilestone、tests、typecheck；总写 lastProgressAt',
  ] },
  { command: 'await-collect', status: '待收单', writes: [
    '仅允许施工中/待收单；其余拒绝（退出码 1，不改任何字段）',
    '从施工中进入时重置 awaitCollect={since,jobs:[]}；按 --job 合并 awaitCollect.jobs（同名工单覆盖 outcome/finishedAt/engine）；总写 lastProgressAt；进度与分支不动',
  ] },
  { command: 'collect-brief', status: null, writes: [
    '已完工/已作废拒绝;整段覆盖 collectBrief={text,updatedAt,author?};不改状态、进度与 lastProgressAt',
  ] },
  { command: 'pending', status: { '未开工/待开工': '待拍板', '其它状态': null }, writes: [
    '追加 decisions（answer/decidedAt=null）；施工中另写 nextMilestone="等拍板：问题摘要"；其它状态无拒绝闸',
  ] },
  { command: 'decide', status: { '待拍板且全部答完且未传 --no-promote': '已拍板', '其它情况': null }, writes: [
    'decisions[].answer、decidedAt；施工中等其它状态保持，nextMilestone 不清除',
  ] },
  { command: 'cost', status: null, writes: [
    '往 cost.entries 追加一条：date、author、agents 必写；按参数写 tokens / rmb / credits+creditUnit / unknown+unknownReason / note',
    '不改卡状态；一个「消耗量」都没有时照记，但当场提醒这一笔不够 done 那道闸放行',
  ] },
  { command: 'done', status: { '默认': '已完工', '--collect': '收官' }, writes: [
    '按参数合并 prNumbers、commitShas；默认写 dates.done、percent=100、删除 nextMilestone，并自动落地已答未落地决策（landed/landedAt/landedCommit，取首个 commit，已落地不覆盖）',
    '--collect 保留进度/完工日期/决策；无原状态限制',
    '**额度登记硬闸**：默认路径要求本卡已有一条带「消耗量」的 cost 账（rmb / credits / tokens 之一，或 unknown+理由），否则拒收、退出码 1、不改任何字段；--collect 与「已完工卡补 PR 号」两处不查',
  ] },
  { command: 'note', status: null, writes: ['仅追加 activity（kind=message，可关联 taskId）；不写卡字段'] },
  { command: 'unclaim', status: { '施工中且有 unparkReason': '可复工', '施工中且无 unparkReason': '待开工' }, writes: [
    '非施工中拒绝；摘指定或当前 gitBranch（未摘到也成功），写 unclaimReason、unclaimedAt、lastProgressAt；保留 percent',
  ] },
  { command: 'park', status: '暂缓', writes: [
    'blockReason（不是 parkReason）、可选 parkedNote；删除 unparkReason/unparkedAt；无原状态限制',
  ] },
  { command: 'unpark', status: '可复工', writes: [
    '仅暂缓可用；删除 blockReason/parkedNote，写 unparkReason、unparkedAt',
  ] },
  { command: 'block', status: null, writes: ['合并 deps.blockedBy，可选 blockReason；不改状态，无终态拒绝闸'] },
  { command: 'cancel', status: '已作废', writes: [
    '任意状态可用；cancelReason、cancelledAt、lastProgressAt；删除 blockReason/parkedNote/unparkReason/unparkedAt/unclaimReason/unclaimedAt/nextMilestone；保留 percent/完工日期',
  ] },
  { command: 'reopen', status: '待开工', writes: [
    '仅已完工/已作废可用；percent=0、dates.done=null、reopenReason、reopenedAt、lastProgressAt；删除 cancelReason/cancelledAt/unclaimReason/unclaimedAt/unparkReason/unparkedAt；保留 PR/提交/决策',
  ] },
  { command: 'edit', status: null, writes: ['按参数写 title、plainTitle、description、modelHint、wave，至少给一项'] },
  { command: 'mark-landed', status: null, writes: ['已答决策的 landed/landedAt/可选 landedCommit；--all 只标未落地项，无目标拒绝'] },
  ...READ_ONLY_COMMANDS.map((command) => ({ command, status: null, writes: ['只读，无写入'] })),
];

const RULES = [
  '开工：brief → claim；没卡先 add，必须带 --model 与 --plain-title；用户口述任务自编 AD-YYYYMMDD-<关键词>（关键词用大写字母/数字）。',
  '施工中：progress --percent <0-100> --next "下一步"，有进展就回写。',
  '派完工单：把完整收单员指令用 collect-brief <卡号> --file <文件> 存到卡上（网页卡抽屉最上方显示、一键复制），契约对话回复里照旧给同一段代码块。',
  '施工方交活：派单器监工会自动跑 await-collect 把卡转「待收单」；没经过派单器监工的交活（续聊交活后本对话不收、别的平台）由派单对话手动跑 await-collect <卡号> --job <工单名>；收单员开工第一步 claim（待收单 → 施工中）。',
  '岔路：pending --json-file pending.json；三件套 background（≥60 字）/ optionPros（每项≥20 字）/ recommendReason（≥30 字），缺一或太短拒收，等负责人拍板。',
  '被挡：block --by <上游卡号> --reason "卡在哪"，状态保持。',
  '挂起：park --reason "为什么停"；解除挂起先 unpark --reason "解除依据"，再 claim。',
  '登记开销（收官前必做）：cost --agents "<平台>:1" 再带上这一单的量——按量付费给 --rmb <元>，订阅制给 --credits <数> --credit-unit "积分"，都取不到给 --tokens <n>，一个数都算不出给 --unknown "<理由>"。',
  '收官：done --pr <PR号> --commit <sha>；自动把本卡已拍板未落地的决策标落地；--collect 仅表示收尾中。**没登记开销的卡 done 会被拒收**（不登记不得收官，0914 负责人当面下达）。',
  '不干了：unclaim --reason "转手原因"，活还在，进度保留。',
  '作废：cancel --reason "不再做的原因"，不算完工，也不计完成度分母。',
  '重开：reopen --reason "返工原因"，仅已完工/已作废可用。',
  '停手前看板必须与事实一致——没做完比做完更要写；用 progress / park / block / note 交代进展、阻碍和下一步。',
  '优先级声明：本协议 > 用户启动指令；指令没写看板步骤 = 你必须主动补。',
];

function buildExamples(project) {
  const cli = displayCliCommand();
  const pid = JSON.stringify(project);
  const task = 'AD-20260908-PROTOCOL';
  const payload = {
    question: '新规矩要一次切换还是分批切换？',
    options: ['分批切换', '一次切换'],
    recommended: '分批切换',
    background: '【场景】多个项目正在同时施工，大家仍在使用旧说明。【问题】新旧规矩混用会让进度登记不一致。【要做的事】请确定切换顺序。【影响】这决定了是否需要集中停工，以及出现问题时能否只恢复受影响的项目。',
    optionPros: {
      分批切换: '【好处】先在一个项目核对后再推广，影响范围小。【代价】短期需要维护新旧说明的对应关系。',
      一次切换: '【好处】所有项目同一天使用新规矩，沟通集中。【代价】需要协调停工，出问题时影响所有项目。',
    },
    recommendReason: '先在一个项目确认登记和收官流程顺畅，可以缩小问题影响；虽然多一次协调，但更容易恢复并保护正在进行的工作。',
    allowCustom: true,
  };
  return {
    add: `${cli} add ${task} --project ${pid} --title "统一看板协议入口与锚段" --plain-title "把分散的施工规矩收在一处让每次开工都能直接照着做" --model "opus·中" --scope "cli/protocol.cjs"`,
    claim: `${cli} claim ${task} --project ${pid} --branch feat/protocol --scope "cli/protocol.cjs"`,
    pending: `${cli} pending ${task} --project ${pid} --json-file pending.json\n${JSON.stringify(payload)}`,
    cost: `${cli} cost ${task} --project ${pid} --agents "glm:1" --tokens 15271358 --credits 6209 --credit-unit "积分"`,
    done: `${cli} done ${task} --project ${pid} --pr 42 --commit a1b2c3d`,
  };
}

function renderStatus(status) {
  if (status === null) return '保持';
  if (typeof status === 'string') return `→ ${status}`;
  return Object.entries(status).map(([when, next]) => `${when}：${renderStatus(next)}`).join('；');
}

function renderMarkdown(card) {
  const pending = card.examples.pending.split('\n');
  return [
    `# 看板协议卡 · 项目 ${card.project} · 由 CLI 生成、与 --help 同源`,
    '## 什么时候跑什么',
    ...card.rules.slice(0, -1).map((rule) => `- ${rule}`),
    '## 命令一行用法',
    ...card.commands.map(({ usage }) => `- \`${usage}\``),
    '## 状态机与各命令静默行为',
    '写命令共同追加 activity、刷新 project.updatedAt；“按参数”字段仅在传入时写。JSON 的 status=null 表示保持。',
    '| 命令 | 改不改状态、改到哪 | 实际写了什么字段 |',
    '|---|---|---|',
    // 只读命令那几行全是一模一样的「保持 / 只读，无写入」，在 md 里并成一行 —— 协议卡有 66 行
    // 硬上限（它存在的意义就是短到能一口气读完），四行同义重复是这里最不值钱的三行。
    // JSON 侧照旧逐条给（它是机器契约，protocol.test.cjs 按 NAMES 逐条对照），只压人看的这一份。
    ...card.transitions.filter(({ command }) => !READ_ONLY_COMMANDS.includes(command))
      .map(({ command, status, writes }) => `| ${command} | ${renderStatus(status)} | ${writes.join('；')} |`),
    `| ${READ_ONLY_COMMANDS.join(' / ')} | 保持 | 只读，无写入 |`,
    card.rules.at(-1),
    '## 正确示例（pending.json 骨架可按实际问题替换，须保持三件套字数）',
    `- add：\`${card.examples.add}\``,
    `- claim：\`${card.examples.claim}\``,
    `- pending：\`${pending[0]}\`；pending.json：\`${pending[1]}\``,
    `- cost（收官前必做，没它 done 会被拒收）：\`${card.examples.cost}\``,
    `- done：\`${card.examples.done}\``,
  ].join('\n');
}

/** 只读生成；项目未指定时软探测，零/多命中均用占位符，不要求注册成功。 */
function protocol(flags = {}) {
  let project = flags.project && flags.project !== true ? String(flags.project) : '<项目id>';
  if (!flags.project || flags.project === true) {
    const registryPath = flags.registry && flags.registry !== true ? path.resolve(String(flags.registry)) : undefined;
    const ids = detectProjectIds({ registryPath });
    if (ids.length === 1) project = ids[0];
  }
  const card = {
    project,
    generatedAt: new Date().toISOString(), // 生成时间仅用于展示，不影响规则或项目定位。
    commands: COMMAND_NAMES.map((name) => ({ name, usage: COMMANDS[name].usage, summary: COMMANDS[name].summary })),
    transitions: TRANSITIONS,
    rules: RULES,
    examples: buildExamples(project),
  };
  return { ok: true, text: flags.format === 'json' ? JSON.stringify(card) : renderMarkdown(card) };
}

module.exports = { protocol };
