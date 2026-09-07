'use strict';
/**
 * renderIndex.cjs —— 从 board 生成 INDEX 状态段（治本 R5），消双写漂移。
 * 只替换 HTML 注释锚 <!--dashboard:status:begin--> … <!--dashboard:status:end--> 之间，
 * 幂等、绝不覆盖人工叙事段；锚缺失则【报错不写】（绝不猜位置覆盖人工内容）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { resolveProject, REGISTRY_PATH } = require('../core/resolveProject.cjs');
const { readBoard } = require('./store.cjs');
const { emojiFor, VOID_STATUSES } = require('../core/boardSchema.cjs');
const { atomicWriteFileSync } = require('../core/atomicWrite.cjs');

const BEGIN = '<!--dashboard:status:begin';
const END = '<!--dashboard:status:end-->';

function resolveProj(flags) {
  return resolveProject(flags.project, { registryPath: flags.registry ? path.resolve(flags.registry) : REGISTRY_PATH });
}

function buildStatusMarkdown(board) {
  const byStatus = {}; for (const t of (board.tasks || [])) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  // 分母剔掉作废卡,跟 CLI list / 网页 / server 摘要同一口径(审计 §4-C1)——
  // 同一个项目在三个地方显示三个完成度,比显示错一个更让人没法判断。
  const total = (board.tasks || []).filter((t) => !VOID_STATUSES.includes(t.status)).length;
  const done = byStatus['已完工'] || 0;
  const head = `> 自动生成 · 勿手改（dashboard render-index 从 board.json 生成）· ${total} 任务 · 已完工 ${done} · 进度 ${total ? Math.round((done / total) * 100) : 0}%`;
  const rows = (board.tasks || []).map((t) => {
    const br = (t.gitBranch || []).join(',') || '-';
    const pr = (t.prNumbers || []).length ? 'PR#' + t.prNumbers.join(',') : '-';
    const doneAt = t.dates && t.dates.done ? t.dates.done : '-';
    return `| ${t.id} | ${emojiFor(t.status)} ${t.status} | ${t.percent || 0}% | ${br} | ${pr} | ${doneAt} | ${t.title} |`;
  });
  return [head, '', '| # | 状态 | 进度 | 分支 | PR | 完工 | 方案 |', '|---|---|---|---|---|---|---|', ...rows].join('\n');
}

function renderIndex(flags) {
  const proj = resolveProj(flags);
  const indexPath = flags.index ? path.resolve(flags.index) : (proj.indexPath || path.join(proj.docsRoot, 'INDEX.md'));
  let src = '';
  try { src = fs.readFileSync(indexPath, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT' || flags.index) throw e;
    return { ok: true, text: `ℹ ${indexPath} 不存在：本项目没有 INDEX 台账，无需渲染（要用就先建这个文件并插一对锚）。` };
  }
  const board = readBoard(proj.board);
  const generated = buildStatusMarkdown(board);
  const b = src.indexOf(BEGIN), e = src.indexOf(END);
  if (b === -1 || e === -1 || e < b) {
    throw new Error(`INDEX 缺少 dashboard:status 锚。请在 ${indexPath} 需要的位置插入一对：\n  ${BEGIN} -->\n  ${END}\n再重跑 render-index（绝不猜位置覆盖人工内容）。`);
  }
  const out = src.slice(0, b) + BEGIN + ' -->\n' + generated + '\n' + src.slice(e);
  if (flags['dry-run']) return { ok: true, dryRun: true, text: generated };
  atomicWriteFileSync(indexPath, out);
  return { ok: true, text: `✔ 已更新 ${indexPath} 的状态段（${(board.tasks || []).length} 任务，幂等，人工段未动）` };
}

module.exports = { renderIndex, buildStatusMarkdown };
