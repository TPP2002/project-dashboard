'use strict';
/**
 * branchAudit.cjs —— 分支台账体检与误扣分支清理（BOARD-GITFIELD-HISTORY-AUTOCLEAN）。
 * 历史同步曾把工位分支误记到老卡；用引用与 merge 证据找回分支自有提交，
 * 结合显式认领与无证据铺开面分档规划清理；体检只读，落盘由调用方负责，不改 git。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readRegistry, resolveProject } = require('../core/resolveProject.cjs');

/** 纯函数：只认 claim 流水；set 是整份覆盖，不能证明卡亲手认领过分支。 */
function claimIndex(activityItems) {
  const claims = new Map();
  for (const item of Array.isArray(activityItems) ? activityItems : []) {
    if (item?.type !== 'claim' || typeof item.taskId !== 'string' || !item.taskId || typeof item.text !== 'string') continue;
    const match = item.text.match(/：分支 (.+?)(?:，文件域 |$)/);
    if (!match) continue;
    const branches = match[1].split(',').map((s) => s.trim()).filter((s) => s && s !== '-');
    if (!branches.length) continue;
    if (!claims.has(item.taskId)) claims.set(item.taskId, new Set());
    for (const branch of branches) claims.get(item.taskId).add(branch);
  }
  return claims;
}

/** 跨板只读汇总当前与月度流水；坏板跳过，坏归档不连坐其它文件，同号卡合并以多保留。 */
function loadClaimIndex(registryPath) {
  const registry = readRegistry(registryPath), items = [];
  const collect = (activity) => {
    if (Array.isArray(activity)) for (const item of activity) if (item?.type === 'claim') items.push(item);
  };
  for (const id of Object.keys(registry.projects || {})) {
    let boardPath, board;
    try {
      boardPath = resolveProject(id, { registryPath }).board;
      board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
    } catch { continue; } // 搬家或离线的板不阻断其它板的证据读取。
    collect(board?.activity);
    let archives;
    try { archives = fs.readdirSync(path.dirname(boardPath)).filter((name) => /^activity-\d{6}\.json$/.test(name)).sort(); }
    catch { continue; } // 板内流水已保留；目录不可读只表示缺少归档证据。
    for (const name of archives) {
      let activity;
      try { activity = JSON.parse(fs.readFileSync(path.join(path.dirname(boardPath), name), 'utf8')); }
      catch { continue; } // 单份归档损坏时继续读取剩余月份。
      collect(activity);
    }
  }
  return claimIndex(items);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
/** 与 scanCommits 保持相同的大小写和完整任务 ID 边界。 */
function taskIdRegex(ids) {
  return new RegExp('(?:^|[^A-Za-z0-9-])(' + ids.map(escapeRe).join('|') + ')(?![A-Za-z0-9-])');
}

function readGit(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
    });
  } catch { return ''; } // 缺引用、空仓或 git 不可用都只表示缺少这份证据。
}

/** 固定三次本地只读查询；失败的查询按空输出处理，不探网、不重试。 */
function loadGraph(repo) {
  const refs = new Map(), nodes = new Map();
  const rawRefs = readGit(repo, ['for-each-ref', '--format=%(refname)%x1f%(objectname)', 'refs/heads', 'refs/remotes']);
  for (const line of rawRefs.split(/\r?\n/)) {
    // for-each-ref 与 log 的格式语法不同，前者可能原样输出 %x1f。
    // 从末尾分隔，避免合法分支名中恰好带有字面量 %x1f。
    const separator = line.includes('\x1f') ? '\x1f' : '%x1f';
    const at = line.lastIndexOf(separator);
    if (at > 0) refs.set(line.slice(0, at), line.slice(at + separator.length));
  }
  const rawLog = readGit(repo, ['log', '--all', '--pretty=format:%H%x1f%P%x1f%s']);
  for (const line of rawLog.split(/\r?\n/)) {
    const first = line.indexOf('\x1f'), second = line.indexOf('\x1f', first + 1);
    if (first < 1 || second < 0) continue;
    const parents = line.slice(first + 1, second);
    nodes.set(line.slice(0, first), { parents: parents ? parents.split(' ') : [], subject: line.slice(second + 1) });
  }
  const head = readGit(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim();
  const name = head.startsWith('origin/') ? head.slice(7)
    : ['main', 'master'].find((n) => refs.has('refs/heads/' + n) || refs.has('refs/remotes/origin/' + n));
  const sha = name && (refs.get('refs/remotes/origin/' + name) || refs.get('refs/heads/' + name));
  return { refs, nodes, trunk: sha ? { name, sha } : null };
}

/** Map 保留 git log 顺序；同名分支的第一条 merge 痕迹就是最新证据。 */
function mergeWitnesses(nodes) {
  const witnesses = new Map();
  const remember = (branch, sha) => { if (!witnesses.has(branch)) witnesses.set(branch, sha || null); };
  for (const [sha, node] of nodes) {
    const pull = node.subject.match(/^Merge pull request #\d+ from [^\s/]+\/(.+)$/);
    if (pull) remember(pull[1], node.parents[1]);
    const merge = node.subject.match(/^Merge (?:remote-tracking )?branch '(?:origin\/)?([^']+)'(?: of \S+)?(?: into (.+))?$/);
    if (merge) {
      remember(merge[1], node.parents[1]);
      if (merge[2]) remember(merge[2], sha);
    }
  }
  return witnesses;
}

function reachability(nodes) {
  const cache = new Map();
  return function reach(start) {
    if (cache.has(start)) return cache.get(start);
    const seen = new Set(), stack = [start];
    while (stack.length) {
      const sha = stack.pop();
      if (seen.has(sha)) continue;
      seen.add(sha);
      const node = nodes.get(sha);
      if (node) for (const parent of node.parents) stack.push(parent);
    }
    cache.set(start, seen);
    return seen;
  };
}

function difference(left, right) { return new Set([...left].filter((sha) => !right.has(sha))); }

/** 只沿主干第一亲链归属，防止后续重复 merge 把早先的分支提交重新认领。 */
function branchOwnership(graph) {
  const { nodes, trunk } = graph;
  if (!trunk) return () => null;
  const reach = reachability(nodes), trunkReach = reach(trunk.sha);
  const merges = [], seen = new Set(), owners = new Map();
  let current = trunk.sha;
  while (current && !seen.has(current)) {
    seen.add(current);
    const node = nodes.get(current);
    if (!node) break;
    if (node.parents.length >= 2) merges.push({ sha: current, parents: node.parents });
    current = node.parents[0];
  }
  for (const merge of merges.reverse()) {
    merge.side = difference(reach(merge.parents[1]), reach(merge.parents[0]));
    for (const sha of merge.side) if (!owners.has(sha)) owners.set(sha, merge.side);
  }
  return function own(witness) {
    if (!witness) return null;
    if (witness === trunk.sha) return trunkReach;
    if (trunkReach.has(witness)) return owners.get(witness) || null;
    const branchReach = reach(witness), commits = difference(branchReach, trunkReach);
    // 分支被合过后继续生长，仍须计入它在此前 merge 中带来的提交。
    for (const merge of merges) {
      if (branchReach.has(merge.parents[1]) && !branchReach.has(merge.sha)) {
        for (const sha of merge.side) commits.add(sha);
      }
    }
    return commits;
  };
}

/** 纯函数：只读取卡的 id/gitBranch；输出维持卡、分支原顺序，不修改输入。 */
function classifyBranches(tasks, graph, opts = {}) {
  const entries = [], summary = { ok: 0, suspect: 0, unknown: 0 };
  const claims = opts.claims || new Map(), claimers = new Map(), spreads = new Map();
  const spreadMin = opts.spreadMin === undefined ? 3 : opts.spreadMin;
  // 一次反向索引，逐条目只查该分支的认领者，不重复扫描活动或所有卡。
  for (const [id, branches] of claims) {
    for (const branch of branches) {
      if (!claimers.has(branch)) claimers.set(branch, []);
      claimers.get(branch).push(id);
    }
  }
  for (const ids of claimers.values()) ids.sort();
  const ids = tasks.map((task) => task.id);
  const subjectIds = new RegExp(taskIdRegex(ids).source, 'g');
  const namePatterns = ids.map((id) => [id, new RegExp('(^|[^a-z0-9])' + escapeRe(id.toLowerCase()) + '([^a-z0-9]|$)')]);
  const history = mergeWitnesses(graph.nodes), own = branchOwnership(graph), evidence = new Map();
  function inspect(branch) {
    if (evidence.has(branch)) return evidence.get(branch);
    let witness = graph.refs.get('refs/heads/' + branch) || graph.refs.get('refs/remotes/' + branch);
    if (!witness) {
      for (const [ref, sha] of graph.refs) {
        if (ref.replace(/^refs\/remotes\/[^/]+\//, '') === branch && ref.startsWith('refs/remotes/')) {
          witness = sha;
          break;
        }
      }
    }
    const commits = own(witness || history.get(branch) || null), mentioned = new Set();
    if (commits) {
      // 保持提交输出顺序和 subject 内的出现顺序，而不是按卡号排序。
      for (const [sha, node] of graph.nodes) {
        if (commits.has(sha)) for (const match of node.subject.matchAll(subjectIds)) mentioned.add(match[1]);
      }
    }
    const nameIds = namePatterns.filter(([, re]) => re.test(branch.toLowerCase())).map(([id]) => id);
    const result = { commits, mentioned, nameIds };
    evidence.set(branch, result);
    return result;
  }
  for (const task of tasks) {
    for (const branch of task.gitBranch || []) {
      const { commits, mentioned, nameIds } = inspect(branch);
      const self = nameIds.includes(task.id);
      const claimed = claims.get(task.id)?.has(branch) || false;
      const claimedBy = (claimers.get(branch) || []).filter((id) => id !== task.id);
      // 显式认领优先于反证；无卡号提交仍先归无法核实，再看认领者与铺开面。
      let verdict, reason, otherIds = [], evidence = 'none';
      if (claimed) {
        verdict = 'ok';
        evidence = 'claim';
        reason = '本卡显式认领过这条分支';
      } else if (self || (commits && mentioned.has(task.id))) {
        verdict = 'ok';
        evidence = self ? 'name' : 'commits';
        reason = self ? '分支名点名本卡' : `分支自有 ${commits.size} 个提交中提到本卡`;
      } else if (commits && mentioned.size) {
        verdict = 'suspect';
        evidence = 'commits';
        otherIds = [...mentioned].filter((id) => id !== task.id);
        reason = `分支自有 ${commits.size} 个提交只提到 ${otherIds.join('、')}，从没提过本卡`;
      } else if (commits) {
        verdict = 'unknown';
        evidence = 'commits';
        reason = `分支自有 ${commits.size} 个提交都没提任何卡，无法核实`;
      } else if (nameIds.length) {
        verdict = 'suspect';
        evidence = 'name';
        otherIds = nameIds.filter((id) => id !== task.id);
        reason = `分支已不存在，主干里也没有它的 merge 记录；但分支名点名的是 ${otherIds.join('、')}`;
      } else {
        verdict = 'unknown';
        reason = '分支已不存在，主干里也找不到它的 merge 记录，无法核实';
      }
      if (verdict === 'unknown' && claimedBy.length) {
        verdict = 'suspect';
        evidence = 'claim';
        otherIds = claimedBy;
        reason = `分支自有提交和分支名都没指向本卡，而这条分支被 ${claimedBy.join('、')} 显式认领过、本卡从没认领过`;
      }
      entries.push({ taskId: task.id, branch, verdict, evidence, reason, otherIds, claimed, claimedBy, spread: 0 });
      if (verdict !== 'ok') spreads.set(branch, (spreads.get(branch) || 0) + 1);
    }
  }
  // 铺开面只数前三步仍非可信的条目；可信条目也带同一计数，便于复核。
  for (const entry of entries) {
    entry.spread = spreads.get(entry.branch) || 0;
    if (entry.verdict === 'unknown' && entry.spread >= spreadMin) {
      entry.verdict = 'suspect';
      entry.evidence = 'spread';
      entry.otherIds = [];
      entry.reason = `分支自有提交和分支名都没指向本卡、也没有任何卡认领过它，却无凭无据地挂在本板 ${entry.spread} 张卡上（早期同步把主目录分支广播给一批老卡的典型痕迹）`;
    }
    summary[entry.verdict]++;
  }
  return { entries, summary };
}

/** 只读加载 git 证据并体检；额外给出探测到的主干名（无证据时为 null）。 */
function auditBoardBranches(board, repo, opts = {}) {
  const graph = loadGraph(repo);
  return { ...classifyBranches(board.tasks || [], graph, opts), trunk: graph.trunk && graph.trunk.name };
}

/**
 * 纯函数：默认仍要求提交反证与全部正主挂分支，其它档依次纳入名字、认领、铺开反证。
 * 主干永不摘；关系优先于无正主计数，默认 skipped 保留两个键；不改输入与条目顺序。
 */
function planBranchCleanup(tasks, entries, opts = {}) {
  const tier = opts.tier === undefined ? 'owned' : opts.tier;
  const level = ['owned', 'suspect', 'claimed-elsewhere', 'broadcast'].indexOf(tier);
  if (level < 0) throw new Error('--tier 只能是 owned / suspect / claimed-elsewhere / broadcast');
  const accepted = ['commits', 'name', 'claim', 'spread'].slice(0, level + 1);
  const trunkNames = new Set(['main', 'master', ...(opts.trunkNames || [])]);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const removals = [], skipped = tier === 'owned' ? { related: 0, noOwner: 0 } : { related: 0, noOwner: 0, trunk: 0 };
  const related = (task, id) => ['dependsOn', 'blockedBy', 'relatedTasks']
    .some((key) => (task?.deps?.[key] || []).includes(id));
  for (const entry of entries) {
    if (entry.verdict !== 'suspect' || !accepted.includes(entry.evidence)) continue;
    const { taskId, branch, otherIds, verdict, evidence } = entry;
    if (trunkNames.has(branch)) {
      if (tier !== 'owned') skipped.trunk++;
      continue;
    }
    if (otherIds.some((id) => related(byId.get(taskId), id) || related(byId.get(id), taskId))) {
      skipped.related++;
      continue;
    }
    if (tier === 'owned' && (!otherIds.length || !otherIds.every((id) => byId.get(id)?.gitBranch?.includes(branch)))) {
      skipped.noOwner++;
      continue;
    }
    removals.push({ taskId, branch, otherIds, verdict, evidence });
  }
  return { removals, skipped };
}

/** 只改传入 board 的 gitBranch；用新数组摘除，返回实际条数，已不存在的条目重跑不计数。 */
function applyBranchCleanup(board, removals) {
  const byId = new Map((board.tasks || []).map((task) => [task.id, task]));
  let removed = 0;
  for (const { taskId, branch } of removals) {
    const task = byId.get(taskId);
    if (!task || !(task.gitBranch || []).includes(branch)) continue;
    task.gitBranch = task.gitBranch.filter((name) => name !== branch);
    removed++;
  }
  return removed;
}

module.exports = { claimIndex, loadClaimIndex, classifyBranches, loadGraph, auditBoardBranches, planBranchCleanup, applyBranchCleanup, taskIdRegex, escapeRe };
