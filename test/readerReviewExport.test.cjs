'use strict';
/**
 * readerReviewExport.test.cjs —— 审阅台「导出给外脑」(READER-EXPORT-REVIEW)。
 *
 * 覆盖(①~⑦ 纯函数,⑧ 路由):
 *   ① 标题行 + 两行引用(批阅日期 / 事实基线 / 批注条数)
 *   ② A 节六列表格:按批注时间升序、追问/批注归类、| 转义与换行 <br>
 *   ③ 无批注时 A 节写「(暂无批注)」,不出表格、不出现批注块
 *   ④ B 节只收 纠正/改判/冲突 边注、正文「你」换成「负责人」;一条没有时整节不出现
 *   ⑤ C 节:入库说明剔除、批注插所在小节末尾、编号与 A 表一致、未定位批注集中最前
 *   ⑥ 定位通用版:认 1~6 级标题、anchor 子串匹配、取第一个命中、小节末尾=下一个级别≤它的标题前或文末
 *   ⑦ exportFileName:非法字符换 -、总长 ≤ 80、日期压成 YYYYMMDD
 *   ⑧ GET /api/reader/export-review:200 回 ok/fileName/md/annoCount;key 非法 400、
 *      项目未注册 404、报告不存在 404;并钉住 report 路由的返回体字段没被这次重构改动
 *
 * 路由用例不起真服务:用假依赖直驱 createReaderApi 的 route 表,清单/正文落临时目录,
 * 批注账本直写临时数据根;全程虚构项目 demo-a,不碰真实数据。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildReviewExport, exportFileName } = require('../server/readerReviewExport.cjs');
const { createReaderApi } = require('../server/readerApi.cjs');

const TODAY = '2026-09-19';

/** 虚构报告:开头带「入库说明」(一级标题 + 引用块 + ---),正文两级小节 + 一个三级子节 */
const REPORT_MD = [
  '# 外脑回运 · 演示项目评估',
  '',
  '> 来源:外脑对话存档',
  '> 状态:评估件 · 仅供演示',
  '',
  '---',
  '',
  '## 第 1 页 · 总览',
  '',
  '总览的正文段。',
  '',
  '### 1.1 细分口径',
  '',
  '细分正文。',
  '',
  '## 第 2 页 · 结论',
  '',
  '结论正文。',
  '',
].join('\n');

/** 三条批注:at 故意乱序给,导出必须按时间升序编号;anchor 覆盖 子串/精确/找不到 三种 */
const ANNOS = [
  { id: 'a2', anchor: '第 2 页', quote: '结论正文', text: '这里下结论太急,能不能补数据?', at: '2026-09-18T02:00:00.000Z' },
  { id: 'a1', anchor: '细分口径', quote: '细分正文', text: '补个数据来源 | 竖线\n第二行意见', at: '2026-09-17T09:00:00.000Z' },
  { id: 'a3', anchor: '不存在的小节', quote: '', text: '这条找不到位置', at: '2026-09-16T09:00:00.000Z' },
];

/** 边注:纠正/改判/冲突 三条进 B 节,提示/现状 两种不进 */
const NOTE_LAYERS = [
  { id: 'L1', name: '第一层', notes: [
    { anchor: '全篇', kind: '提示', text: '普通提示,不进 B 节' },
    { anchor: '1.1', kind: '纠正', text: '你这里说的与现状不符' },
    { anchor: '1.1', kind: '改判', text: '你的建议会推翻已拍的板' },
    { anchor: '全篇', kind: '冲突', text: '与另一处待拍板的事同问' },
    { anchor: '全篇', kind: '现状', text: '普通现状,不进 B 节' },
  ] },
  { id: 'L2', name: '第二层', notes: [] },
];

function build(md, annos, notes) {
  return buildReviewExport({ meta: { title: '演示报告', version: 'v2' }, batch: { baseline: 'main@demo' }, md, annos, notes, today: TODAY });
}

test('① 标题行与两行引用:标题、版本、批阅日期、事实基线、批注条数', () => {
  const lines = build(REPORT_MD, ANNOS, NOTE_LAYERS).split('\n');
  assert.equal(lines[0], '# 批阅意见单 · 演示报告 v2 → 回运给外脑');
  assert.equal(lines[2], '> 负责人批阅日期:2026-09-19;整理:由审阅台批注账本机械导出(未改一字)。报告事实基线:main@demo');
  assert.equal(lines[3], '> 共 3 条批注。「类型」一栏是整理时按内容归的类,不是负责人写的,负责人可改。');
  // 没写 version 时不留尾随空格
  const noVer = buildReviewExport({ meta: { title: '演示报告' }, batch: {}, md: REPORT_MD, annos: [], notes: [], today: TODAY });
  assert.equal(noVer.split('\n')[0], '# 批阅意见单 · 演示报告 → 回运给外脑');
});

test('② A 节六列表格:按 at 升序、追问/批注归类、| 转义、换行 <br>', () => {
  const out = build(REPORT_MD, ANNOS, NOTE_LAYERS);
  const table = out.split('\n').filter((l) => l.startsWith('| '));
  assert.equal(table.length, 4, '表头 + 3 条批注(分隔行 |---| 不以"| "开头,不计)');
  assert.equal(table[0], '| # | 节号/位置 | 报告原文(引用) | 负责人意见(原话) | 类型 | 要求外脑做什么 |');
  // 升序:1 号是最早的「找不到位置」
  assert.match(table[1], /^\| 1 \| 不存在的小节 \| {2}\|/);
  // | 转义 + 换行 <br>;普通批注的「要求外脑做什么」
  assert.equal(table[2], '| 2 | 细分口径 | 细分正文 | 补个数据来源 \\| 竖线<br>第二行意见 | 批注 | 按批注修订或回应 |');
  // 含问号的归「追问」
  assert.equal(table[3], '| 3 | 第 2 页 | 结论正文 | 这里下结论太急,能不能补数据? | 追问 | 回答负责人的追问,并说明是否需要修订正文 |');
});

test('③ 无批注:A 节写「(暂无批注)」,不出表格、不出现批注块', () => {
  const out = build(REPORT_MD, [], []);
  assert.ok(out.includes('\n(暂无批注)\n'));
  assert.ok(!out.includes('| # |'));
  assert.ok(!out.includes('【负责人批注'));
});

test('④ B 节:只收 纠正/改判/冲突、你换成负责人;一条没有时整节连标题都不出现', () => {
  const out = build(REPORT_MD, ANNOS, NOTE_LAYERS);
  assert.ok(out.includes('## B. 回流对账里外脑该知道的(报告只读了资料包,没看到这些;不需要的整节删掉即可)'));
  assert.ok(out.includes('**B1. [纠正] 1.1**'));
  assert.ok(out.includes('**B2. [改判] 1.1**'));
  assert.ok(out.includes('**B3. [冲突] 全篇**'));
  assert.ok(out.includes('负责人这里说的与现状不符'), '「你」应换成「负责人」');
  assert.ok(!out.includes('你这里说的'));
  assert.ok(!out.includes('普通提示'), '提示/现状 两种不进 B 节');
  // A → B → C 的顺序
  assert.ok(out.indexOf('## A.') < out.indexOf('## B.') && out.indexOf('## B.') < out.indexOf('## C.'));
  // 没有可收边注时整节不出现(连标题也不出现);notes 缺失也不炸
  const keep = [{ id: 'L1', name: '层', notes: [{ anchor: '全篇', kind: '提示', text: 'x' }] }];
  assert.ok(!build(REPORT_MD, [], keep).includes('## B.'));
  assert.ok(!build(REPORT_MD, [], undefined).includes('## B.'));
});

test('⑤ C 节:入库说明剔除、批注插所在小节末尾、编号与 A 表一致、未定位批注集中最前', () => {
  const out = build(REPORT_MD, ANNOS, NOTE_LAYERS);
  const c = out.slice(out.indexOf('## C. 报告原文'));
  assert.ok(c.startsWith('## C. 报告原文(负责人批注已插在对应小节末尾)'));
  // 入库说明:引用块与 --- 剔掉,一级标题保留
  assert.ok(!c.includes('> 来源:外脑对话存档'));
  assert.ok(!c.includes('\n---\n'));
  assert.ok(c.includes('# 外脑回运 · 演示项目评估'));
  // 未定位批注集中在 C 最前、正文之前
  const looseAt = c.indexOf('**未能定位到具体页的批注:**');
  const bodyAt = c.indexOf('# 外脑回运 · 演示项目评估');
  assert.ok(looseAt > 0 && looseAt < bodyAt);
  assert.ok(c.includes('> **【负责人批注 1】**\n> 这条找不到位置'));
  // 批注 2:插在「### 1.1 细分口径」小节末尾(下一个级别≤3 的标题之前),带 quote 引用
  const sec2At = c.indexOf('## 第 2 页 · 结论');
  const anno2At = c.indexOf('> **【负责人批注 2】**(针对:「细分正文」)');
  assert.ok(anno2At > c.indexOf('细分正文。') && anno2At < sec2At);
  // 多行批注逐行加 >
  assert.ok(c.includes('> 补个数据来源 | 竖线\n> 第二行意见'));
  // 批注 3:最后一节的末尾=文末
  const anno3At = c.indexOf('> **【负责人批注 3】**(针对:「结论正文」)');
  assert.ok(anno3At > sec2At);
  assert.ok(c.trimEnd().endsWith('> 这里下结论太急,能不能补数据?'));
});

test('⑥ 定位通用版:认多级标题、子串匹配、只挂第一个命中、小节末尾=下一个同级标题前或文末', () => {
  // anchor「重复小节」命中第一处;小节含三级子节,批注应挂整节末尾(下一个同级标题之前)
  const md2 = [
    '# 报告',
    '',
    '## 重复小节',
    '',
    '第一处正文。',
    '',
    '### 重复小节展开',
    '',
    '展开的正文。',
    '',
    '## 之后的小节',
    '',
    '后面的正文。',
    '',
  ].join('\n');
  const c2 = build(md2, [{ anchor: '重复小节', text: '挂在整节末尾', at: '2026-09-18T00:00:00.000Z' }], [])
    .slice(build(md2, [], []).indexOf('## C.'));
  const where = c2.indexOf('> **【负责人批注 1】**');
  assert.ok(where > c2.indexOf('展开的正文。'), '批注应挂在整节(含子节)末尾');
  assert.ok(where < c2.indexOf('## 之后的小节'), '批注应插在下一个级别≤它的标题之前');
  assert.equal(c2.indexOf('> **【负责人批注 1】**', where + 1), -1, '只挂第一处命中,不重复挂');
  // 四级标题也能命中;最后一节的末尾=文末
  const md3 = '# 顶层\n\n#### 四级标题\n\n深处的正文。\n';
  const c3 = build(md3, [{ anchor: '四级', text: '深处批注', at: '2026-09-18T00:00:00.000Z' }], [])
    .slice(build(md3, [], []).indexOf('## C.'));
  assert.ok(c3.indexOf('> **【负责人批注 1】**') > c3.indexOf('深处的正文。'));
  assert.ok(c3.trimEnd().endsWith('> 深处批注'));
  // 空 anchor = 未定位,不许丢
  const out4 = build(md3, [{ text: '整篇批注', at: '2026-09-18T00:00:00.000Z' }], []);
  assert.ok(out4.includes('**未能定位到具体页的批注:**'));
  assert.ok(out4.includes('> 整篇批注'));
});

test('⑦ 入库说明剔除的判定:形态不合或超出前 40 行就不剔,原样进 C 节', () => {
  // --- 之前夹了普通正文 → 不算入库说明
  const mdNotHeader = '# 报告\n\n正文一段。\n\n---\n\n## 第 1 页\n\n内容\n';
  const outN = build(mdNotHeader, [], []);
  assert.ok(outN.includes('正文一段。'));
  assert.ok(outN.includes('\n---\n'));
  // 没有 --- → 原样
  const mdNoSep = '# 报告\n\n> 引用开头\n\n## 第 1 页\n\n内容\n';
  assert.ok(build(mdNoSep, [], []).includes('> 引用开头'));
  // 分隔线在第 40 行之外(之前全是引用块,形态本来合格)→ 不剔
  const lines = ['# 报告', ''];
  for (let i = 0; i < 46; i++) lines.push('> 引用第' + i + '行');
  lines.push('---', '', '## 第 1 页', '', '内容', '');
  const outFar = build(lines.join('\n'), [], []);
  assert.ok(outFar.includes('> 引用第0行'));
  assert.ok(outFar.includes('\n---\n'));
});

test('⑦ exportFileName:非法字符换 -,批阅意见单前缀,日期压成 YYYYMMDD,总长 ≤ 80', () => {
  assert.equal(exportFileName('演示:报告/第一版*草稿', '2026-09-19'), '批阅意见单-演示-报告-第一版-草稿-20260919.md');
  assert.equal(exportFileName('含"引号"和\\斜杠', '2026-09-19'), '批阅意见单-含-引号-和-斜杠-20260919.md');
  const long = exportFileName('长'.repeat(200), '2026-09-19');
  assert.ok(long.length <= 80, '总长不得超过 80 字符,实际 ' + long.length);
  assert.ok(long.startsWith('批阅意见单-') && long.endsWith('-20260919.md'));
});

// ---------- ⑧ 路由:假依赖直驱 createReaderApi 的 route 表,不起真服务 ----------

let FX = null;
before(() => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rex-export-')));
  const repo = path.join(root, 'repo');
  const rel = 'docs/design/审计回流';
  fs.mkdirSync(path.join(repo, rel), { recursive: true });
  fs.writeFileSync(path.join(repo, rel, 'R1.md'), REPORT_MD, 'utf8');
  fs.writeFileSync(path.join(repo, rel, 'reader.json'), JSON.stringify({
    schemaVersion: 1,
    batches: [{ id: 'b1', name: '演示批', baseline: 'main@demo', reports: [
      { key: 'R1', title: '演示报告', version: 'v2', md: rel + '/R1.md', project: 'demo-a' },
    ] }],
  }), 'utf8');
  const dataRoot = path.join(root, 'home');
  const ledgerDir = path.join(dataRoot, 'data', 'reader', 'demo-a');
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.writeFileSync(path.join(ledgerDir, 'R1.json'), JSON.stringify({
    schemaVersion: 2, project: 'demo-a', key: 'R1',
    annos: [{ id: 'a1', blockId: 'b', anchor: '细分口径', quote: '细分正文', text: '批注走账本', author: '负责人', at: '2026-09-17T09:00:00.000Z' }],
    highlights: [], review: null,
  }), 'utf8');
  FX = { root, repo, dataRoot };
});
after(() => {
  if (FX) { try { fs.rmSync(FX.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 清理失败不判红 */ } }
});

/** 用假依赖建 readerApi 并驱动一次 route;返回是否接住 + sendJson 收到的第一笔回包 */
function drive(query, action, method) {
  const sent = [];
  const api = createReaderApi({
    resolveProjectSafe: (id) => (id === 'demo-a' ? { docsRoot: FX.repo } : null),
    sendJson: (_res, status, body) => sent.push({ status, body }),
    readBody: () => { throw new Error('export-review 是 GET,不该读请求体'); },
    bodyMax: 1024,
    dashRoot: FX.dataRoot,
    dataRoot: FX.dataRoot,
    cliIndex: 'cli-index',
    registry: '',
    registryPath: '',
    pollBoards: null,
  });
  const handled = api.route(action || 'export-review', { method: method || 'GET' }, {}, query || {});
  return { handled, first: sent[0] || null };
}

test('⑧ 路由 export-review:200 回 ok/fileName/md/annoCount,md 里批注齐活', () => {
  const { handled, first } = drive({ project: 'demo-a', key: 'R1' });
  assert.equal(handled, true);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.ok, true);
  assert.equal(first.body.annoCount, 1);
  assert.match(first.body.fileName, /^批阅意见单-演示报告-\d{8}\.md$/);
  assert.ok(first.body.md.startsWith('# 批阅意见单 · 演示报告 v2 → 回运给外脑'));
  assert.ok(first.body.md.includes('【负责人批注 1】**(针对:「细分正文」)'));
  assert.ok(first.body.md.includes('批注走账本'));
});

test('⑧ 路由 export-review:key 非法 400;项目未注册 404;报告不存在 404;非 GET 不接', () => {
  assert.equal(drive({ project: 'demo-a', key: 'bad key' }).first.status, 400);
  assert.equal(drive({ project: 'nope', key: 'R1' }).first.status, 404);
  assert.equal(drive({ project: 'demo-a', key: 'NOPE' }).first.status, 404);
  assert.equal(drive({ project: 'demo-a', key: 'R1' }, 'export-review', 'POST').handled, false);
});

test('⑧ 路由 report:抽内部函数后返回体字段与既有契约一致', () => {
  const { handled, first } = drive({ project: 'demo-a', key: 'R1' }, 'report');
  assert.equal(handled, true);
  assert.equal(first.status, 200);
  assert.deepEqual(
    Object.keys(first.body).sort(),
    ['annos', 'batch', 'highlights', 'md', 'notes', 'ok', 'prevMd', 'project', 'report', 'review'],
  );
  assert.equal(first.body.md, REPORT_MD);
  assert.equal(first.body.prevMd, null, '清单没写 prevMd 时回 null');
  assert.equal(first.body.annos.length, 1, '批注从本机账本读出');
  assert.deepEqual(first.body.batch, { id: 'b1', name: '演示批', baseline: 'main@demo' });
});
