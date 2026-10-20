'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { emptyBoard } = require('../core/boardSchema.cjs');
const { resolveProject } = require('../core/resolveProject.cjs');
const { mutate, readBoard } = require('../cli/store.cjs');
const { readOutbox, OUTBOX_VERSION, getOpContext } = require('../core/syncOutbox.cjs');
const { runCliOperation } = require('../core/syncReplay.cjs');
const INDEX = path.resolve(__dirname, '../cli/index.cjs');
const env = { ...process.env, CLAUDE_CODE_SESSION_ID: '' };
const pending = { question: '采用哪个方案？', options: ['甲', '乙'], recommended: '甲',
  background: '说明本次选择的场景与问题以及影响。'.repeat(6),
  optionPros: { 甲: '好处是保持已有流程，代价是需要维护。'.repeat(2), 乙: '好处是引入新流程，代价是需要迁移。'.repeat(2) },
  recommendReason: '现有流程能够满足要求并减少迁移风险。'.repeat(3) };

function fixture(t, cloud = { enabled: true, remoteProjectId: 'remote' }) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-outbox-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(dir, 'board'); fs.mkdirSync(root);
  const board = path.join(root, 'board.json'), reg = path.join(dir, 'registry.json');
  const initial = JSON.stringify(emptyBoard({ id: 't', name: 'test', mainRepo: root }), null, 2) + '\n';
  fs.writeFileSync(board, initial);
  const register = value => fs.writeFileSync(reg, JSON.stringify({ projects: { t: {
    name: 'test', mainRepo: root, board, ...(value === undefined ? {} : { cloud: value }),
  } } }));
  register(cloud);
  const clock = path.join(dir, 'clock.cjs');
  fs.writeFileSync(clock, `const RealDate=Date;global.Date=class extends RealDate{constructor(...a){super(...(a.length?a:['2026-10-19T12:00:00Z']));}};`);
  const f = { dir, root, board, reg, initial, register, clock };
  f.proj = () => resolveProject('t', { registryPath: reg });
  f.ops = () => readOutbox(f.proj());
  f.cli = (args, opts = {}) => spawnSync(process.execPath, ['--require', clock, INDEX, ...args,
    '--project', 't', '--registry', reg], { cwd: dir, env, encoding: 'utf8', windowsHide: true, timeout: 30000, ...opts });
  f.ok = args => { const r = f.cli(args); assert.equal(r.status, 0, r.stderr || r.error?.message); return r; };
  f.seed = () => f.ok(['add', 'T1', '--title', 'test', '--plain-title', '测试任务', '--model', 'test']);
  return f;
}
function flow(f) {
  const file = path.join(f.dir, 'pending.json'); fs.writeFileSync(file, JSON.stringify(pending));
  return [
    ['add', 'T1', '--title', 'test', '--plain-title', '测试任务', '--model', 'test'],
    ['claim', 'T1', '--builder', '派单器', '--branch', 'feature'],
    ['progress', 'T1', '--percent', '40', '--next', '接着干'],
    ['note', 'T1', '--text', '保留留言'], ['pending', 'T1', '--json-file', file],
    ['decide', 'T1', '--did', 'd1', '--answer', '甲'],
    ['cost', 'T1', '--agents', 'test:1', '--tokens', '100'], ['done', 'T1'],
  ];
}

test('① disabled/absent cloud: identical stdout, stderr, exit and board bytes; no sync directory', t => {
  const f = fixture(t, { enabled: false, remoteProjectId: 'remote' });
  const commands = flow(f);
  const execute = () => commands.map(args => {
    const r = f.ok(args);
    assert.equal(fs.existsSync(path.join(f.dir, 'sync')), false);
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, board: fs.readFileSync(f.board, 'utf8') };
  });
  const disabled = execute();
  fs.writeFileSync(f.board, f.initial); f.register(undefined);
  assert.deepEqual(execute(), disabled);
  f.register({ enabled: 'true', remoteProjectId: 'remote' });
  assert.equal(f.proj().cloud, null);
});

test('② enabled: one op per CLI command, exact fields, inline input and contiguous sequence', t => {
  const f = fixture(t);
  const commands = flow(f);
  const brief = path.join(f.dir, 'brief.txt'); fs.writeFileSync(brief, ' 收单说明\n');
  commands.splice(4, 0, ['collect-brief', 'T1', '--file', brief]);
  for (const [i, args] of commands.entries()) { f.ok(args); assert.equal(f.ops().length, i + 1); }
  const rows = f.ops();
  assert.equal(OUTBOX_VERSION, 1);
  assert.deepEqual(rows.map(r => r.seq), rows.map((_, i) => i + 1));
  assert.deepEqual(rows.map(r => r.command), commands.map(a => a[0]));
  assert.equal(new Set(rows.map(r => r.opId)).size, rows.length);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['v','kind','opId','seq','project','remoteProjectId','command','flags','files','author','clientTs','device'].sort());
    assert.equal(row.kind, 'op'); assert.equal(row.v, 1);
    assert.equal(row.project, 't'); assert.equal(row.remoteProjectId, 'remote');
    assert.equal(row.device, os.hostname()); assert.ok(Number.isFinite(Date.parse(row.clientTs)));
    assert.match(row.opId, /^[0-9a-f-]{36}$/);
    assert.ok(Array.isArray(row.flags._));
    for (const key of ['registry', 'json', 'help', 'project']) assert.equal(Object.hasOwn(row.flags, key), false);
  }
  assert.equal(rows.find(r => r.command === 'pending').files['json-file'], JSON.stringify(pending));
  assert.equal(rows.find(r => r.command === 'collect-brief').files.file, ' 收单说明\n');
  assert.equal(rows.find(r => r.command === 'claim').flags.author, 'feature');
  assert.equal(f.proj().syncDir, path.join(f.dir, 'sync', 't'));
  assert.deepEqual(f.proj().cloud, { enabled: true, remoteProjectId: 'remote' });
});

test('③ batch add records one operation and embeds original JSON, including BOM', t => {
  const f = fixture(t);
  const file = path.join(f.dir, 'batch.json');
  const raw = '\ufeff' + JSON.stringify(['T1', 'T2'].map(id => ({ id, title: id, plainTitle: '批量任务', model: 'test' })));
  fs.writeFileSync(file, raw);
  f.ok(['add', '--json-file', file, '--json']);
  assert.equal(readBoard(f.board).tasks.length, 2);
  assert.equal(f.ops().length, 1); assert.equal(f.ops()[0].files['json-file'], raw);
});

test('④ gate and parameter/schema failures do not create operations or modify board', t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.board, 'utf8');
  for (const args of [ ['add', 'T1', '--title', 'x'],
    ['add', 'T1', '--title', 'x', '--model', 'test'],
    ['add', 'T1', '--title', 'x', '--model', 'test', '--plain-title', 'x', '--status', 'INVALID'] ]) {
    assert.equal(f.cli(args).status, 1);
    assert.equal(fs.readFileSync(f.board, 'utf8'), before);
    assert.deepEqual(f.ops(), []);
  }
  f.seed();
  const seeded = fs.readFileSync(f.board, 'utf8');
  for (const args of [['done', 'T1'], ['progress', 'T1', '--percent', '999'], ['claim', 'T1'],
    ['pending', 'T1', '--json-file', path.join(f.dir, 'missing.json')]]) {
    assert.equal(f.cli(args).status, 1);
    assert.equal(f.ops().length, 1);
    assert.equal(fs.readFileSync(f.board, 'utf8'), seeded);
  }
});

test('⑤ two concurrent processes each write 20 CLI notes: seq order equals activity order', async t => {
  const f = fixture(t, null); f.seed(); f.register({ enabled: true, remoteProjectId: 'remote' });
  const worker = `const {spawnSync}=require('node:child_process');
    for(let i=0;i<20;i++){const r=spawnSync(process.execPath,[process.env.INDEX,'note','T1','--text',process.env.PREFIX+i,'--project','t','--registry',process.env.REG],{encoding:'utf8',windowsHide:true,timeout:30000});if(r.status!==0){process.stderr.write(r.stderr||String(r.error));process.exit(1);}}`;
  const run = prefix => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', worker], { cwd: f.dir,
      env: { ...env, INDEX, REG: f.reg, PREFIX: prefix }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  await Promise.all([run('left-'), run('right-')]);
  const rows = f.ops(); assert.equal(rows.length, 40);
  assert.deepEqual(rows.map(r => r.seq), Array.from({ length: 40 }, (_, i) => i + 1));
  assert.equal(new Set(rows.map(r => r.opId)).size, 40);
  assert.deepEqual(rows.map(r => r.flags.text), readBoard(f.board).activity.filter(a => a.kind === 'message').map(a => a.text));
});

test('⑥ actual git scan creates additive patch-ai-meta only; repeated scan creates nothing', t => {
  const f = fixture(t, null); f.seed();
  const git = args => execFileSync('git', ['-C', f.root, '-c', 'core.hooksPath=' + path.join(f.dir, 'no-hooks'), ...args], { windowsHide: true, encoding: 'utf8' });
  git(['init', '-q']); git(['config', 'user.email', 'test@example.invalid']); git(['config', 'user.name', 'test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['commit', '--allow-empty', '-q', '-m', 'feat(T1): change (#77)']);
  f.register({ enabled: true, remoteProjectId: 'remote' });
  f.ok(['sync-from-git', '--branch', 'feature']);
  const rows = f.ops(); assert.equal(rows.length, 1);
  assert.equal(rows[0].command, 'patch-ai-meta'); assert.equal(rows[0].kind, 'op');
  assert.match(rows[0].opId, /^[0-9a-f-]{36}:1$/);
  assert.deepEqual(rows[0].flags, { taskId: 'T1', add: { commitShas: readBoard(f.board).tasks[0].commitShas, prNumbers: [77], gitBranch: ['feature'] },
    remove: { commitShas: [], prNumbers: [], gitBranch: [] } });
  f.ok(['sync-from-git', '--branch', 'feature']); assert.equal(f.ops().length, 1);
});

test('patch metadata and semantic changes separate; patch suffix increases within a command', t => {
  const f = fixture(t, null); f.seed(); f.register({ enabled: true, remoteProjectId: 'remote' });
  runCliOperation('backfill', { project: 't', registry: f.reg }, () => {
    mutate(f.proj(), b => { b.tasks[0].gitBranch.push('one'); });
    mutate(f.proj(), b => { b.tasks[0].prNumbers.push(12); b.tasks[0].percent = 30; });
  });
  const rows = f.ops(); assert.deepEqual(rows.map(r => r.kind), ['op', 'op', 'untracked']);
  assert.equal(rows[1].opId, rows[0].opId.replace(/:1$/, ':2'));
  assert.deepEqual(rows[2].taskIds, ['T1']); assert.equal(rows[2].source, 'backfill');
  assert.equal(getOpContext(), null);
});

test('⑦ direct in-process store mutation records changed task IDs, not an executable op', t => {
  const f = fixture(t, null); f.seed(); f.register({ enabled: true, remoteProjectId: 'remote' });
  mutate(f.proj(), b => { b.tasks[0].title = 'direct update'; });
  const rows = f.ops(); assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['v','kind','seq','project','remoteProjectId','clientTs','device','taskIds','source'].sort());
  assert.equal(rows[0].kind, 'untracked'); assert.deepEqual(rows[0].taskIds, ['T1']);
  mutate(f.proj(), () => {}); assert.equal(f.ops().length, 1);
});

test('⑧ real non-writable queue directory fails command, preserves board, next success uses seq 1', t => {
  const f = fixture(t, null); f.seed(); f.register({ enabled: true, remoteProjectId: 'remote' });
  const dir = f.proj().syncDir; fs.mkdirSync(dir, { recursive: true });
  const before = fs.readFileSync(f.board, 'utf8');
  // 队列文件位置先占一个同名目录,追加必然失败(EISDIR/EPERM 等)。不用 ACL/chmod:
  // 管理员或特权令牌下「禁止写」不一定生效,10-20 在主机上实测因此假红。
  const blocker = path.join(dir, 'outbox.jsonl');
  fs.mkdirSync(blocker);
  try {
    const r = f.cli(['note', 'T1', '--text', 'must fail']);
    assert.equal(r.status, 1, r.stderr || r.error?.message);
    assert.match(r.stderr, /EISDIR|EACCES|EPERM|permission|拒绝/i);
    assert.equal(fs.readFileSync(f.board, 'utf8'), before);
  } finally { fs.rmSync(blocker, { recursive: true, force: true }); }
  assert.deepEqual(f.ops(), []);
  f.ok(['note', 'T1', '--text', 'after repair']); assert.equal(f.ops()[0].seq, 1);
});

test('a command with multiple mutations records once; non-replay nested writes keep their source', t => {
  const f = fixture(t, null); f.seed(); f.register({ enabled: true, remoteProjectId: 'remote' });
  runCliOperation('edit', { project: 't', registry: f.reg, _: ['T1'], title: 'one' }, () => {
    mutate(f.proj(), b => { b.tasks[0].title = 'one'; });
    mutate(f.proj(), b => { b.tasks[0].title = 'two'; });
  });
  assert.equal(f.ops().length, 1); assert.equal(getOpContext(), null);
  assert.throws(() => runCliOperation('edit', { project: 't', registry: f.reg }, () => { throw new Error('reject'); }), /reject/);
  assert.equal(getOpContext(), null);
  runCliOperation('archive-activity', {}, () => {
    assert.equal(getOpContext(), null);
    mutate(f.proj(), b => { b.tasks[0].title = 'nested'; });
  });
  assert.equal(f.ops().length, 2);
  assert.equal(f.ops()[1].kind, 'untracked');
  assert.equal(f.ops()[1].source, 'archive-activity');
  assert.throws(() => runCliOperation('docs-audit', {}, () => { throw new Error('failed audit'); }), /failed audit/);
  mutate(f.proj(), b => { b.tasks[0].title = 'direct'; });
  assert.equal(f.ops()[2].source, 'unknown', 'source must be cleared on both success and error');
});

test('review 1: stale/missing counter recovers from durable JSONL tail; torn JSON is discarded', t => {
  const f = fixture(t); f.seed();
  f.ok(['note', 'T1', '--text', 'durable record']);
  const counter = path.join(f.proj().syncDir, 'outbox.seq');
  const log = path.join(f.proj().syncDir, 'outbox.jsonl');
  fs.writeFileSync(counter, '1\n');
  f.ok(['note', 'T1', '--text', 'after counter rollback']);
  assert.deepEqual(f.ops().map(r => r.seq), [1, 2, 3]);
  fs.unlinkSync(counter);
  f.ok(['note', 'T1', '--text', 'after missing counter']);
  assert.deepEqual(f.ops().map(r => r.seq), [1, 2, 3, 4]);
  const prefix = fs.readFileSync(log);
  fs.appendFileSync(log, '{"v":1,"seq":5,"flags":{"text":"半截记录');
  fs.writeFileSync(counter, '2\n');
  f.ok(['note', 'T1', '--text', 'after torn tail']);
  assert.deepEqual(f.ops().map(r => r.seq), [1, 2, 3, 4, 5]);
  assert.equal(f.ops().at(-1).flags.text, 'after torn tail');
  assert.deepEqual(fs.readFileSync(log).subarray(0, prefix.length), prefix);
  assert.equal(fs.readFileSync(counter, 'utf8'), '5\n');
});

test('review 1: long UTF-8 tail without newline survives; first torn record and ahead counter recover', t => {
  const f = fixture(t); f.seed();
  // Larger than one tail chunk and with multibyte characters across boundaries.
  f.ok(['note', 'T1', '--text', '多字节尾记录'.repeat(1000)]);
  const counter = path.join(f.proj().syncDir, 'outbox.seq');
  const log = path.join(f.proj().syncDir, 'outbox.jsonl');
  const saved = f.ops();
  fs.truncateSync(log, fs.statSync(log).size - 1);
  fs.unlinkSync(counter);
  f.ok(['note', 'T1', '--text', 'append after complete unterminated row']);
  assert.deepEqual(f.ops().slice(0, 2), saved);
  assert.deepEqual(f.ops().map(r => r.seq), [1, 2, 3]);
  fs.writeFileSync(counter, '8\n');
  f.ok(['note', 'T1', '--text', 'respect higher counter']);
  assert.equal(f.ops().at(-1).seq, 9);

  const empty = fixture(t, null); empty.seed(); empty.register({ enabled: true, remoteProjectId: 'remote' });
  fs.mkdirSync(empty.proj().syncDir, { recursive: true });
  fs.writeFileSync(path.join(empty.proj().syncDir, 'outbox.jsonl'), '{"seq":1,');
  empty.ok(['note', 'T1', '--text', 'first complete record']);
  assert.deepEqual(empty.ops().map(r => r.seq), [1]);
});

test('review 1: malformed newline-terminated record is rejected, never erased as a torn tail', t => {
  const f = fixture(t); f.seed();
  const log = path.join(f.proj().syncDir, 'outbox.jsonl');
  fs.appendFileSync(log, '{"broken":\n');
  const beforeLog = fs.readFileSync(log), beforeBoard = fs.readFileSync(f.board);
  const r = f.cli(['note', 'T1', '--text', 'must fail']);
  assert.equal(r.status, 1);
  assert.deepEqual(fs.readFileSync(log), beforeLog);
  assert.deepEqual(fs.readFileSync(f.board), beforeBoard);
});

test('review 3: actual docs-audit --create-card records an untracked write with source', t => {
  const f = fixture(t);
  const plans = path.join(f.root, 'docs', 'plans'); fs.mkdirSync(plans, { recursive: true });
  fs.writeFileSync(path.join(plans, 'untagged.md'), '# A document missing its required status tag\n');
  f.ok(['docs-audit', '--create-card']);
  const rows = f.ops();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'untracked');
  assert.equal(rows[0].source, 'docs-audit');
  const cards = readBoard(f.board).tasks;
  assert.equal(cards.length, 1); assert.match(cards[0].id, /^DOCS-AUDIT-\d{6}$/);
  assert.deepEqual(rows[0].taskIds, [cards[0].id]);
  for (const key of ['command', 'flags', 'opId', 'files']) assert.equal(Object.hasOwn(rows[0], key), false);
});

test('review 5: pending without task ID exits with original error while stdin pipe stays open', async t => {
  const f = fixture(t);
  // Establish the exact existing command error, without entering its stdin reader.
  let expected;
  try { require('../cli/commands.cjs').pending({ project: 't', registry: f.reg, _: [], json: true }); }
  catch (e) { expected = '✖ ' + e.message; }
  assert.match(expected, /缺参数/);
  const before = fs.readFileSync(f.board);
  const child = spawn(process.execPath, [INDEX, 'pending', '--json', '--project', 't', '--registry', f.reg],
    { cwd: f.dir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const started = Date.now();
  const result = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
    // Deliberately do not call child.stdin.end().
  });
  assert.equal(result.code, 1, stderr);
  assert.equal(result.signal, null);
  assert.ok(Date.now() - started < 5000, 'must finish before the five-second timeout');
  assert.equal(stderr.trimEnd(), expected);
  assert.deepEqual(fs.readFileSync(f.board), before);
  assert.deepEqual(f.ops(), []);
});
