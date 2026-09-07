'use strict';
/**
 * AUD-CLI-BRIEF-AND-HELP · 查询命令"要什么给什么"的回归门禁(审计 §4-A4)。
 * 病根:list/show/inbox 把给模型看的技术说明(可达 2000+ 字)整段回吐,且 list 默认含已完工,
 * 每次问看板都要烧掉上万 token。本文件锁死"默认精简 + 显式才要全量"。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cmds = require('../cli/commands.cjs');
const { inbox } = require('../cli/inboxCmd.cjs');
const { emojiFor } = require('../core/boardSchema.cjs');
const { humanTitle } = require('../core/taskTitle.cjs');

/** 长技术说明:模拟真实卡的 title(审计实测 dashboard 卡最长 2166 字)。 */
const SPEC = '技术说明'.repeat(120); // 480 字
const PLAIN = '一句话讲清这张卡要干什么给不看代码的人读';

function setup(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'slim-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const root = path.join(dir, 'repo'); fs.mkdirSync(root);
  cmds.register({ id: 't', name: '示例项目', root, registry: reg });
  return { dir, P: { project: 't', registry: reg } };
}

/** 造一块"真实体量"的板:63 张卡,49 张已完工,每张都带长技术说明。 */
function seedBoard(P, { done = 49, open = 14 } = {}) {
  for (let i = 0; i < done; i++) {
    cmds.add({ _: [`DONE-${i}`], title: SPEC, 'plain-title': PLAIN, status: '已完工', ...P });
  }
  for (let i = 0; i < open; i++) {
    cmds.add({ _: [`OPEN-${i}`], title: SPEC, 'plain-title': PLAIN, ...P });
  }
}

/** 改动前的 list 行口径(逐字照搬旧实现),用作"降了多少"的基线,不是随口估的。 */
function legacyListText(board, projName) {
  const stats = cmds.deriveStats(board);
  const line = `进度 ${stats.progress}%（${stats.done}/${stats.total} 完工）· `
    + Object.entries(stats.byStatus).map(([k, v]) => `${k}${v}`).join(' ');
  const rows = (board.tasks || []).map((x) => `${emojiFor(x.status)} ${String(x.id).padEnd(10)} `
    + `${String(x.status).padEnd(6)} ${String(x.percent || 0).padStart(3)}%  `
    + `${x.gitBranch && x.gitBranch.length ? x.gitBranch.join(',') : '-'}  ${x.title}`);
  return `${projName}  ${line}\n` + rows.join('\n');
}

const BG = '【场景】这是单测背景需要够长以通过校验器所以多写一些占位内容确保达标凑够六十字这里继续补充。【问题】占位。【要做】占位。【为什么】占位。';

test('list 默认隐藏已完工,只在 --all 时全给', (t) => {
  const { P } = setup(t);
  seedBoard(P);
  const def = cmds.list({ ...P }).text;
  assert.ok(!def.includes('DONE-0'), '默认不该出现已完工卡');
  assert.ok(def.includes('OPEN-0'), '未开工卡必须还在');
  assert.match(def, /--all/, '要告诉调用方隐藏了什么、怎么看全');
  const all = cmds.list({ all: true, ...P }).text;
  assert.ok(all.includes('DONE-0') && all.includes('OPEN-0'), '--all 要给全');
});

test('list 显式 --status 已完工 时不被默认过滤吃掉', (t) => {
  const { P } = setup(t);
  seedBoard(P, { done: 2, open: 1 });
  const only = cmds.list({ status: '已完工', ...P }).text;
  assert.ok(only.includes('DONE-0'), '点名要已完工就该给已完工');
  assert.ok(!only.includes('OPEN-0'));
});

test('list 默认行是 id/状态/进度/分支/人话标题(截60),不吐技术说明', (t) => {
  const { P } = setup(t);
  cmds.add({ _: ['P01'], title: SPEC, 'plain-title': PLAIN, ...P });
  cmds.claim({ _: ['P01'], branch: 'feat/x', ...P });
  const text = cmds.list({ ...P }).text;
  assert.ok(text.includes('P01') && text.includes('施工中') && text.includes('feat/x'));
  assert.ok(text.includes(PLAIN), '人话标题要在');
  assert.ok(!text.includes(SPEC), '技术说明全文绝不能整段吐回');
});

test('list 老卡没有人话标题时截技术说明 60 字应急,不整段糊脸', (t) => {
  const { P } = setup(t);
  cmds.add({ _: ['P01'], title: SPEC, ...P });
  const text = cmds.list({ ...P }).text;
  assert.ok(text.includes(SPEC.slice(0, 60)), '要给前 60 字');
  assert.ok(!text.includes(SPEC.slice(0, 61)), '第 61 字起必须截掉');
});

test('list --brief 只给 id/状态/进度', (t) => {
  const { P } = setup(t);
  cmds.add({ _: ['P01'], title: SPEC, 'plain-title': PLAIN, ...P });
  cmds.claim({ _: ['P01'], branch: 'feat/x', ...P });
  const text = cmds.list({ brief: true, ...P }).text;
  assert.ok(text.includes('P01') && text.includes('施工中'));
  assert.ok(!text.includes(PLAIN), '--brief 连人话标题都不要');
  assert.ok(!text.includes('feat/x'), '--brief 不带分支');
});

test('list --fields 自选列;写了不存在的字段该列打 - 而不是报错', (t) => {
  const { P } = setup(t);
  cmds.add({ _: ['P01'], title: SPEC, 'plain-title': PLAIN, model: 'opus·中', ...P });
  const text = cmds.list({ fields: 'id,model,不存在的字段', ...P }).text;
  assert.ok(text.includes('P01') && text.includes('opus·中'));
  assert.ok(!text.includes(PLAIN), '没点名的列不许自作主张塞进来');
  assert.match(text, /-/, '缺的字段留一个占位横杠');
});

test('list 输出体量比改动前降 ≥80%(63 张卡的真实体量)', (t) => {
  const { P, dir } = setup(t);
  seedBoard(P);
  const board = JSON.parse(fs.readFileSync(path.join(dir, 'repo', '.dashboard', 'board.json'), 'utf8'));
  const before = legacyListText(board, '示例项目').length;
  const after = cmds.list({ ...P }).text.length;
  assert.ok(before > 20000, `基线必须真的很大(实为 ${before}),否则这条断言在自欺`);
  assert.ok(after / before <= 0.2, `list 应降至基线 20% 以内,实为 ${(after / before * 100).toFixed(1)}%`);
});

test('show 默认精简卡:id/人话标题/状态/进度/分支/待拍板/下一步,不含技术说明', (t) => {
  const { P } = setup(t);
  cmds.add({ _: ['P01'], title: SPEC, 'plain-title': PLAIN, ...P });
  cmds.pending({
    _: ['P01'], q: '要不要拆成两步?', opt: ['拆', '不拆'], rec: '拆', background: BG,
    'pros-拆': '【好处】拆的好处描述在这里。【代价】拆的代价描述在这里。',
    'pros-不拆': '【好处】不拆的好处描述。【代价】不拆的代价描述。',
    reason: '推荐拆的理由需要写得足够长才能通过校验器所以我多写一些占位内容。', ...P,
  });
  cmds.claim({ _: ['P01'], branch: 'feat/x', ...P });
  cmds.progress({ _: ['P01'], percent: 40, next: '接下来写渲染器', ...P });
  const text = cmds.show({ _: ['P01'], ...P }).text;
  assert.ok(text.includes('P01') && text.includes(PLAIN) && text.includes('施工中'));
  assert.ok(text.includes('40') && text.includes('feat/x'));
  assert.ok(text.includes('要不要拆成两步?'), '待拍板问题要露出来');
  assert.ok(text.includes('接下来写渲染器'), 'nextMilestone 要露出来');
  assert.ok(!text.includes(SPEC), '精简卡不含技术说明全文');
  assert.match(text, /--full/, '要指路怎么看全量');
});

test('show --full 才给整卡 JSON', (t) => {
  const { P } = setup(t);
  cmds.add({ _: ['P01'], title: SPEC, 'plain-title': PLAIN, ...P });
  const text = cmds.show({ _: ['P01'], full: true, ...P }).text;
  const parsed = JSON.parse(text);
  assert.equal(parsed.id, 'P01');
  assert.equal(parsed.title, SPEC, '--full 要一个字不少');
});

test('show --pending 照旧可用(没被精简卡挤掉)', (t) => {
  const { P } = setup(t);
  cmds.add({ _: ['P01'], title: SPEC, 'plain-title': PLAIN, ...P });
  cmds.pending({
    _: ['P01'], q: '问题一?', opt: ['A', 'B'], rec: 'A', background: BG,
    'pros-A': '【好处】A 的好处描述在这里。【代价】A 的代价描述在这里。',
    'pros-B': '【好处】B 的好处描述在这里。【代价】B 的代价描述在这里。',
    reason: '推荐 A 的理由需要写得足够长才能通过校验器所以我多写一些占位内容。', ...P,
  });
  assert.match(cmds.show({ pending: true, ...P }).text, /问题一\?/);
});

test('inbox 列表态只给 id + 人话标题 + 决策数,不吐技术说明', (t) => {
  const { P } = setup(t);
  cmds.add({ _: ['P10'], title: SPEC, 'plain-title': PLAIN, ...P });
  cmds.pending({
    _: ['P10'], q: 'Q?', opt: ['A', 'B'], rec: 'B', strict: true, background: BG,
    'pros-A': '【好处】A好处描述在这里。【代价】A代价描述在这里。',
    'pros-B': '【好处】B好处描述在这里。【代价】B代价描述在这里。',
    reason: '推荐B的理由需要写得足够长才能通过校验器所以多写一些占位内容凑字数。', ...P,
  });
  cmds.decide({ _: ['P10'], did: 'd1', answer: 'B', ...P });
  const text = inbox({ ...P }).text;
  assert.ok(text.includes('P10') && text.includes(PLAIN));
  assert.ok(text.includes('1'), '要报有几条待落地决策');
  assert.ok(!text.includes(SPEC), '列表态不该整段吐技术说明');
});

test('单元格封顶:一张卡攒了几千字符的分支,不许把每一行都撑那么宽', (t) => {
  const { P } = setup(t);
  const 长分支 = Array.from({ length: 80 }, (_, i) => `claude/very-long-branch-name-number-${i}`);
  cmds.add({ _: ['P01'], title: SPEC, 'plain-title': PLAIN, ...P });
  cmds.add({ _: ['P02'], title: SPEC, 'plain-title': PLAIN, ...P });
  cmds.claim({ _: ['P01'], branch: 长分支, ...P });
  const text = cmds.list({ ...P }).text;
  const rows = text.split('\n').filter((l) => l.includes('P0'));
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.ok(r.length < 300, `一行不该被撑到 ${r.length} 字符：${r.slice(0, 80)}…`);
  }
  assert.match(text, /…/, '截断要有明示,不许无声吞字');
});

test('inbox 列表态默认只列一屏,--all 才全列,新拍的板排前面', (t) => {
  const { P } = setup(t);
  for (let i = 0; i < 40; i++) {
    const id = `Q${String(i).padStart(2, '0')}`;
    cmds.add({ _: [id], title: SPEC, 'plain-title': `第 ${i} 张卡的人话标题`, ...P });
    cmds.pending({
      _: [id], q: `问题 ${i}?`, opt: ['A', 'B'], rec: 'B', strict: true, background: BG,
      'pros-A': '【好处】A好处描述在这里。【代价】A代价描述在这里。',
      'pros-B': '【好处】B好处描述在这里。【代价】B代价描述在这里。',
      reason: '推荐B的理由需要写得足够长才能通过校验器所以多写一些占位内容凑字数。', ...P,
    });
    cmds.decide({ _: [id], did: 'd1', answer: 'B', ...P });
    // 造出"拍板日期不同"的两批：后 10 张拍得更晚
    if (i >= 30) cmds.set({ _: [id], field: 'decisions.0.decidedAt', value: '2099-01-01', ...P });
  }
  const def = inbox({ ...P }).text;
  assert.match(def, /共 40 个/, '总数要如实报');
  assert.match(def, /还有 10 个没列/, '没列全就要说清还剩多少、怎么看全');
  assert.ok(def.includes('Q39'), '拍板最新的那张必须在第一屏');
  // 30 张 = 后拍的 Q30~Q39 + 同日的 Q00~Q19；Q20~Q29 被挤到第一屏之外
  assert.ok(!def.includes('Q29'), '排在最后的那批应落到第一屏之外');
  const all = inbox({ all: true, ...P }).text;
  assert.ok(all.includes('Q00') && all.includes('Q39'));
  assert.ok(!/还有 \d+ 个没列/.test(all));
  const five = inbox({ limit: '5', ...P }).text;
  assert.match(five, /只列了 5 个/);
});

test('humanTitle 的截断口径与前端 taskTitle.ts 一致(防两侧漂移)', () => {
  const ts = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'utils', 'taskTitle.ts'), 'utf8');
  const m = ts.match(/PLAIN_TITLE_TRUNCATE_LEN\s*=\s*(\d+)/);
  assert.ok(m, '前端必须还留着这个常量');
  const len = Number(m[1]);
  const long = 'x'.repeat(len + 10);
  assert.equal(humanTitle({ title: long }), long.slice(0, len) + '…');
  assert.equal(humanTitle({ title: long, plainTitle: '人话' }), '人话');
});
