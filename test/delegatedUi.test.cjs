'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('拍板历史标出决定来源，类型字段可选', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-ui-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  const board = path.join(repo, 'board.json'); fs.writeFileSync(board, JSON.stringify({ tasks: [], activity: [] }));
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ projects: { demo: { mainRepo: repo, board } } }));
  const view = fs.readFileSync(path.join(__dirname, '../web/src/views/DecisionHistory.vue'), 'utf8');
  const types = fs.readFileSync(path.join(__dirname, '../web/src/types.ts'), 'utf8');
  for (const s of ['decidedBy', '负责人拍板', '对话代定', '未标']) assert.ok(view.includes(s));
  assert.match(view, /it\.decision\.decidedBy\s*\?\?\s*['"]未标['"]/);
  const decision = types.match(/(?:export\s+)?interface\s+Decision\s*\{[\s\S]*?\}/);
  assert.ok(decision);
  assert.match(decision[0], /askKind\?\s*:\s*string/);
  assert.match(decision[0], /decidedBy\?\s*:\s*string/);
});
