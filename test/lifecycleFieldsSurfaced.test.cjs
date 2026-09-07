'use strict';
/**
 * AUD-CLI-LIFECYCLE-CMDS 接线测试:新增的三个「往回走」的动作,界面上必须看得见。
 *
 * 【这在治什么】UNPARK-REASON-NOT-SHOWN 已经踩过一次同样的坑:CLI 给卡写了
 * unparkReason / unparkedAt,前端一处没接,卡一复工那段说明整块消失,负责人只能去
 * 活动流水里翻。unclaim / cancel / reopen 写的也全是「这卡为什么退回来 / 为什么不做了 /
 * 为什么又要做」——正是负责人一眼要看到的东西,漏接就等于白写。
 *
 * 【判据怎么定的】不写死字段名去 grep,而是**真跑一遍状态迁移**,把每个动作相对于
 * 迁移前那张卡多出来的字段捞出来,再要求每一个都:
 *   ① 在 web/src/types.ts 的 Task 接口里声明了(否则 vue-tsc 下前端根本读不到);
 *   ② 在 TaskDrawer「依赖 / 状态说明」那一段的模板里被渲染,且该段的 v-if 会因它而显示。
 * 以后 CLI 再给这三个动作加字段或改名,这里当场红。
 *
 * 另一半是「已作废」这个新状态的接线:core 加了枚举,前端三张映射表(状态联合类型 /
 * 语义色 / 瓦片记号)少任何一张,界面上就会开天窗或退化成灰瓦片。
 *
 * 【已知局限】同 unparkFieldsSurfaced:前端没有组件测试运行器,第 ② 条与前端映射表
 * 都是对源码的结构扫描,不是真渲染;真渲染那层由 vue-tsc + 人工看一眼兜底。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cmds = require('../cli/commands.cjs');
const { STATUS, VOID_STATUSES } = require('../core/boardSchema.cjs');

const WEB = path.join(__dirname, '..', 'web', 'src');
const TYPES = path.join(WEB, 'types.ts');
const DRAWER = path.join(WEB, 'components', 'TaskDrawer.vue');
const SCHEMA = path.join(WEB, 'api', 'schema.ts');
const DERIVE = path.join(WEB, 'utils', 'derive.ts');

function setup() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-ui-')));
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const root = path.join(dir, 'repo'); fs.mkdirSync(root);
  cmds.register({ id: 't', name: 'd', root, registry });
  return { dir, P: { project: 't', registry } };
}
const clean = (dir) => fs.rmSync(dir, { recursive: true, force: true });

/**
 * 跑一遍迁移,返回「这个动作比它的前一步多出来的字段名」。
 * 基线一律取【动作发生前那一刻】的卡,而不是新卡——否则 claim 顺手盖的进度时间戳
 * 会混进差集里,被当成本动作的产物。
 */
function fieldsAddedBy(run) {
  const { dir, P } = setup();
  try {
    const before = run.before(P);
    const baseline = new Set(Object.keys(before));
    return Object.keys(run.act(P)).filter((k) => !baseline.has(k));
  } finally {
    clean(dir);
  }
}

const unclaimFields = () => fieldsAddedBy({
  before: (P) => { cmds.add({ _: ['P01'], title: 'x', ...P }); return cmds.claim({ _: ['P01'], branch: 'b', ...P }).task; },
  act: (P) => cmds.unclaim({ _: ['P01'], reason: '对话中断,交回', ...P }).task,
});
const cancelFields = () => fieldsAddedBy({
  before: (P) => { cmds.add({ _: ['P01'], title: 'x', ...P }); return cmds.claim({ _: ['P01'], branch: 'b', ...P }).task; },
  act: (P) => cmds.cancel({ _: ['P01'], reason: '方案被否', ...P }).task,
});
const reopenFields = () => fieldsAddedBy({
  before: (P) => {
    cmds.add({ _: ['P01'], title: 'x', ...P });
    cmds.claim({ _: ['P01'], branch: 'b', ...P });
    return cmds.done({ _: ['P01'], ...P }).task;
  },
  act: (P) => cmds.reopen({ _: ['P01'], reason: '验收没过,返工', ...P }).task,
});

/** 从 types.ts 里切出 Task 接口的正文 */
function taskInterfaceBody() {
  const src = fs.readFileSync(TYPES, 'utf8');
  const start = src.indexOf('export interface Task {');
  assert.notEqual(start, -1, 'types.ts 里找不到 Task 接口');
  const end = src.indexOf('\n}', start);
  assert.notEqual(end, -1, 'Task 接口没有收尾的 }');
  return src.slice(start, end);
}

/** 从 TaskDrawer.vue 里切出「依赖 / 状态说明」那一段:v-if 里提到 blockReason 的那个 section */
function stateSection() {
  const src = fs.readFileSync(DRAWER, 'utf8');
  const start = src.search(/<section[^>]*task\.blockReason/);
  assert.notEqual(start, -1, 'TaskDrawer 里找不到状态说明那一段(v-if 提到 task.blockReason 的 section)');
  const end = src.indexOf('</section>', start);
  assert.notEqual(end, -1, '状态说明那一段没有收尾的 </section>');
  const whole = src.slice(start, end);
  return { whole, openTag: whole.slice(0, whole.indexOf('>') + 1) };
}

const CASES = [
  ['unclaim（放弃认领）', unclaimFields, ['unclaimReason', 'unclaimedAt']],
  ['cancel（作废）', cancelFields, ['cancelReason', 'cancelledAt']],
  ['reopen（重开）', reopenFields, ['reopenReason', 'reopenedAt']],
];

for (const [label, fields, expected] of CASES) {
  test(`${label} 写进卡里的就是那两个说明字段,不多不少`, () => {
    assert.deepEqual(fields().sort(), expected.slice().sort());
  });

  test(`${label} 写进卡里的字段,web 的 Task 接口都声明了`, () => {
    const body = taskInterfaceBody();
    for (const f of fields()) assert.match(body, new RegExp(`\\b${f}\\?:`), `types.ts 的 Task 少声明了 ${f}`);
  });

  test(`${label} 写进卡里的字段,抽屉的状态说明那一段都渲染`, () => {
    const { whole, openTag } = stateSection();
    const fs_ = fields();
    for (const f of fs_) assert.match(whole, new RegExp(`task\\.${f}`), `TaskDrawer 那一段没渲染 ${f}`);
    // 光渲染不够:段落自己的 v-if 也得认它,否则卡一退回来整段就消失、渲染代码永远走不到
    assert.ok(
      fs_.some((f) => openTag.includes(`task.${f}`)),
      `状态说明那一段的 v-if 没把 ${label} 的字段算进去,卡退回来后整段仍会消失`,
    );
  });
}

// ---------------------------------------------------------------------------
// 「已作废」这个新状态的前端接线
// ---------------------------------------------------------------------------

test('types.ts 的 Status 联合覆盖 core 的全部状态（含已作废）', () => {
  const src = fs.readFileSync(TYPES, 'utf8');
  const start = src.indexOf('export type Status =');
  assert.notEqual(start, -1, 'types.ts 里找不到 Status 联合类型');
  const body = src.slice(start, src.indexOf('\n\n', start));
  for (const s of STATUS) assert.ok(body.includes(`'${s}'`), `Status 联合少了「${s}」`);
});

test('schema.ts 的语义色与瓦片记号覆盖 core 的全部状态（少一张映射界面就开天窗）', () => {
  const src = fs.readFileSync(SCHEMA, 'utf8');
  for (const table of ['STATUS_TONE', 'STATUS_ICON']) {
    const start = src.indexOf(`export const ${table}`);
    assert.notEqual(start, -1, `schema.ts 里找不到 ${table}`);
    const body = src.slice(start, src.indexOf('\n}', start));
    for (const s of STATUS) assert.ok(body.includes(`${s}:`), `${table} 少了「${s}」`);
  }
});

test('前端的作废口径与 core 同源（VOID_STATUSES 两边一字不差）', () => {
  const src = fs.readFileSync(SCHEMA, 'utf8');
  const m = src.match(/export const VOID_STATUSES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'schema.ts 里找不到 VOID_STATUSES');
  const front = m[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  assert.deepEqual(front.sort(), VOID_STATUSES.slice().sort(), '前端的作废状态跟 core 对不上');
});

// 两种进度口径必须共用同一个分母 countedTasks(),而它剔掉作废卡。这里盯具体函数名是有意的:
// 分母一旦被谁复制成第二份,就会出现 CLI 说 100%、网页说 50% —— 两个数都出自看板,
// 负责人无从判断信哪个,比任何一个单独算错都糟。
test('前端的完成度分母也把作废卡剔掉（CLI 说 100%、网页说 50% 是最糟的情况）', () => {
  const src = fs.readFileSync(DERIVE, 'utf8');
  const at = src.indexOf('function countedTasks');
  assert.notEqual(at, -1, 'derive.ts 里找不到统一分母 countedTasks()');
  assert.match(src.slice(at, src.indexOf('\n}', at)), /VOID_STATUSES/, 'countedTasks() 没把作废卡剔出分母');
  for (const fn of ['export function progress', 'export function avgPercent']) {
    const start = src.indexOf(fn);
    assert.notEqual(start, -1, `derive.ts 里找不到 ${fn}`);
    const body = src.slice(start, src.indexOf('\n}', start));
    assert.match(body, /countedTasks\(/, `${fn} 没走统一分母,自己另算了一份`);
  }
});
