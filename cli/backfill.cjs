'use strict';
/**
 * backfill.cjs —— 回填工作台（治本 R3）。
 * 默认：列出每个 task 还缺哪些语义字段（decisions/deps/wave/bot/tests/禁区），指导补齐。
 * --patch <file.json>：批量应用补丁 {taskId:{"点路径":value,...}}，走锁+校验落盘（绝不手写整个 board）。
 * 补单字段用 cli set/pending/decide/block 更方便；本命令用于查缺 + 批量补。
 */
const fs = require('node:fs');
const path = require('node:path');
const { resolveProject, REGISTRY_PATH } = require('../core/resolveProject.cjs');
const { readBoard, mutate, findTask } = require('./store.cjs');

function resolveProj(flags) {
  return resolveProject(flags.project, { registryPath: flags.registry ? path.resolve(flags.registry) : REGISTRY_PATH });
}

function missingFields(t) {
  const miss = [];
  if (!t.decisions || !t.decisions.length) miss.push('decisions');
  const d = t.deps || {};
  if (!(d.dependsOn || []).length && !(d.blockedBy || []).length && !(d.relatedTasks || []).length) miss.push('deps');
  if (!t.wave) miss.push('wave');
  if (!t.bot) miss.push('bot');
  if (!t.tests) miss.push('tests');
  if (!(t.forbiddenZones || []).length) miss.push('禁区');
  return miss;
}

function setPath(obj, dotted, val) { const p = dotted.split('.'); let o = obj; for (let i = 0; i < p.length - 1; i++) { o[p[i]] = o[p[i]] || {}; o = o[p[i]]; } o[p[p.length - 1]] = val; }

function backfill(flags) {
  const proj = resolveProj(flags);
  if (flags.patch) {
    const patch = JSON.parse(fs.readFileSync(path.resolve(flags.patch), 'utf8'));
    let applied = 0;
    mutate(proj, (b) => {
      for (const [id, fields] of Object.entries(patch)) {
        const t = findTask(b, id);
        for (const [k, v] of Object.entries(fields)) { setPath(t, k, v); applied++; }
      }
    }, { ts: new Date().toISOString(), author: flags.author || 'backfill', type: 'note', text: `backfill 补丁：${Object.keys(patch).length} 个任务 / ${applied} 字段`, taskId: null });
    return { ok: true, text: `✔ backfill 应用补丁：${Object.keys(patch).length} 个任务 / ${applied} 个字段` };
  }
  const b = readBoard(proj.board);
  const rows = (b.tasks || []).map((t) => { const m = missingFields(t); return m.length ? `  ${String(t.id).padEnd(8)} 缺: ${m.join('/')}` : null; }).filter(Boolean);
  return {
    ok: true,
    text: rows.length
      ? `待补语义字段（${rows.length} 个任务）：\n${rows.join('\n')}\n\n补法：cli set/pending/decide/block 单字段补，或 backfill --patch <file.json> 批量。`
      : '✔ 所有任务语义字段齐全',
  };
}

module.exports = { backfill, missingFields };
