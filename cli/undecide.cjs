'use strict';
const path = require('node:path');
const { mutateTask, findTask } = require('./store.cjs');
const { resolveProject, REGISTRY_PATH } = require('../core/resolveProject.cjs');

function required(value, usage) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('缺参数。用法: ' + usage);
  return value.trim();
}

function act(type, author, text, taskId) {
  return { ts: new Date().toISOString(), author, type, text, taskId };
}

/** CLI 不限撤销时间；已落地拒绝，只有「已拍板」状态退回，进度与施工状态保留。 */
function undecide(flags) {
  const id = required((flags._ || [])[0], 'undecide <卡号> --project <id> --did <dN> [--reason <文本>]');
  const did = required(flags.did, '--did <dN>');
  const reason = flags.reason === undefined ? '' : required(flags.reason, '--reason <文本>');
  const author = flags.author === undefined ? '看板' : required(flags.author, '--author <身份>');
  const proj = resolveProject(required(flags.project, '--project <id>'), {
    registryPath: flags.registry ? path.resolve(flags.registry) : REGISTRY_PATH,
  });
  const { board, changed } = mutateTask(proj, id, (b) => {
    const task = findTask(b, id);
    const decision = (task.decisions || []).find(item => item.id === did);
    if (!decision) throw new Error(`决策 ${id}·${did} 不存在`);
    if (decision.answer == null) throw new Error(`决策 ${id}·${did} 尚未拍板，不能撤销`);
    if (decision.landed) throw new Error(`决策 ${id}·${did} 已落地，请先查看落地情况，不能撤销拍板`);
    decision.answer = null;
    decision.decidedAt = null;
    delete decision.decidedBy;
    if (task.status === '已拍板') task.status = '待拍板';
  }, () => act('undecide', author, `撤销拍板 ${id}·${did}${reason ? '：' + reason : ''}`, id));
  return { ok: true, task: findTask(board, id), changed };
}

module.exports = { undecide };
