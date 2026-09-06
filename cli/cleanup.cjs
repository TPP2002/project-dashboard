'use strict';
/**
 * cleanup.cjs —— 收官清工位(WORKFLOW-OPS-SCRIPTS,0901 负责人拍板)。
 *
 * 固化收官后拆工位的正确顺序,治那串反复踩的坑(skill §14-4/5、env-git 记忆):
 *   ① 先摘 node_modules junction(只删链接本身,绝不跟进链接删真身);
 *   ② git worktree remove(报错但目录已消失 = 实际已成,prune 兜底);
 *   ③ 分支删除前先 merge-base --is-ancestor 验「真的合进干线了」,没合入的绝不删;
 *   ④ 终检:主仓 status 没被本次操作弄脏。
 *
 * 【干线保护】BOARD-CLEANUP-DELETES-MAIN(0902 亲踩,0906 负责人拍 A):
 *   ③ 的 is-ancestor 只回答「删了会不会丢成果」,回答不了「这东西该不该删」——
 *   干线自己永远是 origin/<干线> 的祖先,所以那道校验对干线恒为真,等于没有闸门。
 *   实测三条路都能把干线删掉:(a) 分支被 gh pr merge --delete-branch 删掉后工位 HEAD 落到干线;
 *   (b) 显式 --branch main;(c) 跑基线对照那种签在干线上的工位收摊。三次都打印「删除安全」。
 *   现在:先问出本仓干线叫什么(别写死 main——看板自己这个仓干线是 master,
 *   写死 main 让删分支功能从上线起就没生效过),干线一律拒删(--yes 也不行),
 *   且对干线不打印那句会删掉远程正本的 push origin --delete 引导语。
 *
 * 【安全设计】默认 dry-run:只输出体检报告 + 将要执行的命令清单,一步不执行;
 * 加 --yes 才真动手。远程分支永远不动(合并时多半已删,漏删的列出来人工处理)。
 *
 * 【squash 合并识别】CLEANUP-ASSUMES-MAIN-BRANCH(0906 用户报,同日修):
 *   ③ 的 is-ancestor 只认「分支尖端是干线的祖先」,这只对真 merge / rebase 落地成立——
 *   合并方式若是「压成一条」(squash),干线上是一个全新提交,分支提交永远不会是它的祖先,
 *   is-ancestor 对这类仓库恒为假。后果:合并方式是 squash 的仓库,清工位永远判「未合入」,
 *   临时支线永远删不掉。现在:is-ancestor 没过时,再用 git-delete-squashed 那套经典手法兜底——
 *   把分支树接到 merge-base 上造一个"假提交",用 git cherry 比对它的 patch-id 是否已经在
 *   干线里出现过;命中就说明这条分支的内容已经被完整 squash 进干线了,同样判「删除安全」。
 *   这一步只在本地建悬空 commit 对象(不建引用,不碰工作区),失败就当没通过、保守不删。
 *
 * 用法:node cli/index.cjs cleanup --repo <主仓> --worktree <工位路径> [--branch <分支名>] [--yes]
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function git(repo, args, opts = {}) {
  try {
    return { ok: true, out: execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: opts.timeout || 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (e) {
    return { ok: false, out: ((e.stdout || '') + (e.stderr || '')).toString().trim() || e.message };
  }
}

/** 目录是否为 junction/符号链接(reparse point):lstat 的 isSymbolicLink 对 junction 在 node 下为 true */
function isLinkDir(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; }
}

/**
 * 常见干线名。即便探测不出本仓默认分支(没有 origin、离线等),这几个也一律不许删——
 * 宁可漏删一条恰好叫 develop 的支线(人工一条命令的事),也不能再误删一次干线。
 */
const COMMON_TRUNKS = ['main', 'master', 'trunk', 'develop', 'development'];

/**
 * squash 合并识别(git-delete-squashed 经典手法):is-ancestor 判不出「已被压成一条合入」时兜底用。
 * 把 branch 的树接到它与 trunk 的 merge-base 上,造一个不入库的悬空提交,
 * 用 git cherry 比对这个悬空提交的 patch-id 是否已经在 origin/<trunk> 里——命中即视为已合入。
 * 任何一步失败都保守返回 false(不判定为已合入),不抛错、不影响主流程。
 */
function isSquashMerged(repo, branch, trunk) {
  const base = git(repo, ['merge-base', branch, `origin/${trunk}`]);
  if (!base.ok || !base.out) return false;
  const tree = git(repo, ['rev-parse', `${branch}^{tree}`]);
  if (!tree.ok || !tree.out) return false;
  const synthetic = git(repo, ['commit-tree', tree.out, '-p', base.out, '-m', '_squash-check_']);
  if (!synthetic.ok || !synthetic.out) return false;
  const cherry = git(repo, ['cherry', `origin/${trunk}`, synthetic.out]);
  if (!cherry.ok) return false;
  // git cherry 每行以 '-' 开头 = 该 patch-id 已经在 upstream 里出现过(已合入);'+' = 没有
  return cherry.out.trim().startsWith('-');
}

/** 问出这个仓库的干线(默认分支)到底叫什么;探测不出返回 null。绝不写死 main。 */
function defaultBranchOf(repo) {
  const s = git(repo, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (s.ok && s.out) return s.out.replace(/^refs\/remotes\/origin\//, '');
  const r = git(repo, ['ls-remote', '--symref', 'origin', 'HEAD'], { timeout: 30000 });
  if (r.ok) { const m = r.out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m); if (m) return m[1]; }
  for (const c of COMMON_TRUNKS) {
    if (git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${c}`]).ok) return c;
  }
  return null;
}

function cleanup(flags) {
  const repo = flags.repo && flags.repo !== true ? path.resolve(String(flags.repo)) : null;
  const wt = flags.worktree && flags.worktree !== true ? path.resolve(String(flags.worktree)) : null;
  if (!repo || !wt) throw new Error('缺参数。用法: cleanup --repo <主仓> --worktree <工位路径> [--branch <分支>] [--yes]');
  if (path.resolve(repo) === path.resolve(wt)) throw new Error('拒绝:--worktree 就是主仓本身,清不得');
  const doIt = !!flags.yes;
  const L = [];
  const plan = [];
  L.push(`═══ 收官清工位 ${doIt ? '(--yes 实干模式)' : '(体检模式,一步不执行;确认无误后加 --yes)'} ═══`);
  L.push(`主仓 ${repo}`, `工位 ${wt}`);

  // ── 体检 ──
  const wtExists = fs.existsSync(wt);
  L.push('', '【体检】');
  if (!wtExists) L.push('  ⚠ 工位目录已不存在(可能已被清,后面只做 prune 与分支处理)');

  // 未提交改动 = 硬拦(不论 dry-run 还是 --yes)
  if (wtExists) {
    const dirty = git(wt, ['status', '--porcelain']);
    if (dirty.ok && dirty.out) {
      L.push(`  ✖ 工位有 ${dirty.out.split('\n').length} 个未提交改动 —— 先处理(commit/上报),本命令拒绝在脏工位上动手:`);
      for (const line of dirty.out.split('\n').slice(0, 10)) L.push(`      ${line}`);
      return { ok: false, text: L.join('\n') };
    }
    L.push('  ✔ 工位无未提交改动');
  }

  // 分支:显式传入,或从工位 HEAD 读
  let branch = flags.branch && flags.branch !== true ? String(flags.branch) : null;
  if (!branch && wtExists) {
    const h = git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (h.ok && h.out !== 'HEAD') branch = h.out;
  }
  L.push(branch ? `  分支:${branch}` : '  分支:未指定且读不出(游离 HEAD?)——跳过分支处理');

  // 干线是谁:问 git,不写死
  const trunk = defaultBranchOf(repo);
  const isTrunk = (b) => !!b && (b === trunk || COMMON_TRUNKS.includes(b));
  if (branch) L.push(trunk ? `  本仓干线:${trunk}` : '  本仓干线:探测不出(没有 origin?)——仍按常见干线名保护');

  // junction 探测(常见位置:工位根 node_modules;也扫工位一级子目录下的 node_modules)
  const links = [];
  if (wtExists) {
    const candidates = [path.join(wt, 'node_modules')];
    try {
      for (const d of fs.readdirSync(wt, { withFileTypes: true })) {
        if (d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules') {
          candidates.push(path.join(wt, d.name, 'node_modules'));
        }
      }
    } catch (_) { /* 读不了就只查根 */ }
    for (const c of candidates) if (isLinkDir(c)) links.push(c);
    L.push(links.length ? `  ⚠ 发现 ${links.length} 个 junction(必须先摘,否则 worktree remove 会顺着链接删掉别人的真身):` : '  ✔ 未发现 node_modules junction');
    for (const l of links) L.push(`      ${l}`);
  }

  // 分支处理资格:①分支还在吗 ②是不是干线 ③合入了吗。三关全过才允许进删除计划。
  let branchMerged = null;
  let branchActionable = false;
  let mergedVia = null; // 'ancestor' | 'squash' —— 决定删分支时用 -d 还是 -D(见下方计划)
  if (branch) {
    const gone = !git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
    if (gone) {
      L.push(`  ℹ ${branch} 本地已不存在(多半已被 gh pr merge --delete-branch 顺手删掉)—— 判为「已删,无需处理」,跳过分支处理`);
    } else if (isTrunk(branch)) {
      L.push(`  ⛔ ${branch} 是干线(${branch === trunk ? '本仓默认分支' : '常见干线名'})—— 一律拒删,加 --yes 也不行。`,
        '      (is-ancestor 对干线恒为真,挡不住;删干线不该由清工位命令代劳,真要删请人工直接跑 git)');
    } else if (!trunk) {
      branchMerged = false;
      L.push(`  ✖ 探测不出本仓干线,无法验证 ${branch} 是否已合入 —— 保守起见不删这个分支`);
    } else {
      git(repo, ['fetch', '--quiet'], { timeout: 30000 });
      const anc = git(repo, ['merge-base', '--is-ancestor', branch, `origin/${trunk}`]);
      branchMerged = anc.ok;
      mergedVia = branchMerged ? 'ancestor' : null;
      if (!branchMerged && isSquashMerged(repo, branch, trunk)) { branchMerged = true; mergedVia = 'squash'; }
      branchActionable = branchMerged;
      L.push(branchMerged
        ? `  ✔ ${branch} 已合入 origin/${trunk}(${mergedVia === 'squash' ? '内容已被 squash 合并,patch-id 命中' : 'is-ancestor 通过'},删除安全)`
        : `  ✖ ${branch} 未合入 origin/${trunk} —— 不删这个分支(要么还没收官,要么成果会丢)`);
    }
  }

  // ── 计划 ──
  for (const l of links) plan.push({ desc: `摘 junction(只删链接):${l}`, run: () => fs.rmdirSync(l) });
  if (wtExists) {
    plan.push({
      desc: `git worktree remove ${wt}`,
      run: () => {
        const r = git(repo, ['worktree', 'remove', wt]);
        if (!r.ok) {
          if (!fs.existsSync(wt)) return '报错但目录已消失 = 实际已成(已知坑),prune 兜底';
          throw new Error(r.out);
        }
      },
    });
  }
  plan.push({ desc: 'git worktree prune(清悬空登记)', run: () => { const r = git(repo, ['worktree', 'prune']); if (!r.ok) throw new Error(r.out); } });
  if (branchActionable && branchMerged) {
    // squash 路径:git branch -d 自己内部也是 is-ancestor 那套判断,对 squash 恒报「未合并」——
    // 我们已经用 patch-id 独立验过内容安全,这里必须直接 -D,再用 -d 只会重演同一个假阴性。
    const squash = mergedVia === 'squash';
    plan.push({
      desc: squash
        ? `git branch -D ${branch}(squash 合并已用 patch-id 验证,-d 自身的 is-ancestor 检查对 squash 必报「未合并」,直接强删)`
        : `git branch -d ${branch}(已验合入;若报错先核 is-ancestor 结论,别硬 -D)`,
      run: () => {
        const r = git(repo, ['branch', squash ? '-D' : '-d', branch]);
        if (!r.ok) {
          // 已知坑:多 worktree 下 -d 可能误报;is-ancestor 已过,报错文案里带提示但不自动升级 -D
          throw new Error(r.out + (squash ? '' : '\n      (is-ancestor 已通过——多 worktree 下 -d 有误报前科,人工核后可 -D)'));
        }
      },
    });
  }
  // 远程提示只对「本来就该删」的支线打印;干线绝不打印(照抄那句 = 删掉远程正本,灾难级)
  const remote = branchActionable ? git(repo, ['ls-remote', '--heads', 'origin', branch]) : { ok: false, out: '' };
  if (branchActionable && remote.ok && remote.out) {
    L.push(`  ℹ 远程还留着 origin/${branch}(本命令不动远程);确认收官后手动:git push origin --delete ${branch}`);
  }

  L.push('', doIt ? '【执行】' : '【将要执行的动作(加 --yes 才会真跑)】');
  for (const [i, p] of plan.entries()) {
    if (!doIt) { L.push(`  ${i + 1}. ${p.desc}`); continue; }
    try {
      const note = p.run();
      L.push(`  ✔ ${p.desc}${note ? ' —— ' + note : ''}`);
    } catch (e) {
      L.push(`  ✖ ${p.desc}`, `      ${String(e.message || e).split('\n').join('\n      ')}`);
      L.push('  (后续步骤继续,逐项报结果)');
    }
  }

  // ── 终检 ──
  if (doIt) {
    L.push('', '【终检】');
    L.push(fs.existsSync(wt) ? `  ⚠ 工位目录仍在:${wt}(上面哪步红了,按报错处理)` : '  ✔ 工位目录已清');
    const ms = git(repo, ['status', '--porcelain']);
    L.push(ms.ok && !ms.out ? '  ✔ 主仓工作区干净' : `  ⚠ 主仓工作区:\n      ${(ms.out || '读取失败').split('\n').slice(0, 8).join('\n      ')}\n      (若非本次操作所致 = 别的会话的活,别动)`);
  }
  return { ok: true, text: L.join('\n') };
}

module.exports = { cleanup, defaultBranchOf, isSquashMerged, COMMON_TRUNKS };
