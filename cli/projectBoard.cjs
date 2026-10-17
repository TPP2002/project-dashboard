'use strict';
// Explicit owner projection. Local repository evidence never comes from this projection.
const path = require('node:path');
const { DASHBOARD_HOME, readRegistry } = require('../core/resolveProject.cjs');
const { normalizeReal } = require('../core/safePath.cjs');
function readProjectBoard(proj, options = {}) {
  if (proj.remote) return require('./remoteClient.cjs').perform('projection', proj.id, { _: [] }).board;
  return options.optional ? require('./store.cjs').readBoardOrNull(proj.board) : require('./store.cjs').readBoard(proj.board);
}
function inside(root, file) {
  const rel = path.relative(normalizeReal(root), normalizeReal(file));
  return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function artifact(proj, explicit, ...parts) {
  const dest = explicit === undefined ? path.join(DASHBOARD_HOME,'remote-artifacts',proj.id,...parts) : path.resolve(explicit);
  if (explicit !== undefined && (typeof explicit !== 'string' || !explicit.trim())) throw new Error('输出必须是显式本机路径');
  const registry = readRegistry();
  const frozen = [proj.board];
  const bindings = require('./remoteConfig.cjs').load().projects;
  for (const [id,e] of Object.entries(registry.projects || {})) if (bindings[id]) frozen.push(e.board || path.join(e.mainRepo,'.dashboard','board.json'));
  if (frozen.some(board => inside(path.dirname(board),dest))) throw new Error('禁止写入冻结旧板目录');
  return dest;
}
module.exports = { readProjectBoard, artifact, inside };
