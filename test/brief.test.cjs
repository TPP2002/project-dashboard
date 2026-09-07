'use strict';
/**
 * AUD-CLI-BRIEF-AND-HELP · "一条命令拿全开工信息"的回归门禁(审计 §4-A3)。
 * 病根:开工前要读 CLAUDE.md + skill + precheck + show(整卡 JSON)+ inbox --tid(还只在
 * 有待落地决策时可用),信息散在五处、没有一处齐全。brief 把它收成一份 markdown 任务书。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cmds = require('../cli/commands.cjs');
const { brief, buildBrief } = require('../cli/brief.cjs');
const { inbox } = require('../cli/inboxCmd.cjs');
const dispatch = require('../cli/dispatchPrompt.cjs');

const SPEC = '这张卡要做的技术细节说明,写得很长很长,长到没人愿意在列表里看见它。'.repeat(8);
const PLAIN = '登录连续输错要能自动锁一会儿,防有人硬猜密码';
const BG = '【场景】这是单测背景需要够长以通过校验器所以多写一些占位内容确保达标凑够六十字这里继续补充。【问题】占位。【要做】占位。【为什么】占位。';

function setup(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'brief-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const root = path.join(dir, 'repo'); fs.mkdirSync(root);
  cmds.register({ id: 't', name: '示例项目', root, registry: reg });
  return { dir, P: { project: 't', registry: reg } };
}

function askAndAnswer(P, id, q, answer) {
  cmds.pending({
    _: [id], q, opt: ['甲', '乙'], rec: '甲', background: BG,
    'pros-甲': '【好处】甲的好处描述在这里。【代价】甲的代价描述在这里。',
    'pros-乙': '【好处】乙的好处描述在这里。【代价】乙的代价描述在这里。',
    reason: '推荐甲的理由需要写得足够长才能通过校验器所以我多写一些占位内容。', ...P,
  });
  if (answer) cmds.decide({ _: [id], did: 'd1', answer, ...P });
}

test('brief 一屏给齐七件事:人话标题/技术说明/文件域/依赖及其状态/待拍板/已拍板答案/文档', (t) => {
  const { P } = setup(t);
  cmds.add({ _: ['UP-1'], title: '上游那张卡', 'plain-title': '先把接口定下来', ...P });
  cmds.add({
    _: ['FEAT-12'], title: SPEC, 'plain-title': PLAIN, model: 'opus·中',
    scope: ['src/auth/lock.ts', 'test/lock.test.ts'], ...P,
  });
  cmds.set({ _: ['FEAT-12'], field: 'deps.dependsOn', value: '["UP-1"]', ...P });
  cmds.set({ _: ['FEAT-12'], field: 'docs', value: '["docs/plans/登录锁定.md"]', ...P });
  askAndAnswer(P, 'FEAT-12', '锁多久?', '锁 30 分钟');
  cmds.note({ _: ['FEAT-12'], text: '负责人补充:锁定期间要能发邮件解锁', ...P });

  const text = brief({ _: ['FEAT-12'], ...P }).text;
  assert.ok(text.includes(PLAIN), '人话标题');
  assert.ok(text.includes(SPEC), '技术说明要给全（这是模型真正要读的正本）');
  assert.ok(text.includes('src/auth/lock.ts'), '文件域');
  assert.ok(text.includes('UP-1') && text.includes('先把接口定下来'), '依赖要点名并给人话标题');
  assert.match(text, /UP-1[^\n]*未开工/, '依赖要带它此刻的状态');
  assert.ok(text.includes('锁 30 分钟'), '已拍板要落地的答案');
  assert.ok(text.includes('docs/plans/登录锁定.md'), '参考文档');
  assert.ok(text.includes('opus·中'), '建议档位');
  assert.ok(text.includes('负责人补充'), '最近留言');
  assert.match(text, /^# FEAT-12/m, 'markdown 一屏,抬头是卡号');
});

test('最近留言只收 note 命令写的,记账流水不进来(否则整段技术说明会再吐一遍)', (t) => {
  const { P } = setup(t);
  // add 与 set 的流水也记成 type:'note',其中「新建任务 …」那条带着整段技术说明
  cmds.add({ _: ['FEAT-12'], title: SPEC, 'plain-title': PLAIN, ...P });
  cmds.set({ _: ['FEAT-12'], field: 'docs', value: '["docs/x.md"]', ...P });
  let text = brief({ _: ['FEAT-12'], ...P }).text;
  assert.match(text, /## 最近留言\s*\n\s*\n- 无。/, '只有记账流水时,留言区应为空');
  assert.equal(text.split(SPEC).length - 1, 1, '技术说明全文只该出现一次（正本那一段）');
  cmds.note({ _: ['FEAT-12'], text: '负责人:先别动数据库那块', ...P });
  text = brief({ _: ['FEAT-12'], ...P }).text;
  assert.ok(text.includes('负责人:先别动数据库那块'));
});

test('超长留言会被截断,不许把任务书撑爆', (t) => {
  const { P } = setup(t);
  cmds.add({ _: ['FEAT-12'], title: '短说明', 'plain-title': PLAIN, ...P });
  cmds.note({ _: ['FEAT-12'], text: '啰'.repeat(500), ...P });
  const text = brief({ _: ['FEAT-12'], ...P }).text;
  assert.match(text, /截断/);
  assert.ok(!text.includes('啰'.repeat(300)), '不该原样把 500 字粘上来');
});

test('有没答的待拍板问题时,任务书顶部明写禁止开工', (t) => {
  const { P } = setup(t);
  cmds.add({ _: ['FEAT-12'], title: SPEC, 'plain-title': PLAIN, ...P });
  askAndAnswer(P, 'FEAT-12', '要不要顺带改密码策略?', null);
  const text = brief({ _: ['FEAT-12'], ...P }).text;
  assert.match(text, /禁止开工/, '没拍完板就不许动代码,这句必须在');
  assert.ok(text.includes('要不要顺带改密码策略?'), '要把问题原文摆出来');
  assert.ok(text.indexOf('禁止开工') < text.indexOf('技术说明'), '禁令要在技术说明之前,不能埋在后面');
});

test('全部拍完板就不再挂禁令', (t) => {
  const { P } = setup(t);
  cmds.add({ _: ['FEAT-12'], title: SPEC, 'plain-title': PLAIN, ...P });
  askAndAnswer(P, 'FEAT-12', '锁多久?', '锁 30 分钟');
  assert.ok(!/禁止开工/.test(brief({ _: ['FEAT-12'], ...P }).text));
});

test('依赖没完工要明说"现在开工可能白干";上游完工了就不吓人', (t) => {
  const { P } = setup(t);
  cmds.add({ _: ['UP-1'], title: '上游', 'plain-title': '先把接口定下来', ...P });
  cmds.add({ _: ['FEAT-12'], title: SPEC, 'plain-title': PLAIN, ...P });
  cmds.set({ _: ['FEAT-12'], field: 'deps.dependsOn', value: '["UP-1"]', ...P });
  assert.match(brief({ _: ['FEAT-12'], ...P }).text, /白干|还没完工/);
  cmds.done({ _: ['UP-1'], ...P });
  assert.ok(!/白干/.test(brief({ _: ['FEAT-12'], ...P }).text));
});

test('该登记没登记的字段给出补齐命令,不静默留白', (t) => {
  const { P } = setup(t);
  cmds.add({ _: ['FEAT-12'], title: SPEC, ...P }); // 没有 plainTitle / fileScope / docs
  const text = brief({ _: ['FEAT-12'], ...P }).text;
  assert.match(text, /没登记|还没写/, '缺的东西要说出来');
  assert.match(text, /--scope|set .*fileScope/, '要给补齐的路子');
});

test('brief 卡不存在时报错(不静默给一份空任务书)', (t) => {
  const { P } = setup(t);
  assert.throws(() => brief({ _: ['NOPE-1'], ...P }), /NOPE-1|不存在/);
});

test('claim --brief 认领的同时打印同一份任务书', (t) => {
  const { P } = setup(t);
  cmds.add({ _: ['FEAT-12'], title: SPEC, 'plain-title': PLAIN, ...P });
  const res = cmds.claim({ _: ['FEAT-12'], branch: 'feat/lock', brief: true, ...P });
  assert.equal(res.task.status, '施工中');
  assert.ok(res.text.includes('claim'), '先报认领结果');
  assert.ok(res.text.includes(PLAIN) && res.text.includes(SPEC), '再接一份完整任务书');
  // 不加 --brief 时不打任务书（省得每次认领都刷屏）
  cmds.add({ _: ['FEAT-13'], title: SPEC, 'plain-title': PLAIN, ...P });
  const plain = cmds.claim({ _: ['FEAT-13'], branch: 'feat/x', ...P });
  assert.ok(!plain.text, '默认认领只回一行确认');
});

test('inbox --tid 与 brief 同源:任务书里必须含 brief 的正文,再加落地流程', (t) => {
  const { P } = setup(t);
  cmds.add({ _: ['FEAT-12'], title: SPEC, 'plain-title': PLAIN, ...P });
  askAndAnswer(P, 'FEAT-12', '锁多久?', '锁 30 分钟');
  const book = inbox({ tid: 'FEAT-12', ...P }).text;
  assert.ok(book.includes(PLAIN) && book.includes(SPEC), '同一个生成器出的正文');
  assert.match(book, /claim FEAT-12/, '任务书含 claim 命令');
  assert.match(book, /mark-landed FEAT-12 --did d1/, '任务书含逐条 mark-landed');
});

test('派单任务书生成器对最小夹具(没有 board、没有 status)也不炸', () => {
  const task = { id: 'DEMO-1', title: '示例任务', decisions: [{ id: 'd1', question: 'Q', answer: 'A', decidedAt: '2026-01-01' }] };
  const text = dispatch.buildTaskDispatchPrompt('example', '示例项目', task, task.decisions);
  assert.ok(text.includes('DEMO-1') && text.includes('示例任务'));
  assert.ok(buildBrief({ pid: 'example', projName: '示例项目', task }).includes('DEMO-1'));
});
