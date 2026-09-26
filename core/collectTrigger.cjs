'use strict';
/**
 * collectTrigger.cjs —— 「待收单」卡的收单指令与交活结果的单一真相源。
 *
 * 【为什么要有它】外部施工方(GLM/DeepSeek/Codex…)交活之后,要新开一个 Sonnet 对话来收单。
 * 那句"贴进去的开场白"由卡号、项目 id、工单清单拼成,CLI 要打、网页要复制、任务书要引用——
 * 三处各拼各的,迟早有一处漏掉半句,收单员就拿着错的开场白开工。所以模板只有这一份:
 * CLI / 网页(vite 经 'virtual:board-schema' 内联)都用它,改文案只改这里。
 *
 * 【收单闭环】写契约的对话用 collect-brief 把完整收单员指令存到卡上(collectBrief) →
 * 施工方交活 → await-collect 把卡转「待收单」并记下工单清单 →
 * 负责人在「待收单」泳道挑卡、在卡抽屉点「复制收单指令」→ 新开 Sonnet 对话贴进去 →
 * 收单员第一步 claim(待收单 → 施工中),再按复制来的指令照做;没存过指令才走兜底句。
 */

/** await-collect --outcome 的合法取值,按序展示。 */
const COLLECT_OUTCOMES = ['finished', 'timeout', 'failed'];

/** outcome 的人话文案(活动流、抽屉工单清单、收单指令共用)。 */
const OUTCOME_TEXT = { finished: '正常交活', timeout: '超时被停', failed: '异常退出' };

/** 收单指令兜底模板:{taskId}/{projectId} 各出现两处,{jobs} 是工单清单(全角标点一字不差)。
 * 卡上 collectBrief 存了完整指令时不用它;没存才按它现场拼一句兜底。 */
const COLLECT_TRIGGER_TEMPLATE = '【会话种类:收单员 · Sonnet】收单卡 {taskId}(看板项目 {projectId})。第一步 claim 本卡(待收单 → 施工中);这张卡上没有存收单指令,先 show {taskId} --project {projectId} --full 读卡面与留言,拿不准就停下交回编排对话。施工方已交活的工单:{jobs}。';

/** 卡上一条工单都没记时,{jobs} 处给的兜底文案。 */
const NO_JOBS_TEXT = '(卡上没记,见留言)';

/** collect-brief 存进卡上的收单指令全文长度上限,命令与 schema 校验共用一个数。 */
const COLLECT_BRIEF_MAX = 20000;

/**
 * 卡上该用的收单指令。collectBrief.text 存了完整指令就原样返回(不拼任何前后缀);
 * 没存才按兜底模板现场拼一句:jobs 逐条 `工单名(结果文案)`、「、」连接、空列表用 NO_JOBS_TEXT。
 * @param {{projectId:string, task:{id?:string, awaitCollect?:{jobs?:Array<{slug:string,outcome:string}>}, collectBrief?:{text?:string}}}} input
 */
function collectInstructionOf({ projectId, task }) {
  const brief = (task || {}).collectBrief;
  if (brief && typeof brief.text === 'string' && brief.text) return brief.text;
  const jobs = (((task || {}).awaitCollect || {}).jobs || [])
    .map((j) => `${j.slug}(${OUTCOME_TEXT[j.outcome] || j.outcome})`)
    .join('、');
  return COLLECT_TRIGGER_TEMPLATE
    .split('{taskId}').join((task || {}).id || '')
    .split('{projectId}').join(projectId || '')
    .split('{jobs}').join(jobs || NO_JOBS_TEXT);
}

/** 卡上存没存过完整收单指令(collectBrief.text 为非空字符串即算存过)。 */
function hasCollectBrief(task) {
  const brief = (task || {}).collectBrief;
  return !!brief && typeof brief.text === 'string' && !!brief.text;
}

module.exports = { COLLECT_OUTCOMES, OUTCOME_TEXT, COLLECT_TRIGGER_TEMPLATE, NO_JOBS_TEXT, COLLECT_BRIEF_MAX, collectInstructionOf, hasCollectBrief };
