'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const cmds = require('../cli/commands.cjs');
const { emptyBoard } = require('../core/boardSchema.cjs');
const { readBoard } = require('../cli/store.cjs');
const { resolveProject } = require('../core/resolveProject.cjs');
const { readOutbox, getOpContext, setOpContext, clearOpContext } = require('../core/syncOutbox.cjs');
const { applyOp, REPLAY_COMMANDS, entryGateRefusal } = require('../core/syncReplay.cjs');
const { REGISTRY, slimJson } = require('../cli/index.cjs');
const INDEX = path.resolve(__dirname, '../cli/index.cjs');

// Explicit timestamp-only ignore list. No blanket '*At', 'date', or arbitrary
// field stripping; all task/decision/dependency/cost/activity data stays compared.
const IGNORED_TIME_FIELDS = new Set(['ts', 'updatedAt', 'lastProgressAt', 'decidedAt', 'landedAt',
  'infoRequestedAt', 'since', 'finishedAt', 'unclaimedAt', 'unparkedAt', 'cancelledAt', 'reopenedAt']);
const IGNORED_DATE_PATHS = new Set(['dates.design', 'dates.start', 'dates.done', 'cost.entries.*.date']);
function comparable(value, at = '') {
  if (Array.isArray(value)) return value.map(v => comparable(v, at ? at + '.*' : ''));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !IGNORED_TIME_FIELDS.has(k)
    && !IGNORED_DATE_PATHS.has(at ? at + '.' + k : k)).map(([k, v]) => [k, comparable(v, at ? at + '.' + k : k)]));
}
const payload = { question: '用哪条路？', options: ['甲', '乙'], recommended: '甲',
  background: '场景是保存操作并在另一个看板原样执行，需要比较两种选择的实际差异。'.repeat(3),
  optionPros: { 甲: '好处是使用已有规则，代价是需要保留输入。'.repeat(2), 乙: '好处是重新定义规则，代价是增加维护成本。'.repeat(2) },
  recommendReason: '沿用原有规则能够减少两边不一致的问题。'.repeat(3), allowCustom: false };

function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-replay-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const sides = {};
  for (const side of ['a', 'b']) {
    const root = path.join(dir, side); fs.mkdirSync(root);
    const reg = path.join(root, 'registry.json'), board = path.join(root, 'board.json');
    fs.writeFileSync(board, JSON.stringify(emptyBoard({ id: 't', name: 'test', mainRepo: root })));
    const register = cloud => fs.writeFileSync(reg, JSON.stringify({ projects: { t: { mainRepo: root, board,
      ...(cloud ? { cloud: { enabled: true, remoteProjectId: 'remote' } } : {}) } } }));
    register(false);
    sides[side] = { root, reg, board, register, P: { project: 't', registry: reg },
      proj: () => resolveProject('t', { registryPath: reg }) };
  }
  const f = { dir, ...sides };
  f.seed = (id = 'T1', extra = {}) => cmds.add({ ...f.a.P, _: [id], title: 'task', ...extra });
  f.ready = () => {
    fs.copyFileSync(f.a.board, f.b.board); f.a.register(true); f.b.register(true);
  };
  f.cli = (args, options = {}) => cp.spawnSync(process.execPath, [INDEX, ...args, '--project', 't', '--registry', f.a.reg],
    { cwd: dir, env: { ...process.env, CLAUDE_CODE_SESSION_ID: '' }, windowsHide: true, encoding: 'utf8', timeout: 30000, ...options });
  f.execute = (args, options) => { const r = f.cli(args, options); assert.equal(r.status, 0, r.stderr || r.error?.message); return r; };
  f.replay = op => applyOp(op, { registryPath: f.b.reg, projectId: 't' });
  f.equal = () => {
    const a = readBoard(f.a.board), b = readBoard(f.b.board);
    assert.deepEqual(a.tasks.map(v => comparable(v)), b.tasks.map(v => comparable(v)));
    assert.deepEqual(a.activity.map(v => comparable(v)), b.activity.map(v => comparable(v)));
    assert.equal(fs.existsSync(f.b.proj().syncDir), false, 'replay must not create a queue even when B enables cloud');
  };
  return f;
}
const addPending = f => cmds.pending({ ...f.a.P, _: ['T1'], q: payload.question, opt: payload.options,
  rec: payload.recommended, background: payload.background, 'pros-甲': payload.optionPros.甲,
  'pros-乙': payload.optionPros.乙, reason: payload.recommendReason, strict: true });
const decide = f => cmds.decide({ ...f.a.P, _: ['T1'], did: 'd1', answer: '甲' });
const claim = f => cmds.claim({ ...f.a.P, _: ['T1'], branch: 'feature', builder: '派单器' });
const cases = {
  add: { args: ['add', 'NEW', '--title', 'new', '--plain-title', '新任务', '--model', 'test'] },
  claim: { args: ['claim', 'T1', '--builder', '派单器'] },
  unclaim: { setup: claim, args: ['unclaim', 'T1', '--reason', '释放工位'] },
  progress: { args: ['progress', 'T1', '--percent', '35', '--next', '测试', '--tests', '5/4/1', '--typecheck'] },
  'await-collect': { setup: claim, args: ['await-collect', 'T1', '--job', 'job-one', '--engine', 'test'] },
  'collect-brief': { args: ['collect-brief', 'T1'], fileFlag: 'file', content: ' 完整收单说明\n' },
  pending: { args: ['pending', 'T1'], fileFlag: 'json-file', content: '\ufeff' + JSON.stringify(payload) },
  decide: { setup: addPending, args: ['decide', 'T1', '--did', 'd1', '--answer', '甲'] },
  undecide: { setup: f => { addPending(f); decide(f); }, args: ['undecide', 'T1', '--did', 'd1', '--reason', '重新考虑'] },
  park: { args: ['park', 'T1', '--reason', '等上游', '--note', '保留说明'] },
  unpark: { setup: f => cmds.park({ ...f.a.P, _: ['T1'], reason: '等上游' }), args: ['unpark', 'T1', '--reason', '上游已完成'] },
  block: { args: ['block', 'T1', '--by', 'T2', '--reason', '上游依赖'] },
  unblock: { setup: f => cmds.block({ ...f.a.P, _: ['T1'], by: 'T2', reason: '上游' }), args: ['unblock', 'T1', '--reason', '上游已完成'] },
  done: { setup: f => { addPending(f); decide(f); cmds.cost({ ...f.a.P, _: ['T1'], agents: 'test:1', tokens: '10' }); },
    args: ['done', 'T1', '--commit', 'abcdef123456', '--pr', '42'] },
  cancel: { args: ['cancel', 'T1', '--reason', '需求撤回'] },
  reopen: { setup: f => cmds.cancel({ ...f.a.P, _: ['T1'], reason: '暂时取消' }), args: ['reopen', 'T1', '--reason', '恢复需求'] },
  note: { args: ['note', 'T1', '--text', '保留这句话', '--from', 'human'] },
  'request-info': { setup: addPending, args: ['request-info', 'T1', '--did', 'd1', '--missing', 'background,optionPros'] },
  edit: { args: ['edit', 'T1', '--title', 'changed', '--plain-title', '改后的任务', '--desc', '补充说明', '--model', 'test', '--wave', '2'] },
  'mark-landed': { setup: f => { addPending(f); decide(f); }, args: ['mark-landed', 'T1', '--all', '--commit', 'abcdef1'] },
  cost: { args: ['cost', 'T1', '--agents', 'test:2', '--tokens', '500', '--credits', '10', '--credit-unit', '积分', '--note', '本次用量'] },
};
// Actor-dependent assign/unassign defer assignee changes to authenticated replay;
// their source/destination differences are covered by cloudCliAssign/cloudCliUnassign.
test('the equivalence matrix plus actor-dependent commands covers every declared replay command except set', () => {
  assert.deepEqual([...Object.keys(cases), 'assign', 'unassign'].sort(), REPLAY_COMMANDS.filter(c => c !== 'set').sort());
});
for (const [command, spec] of Object.entries(cases)) {
  test(`replay ${command}: real source CLI, independent destination, deleted input and all affected cards/activity equal`, t => {
    const f = fixture(t); f.seed(); f.seed('T2'); if (spec.setup) spec.setup(f); f.ready();
    const args = [...spec.args];
    const file = path.join(f.dir, 'original-input.txt');
    if (spec.fileFlag) { fs.writeFileSync(file, spec.content); args.push('--' + spec.fileFlag, file); }
    f.execute(args);
    const rows = readOutbox(f.a.proj()); assert.equal(rows.length, 1); assert.equal(rows[0].command, command);
    if (spec.fileFlag) fs.unlinkSync(file);
    const result = f.replay(rows[0]); assert.equal(result.ok, true);
    if (command !== 'note') assert.deepEqual(Object.keys(result.result).sort(), ['ok', 'id', 'status', 'percent', 'changed'].sort());
    f.equal(); assert.equal(getOpContext(), null);
    if (command === 'claim') assert.deepEqual(readBoard(f.b.board).tasks[0].gitBranch, []);
  });
}

test('unclaim captures an actual current git branch; replay from a non-git cwd does not query git', t => {
  const f = fixture(t); f.seed(); claim(f); f.ready();
  const repo = path.join(f.dir, 'git'); fs.mkdirSync(repo);
  const git = args => cp.execFileSync('git', ['-C', repo, ...args], { windowsHide: true, stdio: 'pipe' });
  git(['init', '-q']); git(['symbolic-ref', 'HEAD', 'refs/heads/feature']);
  git(['config', 'user.email', 'test@example.invalid']); git(['config', 'user.name', 'test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['-c', 'core.hooksPath=' + path.join(f.dir, 'no-hooks'), 'commit', '--allow-empty', '-q', '-m', 'initial']);
  f.execute(['unclaim', 'T1', '--reason', '释放'], { cwd: repo });
  const op = readOutbox(f.a.proj())[0]; assert.deepEqual(op.flags.branch, ['feature']);
  const original = cp.execFileSync;
  cp.execFileSync = () => { throw new Error('replay attempted a subprocess'); };
  try { f.replay(op); } finally { cp.execFileSync = original; }
  assert.deepEqual(readBoard(f.b.board).tasks[0].gitBranch, []); f.equal();
});

for (const command of ['add', 'pending']) {
  test(`${command} stdin is embedded and replays without stdin; batch dependencies preserved`, t => {
    const f = fixture(t); f.seed(); f.ready();
    const raw = command === 'pending' ? JSON.stringify(payload) : JSON.stringify([
      { id: 'NEW1', title: 'one', plainTitle: '第一张', model: 'test' },
      { id: 'NEW2', title: 'two', plainTitle: '第二张', model: 'test', deps: { dependsOn: ['NEW1'] } },
    ]);
    f.execute(command === 'pending' ? ['pending', 'T1', '--json'] : ['add', '--json'], { input: raw });
    const op = readOutbox(f.a.proj())[0]; assert.equal(op.files.stdin, raw);
    assert.equal(Object.hasOwn(op.flags, 'json'), false); f.replay(op); f.equal();
  });
}

test('applyOp shares exact gate refusals for missing model/plain title and uncosted done', t => {
  const f = fixture(t); f.seed(); f.ready();
  for (const [command, flags] of [['add', { _: ['NEW'], title: 'x' }],
    ['add', { _: ['NEW'], title: 'x', model: 'test' }], ['done', { _: ['T1'] }]]) {
    const message = entryGateRefusal(command, { ...flags, ...f.b.P });
    assert.ok(message);
    const before = fs.readFileSync(f.b.board, 'utf8');
    assert.throws(() => f.replay({ kind: 'op', command, flags, files: {} }), e => e.status === 400 && e.message === message);
    assert.equal(fs.readFileSync(f.b.board, 'utf8'), before);
    const argv = [command, ...(flags._ || []), '--title', 'x'];
    if (flags.model) argv.push('--model', flags.model);
    assert.equal(f.cli(argv).stderr.trimEnd(), '✖ ' + message);
  }
  assert.equal(fs.existsSync(f.b.proj().syncDir), false);
});

test('unknown/excluded commands 403; untracked 400; missing project/card 404; state conflict 409', t => {
  const f = fixture(t); f.seed(); f.ready();
  for (const command of ['unknown', 'release', 'sync-from-git', 'doctor', 'import']) {
    assert.throws(() => f.replay({ kind: 'op', command, flags: {}, files: {} }), e => e.status === 403);
  }
  assert.throws(() => f.replay({ kind: 'untracked' }), e => e.status === 400);
  assert.throws(() => applyOp({ kind: 'op', command: 'note', flags: {}, files: {} }, { registryPath: f.b.reg, projectId: 'absent' }), e => e.status === 404);
  assert.throws(() => f.replay({ kind: 'op', command: 'edit', flags: { _: ['MISSING'], title: 'x' }, files: {} }), e => e.status === 404);
  assert.throws(() => f.replay({ kind: 'op', command: 'unclaim', flags: { _: ['T1'], reason: 'x' }, files: {} }), e => e.status === 409);
});

test('patch-ai-meta unions SHAs and deduplicates other arrays in order; rejects extra keys and missing task', t => {
  const f = fixture(t); f.seed(); f.ready();
  const op = add => ({ kind: 'op', command: 'patch-ai-meta', flags: { taskId: 'T1', add,
    remove: { commitShas: [], prNumbers: [], gitBranch: [] } }, files: {} });
  const add = { commitShas: ['abcdef1', 'abcdef123456', 'bbbbbbb'], prNumbers: [42, 42, 7], gitBranch: ['feature', 'feature', 'next'] };
  f.replay(op(add)); f.replay(op(add));
  const task = readBoard(f.b.board).tasks[0];
  assert.deepEqual(task.commitShas, ['abcdef123456', 'bbbbbbb']);
  assert.deepEqual(task.prNumbers, [42, 7]); assert.deepEqual(task.gitBranch, ['feature', 'next']);
  for (const invalid of [{ ...op(add), flags: { ...op(add).flags, percent: 100 } }, op({ ...add, status: ['已完工'] }),
    op({ ...add, gitBranch: 'feature' })]) assert.throws(() => f.replay(invalid), e => e.status === 400);
  const missing = op(add); missing.flags.taskId = 'MISSING';
  assert.throws(() => f.replay(missing), e => e.status === 404);
  assert.equal(fs.existsSync(f.b.proj().syncDir), false);
});

test('review 2: actual doctor branch cleanup emits removals and replay removes the same branch', t => {
  const f = fixture(t); f.seed(); f.seed('T2');
  const git = args => cp.execFileSync('git', ['-C', f.a.root, '-c', 'core.hooksPath=' + path.join(f.dir, 'no-hooks'), ...args],
    { windowsHide: true, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'master']);
  git(['config', 'user.email', 'test@example.invalid']); git(['config', 'user.name', 'test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['commit', '--allow-empty', '-q', '-m', 'initial']);
  git(['checkout', '-q', '-b', 'old-feature']);
  git(['commit', '--allow-empty', '-q', '-m', 'feat(T2): only T2 owns this change']);
  git(['checkout', '-q', 'master']);
  git(['merge', '--no-ff', '-m', "Merge branch 'old-feature'", 'old-feature']);
  git(['branch', '-D', 'old-feature']);
  // T1 received a stale broadcast entry, not an explicit claim (which doctor
  // correctly treats as authoritative). T2 is the actual owner of the branch.
  cmds.set({ ...f.a.P, _: ['T1'], field: 'gitBranch', value: JSON.stringify(['old-feature']) });
  cmds.claim({ ...f.a.P, _: ['T2'], builder: '派单器', branch: 'old-feature' });
  f.ready();
  f.execute(['doctor', '--branches', '--fix']);
  const rows = readOutbox(f.a.proj());
  const removal = rows.find(row => row.command === 'patch-ai-meta' && row.flags.taskId === 'T1' && row.flags.remove.gitBranch.length);
  assert.ok(removal, JSON.stringify(rows));
  assert.deepEqual(removal.flags.remove, { commitShas: [], prNumbers: [], gitBranch: ['old-feature'] });
  assert.deepEqual(removal.flags.add, { commitShas: [], prNumbers: [], gitBranch: [] });
  for (const row of rows) {
    assert.equal(row.kind, 'op'); assert.equal(row.command, 'patch-ai-meta');
    f.replay(row);
  }
  const a = readBoard(f.a.board).tasks, b = readBoard(f.b.board).tasks;
  assert.deepEqual(a.find(task => task.id === 'T1').gitBranch, []);
  assert.deepEqual(b.map(task => comparable(task)), a.map(task => comparable(task)));
  assert.equal(fs.existsSync(f.b.proj().syncDir), false);
});

test('review 2: removes all metadata types before union, retains re-added entries, validates both maps', t => {
  const f = fixture(t); f.seed();
  cmds.done({ ...f.a.P, _: ['T1'], pr: ['10', '20'], commit: ['abcdef1', 'bbbbbbb'] });
  f.ready();
  const add = { commitShas: ['abcdef123456'], prNumbers: [10, 30], gitBranch: ['new'] };
  const remove = { commitShas: ['abcdef1', 'bbbbbbb'], prNumbers: [10, 20], gitBranch: [] };
  const op = { kind: 'op', command: 'patch-ai-meta', flags: { taskId: 'T1', add, remove }, files: {} };
  f.replay(op);
  const task = readBoard(f.b.board).tasks[0];
  assert.deepEqual(task.commitShas, ['abcdef123456']);
  assert.deepEqual(task.prNumbers, [10, 30]); assert.deepEqual(task.gitBranch, ['new']);
  const before = fs.readFileSync(f.b.board);
  for (const invalid of [
    { ...op.flags, remove: { ...remove, status: [] } },
    { ...op.flags, remove: { ...remove, gitBranch: 'new' } },
    { taskId: 'T1', add }, { ...op.flags, add: { ...add, percent: [] } },
    { ...op.flags, replace: {} },
  ]) {
    assert.throws(() => f.replay({ ...op, flags: invalid }), e => e.status === 400);
    assert.deepEqual(fs.readFileSync(f.b.board), before);
  }
});

test('review 4: explicit replay author overrides both human and arbitrary note from values', t => {
  const f = fixture(t); f.seed(); f.ready();
  for (const from of ['human', '冒充署名']) {
    f.execute(['note', 'T1', '--text', 'review author', '--from', from]);
    const op = readOutbox(f.a.proj()).at(-1);
    assert.equal(op.flags.from, from);
    applyOp(op, { registryPath: f.b.reg, projectId: 't', author: '云端负责人' });
    assert.equal(readBoard(f.b.board).activity.at(-1).author, '云端负责人');
    assert.equal(op.flags.from, from, 'replay must not mutate the supplied operation');
  }
  assert.equal(fs.existsSync(f.b.proj().syncDir), false);
});

test('replay never reads original files or cwd, never spawns, overrides author and does not bind local sessions', t => {
  const f = fixture(t); f.seed(); f.ready();
  // Warm the same command modules before installing IO spies (module source is not input data).
  for (const [modulePath] of Object.values(REGISTRY)) { if (fs.existsSync(path.resolve(__dirname, '../cli', modulePath))) require(path.resolve(__dirname, '../cli', modulePath)); }
  const originals = { cwd: process.cwd, read: fs.readFileSync, session: process.env.CLAUDE_CODE_SESSION_ID };
  const subprocess = new Map(['execFileSync','execSync','spawn','spawnSync','execFile','fork'].map(k => [k, cp[k]]));
  const root = f.b.root;
  const reads = [];
  process.cwd = () => { throw new Error('cwd consulted'); };
  process.env.CLAUDE_CODE_SESSION_ID = '12345678-1234-1234-1234-123456789abc';
  fs.readFileSync = function(file, ...args) {
    const resolved = typeof file === 'string' ? file : '';
    reads.push(resolved);
    assert.ok(resolved === f.b.reg || resolved === f.b.board || resolved === f.b.board + '.lock', `unexpected local read: ${resolved}`);
    return originals.read.call(this, file, ...args);
  };
  for (const key of subprocess.keys()) cp[key] = () => { throw new Error('subprocess attempted'); };
  try {
    applyOp({ kind: 'op', command: 'claim', flags: { _: ['T1'], builder: '派单器', author: 'old' }, files: {} },
      { registryPath: f.b.reg, projectId: 't', author: 'cloud-owner' });
    applyOp({ kind: 'op', command: 'unclaim', flags: { _: ['T1'], branch: [], reason: 'release' }, files: {} },
      { registryPath: f.b.reg, projectId: 't' });
  } finally {
    process.cwd = originals.cwd; fs.readFileSync = originals.read;
    for (const [key, fn] of subprocess) cp[key] = fn;
    if (originals.session === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = originals.session;
  }
  assert.ok(reads.includes(f.b.board));
  assert.equal(readBoard(f.b.board).activity.find(a => a.type === 'claim').author, 'cloud-owner');
  assert.deepEqual(fs.readdirSync(root).sort(), ['board.json', 'registry.json']);
});

test('file paths without embedded contents are rejected, temp input removed even after errors', t => {
  const f = fixture(t); f.seed(); f.ready();
  const original = path.join(f.dir, 'original.json'); fs.writeFileSync(original, JSON.stringify(payload));
  assert.throws(() => f.replay({ kind: 'op', command: 'pending', flags: { _: ['T1'], 'json-file': original }, files: {} }), e => e.status === 400);
  const mkdtemp = fs.mkdtempSync; let created;
  fs.mkdtempSync = (...args) => { created = mkdtemp(...args); return created; };
  try {
    assert.throws(() => f.replay({ kind: 'op', command: 'pending', flags: { _: ['T1'] }, files: { 'json-file': 'invalid json' } }), e => e.status === 400);
  } finally { fs.mkdtempSync = mkdtemp; }
  assert.ok(created); assert.equal(fs.existsSync(created), false);
  assert.equal(fs.existsSync(f.b.proj().syncDir), false);
});

test('replay does not inherit or replace an existing local op context', t => {
  const f = fixture(t); f.seed(); f.ready();
  const ctx = { command: 'edit', flags: {}, files: {}, opId: 'local', author: 'local', clientTs: new Date().toISOString(), device: 'test' };
  setOpContext(ctx);
  try {
    const result = f.replay({ kind: 'op', command: 'edit', flags: { _: ['T1'], title: 'changed' }, files: {} });
    assert.equal(result.ok, true); assert.equal(getOpContext(), ctx);
    assert.deepEqual(result.result, slimJson({ ok: true, task: readBoard(f.b.board).tasks[0], changed: result.result.changed }));
    assert.equal(fs.existsSync(f.b.proj().syncDir), false);
  } finally { clearOpContext(); }
});
