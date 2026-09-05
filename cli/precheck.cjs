'use strict';
/**
 * precheck.cjs —— 开工三查一键化(WORKFLOW-OPS-SCRIPTS,0901 负责人拍板)。
 *
 * 把 skill §11.2 认领协议的头两步 + 正本提醒固化成一条命令,治「每次开工现场拼命令」:
 *   ① git 新鲜度:fetch 后报本地 main 落后 origin/main 多少、worktree 占用清单;
 *   ② 看板占用:施工中的卡(谁占着/分支/多久没动)+ 待拍板数 + 状态统计;
 *   ③ 正本三读:该项目必读文件的存在性与路径(开工须知/口径速查表/CLAUDE.md/AGENTS.md)。
 *
 * 用法:node cli/index.cjs precheck --project <id> [--repo <worktree路径>] [--no-fetch]
 *   --repo 不传用主仓;多 worktree 并行时传自己工位的完整路径(§11.4 完整路径纪律)。
 * 只读命令:不写看板、不改仓库(fetch 只更新远程追踪引用)。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readBoardOrNull } = require('./store.cjs');
const { resolveProject, REGISTRY_PATH } = require('../core/resolveProject.cjs');

function git(repo, args, opts = {}) {
  try {
    return { ok: true, out: execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: opts.timeout || 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (e) {
    return { ok: false, out: ((e.stdout || '') + (e.stderr || '')).toString().trim() || e.message };
  }
}

function relAge(iso) {
  if (!iso) return '无戳';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 60) return `${min} 分钟前`;
  if (min < 60 * 24) return `${Math.round(min / 60)} 小时前`;
  return `${Math.round(min / 1440)} 天前`;
}

function precheck(flags) {
  const pid = flags.project;
  if (!pid || pid === true) throw new Error('缺参数。用法: precheck --project <id> [--repo <worktree路径>] [--no-fetch]');
  const proj = resolveProject(pid, { registryPath: flags.registry ? path.resolve(flags.registry) : REGISTRY_PATH });
  // codeRepo 而非 mainRepo:三查查的是「代码的家」,板可能自成一家(见 resolveProject 头注)。
  const repo = flags.repo ? path.resolve(String(flags.repo)) : proj.codeRepo;
  const L = [];
  L.push(`═══ 开工三查 · 项目 ${pid}(${proj.name || pid}) · 工位 ${repo} ═══`);

  // ── ① git 新鲜度 ──
  L.push('', '【① 新鲜度】');
  if (!fs.existsSync(path.join(repo, '.git'))) {
    L.push(`  ✖ ${repo} 不是 git 检出(路径打错?)`);
  }
  if (!flags['no-fetch']) {
    const f = git(repo, ['fetch', '--quiet'], { timeout: 30000 });
    L.push(f.ok ? '  ✔ git fetch 完成' : `  ⚠ git fetch 失败(离线?):${f.out.split('\n')[0]}`);
  } else {
    L.push('  ⚠ 跳过 fetch(--no-fetch):以下差距按上次 fetch 的旧数据算');
  }
  const head = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  L.push(`  当前分支:${head.ok ? head.out : '?'}`);
  const behind = git(repo, ['rev-list', '--count', 'HEAD..origin/main']);
  const ahead = git(repo, ['rev-list', '--count', 'origin/main..HEAD']);
  if (behind.ok && ahead.ok) {
    const b = parseInt(behind.out, 10), a = parseInt(ahead.out, 10);
    if (b === 0) L.push('  ✔ 本工位不落后 origin/main');
    else L.push(`  ⚠ 本工位落后 origin/main ${b} 个提交${a ? `(本地领先 ${a})` : ''} —— 落后的 worktree 会把已完工任务看成没做(§3.0-1),先同步`);
  } else {
    L.push(`  ⚠ 算不出与 origin/main 的差距:${(behind.ok ? ahead.out : behind.out).split('\n')[0]}`);
  }
  const dirty = git(repo, ['status', '--porcelain']);
  if (dirty.ok) {
    const n = dirty.out ? dirty.out.split('\n').length : 0;
    L.push(n === 0 ? '  ✔ 工作区干净' : `  ⚠ 工作区有 ${n} 个未提交改动(派集群前必须干净;确认不是别的会话的活)`);
  }
  const wt = git(repo, ['worktree', 'list']);
  if (wt.ok && wt.out) {
    L.push('  worktree 占用(挑分支号避开这些,§11.3):');
    for (const line of wt.out.split('\n')) L.push(`    ${line}`);
  }

  // ── ② 看板占用 ──
  L.push('', '【② 看板占用】');
  const board = readBoardOrNull(proj.board);
  if (!board) {
    L.push(`  ✖ 读不到看板 ${proj.board}`);
  } else {
    const tasks = board.tasks || [];
    const byStatus = {};
    for (const t of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    L.push('  统计:' + Object.entries(byStatus).map(([k, v]) => `${k}${v}`).join(' '));
    const working = tasks.filter((t) => t.status === '施工中');
    if (working.length) {
      L.push(`  施工中 ${working.length} 张(已被占用,不许接,§11.2-2):`);
      for (const t of working) {
        L.push(`    🔨 ${t.id} · 分支[${(t.gitBranch || []).join(',') || '-'}] · 进度${t.percent ?? 0}% · 更新 ${relAge(t.lastProgressAt)}`);
      }
    } else {
      L.push('  施工中 0 张(无人占用)');
    }
    const pend = tasks.filter((t) => (t.decisions || []).some((d) => d.answer == null));
    if (pend.length) L.push(`  ❓ 待拍板 ${pend.length} 张:${pend.map((t) => t.id).join(', ')}`);
  }

  // ── ③ 正本三读 ──
  L.push('', '【③ 正本必读(读了再动手,禁止凭记忆臆定)】');
  const musts = [
    ['开工须知', path.join(proj.codeRepo, 'docs', '开工须知.md')],
    ['口径速查表', path.join(proj.codeRepo, 'docs', '口径速查表.md')],
    ['CLAUDE.md', path.join(proj.codeRepo, 'CLAUDE.md')],
    ['AGENTS.md', path.join(proj.codeRepo, 'AGENTS.md')],
  ];
  for (const [name, p] of musts) {
    L.push(fs.existsSync(p) ? `  📖 ${name}:${p}` : `  —— ${name}:不存在(本项目没有则忽略)`);
  }
  L.push('  📖 任务正本:看板卡 description + 卡上挂的 docs(用 `show <卡id>` / `inbox --tid <卡id>` 拉)');

  // ── ④ 施工方与 Codex 额度(0905 负责人定:写代码的活默认派 Codex,额度到线才例外)──
  // 简报脚本住在各项目仓库里(单一实现,SessionStart hook 也跑它),这里只转发它的输出,不另写一份读额度的逻辑。
  L.push('', '【④ 施工方】写代码的活默认派 Codex,本对话只定契约/派单/验收/销卡;自干要对上开工须知例外表编号,回复第一句写明「施工方=…」');
  const brief = path.join(proj.codeRepo, 'scripts', 'codex', 'codex-brief.cjs');
  if (fs.existsSync(brief)) {
    try {
      const out = execFileSync(process.execPath, [brief], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      for (const line of out.split('\n')) L.push(`  ${line}`);
    } catch (e) {
      L.push(`  ⚠ 派单简报跑不起来:${String((e && e.message) || e).split('\n')[0]}`);
    }
  } else {
    L.push('  —— 本项目没有派单简报脚本(scripts/codex/codex-brief.cjs),额度与派单器状态自己查');
  }

  L.push('', '三查只是开工的前半截:认领还要「建分支+推远程」原子抢占 + `claim` 上看板(§11.2-3/4)+ 判施工方留痕(§17.0)。');
  return { ok: true, text: L.join('\n') };
}

module.exports = { precheck };
