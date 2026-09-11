'use strict';
/** 约定位置识别的纯函数契约；事故原文与边界均不依赖本机 git/看板。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { subjectRefs, buildMatcher } = require('../cli/commitRefs.cjs');

const ids = [
  'A1', 'B2', 'A', 'B', 'P12', 'REJ-002', 'BOARD-X', 'HOTFIX', '59',
  'BOT-P2-SUBTICK-FLOW-IMPL', 'BOT-P2-SUBTICK-ALLOC-COST',
  'RESTORE-ICEBERG-QTY-DROP', 'CHAOS-R-SAME-SEED-DIVERGENCE',
  'ORDER-MARKET-PRICE-SEMANTICS-0911', 'BATCH-11B1-DIFF-SWAN', 'BUILD-DENSITY-REDESIGN',
  'ORIGIN-POOL-D4B', 'ORIGIN-POOL-D4B-ACHV', 'CLUSTER-X',
];
const matcher = buildMatcher(ids);
const cases = [
  ['事故：下一步挂卡不算归属',
    'docs(bot-p1): 技术附录回写 S2 与 W6 两行——勘测已交付 PR #549,下一步四选项挂 BOT-P2-SUBTICK-FLOW-IMPL 待拍',
    [], ['BOT-P2-SUBTICK-FLOW-IMPL'], []],
  ['事故：承接卡不算归属',
    'docs(bot-p1): 落盘 2026-09-11 拍板——S2 先补一次实测再定,承接卡 BOT-P2-SUBTICK-ALLOC-COST',
    [], ['BOT-P2-SUBTICK-ALLOC-COST'], []],
  ['约定式 scope', 'feat(A1): 完成', ['A1'], [], []],
  ['多卡 scope', 'fix(A1,B2): 完成', ['A1', 'B2'], [], []],
  ['破坏性标记与全角冒号', 'fix(A1,B2)!： 完成', ['A1', 'B2'], [], []],
  ['卡号作前缀', 'A1: 说明', ['A1'], [], []],
  ['剥前缀后开头卡号', 'docs: A1 施工记录定稿', ['A1'], [], []],
  ['卡号紧跟汉字', '[股市] P12拆分S2: 四配置对象外移', ['P12'], [], []],
  ['标签后开头与正文分开', '[HOTFIX] REJ-002 文案契约扫描范围随 P12 拆分外扩',
    ['HOTFIX', 'REJ-002'], ['P12'], []],
  ['交替剥多层前缀和标签', 'docs: [HOTFIX] fix(A1)!: 【股市】〖59〗 B2施工',
    ['HOTFIX', 'A1', '59', 'B2'], [], []],
  ['合并外壳与多卡开头', 'Merge PR #167: A + B【四闸门达标】', ['A', 'B'], [], [167]],
  ['真实多卡开头串', 'RESTORE-ICEBERG-QTY-DROP + CHAOS-R-SAME-SEED-DIVERGENCE【四闸门达标】',
    ['RESTORE-ICEBERG-QTY-DROP', 'CHAOS-R-SAME-SEED-DIVERGENCE'], [], []],
  ['开头串整号边界失败即停止', 'A1 + B2-extra，随后 B2', ['A1'], ['B2'], []],
  ['空格不算开头串分隔符', 'A1 B2 施工', ['A1'], ['B2'], []],
  ['末尾卡号与 PR 两组', '落地 (A1) (#14)   ', ['A1'], [], [14]],
  ['带嵌套说明的末尾大组',
    '落地 (A1,docs-only)【auto-merge:四闸门达标,CI run 33987 success fast+e2e(自托管 Windows runner 口径)】',
    ['A1'], [], []],
  ['多种括号混合嵌套', '落地 (A1,docs-only)【记录（验真[通过]）】', ['A1'], [], []],
  ['末尾组含两张卡', '完成 (A / B)', ['A', 'B'], [], []],
  ['末尾组带拍板说明', '完成 (ORDER-MARKET-PRICE-SEMANTICS-0911 d2)',
    ['ORDER-MARKET-PRICE-SEMANTICS-0911'], [], []],
  ['末尾组卡号在说明后', '完成 (d2 拍板 A,BATCH-11B1-DIFF-SWAN)',
    ['A', 'BATCH-11B1-DIFF-SWAN'], [], []],
  ['末尾方括号带文字', '完成 [见 A1 的复盘]', ['A1'], [], []],
  ['末尾括号必须配对', '完成 (见 A1 的复盘]', [], ['A1'], []],
  ['未闭合括号不剥', '完成 (见 A1 的复盘', [], ['A1'], []],
  ['最多剥六组', '完成 (见 A1 的复盘)(注1)(注2)(注3)(注4)(注5)(注6)', [], ['A1'], []],
  ['第六组仍算末尾', '完成 (见 A1 的复盘)(注1)(注2)(注3)(注4)(注5)', ['A1'], [], []],
  ['中间纯标注', '方案书 v1(BUILD-DENSITY-REDESIGN)——待落实', ['BUILD-DENSITY-REDESIGN'], [], []],
  ['中间说明组不算标注', '施工 (见 B2 的复盘) 后续记录', [], ['B2'], []],
  ['纯标注不能吞掉左边界字符', '施工 (!A1) 后续记录', [], ['A1'], []],
  ['正文 PR 不因末尾有卡号而生效', '已被 PR#474 覆盖(A1)', ['A1'], [], []],
  ['对账编号不是 PR', '完成 (对账#16)', [], [], []],
  ['编号范围不是 PR', '完成 (#34-36消零自由度)', [], [], []],
  ['正文编号一律忽略', 'feat(A1): PR #549、已被 PR#474 覆盖、对账#16', ['A1'], [], []],
  ['纯 PR 的全角标注', '施工 （PR#107） 记录', [], [], [107]],
  ['卡号和 PR 共组', '施工 (BOARD-X #14) 记录', ['BOARD-X'], [], [14]],
  ['纯标注允许的分隔符', '施工 (A1,，、/+&;； B2 PR #7 / #8) 记录', ['A1', 'B2'], [], [7, 8]],
  ['嵌套中仅最内层纯标注', '施工 (说明 [A1 #14]) 后续', ['A1'], [], [14]],
  ['组内有说明文字时 PR 不生效', '完成 (A1 PR #14 已验真)', ['A1'], [], []],
  ['回滚外壳', 'Revert "feat(A1): x"', ['A1'], [], []],
  ['回滚与合并外壳相套', 'Revert "Merge PR #9: fix(B2): x (#10)"', ['B2'], [], [9, 10]],
  ['无卡号说明', 'chore: 整理说明', [], [], []],
  ['默认 GitHub 合并说明', 'Merge pull request #63 from owner/fix/x', [], [], [63]],
  ['默认 GitHub 分支中的卡号是正文', 'Merge pull request #63 from owner/fix/A1', [], ['A1'], [63]],
  ['同卡两种位置只留约定位置', 'feat(A1): 承接 A1，另提 B2', ['A1'], ['B2'], []],
  ['分类按原文首次出现排序', '正文提 B2、A1、P12、REJ-002、P12，落实 (A1 / B2)',
    ['B2', 'A1'], ['P12', 'REJ-002'], []],
  ['卡号前缀不误截长号', 'ORIGIN-POOL-D4B-ACHV + ORIGIN-POOL-D4B 完成',
    ['ORIGIN-POOL-D4B-ACHV', 'ORIGIN-POOL-D4B'], [], []],
  ['只提长号不顺带命中短号', '承接 ORIGIN-POOL-D4B-ACHV', [], ['ORIGIN-POOL-D4B-ACHV'], []],
  ['大小写与 ASCII 整号边界', 'feat(a1): XA1 A1X A1-extra x-A1，另提 a1', [], [], []],
  ['PR 按出现顺序去重', 'Merge PR #9: A1 (#14) (#9) （PR#7） (#14)', ['A1'], [], [9, 14, 7]],
  ['中间纯组不受末尾六组上限影响', '施工 (A1 #14)(注1)(注2)(注3)(注4)(注5)(注6)', ['A1'], [], [14]],
  ['已有分家仓提交契约', 'fix(bot): CLUSTER-X 修好了 (#77)', ['CLUSTER-X'], [], [77]],
];
for (const [name, subject, structural, prose, prs] of cases) {
  test(name, () => assert.deepEqual(subjectRefs(subject, matcher), { structural, prose, prs }));
}

for (const separator of ['+', '/', '、', ',', '，', '&']) {
  test('开头串分隔符 ' + separator, () => {
    assert.deepEqual(subjectRefs(`A1 ${separator} B2【达标】`, matcher),
      { structural: ['A1', 'B2'], prose: [], prs: [] });
  });
}

test('标签不在卡表里时不凭空生成卡号', () => {
  assert.deepEqual(subjectRefs('[HOTFIX] REJ-002 文案契约扫描范围随 P12 拆分外扩',
    buildMatcher(['REJ-002', 'P12'])), { structural: ['REJ-002'], prose: ['P12'], prs: [] });
});

test('空卡表、空 subject 与正则特殊字符', () => {
  assert.deepEqual(subjectRefs('Merge PR #7: chore: x (#8)', buildMatcher([])),
    { structural: [], prose: [], prs: [7, 8] });
  assert.deepEqual(subjectRefs('', matcher), { structural: [], prose: [], prs: [] });
  assert.deepEqual(subjectRefs('A.1 + B$2 完成', buildMatcher(['A.1', 'B$2'])),
    { structural: ['A.1', 'B$2'], prose: [], prs: [] });
});

test('复用匹配器不串 subject、不重编译卡号正则且不改变输入', (t) => {
  const source = Object.freeze(['A1', 'B2']);
  const reusable = buildMatcher(source);
  reusable.all.lastIndex = 3;
  t.mock.method(globalThis, 'RegExp', function () { assert.fail('subjectRefs 不应重建卡号正则'); });
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(subjectRefs('feat(A1): 提到 B2 (#14)', reusable),
      { structural: ['A1'], prose: ['B2'], prs: [14] });
    assert.deepEqual(subjectRefs('chore: 没有关联', reusable), { structural: [], prose: [], prs: [] });
    assert.equal(reusable.all.lastIndex, 3);
  }
  assert.deepEqual(source, ['A1', 'B2']);
});
