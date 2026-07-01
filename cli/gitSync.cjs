'use strict';
/**
 * gitSync.cjs —— 从 git 自动派生 board 字段（治本 R2）+ doctor 对账兜底。
 * git 派生（权威=git）：commitShas / prNumbers / gitBranch / activity。
 * 语义字段（decisions/deps/wave/status 等，权威=人）【绝不碰】。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveProject, REGISTRY_PATH } = require('../core/resolveProject.cjs');
const { readBoard, readBoardOrNull, mutate, unionBy } = require('./store.cjs');
const { atomicWriteJsonSync } = require('../core/atomicWrite.cjs');

function resolveProj(flags) {
  return resolveProject(flags.project, { registryPath: flags.registry ? path.resolve(flags.registry) : REGISTRY_PATH });
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function git(repo, args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim(); }
function safeGit(repo, args) { try { return git(repo, args); } catch { return ''; } }
function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

/** 扫最近提交，对 subject 里匹配到的 task id 聚合 git 派生字段。 */
function scanCommits(repo, taskIds, opts = {}) {
  const perTask = {}; // id → { commits:Set, prs:Set }
  if (!taskIds.length) return { perTask, scanned: 0 };
  const idRe = new RegExp('(?:^|[^A-Za-z0-9-])(' + taskIds.map(escapeRe).join('|') + ')(?![A-Za-z0-9-])');
  const raw = safeGit(repo, ['log', '-n', String(opts.n || 300), '--pretty=format:%H%x1f%s']);
  if (!raw) return { perTask, scanned: 0 };
  const lines = raw.split('\n');
  for (const line of lines) {
    const [hash, subject = ''] = line.split('\x1f');
    const m = subject.match(idRe);
    if (!m) continue;
    const id = m[1];
    perTask[id] = perTask[id] || { commits: new Set(), prs: new Set() };
    perTask[id].commits.add(hash.slice(0, 12));
    const pr = subject.match(/#(\d+)/);
    if (pr) perTask[id].prs.add(Number(pr[1]));
  }
  return { perTask, scanned: lines.length };
}

/** 从 git 派生并写回 board（只碰 git 派生字段）。 */
function syncFromGit(flags) {
  const proj = resolveProj(flags);
  const repo = proj.mainRepo;
  const board0 = readBoardOrNull(proj.board);
  if (!board0) throw new Error('board.json 不存在，先 register/import');
  const taskIds = (board0.tasks || []).map((t) => t.id);
  const branch = flags.branch || safeGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const { perTask, scanned } = scanCommits(repo, taskIds, { n: flags.n ? parseInt(flags.n, 10) : 300 });
  let changed = 0;
  mutate(proj, (b) => {
    for (const t of b.tasks || []) {
      const info = perTask[t.id];
      if (!info) continue;
      const bC = (t.commitShas || []).length, bP = (t.prNumbers || []).length, bB = (t.gitBranch || []).length;
      t.commitShas = unionBy([...(t.commitShas || []), ...info.commits], String);
      if (info.prs.size) t.prNumbers = unionBy([...(t.prNumbers || []), ...info.prs], String);
      if (branch && branch !== 'HEAD') t.gitBranch = unionBy([...(t.gitBranch || []), branch], String);
      if (t.commitShas.length !== bC || t.prNumbers.length !== bP || (t.gitBranch || []).length !== bB) changed++;
    }
  }, changed ? { ts: new Date().toISOString(), author: 'git-hook', type: 'note', text: `sync-from-git：${changed} 个任务的 git 字段已更新`, taskId: null } : null);
  return { ok: true, changed, scanned };
}

/** doctor：对账 git↔board + 自检 hook + 有边界 --fix。 */
function backup(boardPath) {
  const bak = boardPath + '.bak-' + Date.now().toString(36);
  try { atomicWriteJsonSync(bak, readBoard(boardPath)); } catch { /* ignore */ }
  return bak;
}
function doctor(flags) {
  const proj = resolveProj(flags);
  const repo = proj.mainRepo;
  const board = readBoardOrNull(proj.board);
  if (!board) return { ok: false, text: '✖ board.json 不存在' };
  const issues = [];

  // 1) hook 自检
  const hookPath = path.join(repo, '.git', 'hooks', 'post-commit');
  const hookOk = fs.existsSync(hookPath) && /dashboard/.test(safeRead(hookPath));
  if (!hookOk) issues.push('同步 hook 未安装（.git/hooks/post-commit），board 可能过时 → 跑 `hooksInstall` 修复');

  // 1.5) 待拍板质量 lint（skill §6.2/§6.3 硬规则）——已在的 decisions 缺三件套就报
  const badDecisions = [];
  for (const t of board.tasks || []) {
    for (const d of t.decisions || []) {
      if (d.answer !== null) continue; // 已拍板的老数据放过
      const miss = [];
      if (!d.background || String(d.background).trim().length < 60) miss.push('background<60字');
      if (!d.recommendReason || String(d.recommendReason).trim().length < 30) miss.push('recommendReason<30字');
      if (!d.optionPros || typeof d.optionPros !== 'object') miss.push('optionPros');
      else for (const opt of d.options || []) if (!(d.optionPros[opt] || '').trim()) miss.push(`optionPros["${opt}"]`);
      if (miss.length) badDecisions.push(`${t.id}·${d.id}：缺 ${miss.join(', ')}`);
    }
  }
  if (badDecisions.length) issues.push(`${badDecisions.length} 条待拍板不合格（skill §6.2）：\n    ` + badDecisions.slice(0, 10).join('\n    ') + (badDecisions.length > 10 ? `\n    ...（共 ${badDecisions.length} 条）` : ''));

  // 2) git 派生字段漂移（git 有、board 缺）
  const taskIds = (board.tasks || []).map((t) => t.id);
  const { perTask } = scanCommits(repo, taskIds);
  let missing = 0;
  for (const t of board.tasks || []) {
    const info = perTask[t.id]; if (!info) continue;
    const have = new Set((t.commitShas || []).map(String));
    for (const c of info.commits) if (!have.has(c) && !have.has(c.slice(0, 7))) missing++;
  }
  if (missing > 0) issues.push(`${missing} 条 git 提交未记入 board（git 派生字段漂移）→ 加 --fix 自动补`);

  // 3) --fix：备份 + syncFromGit（只补 git 派生字段，语义字段绝不碰）
  if (flags.fix && missing > 0) {
    const bak = backup(proj.board);
    const r = syncFromGit(flags);
    issues.push(`已备份 ${path.basename(bak)} 并自动补齐（changed=${r.changed}）`);
  }

  return { ok: issues.length === 0, text: issues.length ? issues.map((s) => '• ' + s).join('\n') : '✔ board 与 git 一致、hook 已装' };
}

module.exports = { syncFromGit, doctor, scanCommits };
