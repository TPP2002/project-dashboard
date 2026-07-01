'use strict';
/**
 * boardSchema.cjs —— board.json 结构校验（写前拒坏数据）+ 常量 + 工厂（治本 R9a 派生不落盘）
 *
 * 零依赖手写 validator（core 要零依赖，不引 zod）。规则表驱动：必填/枚举/类型/日期正则/
 * percent 范围/answer∈options/commit sha 格式 + 引用完整性（deps 与 activity.taskId 指向存在的 task、id 唯一）。
 * 一次收集全部错误、带 JSON 路径。统计（statusStats/进度/矩阵）一律读时派生、【不进 schema、不落盘】。
 */

const SCHEMA_VERSION = '1.0';

const STATUS = ['未开工', '待开工', '待拍板', '已拍板', '施工中', '可复工', '收官', '已完工', '暂缓', '压轴'];

// statusEmoji 由 status 派生（不独立存/校验）
const STATUS_EMOJI = {
  未开工: '⬜', 待开工: '📋', 待拍板: '❓', 已拍板: '✅', 施工中: '🔨',
  可复工: '🔄', 收官: '🏁', 已完工: '✅', 暂缓: '🚫', 压轴: '🎬',
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/;
const TASKID = /^[A-Z0-9][A-Z0-9-]*$/;
const SHA = /^[0-9a-f]{7,40}$/;

function emojiFor(status) { return STATUS_EMOJI[status] || '⬜'; }

/** 空 board 工厂（register 用） */
function emptyBoard(project) {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    project: {
      id: project.id,
      name: project.name || project.id,
      mainRepo: project.mainRepo || '',
      forbiddenZones: [],
      createdAt: now,
      updatedAt: now,
    },
    tasks: [],
    activity: [],
  };
}

function isType(v, t) {
  if (t === 'array') return Array.isArray(v);
  if (t === 'int') return Number.isInteger(v);
  if (t === 'string') return typeof v === 'string';
  if (t === 'bool') return typeof v === 'boolean';
  if (t === 'object') return v && typeof v === 'object' && !Array.isArray(v);
  return true;
}

function validateTask(t, p, errs, ids) {
  const req = (k, type) => {
    if (t[k] === undefined || t[k] === null) errs.push(`${p}.${k}: 缺失必填字段`);
    else if (!isType(t[k], type)) errs.push(`${p}.${k}: 类型应为 ${type}`);
  };
  req('id', 'string'); req('title', 'string'); req('status', 'string'); req('wave', 'int');
  if (t.id && !TASKID.test(t.id)) errs.push(`${p}.id: 非法 id「${t.id}」（应匹配 ${TASKID}）`);
  if (t.status && !STATUS.includes(t.status)) errs.push(`${p}.status: 非法枚举「${t.status}」，允许: ${STATUS.join('/')}`);
  if (t.percent !== undefined && (!Number.isInteger(t.percent) || t.percent < 0 || t.percent > 100)) {
    errs.push(`${p}.percent: 应为 0–100 的整数`);
  }
  if (t.dates !== undefined) {
    if (!isType(t.dates, 'object')) errs.push(`${p}.dates: 应为对象`);
    else for (const k of ['design', 'start', 'done']) {
      const d = t.dates[k];
      if (d !== null && d !== undefined && !DATE.test(d)) errs.push(`${p}.dates.${k}: 日期应为 YYYY-MM-DD，实为「${d}」`);
    }
  }
  for (const arrKey of ['gitBranch', 'worktree', 'prNumbers', 'commitShas', 'forbiddenZones', 'fileScope', 'docs']) {
    if (t[arrKey] !== undefined && !Array.isArray(t[arrKey])) errs.push(`${p}.${arrKey}: 应为数组`);
  }
  (t.commitShas || []).forEach((s, i) => { if (!SHA.test(String(s))) errs.push(`${p}.commitShas[${i}]: 非法 sha「${s}」`); });
  (t.decisions || []).forEach((d, i) => {
    const dp = `${p}.decisions[${i}]`;
    for (const k of ['id', 'question', 'recommended']) if (!d[k]) errs.push(`${dp}.${k}: 缺失`);
    if (!Array.isArray(d.options) || d.options.length === 0) errs.push(`${dp}.options: 至少一个选项`);
    if (d.answer !== null && d.answer !== undefined && Array.isArray(d.options) && !d.options.includes(d.answer)) {
      errs.push(`${dp}.answer: 答案「${d.answer}」不在 options 中`);
    }
    if (d.decidedAt && !DATE.test(d.decidedAt)) errs.push(`${dp}.decidedAt: 日期格式错误`);
  });
  if (t.deps !== undefined && !isType(t.deps, 'object')) errs.push(`${p}.deps: 应为对象`);
  if (t.id) {
    if (ids.has(t.id)) errs.push(`${p}.id: 重复 id「${t.id}」`);
    ids.add(t.id);
  }
}

/**
 * 校验整个 board。
 * @returns {{ok: boolean, errors: string[]}}
 */
function validate(board) {
  const errs = [];
  if (!board || typeof board !== 'object') return { ok: false, errors: ['board: 应为对象'] };
  if (!board.schemaVersion) errs.push('schemaVersion: 缺失');

  const proj = board.project;
  if (!isType(proj, 'object')) errs.push('project: 缺失或非对象');
  else {
    for (const k of ['id', 'name', 'createdAt', 'updatedAt']) if (proj[k] === undefined) errs.push(`project.${k}: 缺失`);
    if (proj.createdAt && !DATETIME.test(proj.createdAt)) errs.push('project.createdAt: date-time 格式错误');
    if (proj.updatedAt && !DATETIME.test(proj.updatedAt)) errs.push('project.updatedAt: date-time 格式错误');
  }

  if (!Array.isArray(board.tasks)) { errs.push('tasks: 应为数组'); return { ok: errs.length === 0, errors: errs }; }

  const ids = new Set();
  board.tasks.forEach((t, i) => validateTask(t, `tasks[${i}]`, errs, ids));

  // 引用完整性：deps 指向存在的 task
  board.tasks.forEach((t, i) => {
    const d = t.deps || {};
    for (const rel of ['dependsOn', 'blockedBy', 'relatedTasks']) {
      (d[rel] || []).forEach((ref) => { if (!ids.has(ref)) errs.push(`tasks[${i}].deps.${rel}: 引用了不存在的 task「${ref}」`); });
    }
  });

  if (board.activity !== undefined) {
    if (!Array.isArray(board.activity)) errs.push('activity: 应为数组');
    else board.activity.forEach((a, i) => {
      if (a.ts && !DATETIME.test(a.ts)) errs.push(`activity[${i}].ts: date-time 格式错误`);
      if (a.taskId && !ids.has(a.taskId)) errs.push(`activity[${i}].taskId: 引用不存在的 task「${a.taskId}」`);
    });
  }

  return { ok: errs.length === 0, errors: errs };
}

/** 校验失败即抛（写前调用） */
function assertValid(board) {
  const { ok, errors } = validate(board);
  if (!ok) throw new Error(`board.json 校验失败（${errors.length} 处）：\n  ` + errors.join('\n  '));
}

module.exports = { SCHEMA_VERSION, STATUS, STATUS_EMOJI, emojiFor, emptyBoard, validate, assertValid };
