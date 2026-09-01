'use strict';
// DOCS-LIFECYCLE-GOVERNANCE(0901):docs-audit 探雷器四桶判定 + 建卡幂等。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cmds = require('../cli/commands.cjs');
const { docsAudit } = require('../cli/docsAudit.cjs');

function setup() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'da-')));
  const reg = path.join(dir, 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ schemaVersion: '1.0', projects: {} }));
  const root = path.join(dir, 'repo');
  fs.mkdirSync(path.join(root, 'docs', 'design'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'plans'), { recursive: true });
  cmds.register({ id: 'd', name: 'x', root, registry: reg });
  return { dir, root, P: { project: 'd', registry: reg } };
}
const clean = (dir) => fs.rmSync(dir, { recursive: true, force: true });
const md = (root, rel, head) => fs.writeFileSync(path.join(root, 'docs', rel), `# 标题\n${head}\n\n正文……\n`);

test('docs-audit:四桶判定(疑似转历史/核对过期/无标签/旧式)+归档态跳过', () => {
  const { dir, root, P } = setup();
  // 关联卡:60 天前完工
  const old = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  cmds.add({ _: ['CARD-A'], title: 'x', ...P });
  cmds.done({ _: ['CARD-A'], ...P });
  // 手改完工日期为 60 天前(done 写的是今天)
  const boardPath = path.join(root, '.dashboard', 'board.json');
  const b = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  b.tasks.find((t) => t.id === 'CARD-A').dates.done = old;
  fs.writeFileSync(boardPath, JSON.stringify(b));

  md(root, 'design/a-该转历史.md', '> 状态:正本 · 关联卡 CARD-A · 最后核对 ' + new Date().toISOString().slice(0, 10));
  md(root, 'design/b-核对过期.md', '> 状态:正本 · 最后核对 2026-01-01');
  md(root, 'plans/c-无标签.md', '(没有状态行的普通文档)');
  md(root, 'design/d-旧式.md', '**✅ 定稿(2026-07-02)+审①修订已落地**');
  md(root, 'plans/e-已归档.md', '> 状态:已被 design/新方案.md 取代');

  const r = docsAudit({ ...P });
  assert.match(r.text, /【A 疑似该转历史】1 篇/);
  assert.match(r.text, /a-该转历史.*CARD-A 已完工 (59|60|61) 天/);
  assert.match(r.text, /【B 核对过期】1 篇/);
  assert.match(r.text, /b-核对过期/);
  assert.match(r.text, /【C 无标签】1 篇/);
  assert.match(r.text, /c-无标签/);
  assert.match(r.text, /旧式定稿标注 1/);
  assert.match(r.text, /已归档态 1/);
  assert.ok(!/e-已归档.*已完工/.test(r.text), '归档态不进 A 桶');
  clean(dir);
});

test('docs-audit --create-card:建巡检卡且幂等,报告文件落盘', () => {
  const { dir, root, P } = setup();
  md(root, 'plans/x-无标签.md', '裸文档');
  const r1 = docsAudit({ ...P, 'create-card': true });
  assert.match(r1.text, /已建巡检卡 DOCS-AUDIT-\d{6}/);
  const r2 = docsAudit({ ...P, 'create-card': true });
  assert.match(r2.text, /已存在,跳过建卡/);
  const b = JSON.parse(fs.readFileSync(path.join(root, '.dashboard', 'board.json'), 'utf8'));
  const cards = b.tasks.filter((t) => t.id.startsWith('DOCS-AUDIT-'));
  assert.equal(cards.length, 1, '幂等:只建一张');
  assert.equal(cards[0].status, '未开工');
  const reports = fs.readdirSync(path.join(root, '.dashboard')).filter((f) => f.startsWith('docs-audit-'));
  assert.equal(reports.length, 1, '报告文件应落盘');
  clean(dir);
});

test('docs-audit:三桶全空时不建卡', () => {
  const { dir, root, P } = setup();
  md(root, 'design/ok.md', '> 状态:正本 · 最后核对 ' + new Date().toISOString().slice(0, 10));
  const r = docsAudit({ ...P, 'create-card': true });
  assert.match(r.text, /三桶全空,本月无需巡检卡/);
  clean(dir);
});

test('docs-audit --monthly-tick:首跑记账,30天内秒退,状态文件顺延', () => {
  const { dir, root, P } = setup();
  md(root, 'plans/x.md', '裸文档');
  const r1 = docsAudit({ ...P, 'monthly-tick': true });
  assert.match(r1.text, /节拍已记账/);
  const statePath = path.join(root, '.dashboard', 'docs-audit-state.json');
  assert.ok(fs.existsSync(statePath), '状态文件应落盘');
  const r2 = docsAudit({ ...P, 'monthly-tick': true });
  assert.match(r2.text, /未到期.*0 天前/);
  // 把 lastSuccessAt 拨回 31 天前 → 应到期真跑
  fs.writeFileSync(statePath, JSON.stringify({ lastSuccessAt: new Date(Date.now() - 31 * 86400000).toISOString() }));
  const r3 = docsAudit({ ...P, 'monthly-tick': true });
  assert.match(r3.text, /节拍已记账/, '拨回31天后应再次真跑');
  clean(dir);
});

// ── DOCS-STATUS-LINE-COLON-DIVERGENCE(0901 拍板:两条分歧一起对齐)──────────
// 巡检器与项目侧索引器(scripts/docs-index.lib.ts)必须用同一套状态行判据,
// 否则同一篇文档会「一台看得见、另一台看不见」,人眼看索引还看不出问题。
test('docs-audit:状态行判据 —— 全角冒号与 ** 加粗前缀都认(与 docs-index 对齐)', () => {
  const { dir, root, P } = setup();
  const today = new Date().toISOString().slice(0, 10);
  md(root, 'design/全角冒号.md', '> 状态：正本 · 最后核对 ' + today);
  md(root, 'design/加粗前缀.md', '> **状态:正本 · 最后核对 ' + today + '**');
  md(root, 'design/全角加加粗.md', '> **状态：正本 · 最后核对 ' + today + '**');
  md(root, 'design/半角基线.md', '> 状态:正本 · 最后核对 ' + today);

  const r = docsAudit({ ...P });
  assert.match(r.text, /【C 无标签】0 篇/, '四种写法都该算「有状态行」,C 桶应为空');
  assert.match(r.text, /标准状态行 4/);
  clean(dir);
});

test('docs-audit:全角冒号写法也能抽出状态词参与 A 桶判定', () => {
  const { dir, root, P } = setup();
  const old = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  cmds.add({ _: ['CARD-F'], title: 'x', ...P });
  cmds.done({ _: ['CARD-F'], ...P });
  const boardPath = path.join(root, '.dashboard', 'board.json');
  const b = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  b.tasks.find((t) => t.id === 'CARD-F').dates.done = old;
  fs.writeFileSync(boardPath, JSON.stringify(b));

  md(root, 'design/全角该转历史.md', '> 状态：正本 · 关联卡 CARD-F · 最后核对 ' + new Date().toISOString().slice(0, 10));
  const r = docsAudit({ ...P });
  assert.match(r.text, /【A 疑似该转历史】1 篇/);
  assert.match(r.text, /全角该转历史.*标「正本」.*CARD-F 已完工/, '状态词应能从全角冒号行里抽出来');
  clean(dir);
});

// ── DOCS-AUDIT-FROZEN-EXCLUDE(0901 拍板:机械推导,修正公式)──────────────
// 已终止任务的施工记录是「历史凭据」,被项目侧单测按 git blob 哈希字节冻死,
// 永远不许再加状态行 ⇒ 不能算进 C 桶,否则该桶恒定挂着一批清不掉的,巡检器失效。
// 判据 = 合同 json 的 lineage.state(缺失则回退 taskStatus)以 TERMINATED_ 开头。
const contract = (root, taskId, body) =>
  fs.writeFileSync(path.join(root, 'docs', 'plans', `${taskId}-任务合同.json`), JSON.stringify({ taskId, ...body }));

test('docs-audit:已终止任务的施工记录进「冻结豁免」,不算 C 桶', () => {
  const { dir, root, P } = setup();
  contract(root, 'LC-DEAD', { taskStatus: 'RECHARTER_REQUIRED', lineage: { state: 'TERMINATED_REJECTED_RECHARTERED' } });
  md(root, 'plans/LC-DEAD-设计与施工记录.md', '(字节冻结件,一个字都不许改)');
  md(root, 'plans/普通无标签.md', '(该进 C 桶的裸文档)');

  const r = docsAudit({ ...P });
  assert.match(r.text, /无标签 1;冻结豁免 1/, '摘要行应单列冻结豁免计数');
  assert.match(r.text, /【冻结豁免】1 篇/, '报告应单列冻结豁免桶');
  assert.match(r.text, /【C 无标签】1 篇/, 'C 桶只该剩那篇普通裸文档');
  assert.match(r.text, /普通无标签/);
  assert.ok(!/【C 无标签】[\s\S]*LC-DEAD-设计与施工记录/.test(r.text), '冻结件不许出现在 C 桶清单里');
  clean(dir);
});

test('docs-audit:仍在进行(ACTIVE)的任务不豁免 —— 防过度豁免', () => {
  const { dir, root, P } = setup();
  contract(root, 'LC-ALIVE', { taskStatus: 'ACTIVE', lineage: { state: 'ACTIVE' } });
  md(root, 'plans/LC-ALIVE-设计与施工记录.md', '(活着的任务,该照常催它贴标签)');

  const r = docsAudit({ ...P });
  assert.match(r.text, /【C 无标签】1 篇/);
  assert.match(r.text, /LC-ALIVE-设计与施工记录/);
  assert.ok(!/冻结豁免 [1-9]/.test(r.text), 'ACTIVE 任务不该被豁免');
  clean(dir);
});

test('docs-audit:合同 json 损坏/缺字段不炸,退回现状', () => {
  const { dir, root, P } = setup();
  fs.writeFileSync(path.join(root, 'docs', 'plans', 'LC-BROKEN-任务合同.json'), '{ 这不是合法 json');
  contract(root, 'LC-NOSTATE', {}); // 既无 lineage 也无 taskStatus
  md(root, 'plans/LC-BROKEN-设计与施工记录.md', '裸文档');
  md(root, 'plans/LC-NOSTATE-设计与施工记录.md', '裸文档');

  const r = docsAudit({ ...P });
  assert.match(r.text, /【C 无标签】2 篇/, '解析不出终止态的一律不豁免,照常进 C 桶');
  clean(dir);
});

test('docs-audit:冻结豁免件不参与建卡判据(只剩冻结件时不建卡)', () => {
  const { dir, root, P } = setup();
  contract(root, 'LC-DEAD2', { taskStatus: 'RECHARTER_REQUIRED', lineage: { state: 'TERMINATED_T1_GREEN_FAILED_RECHARTERED' } });
  md(root, 'plans/LC-DEAD2-设计与施工记录.md', '字节冻结件');
  const r = docsAudit({ ...P, 'create-card': true });
  assert.match(r.text, /三桶全空,本月无需巡检卡/);
  clean(dir);
});
