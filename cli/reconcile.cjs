'use strict';
/**
 * reconcile —— 看板对账:在办卡对 PR、分支、派单器的单,列出状态和实情对不上的卡。
 * 不带 --apply 只读;--apply 写去重的【对账】留言,并把「施工中却多日没动静」的卡转暂缓。
 * 云项目只读。判定逻辑全在 core/reconcileScan.cjs(纯函数),本文件只管取数、输出与写回。
 * 外部读取(gh / git)经 deps.runFile 注入,测试不碰网络和真仓库。
 */
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { scanProject, KINDS } = require('../core/reconcileScan.cjs');

const DAY = 86400000;

/** 同步执行外部程序;ENOENT、超时、非零退出一律返回 {status:非0, stdout:''},不抛。 */
function defaultRunFile(cmd, args, opts = {}) {
  try {
    const stdout = childProcess.execFileSync(cmd, args, {
      encoding: 'utf8', windowsHide: true, timeout: opts.timeout || 30000, maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'], ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    return { status: 0, stdout: String(stdout) };
  } catch (e) {
    return { status: typeof e.status === 'number' && e.status !== 0 ? e.status : -1, stdout: '' };
  }
}

const asArray = (v) => (v === undefined || v === true || v === false ? [] : Array.isArray(v) ? v : [v]).filter((x) => x !== true).map(String);
const normPath = (p) => {
  let s = path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
};
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const toIso = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
const numFlag = (v, def, name) => {
  if (v === undefined) return def;
  const n = Number(v);
  if (v === true || !Number.isFinite(n) || n < 0) throw new Error(`${name} 要给非负数字`);
  return n;
};

/** 读一个派单器 jobs 目录:每个工单目录一条,契约有、目录没有的记成 dispatched=false。 */
function readJobsDir(dir) {
  const out = [];
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  const worktrees = path.join(path.dirname(dir), 'worktrees');
  const dirs = new Set(names.filter((d) => d.isDirectory()).map((d) => d.name));
  for (const slug of dirs) {
    const base = path.join(dir, slug);
    const meta = readJson(path.join(base, 'meta.json')) || {};
    const contract = readJson(path.join(dir, slug + '.json')) || {};
    const taskId = meta.taskId || contract.taskId;
    if (!taskId) continue;
    const state = readJson(path.join(base, 'state.json')) || {};
    const verdict = readJson(path.join(base, 'verdict.json')) || {};
    const land = readJson(path.join(base, 'land.json')) || {};
    const auto = readJson(path.join(base, 'auto-land', 'state.json')) || {};
    out.push({
      dir, meta, slug, taskId: String(taskId),
      branch: meta.worktreeBranch || null,
      landed: !!land.landedAt, pushed: land.pushed === true, landBranch: land.branch || null,
      finishedAt: toIso(state.finishedAt), startedAt: toIso(state.startedAt), pid: state.pid || null,
      verdict: verdict.finalStatus || null,
      worktreeExists: fs.existsSync(path.join(worktrees, slug)),
      dispatched: true,
      autoLandPr: auto.prNumber === undefined ? null : auto.prNumber,
    });
  }
  for (const f of names) {
    if (!f.isFile() || !f.name.endsWith('.json')) continue;
    const slug = f.name.slice(0, -5);
    if (dirs.has(slug)) continue;
    const contract = readJson(path.join(dir, f.name));
    if (!contract || !contract.taskId) continue;
    out.push({
      dir, meta: contract, slug: contract.slug || slug, taskId: String(contract.taskId), branch: null,
      landed: false, pushed: false, landBranch: null, finishedAt: null, startedAt: null, pid: null,
      verdict: null, worktreeExists: false, dispatched: false, autoLandPr: null,
    });
  }
  return out;
}

/**
 * 读文档目录里还没派的契约(只扫一层 *.json):有字符串 taskId 与 slug、jobs 目录下没有同名子目录、
 * 且该 slug 还没被读到的,记成 dispatched=false 的条目(形状同 readJobsDir 的「契约有、目录没有」)。
 */
function readContractDirs(rels, mainRepo, jobsDirs, haveSlugs) {
  const out = [];
  const seen = new Set(haveSlugs);
  for (const rel of rels) {
    const dir = path.resolve(mainRepo, rel);
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const f of names) {
      if (!f.isFile() || !f.name.endsWith('.json')) continue;
      const contract = readJson(path.join(dir, f.name));
      if (!contract || typeof contract.taskId !== 'string' || !contract.taskId
        || typeof contract.slug !== 'string' || !contract.slug) continue;
      if (seen.has(contract.slug)) continue;
      if (jobsDirs.some((jd) => fs.existsSync(path.join(jd, contract.slug)))) continue;
      seen.add(contract.slug);
      out.push({
        dir, meta: contract, slug: contract.slug, taskId: contract.taskId, branch: null,
        landed: false, pushed: false, landBranch: null, finishedAt: null, startedAt: null, pid: null,
        verdict: null, worktreeExists: false, dispatched: false, autoLandPr: null,
      });
    }
  }
  return out;
}

/** 单是否归项目 P(见施工单第 5 步⑥)。 */
function jobBelongs(job, p) {
  const meta = job.meta || {};
  const pid = meta.boardAwaitCollect && meta.boardAwaitCollect.projectId;
  if (pid) return pid === p.id;
  if (meta.repoRoot) {
    const r = normPath(meta.repoRoot);
    return [p.mainRepo, p.codeRepo].some((x) => x && normPath(x) === r);
  }
  const d = normPath(job.dir);
  const m = normPath(p.mainRepo);
  return d === m || d.startsWith(m + '/');
}

function gitInfo(p, runFile, now, fetchFirst, notes) {
  const git = (args, timeout) => runFile('git', ['-C', p.repo, ...args], { timeout: timeout || 30000 });
  if (fetchFirst) {
    const f = git(['fetch', '--prune', '--quiet', 'origin'], 60000);
    if (f.status !== 0) notes.push('git fetch 没成功,用的是本地已有的远端记录');
  }
  let trunk = null;
  const sym = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (sym.status === 0 && sym.stdout.trim()) trunk = sym.stdout.trim().replace(/^origin\//, '');
  if (!trunk) {
    for (const n of ['main', 'master']) {
      if (git(['rev-parse', '--verify', '--quiet', 'origin/' + n]).status === 0) { trunk = n; break; }
    }
  }
  const branches = { available: false, remote: new Map(), isAncestor: () => null };
  if (trunk) {
    const refs = git(['for-each-ref', '--format=%(refname:short)%09%(committerdate:iso-strict)', 'refs/remotes/origin']);
    if (refs.status === 0) {
      for (const line of refs.stdout.split(/\r?\n/)) {
        const [name, date] = line.split('\t');
        if (!name || !name.startsWith('origin/')) continue;
        const b = name.slice(7);
        if (b && b !== 'HEAD') branches.remote.set(b, date || null);
      }
      branches.available = true;
      branches.isAncestor = (b) => {
        const r = git(['merge-base', '--is-ancestor', 'origin/' + b, 'origin/' + trunk]);
        return r.status === 0 ? true : r.status === 1 ? false : null;
      };
    }
  }
  if (!branches.available) notes.push('没拿到分支数据,②没判');

  const prs = { available: false, open: [], merged: [] };
  const url = git(['remote', 'get-url', 'origin']);
  const slug = url.status === 0 ? require('../core/schedCiJobs.cjs').githubRepository(url.stdout.trim()) : null;
  if (slug) {
    const since = new Date(now - 30 * DAY).toISOString().slice(0, 10);
    const gh = (args) => {
      const r = runFile('gh', ['pr', 'list', '--repo', slug, ...args], { timeout: 30000 });
      if (r.status !== 0) return null;
      try { const v = JSON.parse(r.stdout || '[]'); return Array.isArray(v) ? v : null; } catch { return null; }
    };
    const open = gh(['--state', 'open', '--limit', '200', '--json', 'number,title,headRefName,updatedAt']);
    const merged = gh(['--state', 'merged', '--search', `merged:>=${since}`, '--limit', '500',
      '--json', 'number,title,headRefName,mergedAt']);
    if (open && merged) { prs.available = true; prs.open = open; prs.merged = merged; }
  }
  if (!prs.available) notes.push('没拿到 PR 数据,①②⑥ 没判');
  return { branches, prs };
}

function readBoard(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readWaitingPrereq(p, runFile) {
  const waiting = new Map();
  const [first, ...args] = p.queueCommand;
  const r = runFile(first === 'node' ? process.execPath : first, args, { cwd: p.mainRepo, timeout: 120000 });
  if (r.status !== 0) return { available: false, waiting, reason: '队列判读命令没跑成' };
  let data;
  try { data = JSON.parse(r.stdout); } catch { return { available: false, waiting, reason: '队列判读输出读不懂' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.items)) {
    return { available: false, waiting, reason: '队列判读输出读不懂' };
  }
  if (data.gitOk === false) return { available: false, waiting, reason: '队列判读读不了 git 合并记录' };
  for (const item of data.items) {
    if (!item || item.verdict !== 'wait-prereq' || typeof item.card !== 'string' || !item.card.trim()
      || typeof item.slug !== 'string' || !item.slug.trim()) continue;
    if (!waiting.has(item.card)) waiting.set(item.card, []);
    waiting.get(item.card).push({ slug: item.slug, reasons: Array.isArray(item.reasons) ? item.reasons.filter((v) => typeof v === 'string') : [] });
  }
  return { available: true, waiting, reason: '' };
}

function reconcile(flags, deps = {}) {
  const runFile = deps.runFile || defaultRunFile;
  const nowFn = deps.now || Date.now;
  const now = nowFn();
  const projectIds = asArray(flags.project);
  const all = flags.all === true;
  if (!all && !projectIds.length) {
    process.stderr.write('✖ reconcile 需要 --project <id>（可重复）或 --all\n');
    (deps.exit || process.exit)(2);
    return { ok: false, text: '缺参数：需要 --project <id> 或 --all' };
  }
  const staleDays = numFlag(flags['stale-days'], 2, '--stale-days');
  const collectHours = numFlag(flags['collect-hours'], 6, '--collect-hours');
  const renoteDays = numFlag(flags['renote-days'], 7, '--renote-days');
  const cliContractDirs = asArray(flags['contracts-dir']);
  const contractRels = (p) => (cliContractDirs.length ? cliContractDirs : p.contractDirs);
  const apply = flags.apply === true;
  const registryPath = flags.registry && flags.registry !== true ? path.resolve(String(flags.registry)) : undefined;
  const cmds = require('./commands.cjs');
  const { readRegistry } = require('../core/resolveProject.cjs');
  const registry = readRegistry(registryPath);
  const entries = registry.projects || {};

  // ①读注册表项目项,容错跳过坏项
  const projects = [];
  const skipped = [];
  const wanted = all ? Object.keys(entries) : projectIds;
  for (const id of wanted) {
    const e = entries[id];
    if (!e || typeof e !== 'object' || typeof e.mainRepo !== 'string' || !e.mainRepo) {
      if (all) { skipped.push(id); continue; }
      throw new Error(`未注册的项目 "${id}"（或登记项缺 mainRepo）`);
    }
    const mainRepo = path.resolve(e.mainRepo);
    const codeRepo = e.codeRepo ? path.resolve(e.codeRepo) : mainRepo;
    projects.push({
      id, name: e.name || id, mainRepo, codeRepo, repo: codeRepo,
      board: e.board ? path.resolve(e.board) : path.join(mainRepo, '.dashboard', 'board.json'),
      cloud: !!(e.cloud && e.cloud.enabled),
      exempt: Array.isArray(e.reconcileExempt) ? e.reconcileExempt.filter((x) => typeof x === 'string') : [],
      contractDirs: Array.isArray(e.reconcileContractDirs) ? e.reconcileContractDirs.filter((x) => typeof x === 'string' && x) : [],
      queueCommand: Array.isArray(e.reconcileQueueCommand) && e.reconcileQueueCommand.length > 0
        && e.reconcileQueueCommand.every((x) => typeof x === 'string' && x.trim()) ? e.reconcileQueueCommand : null,
    });
  }

  // ⑥派单器的单:同一目录只扫一遍
  let jobsDirs = asArray(flags['jobs-dir']).map((d) => path.resolve(d));
  if (!jobsDirs.length) {
    jobsDirs = projects.map((p) => path.join(p.mainRepo, '.codex', 'jobs')).filter((d) => fs.existsSync(d));
  }
  const allJobs = [];
  for (const d of [...new Set(jobsDirs.map(normPath))].map((n) => jobsDirs.find((d) => normPath(d) === n))) {
    allJobs.push(...readJobsDir(d));
  }

  const result = [];
  const lines = [];
  const applied = { notes: 0, parks: 0, skippedDuplicate: 0 };
  const errors = [];
  let totalFindings = 0;
  for (const id of skipped) lines.push(`⚠ 注册表里 ${id} 登记项不完整,已跳过`);

  for (const p of projects) {
    const board = readBoard(p.board);
    if (!board || !Array.isArray(board.tasks)) { lines.push(`⚠ ${p.name}(${p.id}):看板读不出来,已跳过`); continue; }
    const notes = [];
    const { branches, prs } = gitInfo(p, runFile, now, flags.fetch === true, notes);
    const taskIds = new Set(board.tasks.map((t) => t.id));
    const own = allJobs.filter((j) => taskIds.has(j.taskId) && jobBelongs(j, p));
    const have = new Set(allJobs.map((j) => j.slug));
    const jobsOfProject = new Set([path.join(p.mainRepo, '.codex', 'jobs'), ...jobsDirs].map(normPath));
    const extra = readContractDirs(contractRels(p), p.mainRepo, [...jobsOfProject], have)
      .filter((j) => taskIds.has(j.taskId))
      .filter((j) => {
        const m = j.meta || {};
        return (m.repoRoot || (m.boardAwaitCollect && m.boardAwaitCollect.projectId)) ? jobBelongs(j, p) : true;
      });
    const jobs = [...own, ...extra].map(({ meta, dir, ...j }) => j);
    const exempt = new Set([...asArray(flags.exempt), ...p.exempt]);
    const scanInput = { projectId: p.id, board, now, staleDays, collectHours, exempt, prs, branches, jobs };
    let scan = scanProject(scanInput);
    if (p.queueCommand && scan.findings.some((f) => f.kind === 'STALE_IN_PROGRESS')) {
      const queue = readWaitingPrereq(p, runFile);
      if (queue.available) scan = scanProject({ ...scanInput, waitingPrereq: queue.waiting });
      else notes.push(`${queue.reason},「施工中多日没动静」按原规则判`);
    }
    totalFindings += scan.findings.length;
    result.push({
      id: p.id, name: p.name, activeCount: scan.activeCount, prAvailable: prs.available,
      branchAvailable: branches.available, cloudReadOnly: p.cloud, findings: scan.findings, waitingPrereq: scan.waiting,
    });

    lines.push(`${p.name}(${p.id}):在办 ${scan.activeCount} 张,对不上 ${scan.findings.length} 张`);
    if (p.cloud) lines.push('  云项目只读:不写看板,只输出。');
    for (const n of notes) lines.push('  ' + n);
    for (const [kind, label] of Object.entries(KINDS)) {
      const group = scan.findings.filter((f) => f.kind === kind);
      if (!group.length) continue;
      lines.push(`  【${label}】${group.length} 条`);
      for (const f of group) lines.push(`    ${f.taskId} ${f.plainTitle} —— ${f.detail}`);
    }
    if (scan.waiting.length) {
      lines.push(`  【等前置,不挂暂缓】${scan.waiting.length} 条`);
      for (const w of scan.waiting) lines.push(`    ${w.taskId} ${w.plainTitle} —— ${w.detail}`);
    }

    if (!apply || p.cloud) continue;
    const base = { project: p.id, registry: registryPath };
    for (const f of scan.findings) {
      try {
        const fresh = readBoard(p.board) || board;
        const tag = `〔RC:${f.key}〕`;
        const text = `【对账】${KINDS[f.kind]}:${f.detail}${tag}`;
        let last = null;
        for (const a of fresh.activity || []) {
          if (a.taskId === f.taskId && a.author === 'reconcile' && String(a.text || '').includes(tag)) last = a;
        }
        const lastTs = last ? Date.parse(last.ts) : NaN;
        const dup = last && String(last.text) === text && !(now - lastTs >= renoteDays * DAY);
        if (dup) applied.skippedDuplicate++;
        else {
          cmds.note({ ...base, _: [f.taskId], author: 'reconcile', text });
          applied.notes++;
        }
        if (f.kind === 'STALE_IN_PROGRESS') {
          const cur = (readBoard(p.board) || fresh).tasks.find((t) => t.id === f.taskId);
          if (cur && cur.status === '施工中') {
            cmds.park({ ...base, _: [f.taskId], author: 'reconcile',
              reason: `【对账】${staleDays} 天没有动静:没有开着的 PR、在跑的单,登记的分支也没有新提交。复工请 unpark。` });
            applied.parks++;
          }
        }
      } catch (e) {
        errors.push(`${f.taskId} ${f.kind}: ${e.message}`);
      }
    }
  }

  if (totalFindings === 0 && result.length) lines.push('全部对得上');
  if (apply) lines.push(`已写留言 ${applied.notes} 条,转暂缓 ${applied.parks} 张,重复跳过 ${applied.skippedDuplicate} 条`);
  for (const e of errors) lines.push('⚠ 写入失败 ' + e);
  return { ok: true, text: lines.join('\n'), projects: result, applied };
}

module.exports = { reconcile };
