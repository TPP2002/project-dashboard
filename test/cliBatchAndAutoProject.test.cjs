'use strict';
/**
 * cliBatchAndAutoProject.test.cjs —— AUD-CLI-BATCH-AND-AUTOPROJECT(审计 A8/A11)。
 *
 * 要钉死的行为:
 *   ① 批量建卡 `add --json-file` / `add --json`:一次加锁一次写盘,逐项走与单卡相同的校验
 *      (含 --model / --plain-title 两道机器闸),【任一项不合格 = 整批一张都不建】,
 *      且错误一次报全(不是遇到第一个就退)——这是"批量"跟"循环调单卡"的唯一区别,必须有测试守着;
 *   ② `pending --json-file`:PowerShell 下 stdin heredoc 不便,改从文件读;两条路都要剥 UTF-8 BOM
 *      (PowerShell 的 `>` / Out-File 默认写 BOM,JSON.parse 见 BOM 直接抛);
 *   ③ `--project` 可省略:按 cwd 的 git 仓反查,worktree 认到主仓、codeRepo 也算命中,
 *      一个仓登记给多个项目时【报歧义而不是靠 registry 插入顺序猜】;
 *   ⑤ `set` 对有专门命令的字段打印提示(只提示不拦)。
 *
 * ④ 的短别名垫片在 release.test.cjs(那边有现成的 git 仓夹具)。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const cmds = require('../cli/commands.cjs');
const { detectProjectIds } = require('../core/resolveProject.cjs');

const CLI = path.join(__dirname, '..', 'cli', 'index.cjs');

function setup(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'batch-')));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } });
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const root = path.join(dir, 'repo'); fs.mkdirSync(root);
  cmds.register({ id: 't', name: '演示', root, registry: reg });
  return { dir, root, reg, P: { project: 't', registry: reg } };
}
const readBoard = (env) => JSON.parse(fs.readFileSync(path.join(env.root, '.dashboard', 'board.json'), 'utf8'));
function writeJson(p, obj, { bom = false } = {}) {
  fs.writeFileSync(p, (bom ? '﻿' : '') + JSON.stringify(obj, null, 2), 'utf8');
  return p;
}
const card = (id, over = {}) => ({ id, title: `技术说明 ${id}`, plainTitle: `人话标题 ${id}`, model: 'opus·中', ...over });

/**
 * 跑真正的 CLI 入口(要验的正是入口那两道机器闸怎么放行批量、以及 set 往 stderr 打的提示)。
 * 用 spawnSync 而不是 execFileSync:后者成功时只交出 stdout,拿不到"成功但有提示"的 stderr。
 */
function runCli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', windowsHide: true, input: opts.input || '', cwd: opts.cwd,
  });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

// ---------------- ① 批量建卡 ----------------

test('批量建卡:一份清单一次建完,每项字段与单卡 add 一致,每张卡各留一条流水', (t) => {
  const env = setup(t);
  const file = writeJson(path.join(env.dir, 'cards.json'), [
    card('T-A', { scope: ['cli/a.cjs', 'core/a.cjs'], wave: 2, desc: '一句话' }),
    card('T-B', { model: 'sonnet·低', deps: { dependsOn: ['T-A'] }, status: '待开工' }),
  ]);
  const res = cmds.addBatch({ 'json-file': file, ...env.P });
  assert.equal(res.count, 2);
  assert.deepEqual(res.ids, ['T-A', 'T-B']);

  const b = readBoard(env);
  const a = b.tasks.find((x) => x.id === 'T-A');
  assert.equal(a.title, '技术说明 T-A');
  assert.equal(a.plainTitle, '人话标题 T-A');
  assert.equal(a.modelHint, 'opus·中');
  assert.deepEqual(a.fileScope, ['cli/a.cjs', 'core/a.cjs']);
  assert.equal(a.wave, 2);
  assert.equal(a.description, '一句话');
  assert.equal(a.status, '未开工');
  assert.equal(a.percent, 0);
  const bb = b.tasks.find((x) => x.id === 'T-B');
  assert.equal(bb.status, '待开工');
  assert.deepEqual(bb.deps, { dependsOn: ['T-A'], blockedBy: [], relatedTasks: [] });
  assert.equal(bb.wave, 0, '没给 wave 就留 0,不许继承别人的波次');

  // 每张卡在活动流里都查得到自己(批量不该让某张卡"查无此人"),外加一条批次汇总
  for (const id of ['T-A', 'T-B']) {
    assert.ok(b.activity.some((e) => e.taskId === id && /新建任务/.test(e.text)), `${id} 缺自己的建卡流水`);
  }
  assert.ok(b.activity.some((e) => e.taskId === null && /批量建卡 2 张/.test(e.text)), '缺批次汇总流水');
});

test('批量原子性:任一项不合格 → 一张都不建,且错误一次报全', (t) => {
  const env = setup(t);
  cmds.add({ _: ['T-OLD'], title: '已有的卡', ...env.P });
  const before = JSON.stringify(readBoard(env));

  const file = writeJson(path.join(env.dir, 'bad.json'), [
    card('T-OK'),                                   // 这张本身没问题,但整批被拒时它也不许落盘
    card('T-NOPLAIN', { plainTitle: '' }),          // 缺人话标题(= --plain-title 机器闸)
    card('T-NOMODEL', { model: '' }),               // 缺建议档位(= --model 机器闸)
    card('T-OLD'),                                  // 卡号已在板上
  ]);
  assert.throws(() => cmds.addBatch({ 'json-file': file, ...env.P }), (e) => {
    // 一次报全:四类问题都要出现在同一条错误里,而不是"改一个报一个"来回四轮
    assert.match(e.message, /整批拒绝/);
    assert.match(e.message, /T-NOPLAIN.*plainTitle/s);
    assert.match(e.message, /T-NOMODEL.*model/s);
    assert.match(e.message, /T-OLD.*已在板上/s);
    return true;
  });
  assert.equal(JSON.stringify(readBoard(env)), before, '整批拒绝后 board.json 必须一个字节都没动');
});

test('批量建卡:批内重号、依赖指向不存在的卡、不认识的字段都当场拒', (t) => {
  const env = setup(t);
  const dup = writeJson(path.join(env.dir, 'dup.json'), [card('T-X'), card('T-X')]);
  assert.throws(() => cmds.addBatch({ 'json-file': dup, ...env.P }), /卡号跟第 1 项重了/);

  const badDep = writeJson(path.join(env.dir, 'dep.json'), [card('T-Y', { deps: { dependsOn: ['查无此卡'] } })]);
  assert.throws(() => cmds.addBatch({ 'json-file': badDep, ...env.P }), /指向不存在的卡/);

  // 键名拼错必须报出来,不许静默吞掉——CLI-ADD-NO-PLAINTITLE-FILESCOPE 就是这么来的
  const typo = writeJson(path.join(env.dir, 'typo.json'), [{ id: 'T-Z', title: 'x', plaintitle: '拼错了', model: 'opus·中' }]);
  assert.throws(() => cmds.addBatch({ 'json-file': typo, ...env.P }), /不认识的字段「plaintitle」/);

  assert.equal(readBoard(env).tasks.length, 0, '三次拒绝之后板上仍应一张卡都没有');
});

test('批量建卡:同批内互相依赖算数(A 依赖同批的 B),依赖不必先建好', (t) => {
  const env = setup(t);
  const file = writeJson(path.join(env.dir, 'chain.json'), [
    card('T-1', { deps: { dependsOn: ['T-2'] } }),
    card('T-2'),
  ]);
  assert.equal(cmds.addBatch({ 'json-file': file, ...env.P }).count, 2);
});

test('批量建卡:--json-file 剥 UTF-8 BOM(PowerShell 默认就写 BOM)', (t) => {
  const env = setup(t);
  const file = writeJson(path.join(env.dir, 'bom.json'), [card('T-BOM')], { bom: true });
  assert.equal(cmds.addBatch({ 'json-file': file, ...env.P }).count, 1);
});

test('批量建卡:{"tasks":[…]} 包装形态也认;空数组/不是数组 → 明确报错', (t) => {
  const env = setup(t);
  const wrapped = writeJson(path.join(env.dir, 'w.json'), { tasks: [card('T-W')] });
  assert.equal(cmds.addBatch({ 'json-file': wrapped, ...env.P }).count, 1);
  assert.throws(() => cmds.addBatch({ 'json-file': writeJson(path.join(env.dir, 'e.json'), []), ...env.P }), /空数组/);
  assert.throws(() => cmds.addBatch({ 'json-file': writeJson(path.join(env.dir, 'o.json'), { a: 1 }), ...env.P }), /应是【数组】/);
  assert.throws(() => cmds.addBatch({ 'json-file': path.join(env.dir, '不存在.json'), ...env.P }), /读不到/);
});

test('isBatchAdd:只有"给了 --json-file"或"给了 --json 且没写卡号"才算批量', () => {
  assert.equal(cmds.isBatchAdd({ 'json-file': 'x.json', _: [] }), true);
  assert.equal(cmds.isBatchAdd({ json: true, _: [] }), true);
  // --json 还兼着全局"输出 JSON"开关:老写法 `add T1 … --json` 必须仍按单卡走,不许把卡号丢了
  assert.equal(cmds.isBatchAdd({ json: true, _: ['T1'] }), false);
  assert.equal(cmds.isBatchAdd({ _: ['T1'] }), false);
  assert.equal(cmds.isBatchAdd({ 'json-file': true, _: [] }), false, '--json-file 后面漏写路径不算批量,该走报错');
});

test('CLI 入口:批量绕开两道单卡机器闸(闸门改成逐项判),单卡建卡照旧被拦', (t) => {
  const env = setup(t);
  const file = writeJson(path.join(env.dir, 'cards.json'), [card('T-CLI')]);

  const ok = runCli(['add', '--json-file', file, '--project', 't', '--registry', env.reg]);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /批量建卡 1 张/);

  // stdin 形态(POSIX shell 的等价写法)
  const viaStdin = runCli(['add', '--json', '--project', 't', '--registry', env.reg], { input: JSON.stringify([card('T-STDIN')]) });
  assert.equal(viaStdin.code, 0, viaStdin.err);

  // 单卡仍必须带 --model / --plain-title
  const bare = runCli(['add', 'T-BARE', '--title', 'x', '--project', 't', '--registry', env.reg]);
  assert.equal(bare.code, 1);
  assert.match(bare.err, /建卡必须带 --model/);

  assert.deepEqual(readBoard(env).tasks.map((x) => x.id), ['T-CLI', 'T-STDIN']);
});

// ---------------- ② pending --json-file ----------------

const PENDING_PAYLOAD = {
  question: '这个要拍什么板?',
  options: ['选项A', '选项B'],
  recommended: '选项A',
  background: '【场景】这是单元测试用的背景描述文字需要够长才能通过校验器所以我在这里多写一些占位内容以确保。【问题】占位以通过字数下限。【要做的事】占位。【为什么重要】占位。',
  optionPros: { 选项A: '【好处】A 的好处描述。【代价】A 的代价描述在这里。', 选项B: '【好处】B 的好处描述。【代价】B 的代价描述在这里。' },
  recommendReason: '推荐 A 的理由描述需要写得足够长才能通过校验器所以我在这里多写一些内容占位。',
};

test('pending --json-file:从文件读整块 JSON(带 BOM 也认),三件套照常硬校验', (t) => {
  const env = setup(t);
  cmds.add({ _: ['T-P'], title: 'x', ...env.P });
  const file = writeJson(path.join(env.dir, 'pending.json'), PENDING_PAYLOAD, { bom: true });
  const res = cmds.pending({ _: ['T-P'], 'json-file': file, ...env.P });
  assert.equal(res.task.status, '待拍板');
  assert.equal(res.task.decisions[0].question, '这个要拍什么板?');
  assert.equal(res.task.decisions[0].allowCustom, true);

  const bad = writeJson(path.join(env.dir, 'bad.json'), { ...PENDING_PAYLOAD, background: '太短' });
  assert.throws(() => cmds.pending({ _: ['T-P'], 'json-file': bad, ...env.P }), /background 太短/);
});

// ---------------- ③ --project 可省略 / 歧义判定 ----------------

function gitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-C', dir, 'init', '-q'], { windowsHide: true, stdio: 'ignore' });
  return fs.realpathSync.native(dir);
}

test('detectProjectIds:认得主仓、子目录与 worktree;mainRepo 与 codeRepo 都算命中', (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'detect-')));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } });
  const repo = gitRepo(path.join(dir, 'repo'));
  const boardHome = path.join(dir, 'board-home'); fs.mkdirSync(boardHome);
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ projects: {
    // 板自成一家、代码住在 repo 里(cluster 那种形状):只比 mainRepo 会漏掉它
    cluster: { name: 'c', mainRepo: boardHome, codeRepo: repo, board: path.join(boardHome, 'board.json') },
  } }));
  assert.deepEqual(detectProjectIds({ registryPath: reg, cwd: repo }), ['cluster']);

  const sub = path.join(repo, 'a', 'b'); fs.mkdirSync(sub, { recursive: true });
  assert.deepEqual(detectProjectIds({ registryPath: reg, cwd: sub }), ['cluster'], '子目录里也要认得(git 给的是相对路径)');

  // worktree:--git-common-dir 指向主仓的 .git,故并行工位认到同一项目
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t.t'], { windowsHide: true, stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't'], { windowsHide: true, stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'], { windowsHide: true, stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { windowsHide: true, stdio: 'ignore' });
  const wt = path.join(dir, 'wt');
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt], { windowsHide: true, stdio: 'ignore' });
  assert.deepEqual(detectProjectIds({ registryPath: reg, cwd: fs.realpathSync.native(wt) }), ['cluster']);

  assert.deepEqual(detectProjectIds({ registryPath: reg, cwd: dir }), [], '不在登记仓里 = 认不出来,返回空');
});

test('detectProjectIds:一个仓登记给两个项目 → 全都返回(交给调用方报歧义,不靠插入顺序决胜)', (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'detect2-')));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } });
  const repo = gitRepo(path.join(dir, 'repo'));
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ projects: {
    one: { mainRepo: repo, board: path.join(dir, 'b1.json') },
    two: { mainRepo: path.join(dir, 'elsewhere'), codeRepo: repo, board: path.join(dir, 'b2.json') },
  } }));
  assert.deepEqual(detectProjectIds({ registryPath: reg, cwd: repo }), ['one', 'two']);
});

test('CLI 入口:仓里跑可省略 --project;同仓多项目 → 报歧义并退出 1,绝不替人猜', (t) => {
  const env = setup(t);
  gitRepo(env.root);
  cmds.add({ _: ['T-AUTO'], title: '自动认项目', ...env.P });

  const ok = runCli(['list', '--registry', env.reg], { cwd: env.root });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /T-AUTO/);

  const sub = path.join(env.root, 'deep', 'er'); fs.mkdirSync(sub, { recursive: true });
  assert.match(runCli(['list', '--registry', env.reg], { cwd: sub }).out, /T-AUTO/);

  // 同一个仓再登记一个项目 → 歧义
  cmds.register({ id: 't2', name: '第二个板', root: env.root, board: path.join(env.dir, 'b2.json'), registry: env.reg });
  const amb = runCli(['list', '--registry', env.reg], { cwd: env.root });
  assert.equal(amb.code, 1);
  assert.match(amb.err, /歧义|同时登记给/);
  assert.match(amb.err, /t、t2/);

  // 显式指定仍照旧
  assert.equal(runCli(['list', '--project', 't', '--registry', env.reg], { cwd: env.root }).code, 0);
});

test('CLI 入口:不吃 --project 的命令(claim-check 等)不做反查,省掉每次 commit 的 git 子进程', (t) => {
  const env = setup(t);
  gitRepo(env.root);
  // claim-check 扫全部已注册项目;它若被自动填了 --project 也不该改变行为,这里验的是"不报缺 --project"
  const r = runCli(['claim-check', '--branch', 'master', '--registry', env.reg], { cwd: env.root });
  assert.notEqual(r.code, 1, `claim-check 不该因 --project 报错: ${r.err}`);
});

// ---------------- ⑤ set 提示 ----------------

test('set:字段有专门命令就提示(只提示不拦),没有就不吵;提示里的命令必须真的存在', (t) => {
  const env = setup(t);
  cmds.add({ _: ['T-S'], title: 'x', ...env.P });

  const hit = runCli(['set', 'T-S', '--field', 'status', '--value', '"施工中"', '--project', 't', '--registry', env.reg]);
  assert.equal(hit.code, 0, hit.err);
  assert.match(hit.err, /status 有专门命令/);
  assert.match(hit.err, /claim <id> --branch/);
  assert.match(hit.err, /done <id> --pr/);
  // 本条要守的是【不许指一条不存在的命令】。表里写死了 edit/cancel/reopen/unclaim,
  // 它们随 AUD-CLI-LIFECYCLE-CMDS 落地才存在——所以不钉"有哪几条",钉"凡是提示里出现的都真的有"。
  const named = [...hit.err.matchAll(/^ {4}([a-z-]+) </gm)].map((m) => m[1]);
  assert.ok(named.length >= 4, `提示里应列出多条命令,实际: ${named.join(',')}`);
  for (const c of named) {
    assert.equal(typeof cmds[c === 'mark-landed' ? 'markLanded' : c], 'function', `提示指了一条不存在的命令: ${c}`);
  }
  assert.ok(named.includes('cancel'), '生命周期命令一落地,提示该自动带上它们(这张表不用改)');
  assert.equal(readBoard(env).tasks[0].status, '施工中', 'set 只提示,值照写');

  const quiet = runCli(['set', 'T-S', '--field', 'docs', '--value', '["docs/x.md"]', '--project', 't', '--registry', env.reg]);
  assert.equal(quiet.code, 0, quiet.err);
  assert.doesNotMatch(quiet.err, /有专门命令/);

  // 点路径按第一段回退:deps.blockedBy → deps 没登记,但 percent 这种直白字段要命中 progress
  const pct = runCli(['set', 'T-S', '--field', 'percent', '--value', '30', '--project', 't', '--registry', env.reg]);
  assert.match(pct.err, /progress <id> --percent/);
});
