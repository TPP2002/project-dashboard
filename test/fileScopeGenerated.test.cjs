'use strict';
/**
 * BOARD-FILESCOPE-INDEX-POLLUTION 回归测试。
 *
 * 【这卡在治什么】fileScope(文件范围)里填了「人人都会碰的自动生成物」——最典型的是
 * docs/INDEX-自动生成.md(看板 render-index 自己吐出来的目录)——之后:
 *   ① 并行清单会把八竿子打不着的卡判成「同区、会撞车」,只肯一张张串行派;
 *   ② 一张施工中的卡只要 fileScope 里有这个文件,就能把整组候选卡按住不放;
 *   ③ 占用防撞页把这一行显示成 N 张卡抢同一个文件的「冲突」。
 * 2026-09-03 实证:rogue 板上 docs/INDEX-自动生成.md 同时出现在 7 张卡的 fileScope 里。
 *
 * 修复判据:生成物在「判撞车」这件事上一律不算数(仍原样保留在卡里给人看),
 * 并且建卡/认领时当场提醒别填。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const { isGeneratedArtifact, GENERATED_ARTIFACT_PATTERNS, toEsmSource } = require('../core/generatedArtifacts.cjs');
const { buildParallelPlan, scopeKeys } = require('../server/parallelPlan.cjs');
const cmds = require('../cli/commands.cjs');

const INDEX = path.join(__dirname, '..', 'cli', 'index.cjs');

// ---------- ① 判据本身 ----------
test('生成物判据:该认的认出来,该放过的别误伤', () => {
  const generated = [
    'docs/INDEX-自动生成.md',
    'docs\\INDEX-自动生成.md',            // Windows 反斜杠写法
    './docs/INDEX-自动生成.md',
    '.dashboard/board.json',
    'F:/code-repo/.dashboard/INDEX.md',
    'package-lock.json',
    'web/package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'node_modules/**',
    'web/dist/**',
    'coverage/lcov.info',
  ];
  for (const p of generated) assert.equal(isGeneratedArtifact(p), true, `应判为生成物: ${p}`);

  const handwritten = [
    'docs/design/纪元.md',
    'docs/plans/foundation-wiring-0809/**',
    'docs/INDEX.md',                       // 不带「自动生成」字样的手写目录不误伤
    'src/engine/build/draft.ts',           // build 是真源码目录(肉鸽仓实有),绝不能当生成物
    'scripts/build-content.ts',
    'src/dist-helper.ts',                  // dist 只作为完整路径段才算数
    'src/shell/run/gameShell.ts',
    'tests/unit/**',
    // 历史数据里真有的混装写法(肉鸽仓 CODEX 卡):里面有手写文件,整条照旧参与判撞车
    'docs/开工须知*.md,docs/口径速查表.md,CLAUDE.md,AGENTS.md,docs/INDEX-自动生成.md',
    '',
    null,
  ];
  for (const p of handwritten) assert.equal(isGeneratedArtifact(p), false, `不该判为生成物: ${p}`);

  assert.ok(Array.isArray(GENERATED_ARTIFACT_PATTERNS) && GENERATED_ARTIFACT_PATTERNS.length, '判据表要导出,供前端同源引入');
});

test('scopeKeys 把生成物剔掉,只留真正会撞车的目录键', () => {
  assert.deepEqual(scopeKeys(['docs/INDEX-自动生成.md', 'src/engine/market/**']), ['src/engine']);
  assert.deepEqual(scopeKeys(['docs/INDEX-自动生成.md']), [], '整张卡只填了生成物 = 等于没填文件范围');
  assert.deepEqual(scopeKeys(['src/shell/run/gameShell.ts']), ['src/shell'], '正常路径照旧');
});

// ---------- ② 并行清单 ----------
const card = (id, status, fileScope) => ({
  id, status, title: id, plainTitle: id, percent: 0, fileScope,
  deps: { dependsOn: [], blockedBy: [], relatedTasks: [] },
});

test('只因为都碰了自动生成目录,两张无关卡不再被判成同区', () => {
  const plan = buildParallelPlan([
    card('AAA-ENGINE', '未开工', ['src/engine/market/**', 'docs/INDEX-自动生成.md']),
    card('BBB-UI', '未开工', ['web/src/views/**', 'docs/INDEX-自动生成.md']),
  ]);
  const ready = plan.ready.map((r) => r.id).sort();
  assert.deepEqual(ready, ['AAA-ENGINE', 'BBB-UI'], '两张卡改的是完全不同的模块,应该都能派');
  assert.equal(plan.waitingSameArea.length, 0, '不该有人被「同区」按住');
});

test('施工中的卡不会靠自动生成物把无关候选卡按住', () => {
  const plan = buildParallelPlan([
    card('RUNNING-DOCS', '施工中', ['scripts/bot/**', 'docs/INDEX-自动生成.md']),
    card('CAND-ENGINE', '未开工', ['src/engine/market/**', 'docs/INDEX-自动生成.md']),
  ]);
  assert.deepEqual(plan.ready.map((r) => r.id), ['CAND-ENGINE'], '候选卡不碰 scripts/bot,应可派');
  assert.equal(plan.waitingSameArea.length, 0);
});

test('真撞车照旧拦住(防止一刀切把冲突判断废掉)', () => {
  const plan = buildParallelPlan([
    card('AAA-ENGINE', '未开工', ['src/engine/market/**', 'docs/INDEX-自动生成.md']),
    card('BBB-ENGINE', '未开工', ['src/engine/build/draft.ts']),
  ]);
  assert.equal(plan.ready.length, 1, '同在 src/engine 下的两张卡只该放一张');
  assert.equal(plan.waitingSameArea.length, 1);
  assert.equal(plan.waitingSameArea[0].reason, 'same-area');
});

test('整张卡只填了生成物 = 按「没填文件范围」处理,并明说这是猜的', () => {
  const plan = buildParallelPlan([
    card('ZZZ-ONE', '未开工', ['docs/INDEX-自动生成.md']),
    card('ZZZ-TWO', '未开工', ['docs/INDEX-自动生成.md']),
  ]);
  assert.equal(plan.stats.withScope, 0, '只填生成物不算填了文件范围');
  assert.equal(plan.ready.length, 1, '退回按卡号前缀分组,同前缀只推一张');
  assert.equal(plan.ready[0].guessedGroup, true, '必须标注这是猜的');
});

// ---------- ③ 建卡指引(CLI 当场提醒) ----------
function setup() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fsg-')));
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const root = path.join(dir, 'repo'); fs.mkdirSync(root);
  cmds.register({ id: 't', name: 'd', root, registry: reg });
  return { dir, reg, board: path.join(root, '.dashboard', 'board.json') };
}
const clean = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows 偶发句柄滞留 */ } };
/** 跑真 CLI 入口,stdout / stderr 分开取(警告走 stderr,不能混进 stdout 的 JSON) */
function cli(reg, ...args) {
  const r = spawnSync('node', [INDEX, ...args, '--registry', reg], { encoding: 'utf8' });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

test('add --scope 填了生成物:照收但当场警告(不拦,免得把人卡在建卡这一步)', () => {
  const { dir, reg, board } = setup();
  const r = execFileSync('node', [INDEX, 'add', 'T1', '--project', 't', '--title', 'x', '--plain-title', '人话',
    '--model', 'sonnet·中', '--scope', 'docs/INDEX-自动生成.md', '--scope', 'src/engine/**',
    '--registry', reg], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(r.length, 'add 应正常返回');
  const b = JSON.parse(fs.readFileSync(board, 'utf8'));
  assert.deepEqual(b.tasks[0].fileScope, ['docs/INDEX-自动生成.md', 'src/engine/**'], '原样保留,不替用户删');
  clean(dir);
});

test('add 警告文字点名那个生成物,并说明并行判断会忽略它', () => {
  const { dir, reg } = setup();
  const r = cli(reg, 'add', 'T1', '--project', 't', '--title', 'x', '--plain-title', '人话',
    '--model', 'sonnet·中', '--scope', 'docs/INDEX-自动生成.md');
  assert.equal(r.code, 0, '不该拒收');
  assert.match(r.err, /docs\/INDEX-自动生成\.md/, '警告要点名是哪一条');
  assert.match(r.err, /并行/, '警告要讲清后果:并行判断不吃这条');
  clean(dir);
});

test('claim --scope 同样警告;正常路径则一声不吭', () => {
  const { dir, reg } = setup();
  cli(reg, 'add', 'T1', '--project', 't', '--title', 'x', '--plain-title', '人话', '--model', 'sonnet·中');
  const noisy = cli(reg, 'claim', 'T1', '--project', 't', '--branch', 'b1', '--scope', 'package-lock.json');
  assert.equal(noisy.code, 0);
  assert.match(noisy.err, /package-lock\.json/);

  const quiet = cli(reg, 'claim', 'T1', '--project', 't', '--branch', 'b1', '--scope', 'src/engine/**');
  assert.equal(quiet.code, 0);
  assert.equal(quiet.err.trim(), '', '正常文件范围不该有任何警告噪音');
  clean(dir);
});

// ---------- ④ 前端同源(占用防撞页用的是同一份判据) ----------
test('前端虚拟模块源码与 core 判据同源,行为逐条一致', () => {
  const src = toEsmSource();
  assert.match(src, /export const GENERATED_ARTIFACT_PATTERNS/);
  assert.match(src, /export const isGeneratedArtifact/);
  // 把生成的 ESM 源码转成可执行片段,逐条比对与 core 的判定是否一模一样
  const body = src.replace(/export const /g, 'const ') + '\nreturn isGeneratedArtifact;';
  const fn = new Function(body)();
  for (const p of ['docs/INDEX-自动生成.md', 'src/engine/build/draft.ts', 'web/dist/**', 'docs/INDEX.md', 'yarn.lock']) {
    assert.equal(fn(p), isGeneratedArtifact(p), `前端判定应与 core 一致: ${p}`);
  }
});

test('vite 配置确实是从 core 取这份判据(防以后有人在前端另抄一份)', () => {
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'web', 'vite.config.ts'), 'utf8');
  assert.match(cfg, /generatedArtifacts\.cjs/, 'vite 必须 require core/generatedArtifacts.cjs');
  assert.match(cfg, /toEsmSource/, '必须用 core 导出的源码生成器,不许前端自己抄一份正则');
  const collision = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'views', 'Collision.vue'), 'utf8');
  assert.match(collision, /isGeneratedArtifact/, '占用防撞页要用这份判据');
});
