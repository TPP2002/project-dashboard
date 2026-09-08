'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const cmds = require('../cli/commands.cjs');
const { readBoard } = require('../cli/store.cjs');
const { requestInfo } = require('../cli/requestInfo.cjs');
const { brief, recentHumanNotes } = require('../cli/brief.cjs');
const { inbox } = require('../cli/inboxCmd.cjs');
const { doctor } = require('../cli/gitSync.cjs');

const CLI = path.resolve(__dirname, '../cli/index.cjs');
const INFO = { background: '背'.repeat(60), optionPros: { A: '甲'.repeat(20), B: '乙'.repeat(20) }, recommendReason: '荐'.repeat(30) };

function setup(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'human-channel-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root);
  cmds.register({ id: 'human', name: '负责人留言测试', root, registry });
  const P = { project: 'human', registry };
  cmds.add({ ...P, _: ['P01'], title: '施工细节', 'plain-title': '负责人可以留下开工提醒', status: '待开工' });
  const board = path.join(root, '.dashboard', 'board.json');
  const run = (args) => spawnSync(process.execPath, [CLI, ...args, '--project', P.project, '--registry', registry], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000,
    env: { ...process.env, DASHBOARD_SKIP_SERVICE_PROBE: '1' },
  });
  return { P, board, run };
}

// 老板允许缺三件套；用 CLI set 构造遗留决策，不手写 board。
function setDecision(P, fields = {}) {
  const decision = { id: 'd1', question: '应该采用哪个方案？', options: ['A', 'B'], recommended: 'A', answer: null, decidedAt: null, ...fields };
  cmds.set({ ...P, _: ['P01'], field: 'decisions', value: JSON.stringify([decision]) });
}
const ask = (P, fields = {}) => requestInfo({ ...P, _: ['P01'], did: 'd1', missing: 'background,optionPros', ...fields });

test('note --from human 固定负责人署名，保留位置卡号与 --task，其他身份原样', (t) => {
  const { P, board, run } = setup(t);
  const result = run(['note', 'P01', '--text', '请先看负责人留下的说明', '--from', 'human', '--author', '不能覆盖负责人', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).taskId, 'P01');
  const first = readBoard(board).activity.at(-1);
  assert.equal(first.author, '负责人');
  assert.equal(first.kind, 'message');
  assert.equal(first.type, 'note');
  assert.equal(first.taskId, 'P01');
  cmds.note({ ...P, task: 'P01', text: '审阅说明', from: '审阅人' });
  assert.equal(readBoard(board).activity.at(-1).author, '审阅人');
  cmds.note({ ...P, _: ['P01'], text: '保持旧署名语义', author: 'human' });
  assert.equal(readBoard(board).activity.at(-1).author, 'human');
});

test('request-info 真 CLI 写活动与 infoRequestedAt，JSON 只返回变更摘要', (t) => {
  const { P, board, run } = setup(t);
  setDecision(P);
  const result = run(['request-info', 'P01', '--did', 'd1', '--missing', 'background,optionPros', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, id: 'P01', status: '待开工', percent: 0, changed: ['decisions'] });
  const saved = readBoard(board);
  const decision = saved.tasks[0].decisions[0];
  assert.match(decision.infoRequestedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(decision.answer, null);
  assert.deepEqual(saved.activity.at(-1), {
    ts: decision.infoRequestedAt, type: 'note', kind: 'request-info', author: '负责人',
    taskId: 'P01', did: 'd1', missing: ['background', 'optionPros'],
    text: '负责人要求补齐 d1 的三件套：background、optionPros',
  });
  ask(P, { missing: 'recommendReason', author: '项目负责人' });
  assert.equal(readBoard(board).activity.at(-1).author, '项目负责人');
});

test('request-info 拒绝已答决策、无此卡和无此决策，失败不落盘', (t) => {
  const { P, board } = setup(t);
  setDecision(P, { answer: 'A', decidedAt: '2026-09-08' });
  const before = fs.readFileSync(board, 'utf8');
  assert.throws(() => ask(P), /已答/);
  assert.throws(() => ask(P, { _: ['NO-TASK'] }), /任务 NO-TASK 不存在/);
  assert.throws(() => ask(P, { did: 'd99' }), /决策 P01·d99 不存在/);
  assert.equal(fs.readFileSync(board, 'utf8'), before);
});

test('request-info 拒绝非法或空 missing，不误写 timestamp 或活动', (t) => {
  const { P, board } = setup(t);
  setDecision(P);
  const before = fs.readFileSync(board, 'utf8');
  for (const missing of ['status', 'background,answer', 'background,', 'background,,optionPros', '', true, ['background']]) {
    assert.throws(() => ask(P, { missing }), /missing/);
    assert.equal(fs.readFileSync(board, 'utf8'), before);
  }
});

test('brief 标题后先读负责人最近三条，倒序、截断且不混入其他卡与记账流水', (t) => {
  const { P, board } = setup(t);
  cmds.add({ ...P, _: ['P02'], title: '另一张卡', 'plain-title': '另一张卡的留言', author: '负责人' });
  setDecision(P);
  cmds.note({ ...P, _: ['P01'], from: 'human', text: '已被挤出的旧留言' });
  cmds.note({ ...P, _: ['P01'], from: 'human', text: '先看这条说明' });
  cmds.note({ ...P, _: ['P01'], from: 'human', text: '长'.repeat(260) });
  ask(P);
  cmds.note({ ...P, _: ['P02'], from: 'human', text: '另一张卡的私有提醒' });
  cmds.note({ ...P, from: 'human', text: '项目级提醒' });
  cmds.note({ ...P, _: ['P01'], author: '施工方', text: '施工方汇报' });
  const text = brief({ ...P, _: ['P01'] }).text;
  assert.match(text, /^# P01[^\n]*\n\n## 负责人留言（最近 3 条，先读）/);
  const top = text.slice(text.indexOf('## 负责人留言'), text.indexOf('**项目**'));
  assert.equal(top.split('\n').filter((line) => line.startsWith('- ')).length, 3);
  assert.ok(top.indexOf('要求补齐 d1') < top.indexOf('长'.repeat(10)));
  assert.ok(top.indexOf('长'.repeat(10)) < top.indexOf('先看这条说明'));
  assert.doesNotMatch(text, /已被挤出的旧留言|另一张卡的私有提醒|项目级提醒/);
  assert.doesNotMatch(top, /施工方汇报|新建任务/);
  assert.match(text, /## 最近留言[\s\S]*施工方汇报/);
  assert.ok(recentHumanNotes(readBoard(board), 'P01').every((note) => note.text.length <= 200));
  assert.ok(!text.includes('长'.repeat(200)));
});

test('没有负责人留言不输出置顶段；claim --brief 和 inbox --tid 复用置顶内容', (t) => {
  const { P } = setup(t);
  assert.doesNotMatch(brief({ ...P, _: ['P01'] }).text, /## 负责人留言/);
  setDecision(P, { ...INFO, answer: 'A', decidedAt: '2026-09-08' });
  cmds.note({ ...P, _: ['P01'], from: 'human', text: '开工之前先确认负责人说明' });
  const texts = [brief({ ...P, _: ['P01'] }).text, inbox({ ...P, tid: 'P01' }).text,
    cmds.claim({ ...P, _: ['P01'], branch: 'test/human-channel', brief: true }).text];
  for (const text of texts) {
    assert.match(text, /# P01[^\n]*\n\n## 负责人留言（最近 3 条，先读）/);
    assert.ok(text.indexOf('开工之前先确认负责人说明') < text.indexOf('## 技术说明'));
  }
});

test('doctor --quick 要求补三件套按决策计数，补齐或答复后解除提醒', (t) => {
  const { P, board } = setup(t);
  setDecision(P);
  ask(P);
  ask(P);
  let report = doctor({ ...P, quick: true });
  assert.equal(report.ok, false);
  assert.match(report.text, /1 条待拍板被负责人要求补三件套：P01·d1/);
  const stamp = readBoard(board).tasks[0].decisions[0].infoRequestedAt;
  setDecision(P, { ...INFO, infoRequestedAt: stamp, optionPros: { A: '太短', B: INFO.optionPros.B } });
  assert.match(doctor({ ...P, quick: true }).text, /要求补三件套/);
  setDecision(P, { ...INFO, infoRequestedAt: stamp });
  assert.doesNotMatch(doctor({ ...P, quick: true }).text, /要求补三件套/);
  setDecision(P, { infoRequestedAt: stamp, answer: 'A', decidedAt: '2026-09-08' });
  assert.doesNotMatch(doctor({ ...P, quick: true }).text, /要求补三件套/);
  setDecision(P, { infoRequestedAt: undefined });
  assert.doesNotMatch(doctor({ ...P, quick: true }).text, /要求补三件套/);
});

test('precheck 在看板占用后展示项目最近五条负责人留言并报告补齐要求', (t) => {
  const { P, run } = setup(t);
  setDecision(P);
  cmds.add({ ...P, _: ['P02'], title: '第二张卡' });
  for (let i = 1; i <= 6; i++) cmds.note({ ...P, _: [i % 2 ? 'P01' : 'P02'], from: 'human', text: `负责人指示 ${i}` });
  ask(P);
  const result = run(['precheck', '--no-fetch']);
  assert.equal(result.status, 0, result.stderr);
  const start = result.stdout.indexOf('【负责人留言】');
  assert.ok(start > result.stdout.indexOf('【② 看板占用】'));
  const section = result.stdout.slice(start, result.stdout.indexOf('【③ 正本必读'));
  assert.match(section, /P01.*要求补齐 d1/);
  assert.match(section, /P02.*负责人指示 6/);
  assert.match(section, /1 条待拍板被负责人要求补三件套：P01·d1/);
  assert.doesNotMatch(section, /负责人指示 [12]/);
  assert.equal(section.split('\n').filter((line) => /^  P0[12] ·/.test(line)).length, 5);
});
