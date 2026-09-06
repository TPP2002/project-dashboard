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
const { readBoard, readBoardOrNull, mutate, unionBy, unionShas, hasCommit } = require('./store.cjs');
const { atomicWriteJsonSync } = require('../core/atomicWrite.cjs');

const { releaseHome } = require('../core/runtimeRoot.cjs');
const { releaseStatus } = require('./release.cjs');
const { hookInstalledFor } = require('../core/hookProbe.cjs');

function resolveProj(flags) {
  return resolveProject(flags.project, { registryPath: flags.registry ? path.resolve(flags.registry) : REGISTRY_PATH });
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function git(repo, args) { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim(); }
function safeGit(repo, args) { try { return git(repo, args); } catch { return ''; } }
function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

/**
 * 扫提交，对 subject 里匹配到的 task id 聚合 git 派生字段。
 * opts.commit 给了就只认那一次提交（post-commit 钩子用）；不给才回退到扫最近 N 条（doctor 对账用）。
 */
function scanCommits(repo, taskIds, opts = {}) {
  const perTask = {}; // id → { commits:Set, prs:Set }
  if (!taskIds.length) return { perTask, scanned: 0 };
  const idRe = new RegExp('(?:^|[^A-Za-z0-9-])(' + taskIds.map(escapeRe).join('|') + ')(?![A-Za-z0-9-])');
  const raw = safeGit(repo, opts.commit
    ? ['log', '-1', '--pretty=format:%H%x1f%s', opts.commit]
    : ['log', '-n', String(opts.n || 300), '--pretty=format:%H%x1f%s']);
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
  // codeRepo 而非 mainRepo：卡的提交在「代码的家」里，板可能自成一家（见 resolveProject 头注）。
  const repo = proj.codeRepo;
  const board0 = readBoardOrNull(proj.board);
  if (!board0) throw new Error('board.json 不存在，先 register/import');
  const taskIds = (board0.tasks || []).map((t) => t.id);
  // gitBranch 只认显式传入（钩子按本工位 HEAD 传 / claim 由人传）。
  // 曾经在这里回查主目录 HEAD 兜底：多 worktree 并行时主目录签的是哪个分支纯属巧合，
  // 那个采样值又会被下面的窗口扫描广播给窗口内全部匹配到的卡，把老卡的分支台账越滚越脏。
  const branch = typeof flags.branch === 'string' ? flags.branch.trim() : '';
  const commit = typeof flags.commit === 'string' ? flags.commit.trim() : '';
  const { perTask, scanned } = scanCommits(repo, taskIds, { n: flags.n ? parseInt(flags.n, 10) : 300, commit });
  const snap = (t) => JSON.stringify([t.commitShas || [], t.prNumbers || [], t.gitBranch || []]);
  let changed = 0;
  mutate(proj, (b) => {
    changed = 0; // mutator 在锁内跑，board 是锁内重读的那份；计数每次从头算，免重入时叠加
    for (const t of b.tasks || []) {
      const info = perTask[t.id];
      if (!info) continue;
      const before = snap(t);
      t.commitShas = unionShas([...(t.commitShas || []), ...info.commits]);
      if (info.prs.size) t.prNumbers = unionBy([...(t.prNumbers || []), ...info.prs], String);
      if (branch && branch !== 'HEAD') t.gitBranch = unionBy([...(t.gitBranch || []), branch], String);
      // 比【内容】不比【长度】：板里存的 8 位短哈希被 unionShas 升成 12 位时数组长度纹丝不动，
      // 但板确实变了。只比长度会让这类改动报成 changed=0，下游据此判「无需备份/无需留痕」就全错。
      if (snap(t) !== before) changed++;
    }
    // 函数形态：这条流水依赖 changed，必须等 mutator 跑完才算得出来（见 store.mutate 头注）。
  }, () => (changed
    ? { ts: new Date().toISOString(), author: 'git-hook', type: 'note', text: `sync-from-git：${changed} 个任务的 git 字段已更新`, taskId: null }
    : null));
  return { ok: true, changed, scanned };
}

/** doctor：对账 git↔board + 自检 hook + 有边界 --fix。 */
let backupSequence = 0; // 连续备份用序号区分，避免同毫秒覆盖。
function backup(boardPath) {
  const bak = boardPath + '.bak-' + Date.now().toString(36) + '-' + (++backupSequence);
  try { atomicWriteJsonSync(bak, readBoard(boardPath)); } catch { /* ignore */ }
  return bak;
}
function doctor(flags) {
  const proj = resolveProj(flags);
  const repo = proj.codeRepo; // 同 syncFromGit：hook 与提交都在「代码的家」

  let board = readBoardOrNull(proj.board);
  if (!board) return { ok: false, text: '✖ board.json 不存在' };
  const issues = [];

  // 1) hook 自检
  const hookPath = path.join(repo, '.git', 'hooks', 'post-commit');
  const hookOk = hookInstalledFor(repo, proj.id);
  if (!hookOk) issues.push((fs.existsSync(hookPath) ? '本项目的同步块未装（共用仓里别的项目装了不算）' : '本项目的同步 hook 未安装，board 可能过时') + ' → 跑 `hooksInstall` 修复');

  // 1.6) 发布副本新鲜度（HOOK-CLI-POINTS-AT-LIVE-CHECKOUT，负责人 0906 拍板 d2=A：收官手动 release、体检落后就提醒）。
  // 只在【本仓 hook 确实指着发布副本】时才查——hook 指别处（测试隔离 / 尚未迁移）时，机器上碰巧有没有副本
  // 与这个仓无关，不该拿它决定 doctor 的红绿。
  if (hookOk) {
    const relHome = releaseHome();
    if (safeRead(hookPath).includes(relHome.replace(/\\/g, '/') + '/cli/index.cjs')) {
      const rs = releaseStatus({ dest: relHome });
      if (rs.exists && rs.behind > 0) issues.push(rs.text.replace(/^[⚠✖] /, '') + '（本仓 hook 跑的就是这份副本）');
    }
  }

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
  // 诊断与修复必须同窗口：--n 传下去，别一个看 300 条、一个看别的条数。
  const scanN = flags.n ? parseInt(flags.n, 10) : 300;
  const taskIds = (board.tasks || []).map((t) => t.id);
  const { perTask } = scanCommits(repo, taskIds, { n: scanN });
  let missing = 0;
  for (const t of board.tasks || []) {
    const info = perTask[t.id]; if (!info) continue;
    // 「已记入」= store.hasCommit，与 --fix 真正执行的 unionShas 同一口径。
    // 曾经这里只认「恰好 12 位或恰好 7 位」，于是 done --commit 存的 40 位全哈希一律被算成漏记，
    // 报了也补不进（DOCTOR-FIX-MISSING-NEVER-CLEARS）。
    for (const c of info.commits) if (!hasCommit(t.commitShas, c)) missing++;
  }
  if (missing > 0) issues.push(`${missing} 条 git 提交未记入 board（git 派生字段漂移）→ 加 --fix 自动补`);

  // 3) --fix：备份 + syncFromGit（只补 git 派生字段，语义字段绝不碰）
  let fixBackup = null;
  if (flags.fix && missing > 0) {
    fixBackup = backup(proj.board);
    // commit 显式清掉：doctor 是【整窗口对账】，修复也得按整窗口来。
    // 把外面传进来的 --commit 带下去，会变成「诊断看一整窗、修复只修一条」，又是一次口径分裂。
    const r = syncFromGit({ ...flags, commit: undefined });
    if (r.changed === 0) {
      // 兜底：真没改动就别留垃圾备份 —— 「每跑一次 --fix 多攒一个 .bak」就是这么来的。
      // 口径统一后正常走不到这里；留着防并发（doctor 读板在锁外，别的进程可能抢先补过了）。
      try { fs.unlinkSync(fixBackup); } catch { /* 删不掉就留着，不影响结论 */ }
      fixBackup = null;
      issues.push('已尝试自动补齐，但 board 实际无需改动（changed=0，未留备份）');
    } else {
      issues.push(`已备份 ${path.basename(fixBackup)} 并自动补齐（changed=${r.changed}）`);
    }
  }

  const result = {};
  let branchSummary = '', cleanupSummary = '';
  if (flags.branches) {
    // Stop 钩子的默认 doctor 不加载提交图；补提交后体检必须使用最新台账。
    if (flags.fix && missing > 0) board = readBoardOrNull(proj.board);
    const { auditBoardBranches, planBranchCleanup, applyBranchCleanup } = require('./branchAudit.cjs');
    const audit = auditBoardBranches(board, repo);
    result.branchAudit = audit;
    const { ok, suspect, unknown } = audit.summary;
    branchSummary = `分支台账体检（--branches）：可疑 ${suspect} 条 / 可信 ${ok} 条 / 无法核实 ${unknown} 条`;
    if (suspect) {
      const details = audit.entries.filter((entry) => entry.verdict === 'suspect').slice(0, 30)
        .map((entry) => `${entry.taskId}·${entry.branch}：${entry.reason}`);
      if (suspect > 30) details.push(`...（共 ${suspect} 条，--json 看全量）`);
      issues.push(branchSummary + ' → 可疑条目：\n    ' + details.join('\n    '));
    }
    if (flags.fix) {
      const plan = planBranchCleanup(board.tasks || [], audit.entries);
      const skippedText = `跳过 有依赖关系 ${plan.skipped.related} / 分支没正主 ${plan.skipped.noOwner}`;
      let removed = 0, bak = null;
      if (plan.removals.length > 0) {
        // 补提交前若已备份，整次修复共用这份原样备份，保留完整回退点。
        const backupPath = fixBackup || backup(proj.board);
        if (!fs.existsSync(backupPath)) throw new Error('分支台账备份失败，未执行清理');
        bak = path.basename(backupPath);
        const activity = { ts: new Date().toISOString(), author: 'doctor', type: 'note', text: '', taskId: null };
        mutate(proj, (b) => {
          removed = applyBranchCleanup(b, plan.removals);
          activity.text = `doctor --branches --fix：摘掉 ${removed} 条误扣分支（备份 ${bak}；${skippedText}）`;
        }, activity);
      }
      audit.cleanup = { removed, skipped: plan.skipped, backup: bak, entries: plan.removals };
      if (removed > 0) {
        const details = plan.removals.slice(0, 30)
          .map((entry) => `${entry.taskId}·${entry.branch}（正主 ${entry.otherIds.join('、')}）`);
        if (plan.removals.length > 30) details.push(`...（共 ${plan.removals.length} 条，--json 看全量）`);
        issues.push(`已按体检结果摘掉 ${removed} 条误扣分支（备份 ${bak}）：\n    ` + details.join('\n    '));
      } else {
        cleanupSummary = `分支台账无需清理（${skippedText}）`;
      }
    }
  }
  result.ok = issues.length === 0;
  result.text = issues.length ? issues.map((s) => '• ' + s).join('\n') : '✔ board 与 git 一致、hook 已装';
  if (branchSummary && !result.branchAudit.summary.suspect) result.text += '\n' + branchSummary;
  if (cleanupSummary) result.text += '\n' + cleanupSummary;
  return result;
}

module.exports = { syncFromGit, doctor, scanCommits };
