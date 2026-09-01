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
