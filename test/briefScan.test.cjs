'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { splitSentences, scanBrief, textOfTask, textOfCard, formatRejection, projectAdopted } = require('../cli/briefScan.cjs');

const entry = path.join(__dirname, '..', 'cli', 'briefScan.cjs');
function cli(...args) {
  try {
    return { code: 0, stdout: execFileSync('node', [entry, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}

test('逐句识别待拍板要求，放过引用、否定和明确分类', () => {
  const flagged = ['分解产出后停下等负责人拍板开工。', '有冲突立刻停下问负责人,严禁自动解。', '遇到岔路停下汇报给负责人。', '遇到岔路停下报告负责人。', '停下报告，等负责人拍板再继续。', '没有这个型号时先问负责人。', '等我说开工再动代码。', '正式施工等拍板。'];
  for (const sentence of flagged) {
    const result = scanBrief(sentence);
    assert.equal(result.hits.length, 1, sentence);
    assert.equal(result.hits[0].sentence, sentence);
    assert.equal(result.hits[0].rule, 'ask');
  }
  const allowed = ['不用先问负责人,直接做。', '启动指令里不写「先问负责人」「等我说开工」。', '这道检查拦下夹带先问负责人的句子。', '花钱超过 10 元先问负责人。', '要动生产先问负责人。', '收单链还是停下等人救。', '工人也可能去跑测试被拒、停下来问。', "openQuestions 为 ['等拍板']。", '工人遇到岔路停下交 blocked。', '有冲突立刻停下报告,严禁自动解。', '对契约未覆盖的机制选择停下报告，不扩面。', '发现对不上就停下来报告', '停下报告给派单方。'];
  for (const sentence of allowed) assert.deepEqual(scanBrief(sentence).hits, [], sentence);
  const paragraph = '第一句正常。没有这个型号时先问负责人。第三句也正常。';
  assert.deepEqual(splitSentences(paragraph), ['第一句正常。', '没有这个型号时先问负责人。', '第三句也正常。']);
  assert.equal(scanBrief(paragraph).hits[0].sentence, '没有这个型号时先问负责人。');
  assert.equal(scanBrief(paragraph).hits.length, 1);
});

test('卡面风险不拦游戏里的买卖、手续费、负责人自己充值、看板发版', () => {
  for (const sentence of [
    '玩家花钱买情报提前躲雷。',
    '成交流水显示手续费。',
    'P 路线须对发生真实付费购买,同 seed 150 局。',
    '到负责人充值或次日刷新前跳过。',
    '负责人充值后自动路由恢复。',
    '看板仓合并后发版。',
    '看板仓让开工任务书印出卡片描述并发版。',
    '机器人花钱上限改成现金减 3 天账单。',
  ]) assert.deepEqual(scanBrief(sentence, { kind: 'card' }).hits, [], sentence);
  const cases = [
    ['本卡要充值 200 元买 Codex 额度。', '充值'],
    ['收官后花钱买 Steam 测试 key。', '花钱买'],
    ['月底续费 Codex Plus。', '续费'],
    ['删玩家存档后重开。', '删玩家存档'],
    ['游戏收官后发版到 Steam。', '发版'],
    ['看板改完,游戏发版。', '发版'],
    ['玩家花钱买情报,随后我们发版。', '发版'],
    ['部署到 VPS 后重启服务。', '部署到 VPS'],
    ['收官后发版。', '发版'],
  ];
  for (const [sentence, match] of cases) {
    const hits = scanBrief(sentence, { kind: 'card' }).hits;
    assert.equal(hits.length, 1, sentence);
    assert.equal(hits[0].rule, 'risk', sentence);
    assert.equal(hits[0].match, match, sentence);
  }
});

test('卡面风险及文本提取', () => {
  assert.equal(scanBrief('收官后发版。', { kind: 'card' }).hits[0].rule, 'risk');
  for (const text of ['负责人 2026-11-11 原话「照这个改」。收官后发版。', '本卡不发版。', '机器人花钱上限改成现金减 3 天账单。']) assert.deepEqual(scanBrief(text, { kind: 'card' }).hits, []);
  assert.deepEqual(scanBrief('收官后发版。', { kind: 'job' }).hits, []);
  assert.throws(() => scanBrief('文字', { kind: 'xxx' }));
  const task = { title: '标题', goal: '先问负责人。', background: '背景', nonGoals: ['不做', 1], steps: ['施工'], acceptance: [{ note: '验收' }, {}], allowedPaths: ['先问负责人'], slug: '先问负责人' };
  assert.equal(textOfTask(task), '标题\n先问负责人。\n背景\n不做\n施工\n验收');
  assert.equal(scanBrief(textOfTask(task)).hits.length, 1);
  assert.equal(scanBrief(textOfTask({ allowedPaths: ['先问负责人'] })).hits.length, 0);
  assert.equal(textOfCard({ title: '标题', plainTitle: '人话', desc: '描述', description: '说明' }), '标题\n人话\n描述\n说明');
  const message = formatRejection(scanBrief(task.goal).hits);
  assert.match(message, /先问负责人/);
  assert.match(message, /六类/);
});

test('授权页与真实入口', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-scan-'));
  try {
    assert.equal(projectAdopted(undefined), false);
    assert.equal(projectAdopted(dir), false);
    let result = cli('--text', '先问负责人。');
    assert.equal(result.code, 3);
    assert.match(result.stderr, /先问负责人/);
    result = cli('--text', '直接做。');
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
    result = cli('--repo', dir, '--text', '先问负责人。');
    assert.equal(result.code, 0);
    assert.match(result.stdout, /不扫/);
    const job = path.join(dir, 'job.json');
    fs.writeFileSync(job, '\ufeff' + JSON.stringify({ goal: '先问负责人。' }));
    result = cli('--file', job, '--kind', 'job');
    assert.equal(result.code, 3);
    result = cli('--json', '--text', '先问负责人。');
    assert.equal(result.code, 3);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.adopted, true);
    assert.equal(parsed.hits.length, 1);
    assert.match(parsed.message, /先问负责人/);
    assert.equal(cli().code, 2);
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, 'docs', '授权页.md'), '授权');
    assert.equal(projectAdopted(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
