'use strict';
/**
 * cleanup.cjs —— 收官清工位(WORKFLOW-OPS-SCRIPTS,0901 负责人拍板)。
 *
 * 固化收官后拆工位的正确顺序,治那串反复踩的坑(skill §14-4/5、env-git 记忆):
 *   ① 先摘 node_modules junction(只删链接本身,绝不跟进链接删真身);
 *   ② git worktree remove(报错但目录已消失 = 实际已成,prune 兜底);
 *   ③ 分支删除前先 merge-base --is-ancestor 验「真的合进 origin/main 了」,没合入的绝不删;
 *   ④ 终检:主仓 status 没被本次操作弄脏。
 *
 * 【安全设计】默认 dry-run:只输出体检报告 + 将要执行的命令清单,一步不执行;
 * 加 --yes 才真动手。远程分支永远不动(合并时多半已删,漏删的列出来人工处理)。
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

  // 分支合入校验
  let branchMerged = null;
  if (branch) {
    git(repo, ['fetch', '--quiet'], { timeout: 30000 });
    const anc = git(repo, ['merge-base', '--is-ancestor', branch, 'origin/main']);
    branchMerged = anc.ok;
    L.push(branchMerged
      ? `  ✔ ${branch} 已合入 origin/main(is-ancestor 通过,删除安全)`
      : `  ✖ ${branch} 未合入 origin/main —— 不删这个分支(要么还没收官,要么成果会丢)`);
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
  if (branch && branchMerged) {
    plan.push({
      desc: `git branch -d ${branch}(已验合入;若报错先核 is-ancestor 结论,别硬 -D)`,
      run: () => {
        const r = git(repo, ['branch', '-d', branch]);
        if (!r.ok) {
          // 已知坑:多 worktree 下 -d 可能误报;is-ancestor 已过,报错文案里带提示但不自动升级 -D
          throw new Error(r.out + '\n      (is-ancestor 已通过——多 worktree 下 -d 有误报前科,人工核后可 -D)');
        }
      },
    });
  }
  const remote = branch ? git(repo, ['ls-remote', '--heads', 'origin', branch]) : { ok: false, out: '' };
  if (branch && remote.ok && remote.out) {
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

module.exports = { cleanup };
