'use strict';
// Remote owner administration is constrained to the existing TASK business domain.
const protocol = require('./boardCommand.cjs');
const ROOTS = new Set(('title plainTitle description status percent wave dates gitBranch worktree prNumbers commitShas decisions deps docs forbiddenZones fileScope modelHint builder cost bot tests typecheck nextMilestone lastProgressAt blockReason parkedNote awaitCollect collectBrief').split(' '));
function field(name) {
  if (typeof name !== 'string' || !name || name.split('.').some(k => !/^[A-Za-z0-9_-]+$/.test(k) || ['__proto__','constructor','prototype'].includes(k)) || !ROOTS.has(name.split('.')[0])) throw new Error('仅允许现有 task 业务字段，禁止内部字段和文件能力');
}
function setPath(task, name, value) {
  field(name);
  protocol.safeTree(value);
  const parts = name.split('.');
  let target = task;
  for (const key of parts.slice(0,-1)) {
    if (target[key] === undefined) target[key] = {};
    if (!target[key] || typeof target[key] !== 'object') throw new Error('点路径父字段不是对象');
    target = target[key];
  }
  target[parts.at(-1)] = value;
}
function patch(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('补丁必须为 taskId 到字段的对象');
  for (const [id,fields] of Object.entries(payload)) {
    if (!/^[A-Z0-9][A-Z0-9-]*$/.test(id) || !fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('非法任务补丁');
    for (const [key,value] of Object.entries(fields)) { field(key); protocol.safeTree(value); }
  }
}
function importTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 50) throw new Error('导入语义批次必须为1至50张卡');
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || Array.isArray(task) || typeof task.id !== 'string') throw new Error('非法导入任务');
    for (const key of Object.keys(task)) if (key !== 'id') field(key);
    protocol.safeTree(task);
  }
}
module.exports = { ROOTS, field, setPath, patch, importTasks };
