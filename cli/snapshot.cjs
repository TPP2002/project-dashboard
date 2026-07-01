'use strict';
/**
 * snapshot.cjs —— 把 board.json 导出为 git 外快照（治本 R9b 备份/历史）。
 * board 不进 git，历史留痕靠这里：默认导出到 <dashboard>/snapshots/<projectId>/<ts>.json。
 */
const fs = require('node:fs');
const path = require('node:path');
const { resolveProject, REGISTRY_PATH, DASHBOARD_HOME } = require('../core/resolveProject.cjs');
const { readBoard } = require('./store.cjs');
const { atomicWriteJsonSync } = require('../core/atomicWrite.cjs');

function resolveProj(flags) {
  return resolveProject(flags.project, { registryPath: flags.registry ? path.resolve(flags.registry) : REGISTRY_PATH });
}

function snapshot(flags) {
  const proj = resolveProj(flags);
  const board = readBoard(proj.board);
  const stamp = String(flags.stamp || new Date().toISOString()).replace(/[:.]/g, '-');
  const outDir = flags.out ? path.resolve(flags.out) : path.join(DASHBOARD_HOME, 'snapshots', proj.id);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, stamp + '.json');
  atomicWriteJsonSync(outPath, board);
  return { ok: true, path: outPath, text: `✔ 快照已导出：${outPath}（${(board.tasks || []).length} 任务）` };
}

module.exports = { snapshot };
