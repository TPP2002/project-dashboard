'use strict';
/**
 * UNPARK-REASON-NOT-SHOWN 回归测试:unpark 写进卡里的字段,界面上必须看得见。
 *
 * 【这卡在治什么】PARK-HAS-NO-UNPARK 给 unpark 加了 task.unparkReason / task.unparkedAt
 * (凭什么解除的暂缓、哪天解的),但前端一处都没接:web/src/types.ts 的 Task 没声明它们,
 * TaskDrawer 的「依赖 / 阻塞」那一段也不渲染。后果:卡从「暂缓」走到「可复工」之后,
 * 抽屉里那一段整块消失,负责人只能去活动流水里翻 type='unpark' 那条——多翻一层,
 * 而 unpark 的初衷之一就是让解除依据摆在卡面上。
 *
 * 【判据怎么定的】这里不写死字段名去 grep,而是**真跑一遍 park→unpark**,
 * 把 unpark 相对于一张新卡多出来的字段捞出来,再要求每一个都:
 *   ① 在 web/src/types.ts 的 Task 接口里声明了(否则 vue-tsc 下前端根本读不到);
 *   ② 在 TaskDrawer「依赖 / 阻塞」那一段的模板里被渲染,且该段的 v-if 会因它而显示。
 * 这样以后 CLI 再给 unpark 加字段或改名,这里当场红,不会又悄悄漏接一次。
 *
 * 【已知局限】前端没有组件测试运行器(web 下没有 vitest / @vue/test-utils),
 * 所以第 ②条是对 .vue 源码的结构扫描,不是真渲染。为这一张卡引一整套组件测试栈不划算;
 * 真渲染这一层由 vue-tsc 类型检查 + 人工看一眼界面兜底。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cmds = require('../cli/commands.cjs');

const WEB = path.join(__dirname, '..', 'web', 'src');
const TYPES = path.join(WEB, 'types.ts');
const DRAWER = path.join(WEB, 'components', 'TaskDrawer.vue');

/** 建一个临时项目,返回 CLI 调用要带的参数 */
function setup() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'unpark-ui-')));
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const root = path.join(dir, 'repo'); fs.mkdirSync(root);
  cmds.register({ id: 't', name: 'd', root, registry });
  return { dir, P: { project: 't', registry } };
}
const clean = (dir) => fs.rmSync(dir, { recursive: true, force: true });

/** 跑一遍 park→unpark,返回「复工后比新卡多出来的字段名」 */
function unparkOnlyFields() {
  const { dir, P } = setup();
  try {
    const fresh = cmds.add({ _: ['P01'], title: 'x', ...P }).task;
    const baseline = new Set(Object.keys(fresh));
    cmds.park({ _: ['P01'], reason: '等上游', note: '遗留A', ...P });
    const unparked = cmds.unpark({ _: ['P01'], reason: '上游已就绪', ...P }).task;
    return Object.keys(unparked).filter((k) => !baseline.has(k));
  } finally {
    clean(dir);
  }
}

/** 从 types.ts 里切出 Task 接口的正文 */
function taskInterfaceBody() {
  const src = fs.readFileSync(TYPES, 'utf8');
  const start = src.indexOf('export interface Task {');
  assert.notEqual(start, -1, 'types.ts 里找不到 Task 接口');
  const end = src.indexOf('\n}', start);
  assert.notEqual(end, -1, 'Task 接口没有收尾的 }');
  return src.slice(start, end);
}

/** 从 TaskDrawer.vue 里切出「阻塞/暂缓那一段」:v-if 里提到 blockReason 的那个 section */
function blockSection() {
  const src = fs.readFileSync(DRAWER, 'utf8');
  const start = src.search(/<section[^>]*task\.blockReason/);
  assert.notEqual(start, -1, 'TaskDrawer 里找不到阻塞/暂缓那一段(v-if 提到 task.blockReason 的 section)');
  const end = src.indexOf('</section>', start);
  assert.notEqual(end, -1, '阻塞/暂缓那一段没有收尾的 </section>');
  const whole = src.slice(start, end);
  return { whole, openTag: whole.slice(0, whole.indexOf('>') + 1) };
}

test('park→unpark 只多出解除依据与解除日期两个字段', () => {
  assert.deepEqual(unparkOnlyFields().sort(), ['unparkReason', 'unparkedAt']);
});

test('unpark 写进卡里的字段,web 的 Task 接口都声明了', () => {
  const body = taskInterfaceBody();
  for (const field of unparkOnlyFields()) {
    assert.match(body, new RegExp(`\\b${field}\\?:`), `types.ts 的 Task 少声明了 ${field}`);
  }
});

test('unpark 写进卡里的字段,抽屉的阻塞/暂缓那一段都渲染', () => {
  const { whole, openTag } = blockSection();
  const fields = unparkOnlyFields();
  for (const field of fields) {
    assert.match(whole, new RegExp(`task\\.${field}`), `TaskDrawer 那一段没渲染 ${field}`);
  }
  // 光渲染不够:段落自己的 v-if 也得认这些字段,否则卡一复工整段就消失、渲染代码永远走不到
  assert.ok(
    fields.some((field) => openTag.includes(`task.${field}`)),
    '阻塞/暂缓那一段的 v-if 没把复工字段算进去,卡走到「可复工」后整段仍会消失',
  );
});
