'use strict';
/**
 * resolveProject.cjs —— 项目定位（治本 R4）
 *
 * CLI 一律用 --project <id> 显式定位，绝不靠 cwd 猜（worktree/junction 丛林里 cwd 反查会失灵）。
 * 读全局 registry.json，把 id 映射到 { mainRepo, board, lock, docsRoot }，路径全部 realpath 规范化。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { normalizeReal } = require('./safePath.cjs');

const DASHBOARD_HOME = path.join(os.homedir(), '.claude', 'dashboard');
const REGISTRY_PATH = path.join(DASHBOARD_HOME, 'registry.json');

function readRegistry(registryPath = REGISTRY_PATH) {
  try {
    return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { schemaVersion: '1.0', projects: {} };
    throw new Error(`registry.json 读取/解析失败：${err.message}`);
  }
}

/**
 * 解析 projectId → 路径集合。
 * @param {string} projectId
 * @param {{registryPath?: string}} [opts]
 * @returns {{id:string,name:string,mainRepo:string,board:string,lock:string,docsRoot:string}}
 */
function resolveProject(projectId, opts = {}) {
  if (!projectId) throw new Error('必须指定 --project <id>（禁止按 cwd 猜项目）');
  const registry = readRegistry(opts.registryPath);
  const entry = registry.projects && registry.projects[projectId];
  if (!entry) {
    const known = Object.keys(registry.projects || {}).join(', ') || '（空）';
    throw new Error(`未注册的项目 "${projectId}"。已注册：${known}。请先 cli register。`);
  }
  const mainRepo = normalizeReal(entry.mainRepo);
  const board = entry.board ? normalizeReal(entry.board) : path.join(mainRepo, '.dashboard', 'board.json');
  return {
    id: projectId,
    name: entry.name || projectId,
    mainRepo,
    board,
    lock: board + '.lock',
    docsRoot: entry.docsRoot ? normalizeReal(entry.docsRoot) : mainRepo,
  };
}

module.exports = { resolveProject, readRegistry, DASHBOARD_HOME, REGISTRY_PATH };
