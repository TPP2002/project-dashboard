'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cmds = require('../cli/commands.cjs');
const { reconcile } = require('../cli/reconcile.cjs');
const { KINDS } = require('../core/reconcileScan.cjs');

const H = 3600000;
const iso = (agoMs) => new Date(Date.now() - agoMs).toISOString();
const readBoard = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(v)); };

/** 假的 gh/git:按 cmd 与 args 返回预设输出。 */
function fakeRun(opts = {}) {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'gh') {
      if (opts.ghMissing) return { status: -1, stdout: '' };
      const state = args[args.indexOf('--state') + 1];
      return { status: 0, stdout: JSON.stringify(state === 'open' ? opts.open || [] : opts.merged || []) };
    }
    const sub = args.slice(2);
    switch (sub[0]) {
      case 'symbolic-ref': return { status: 0, stdout: 'origin/main\n' };
      case 'remote': return { status: 0, stdout: 'https://github.com/owner/repo.git\n' };
      case 'for-each-ref': return { status: 0, stdout: (opts.remote || []).map(([b, t]) => `origin/${b}\t${t}`).join('\n') + '\n' };
      case 'merge-base': return { status: 1, stdout: '' };
      default: return { status: 0, stdout: '' };
    }
  };
  fn.calls = calls;
  return fn;
}

function setup(t, extraProjects = []) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const make = (id) => {
    const repo = path.join(dir, id); fs.mkdirSync(repo);
    cmds.register({ id, name: id, root: repo, registry: reg });
    return { id, repo, board: path.join(repo, '.dashboard', 'board.json'), P: { project: id, registry: reg } };
  };
  const main = make('myproj');
  const others = extraProjects.map(make);
  return { dir, reg, main, others };
}

/** 建一批覆盖六类的卡与工单。 */
function seed(f) {
  const { P, repo, board } = f.main;
  for (const id of ['ST1', 'LD1', 'CL1', 'JB1', 'JB2', 'JB3']) cmds.add({ ...P, _: [id], title: id, 'plain-title': '卡 ' + id });
  const b = readBoard(board);
  b.activity = [];
  const set = (id, patch) => Object.assign(b.tasks.find((x) => x.id === id), patch);
  set('ST1', { status: '施工中', lastProgressAt: iso(10 * 24 * H) });
  set('LD1', { status: '收官', lastProgressAt: iso(H), prNumbers: [11] });
  set('CL1', { status: '暂缓', lastProgressAt: iso(H) });
  set('JB1', { status: '待收单', lastProgressAt: iso(H) });
  set('JB2', { status: '收官', lastProgressAt: iso(H) });
  set('JB3', { status: '施工中', lastProgressAt: iso(H) });
  writeJson(board, b);
  const jobs = path.join(repo, '.codex', 'jobs');
  const mk = (slug, taskId, branch, files) => {
    writeJson(path.join(jobs, slug, 'meta.json'), { taskId, slug, worktreeBranch: branch, boardAwaitCollect: { projectId: 'myproj' } });
    for (const [name, v] of Object.entries(files)) writeJson(path.join(jobs, slug, name), v);
    fs.mkdirSync(path.join(repo, '.codex', 'worktrees', slug), { recursive: true });
  };
  mk('slug-a', 'JB1', 'codex/jb1', { 'state.json': { pid: 1, startedAt: iso(20 * H), finishedAt: iso(10 * H), exitCode: 0 } });
  mk('slug-b', 'JB2', 'codex/jb2', { 'land.json': { landedAt: iso(2 * H), branch: 'codex/jb2', pushed: true } });
  mk('slug-c', 'JB3', 'codex/jb3', {
    'state.json': { pid: 2, startedAt: iso(20 * H), finishedAt: iso(10 * H) }, 'verdict.json': { finalStatus: 'blocked' },
  });
  return fakeRun({
    merged: [{ number: 11, title: 'LD1: done', headRefName: 'codex/ld1', mergedAt: iso(H) }],
    open: [{ number: 12, title: 'CL1: still open', headRefName: 'codex/cl1', updatedAt: iso(H) }],
    remote: [['codex/jb2', iso(H)], ['main', iso(H)]],
  });
}

const run = (f, runFile, extra = {}) => reconcile({ project: 'myproj', registry: f.reg, ...extra }, { runFile });
const FOUND = ['ST1', 'LD1', 'CL1', 'JB1', 'JB2', 'JB3'];

test('C1 不带 --apply 只读:板文件字节不变,输出含各类标题', (t) => {
  const f = setup(t); const rf = seed(f);
  const before = fs.readFileSync(f.main.board);
  const res = run(f, rf);
  assert.deepEqual(fs.readFileSync(f.main.board), before);
  for (const label of Object.values(KINDS)) assert.ok(res.text.includes(label), label);
  assert.match(res.text, /myproj\(myproj\):在办 \d+ 张,对不上 6 张/);
  assert.deepEqual(res.projects[0].findings.map((x) => x.taskId).sort(), [...FOUND].sort());
  assert.ok(rf.calls.every((c) => c[0] === 'git' || (c[0] === 'gh' && c[1] === 'pr' && c[2] === 'list')), '只读 gh');
});

test('C2 --apply:命中卡各多一条对账留言,只有 STALE 转暂缓', (t) => {
  const f = setup(t); const rf = seed(f);
  const before = Object.fromEntries(readBoard(f.main.board).tasks.map((x) => [x.id, x.status]));
  const res = run(f, rf, { apply: true });
  const b = readBoard(f.main.board);
  for (const id of FOUND) {
    const mine = b.activity.filter((a) => a.taskId === id && a.author === 'reconcile' && a.text.includes('〔RC:'));
    assert.equal(mine.length, 1, id);
    assert.ok(mine[0].text.startsWith('【对账】'));
  }
  for (const x of b.tasks) assert.equal(x.status, x.id === 'ST1' ? '暂缓' : before[x.id], x.id);
  assert.equal(res.applied.notes, 6); assert.equal(res.applied.parks, 1);
});

test('C3 紧接着再跑 --apply:不新增留言,重复被跳过', (t) => {
  const f = setup(t); const rf = seed(f);
  run(f, rf, { apply: true });
  const n1 = readBoard(f.main.board).activity.length;
  const res = run(f, rf, { apply: true });
  assert.equal(readBoard(f.main.board).activity.length, n1);
  assert.equal(res.applied.notes, 0);
  assert.ok(res.applied.skippedDuplicate > 0);
});

test('C4 云项目只读:--apply 板文件字节不变', (t) => {
  const f = setup(t); const rf = seed(f);
  const reg = JSON.parse(fs.readFileSync(f.reg, 'utf8'));
  reg.projects.myproj.cloud = { enabled: true, remoteProjectId: 'r1' };
  fs.writeFileSync(f.reg, JSON.stringify(reg));
  const before = fs.readFileSync(f.main.board);
  const res = run(f, rf, { apply: true });
  assert.deepEqual(fs.readFileSync(f.main.board), before);
  assert.ok(res.text.includes('云项目只读'));
  assert.equal(res.projects[0].cloudReadOnly, true);
  assert.equal(res.applied.notes, 0);
});

test('C5 --all 遍历两个项目,json 字段齐全', (t) => {
  const f = setup(t, ['proj2']); const rf = seed(f);
  const res = reconcile({ all: true, json: true, registry: f.reg }, { runFile: rf });
  assert.equal(res.ok, true);
  assert.equal(res.projects.length, 2);
  for (const p of res.projects) {
    for (const k of ['id', 'name', 'activeCount', 'prAvailable', 'branchAvailable', 'cloudReadOnly', 'findings']) assert.ok(k in p, k);
    assert.ok(Array.isArray(p.findings));
  }
  assert.deepEqual(Object.keys(res.applied).sort(), ['notes', 'parks', 'skippedDuplicate']);
  const second = res.projects.find((p) => p.id === 'proj2');
  assert.equal(second.findings.length, 0);
});

test('C6 gh 不存在:不抛,prAvailable=false,依赖 PR 数据的三类不判', (t) => {
  const f = setup(t);
  seed(f);
  const missing = fakeRun({ ghMissing: true, remote: [['codex/jb2', iso(H)]] });
  const res = run(f, missing);
  const p = res.projects[0];
  assert.equal(p.prAvailable, false);
  const kinds = p.findings.map((x) => x.kind);
  for (const k of ['ALL_LANDED', 'LANDED_NO_PR', 'CLOSED_WITH_OPEN_PR']) assert.ok(!kinds.includes(k), k);
  assert.ok(kinds.includes('AWAIT_COLLECT'));
  assert.ok(missing.calls.some((c) => c[0] === 'gh'));
});

const rcNotes = (f, id) => readBoard(f.main.board).activity
  .filter((a) => a.taskId === id && a.author === 'reconcile' && a.text.includes('〔RC:'));

test('C8 同一发现连跑两次 --apply:第二次 skippedDuplicate 为 1、留言数不变', (t) => {
  const f = setup(t); const rf = seed(f);
  run(f, rf, { apply: true });
  const before = rcNotes(f, 'LD1').length;
  const res = run(f, rf, { apply: true, exempt: ['ST1', 'CL1', 'JB1', 'JB2', 'JB3'] });
  assert.equal(res.applied.skippedDuplicate, 1);
  assert.equal(res.applied.notes, 0);
  assert.equal(rcNotes(f, 'LD1').length, before);
});

test('C9 发现的 detail 变了再跑:写第二条', (t) => {
  const f = setup(t); const rf = seed(f);
  run(f, rf, { apply: true });
  const b = readBoard(f.main.board);
  // 发现里的「最后一次动静」只显示到月-日:挪 3 天保证跨日,否则同一天里跑这条会因 detail 没变而红
  b.tasks.find((x) => x.id === 'LD1').lastProgressAt = iso(3 * 24 * H);
  writeJson(f.main.board, b);
  const res = run(f, rf, { apply: true, exempt: ['ST1', 'CL1', 'JB1', 'JB2', 'JB3'] });
  assert.equal(res.applied.notes, 1);
  const notes = rcNotes(f, 'LD1');
  assert.equal(notes.length, 2);
  assert.notEqual(notes[0].text, notes[1].text);
});

test('C10 第一条留言 ts 改成 8 天前、全文相同再跑:写第二条', (t) => {
  const f = setup(t); const rf = seed(f);
  run(f, rf, { apply: true });
  const b = readBoard(f.main.board);
  for (const a of b.activity) if (a.author === 'reconcile') a.ts = iso(8 * 24 * H);
  writeJson(f.main.board, b);
  const res = run(f, rf, { apply: true, exempt: ['ST1', 'CL1', 'JB1', 'JB2', 'JB3'] });
  assert.equal(res.applied.notes, 1);
  assert.equal(rcNotes(f, 'LD1').length, 2);
});

function contractSetup(t) {
  const f = setup(t);
  const { P, repo, board } = f.main;
  cmds.add({ ...P, _: ['X1'], title: 'X1', 'plain-title': '卡 X1' });
  const b = readBoard(board);
  Object.assign(b.tasks.find((x) => x.id === 'X1'), { status: '收官', lastProgressAt: iso(H), prNumbers: [21] });
  writeJson(board, b);
  const rf = fakeRun({ merged: [{ number: 21, title: 'X1: done', headRefName: 'codex/x1', mergedAt: iso(H) }] });
  const contract = path.join(repo, 'docs', 'plans', 'x1-task-contract.json');
  writeJson(contract, { taskId: 'X1', slug: 'x1-slug' });
  const setDirs = (dirs) => {
    const reg = JSON.parse(fs.readFileSync(f.reg, 'utf8'));
    reg.projects.myproj.reconcileContractDirs = dirs;
    fs.writeFileSync(f.reg, JSON.stringify(reg));
  };
  const hasLanded = (res) => res.projects[0].findings.some((x) => x.kind === 'ALL_LANDED' && x.taskId === 'X1');
  return { f, rf, contract, setDirs, hasLanded };
}

test('C11 登记了契约目录:没派的契约让卡不报 ALL_LANDED;删掉契约再跑就报', (t) => {
  const { f, rf, contract, setDirs, hasLanded } = contractSetup(t);
  assert.equal(hasLanded(run(f, rf)), true, '没登记目录时照旧报');
  setDirs(['docs/plans']);
  assert.equal(hasLanded(run(f, rf)), false);
  fs.rmSync(contract);
  assert.equal(hasLanded(run(f, rf)), true);
});

test('C12 --contracts-dir 给了时覆盖注册表字段', (t) => {
  const { f, rf, setDirs, hasLanded } = contractSetup(t);
  setDirs(['docs/plans']);
  assert.equal(hasLanded(run(f, rf, { 'contracts-dir': 'docs/nowhere' })), true, '覆盖成不存在的目录');
  setDirs(['docs/nowhere']);
  assert.equal(hasLanded(run(f, rf, { 'contracts-dir': ['docs/plans'] })), false, '覆盖成有契约的目录');
});

test('C7 源码里每处 execFileSync / spawnSync 调用都带 windowsHide: true', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'cli', 'reconcile.cjs'), 'utf8');
  const re = /(execFileSync|spawnSync)\(/g;
  let m; let count = 0;
  while ((m = re.exec(src))) {
    count++;
    assert.ok(src.slice(m.index, m.index + 400).includes('windowsHide: true'), `第 ${count} 处缺 windowsHide`);
  }
  assert.ok(count >= 1);
});
