'use strict';
/**
 * branchAudit.cjs —— 分支台账的只读体检（BOARD-GITFIELD-HISTORY-CLEANUP）。
 * 历史同步曾把工位分支误记到老卡；用引用与 merge 证据找回分支自有提交，
 * 报告可信、可疑或无法核实，供人工确认，绝不改写看板或 git。
 */
const { execFileSync } = require('node:child_process');

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
function classifyBranches(tasks, graph) {
  const entries = [], summary = { ok: 0, suspect: 0, unknown: 0 };
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
      // evidence：这条判决靠什么——commits（分支自有提交）/ name（分支名）/ none（两样都没有）。
      // 「可疑」只在有反面证据时才判：分支的提交明明白白提到了别的卡、或分支名点名别的卡；
      // 分支自有提交一张卡都没提（早期提交不带卡号是常态），是没证据，不是反证，归无法核实。
      let verdict, reason, otherIds = [], evidence = 'none';
      if (self || (commits && mentioned.has(task.id))) {
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
      entries.push({ taskId: task.id, branch, verdict, evidence, reason, otherIds });
      summary[verdict]++;
    }
  }
  return { entries, summary };
}

/** 只读加载 git 证据并体检；额外给出探测到的主干名（无证据时为 null）。 */
function auditBoardBranches(board, repo) {
  const graph = loadGraph(repo);
  return { ...classifyBranches(board.tasks || [], graph), trunk: graph.trunk && graph.trunk.name };
}

module.exports = { classifyBranches, loadGraph, auditBoardBranches, taskIdRegex, escapeRe };
