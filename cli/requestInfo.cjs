'use strict';
const path = require('node:path');
const { mutateTask, findTask } = require('./store.cjs');
const { resolveProject, REGISTRY_PATH } = require('../core/resolveProject.cjs');

const INFO_FIELDS = ['background', 'optionPros', 'recommendReason'];
const nowIso = () => new Date().toISOString();

function required(value, usage) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('缺参数。用法: ' + usage);
  return value.trim();
}

/** 只登记补齐要求，不代答或改状态；重复要求保留各次活动并刷新要求时间。 */
function requestInfo(flags) {
  const id = required((flags._ || [])[0], 'request-info <卡号> --project <id> --did <dN> --missing <字段列表>');
  const did = required(flags.did, '--did <dN>');
  const fields = required(flags.missing, '--missing <background,optionPros,recommendReason 的子集>').split(',').map((s) => s.trim());
  if (fields.some((field) => !INFO_FIELDS.includes(field))) {
    throw new Error('--missing 只能包含 background、optionPros、recommendReason，字段之间用逗号分隔');
  }
  const missing = [...new Set(fields)];
  const author = flags.author === undefined ? '负责人' : required(flags.author, '--author <身份>');
  const proj = resolveProject(required(flags.project, '--project <id>'), {
    registryPath: flags.registry ? path.resolve(flags.registry) : REGISTRY_PATH,
  });
  let ts;
  const { board, changed } = mutateTask(proj, id, (b) => {
    const task = findTask(b, id);
    const decision = (task.decisions || []).find((d) => d.id === did);
    if (!decision) throw new Error(`决策 ${id}·${did} 不存在`);
    if (decision.answer != null) throw new Error(`决策 ${id}·${did} 已答，不能要求补齐三件套`);
    ts = nowIso();
    decision.infoRequestedAt = ts;
  }, () => ({
    ts, type: 'note', kind: 'request-info', author, taskId: id, did, missing,
    text: `负责人要求补齐 ${did} 的三件套：${missing.join('、')}`,
  }));
  return { ok: true, task: findTask(board, id), changed };
}

/** 按三件套的字数门槛判断是否补齐，不把历史要求误报成仍待处理。 */
function incompleteInfo(decision) {
  if (String(decision.background || '').trim().length < 60) return true;
  if (String(decision.recommendReason || '').trim().length < 30) return true;
  const pros = decision.optionPros;
  if (!pros || typeof pros !== 'object' || Array.isArray(pros)) return true;
  return (decision.options || []).some((option) => typeof pros[option] !== 'string' || pros[option].trim().length < 20);
}

/** doctor（含 quick）与 precheck 共用，只读并按卡与决策去重。 */
function requestedInfoIssues(board) {
  const requested = new Set((board.activity || [])
    .filter((a) => a && a.kind === 'request-info' && a.taskId && a.did)
    .map((a) => `${a.taskId}\0${a.did}`));
  const pending = [];
  for (const task of board.tasks || []) {
    for (const decision of task.decisions || []) {
      if (decision.answer == null && decision.infoRequestedAt
        && requested.has(`${task.id}\0${decision.id}`) && incompleteInfo(decision)) {
        pending.push(`${task.id}·${decision.id}`);
      }
    }
  }
  return pending.length ? [`${pending.length} 条待拍板被负责人要求补三件套：${pending.join('、')}`] : [];
}

module.exports = { requestInfo, requestedInfoIssues };
