'use strict';
// Shared presentation/authorization rules. Project access is checked by callers;
// the CLI evaluates these against the freshly read task inside both locks.
const terminal = t => ['已完工', '已作废'].includes(t.status);
const pending = t => (t.decisions || []).some(d => d.answer === undefined || d.answer === null || d.answer === '');
function aiWork(t) {
  return !!t.builder || ['gitBranch', 'prNumbers', 'commitShas'].some(k => (t[k] || []).length > 0);
}
function memberActions(task, user) {
  if (!user || user.disabled || !['owner', 'member'].includes(user.role)) return [];
  const owner = user.role === 'owner';
  const actions = ['note'];
  if (!owner && aiWork(task)) return actions;
  const assigned = owner || task.assigneeUserId === user.id;
  const createdOrAssigned = assigned || task.createdByUserId === user.id;
  if ((!task.assigneeUserId || assigned) && ['未开工', '待开工', '可复工', '已拍板'].includes(task.status) && !pending(task)) actions.push('claim');
  if (assigned && task.status === '施工中' && !task.blockReason && !(task.deps?.blockedBy || []).length) actions.push('progress');
  if (assigned && task.status === '施工中') actions.push('unclaim');
  if (assigned && !terminal(task) && task.status !== '暂缓') actions.push('park');
  if (assigned && task.status === '暂缓') actions.push('unpark');
  if (assigned && !terminal(task) && !pending(task)) actions.push('done');
  if (createdOrAssigned && task.status !== '已作废' && !pending(task)) actions.push('cancel');
  if (createdOrAssigned && terminal(task)) actions.push('reopen');
  return actions;
}
module.exports = { memberActions, aiWork };
