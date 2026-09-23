'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ATTRIBUTION_API_VERSION, TRUNK_BRANCHES, BINDINGS_FILE,
  signalTextsOfRow, extractCommandSignals, parseBindings, attributeSession,
} = require('../core/sessionAttribution.cjs');

const cards = [
  { id: 'CARD-A', gitBranch: ['main', 'feat/a'] },
  { id: 'CARD-B', gitBranch: ['main', 'feat/b', 'feat/x'] },
  { id: 'CARD-C', gitBranch: ['feat/x'] },
];
const session = (fields = {}) => ({ sessionId: '00000000-0000-4000-8000-00000000000a',
  branches: [], claimIds: [], branchFlags: [], ...fields });

test('公开接口固定，主干 main/master/HEAD 不参与归因', () => {
  assert.equal(ATTRIBUTION_API_VERSION, 1);
  assert.deepEqual(TRUNK_BRANCHES, ['main', 'master', 'HEAD']);
  assert.equal(Object.isFrozen(TRUNK_BRANCHES), true);
  assert.equal(BINDINGS_FILE, 'session-bindings.jsonl');
  for (const trunk of TRUNK_BRANCHES) {
    const board = [{ id: 'CARD-A', gitBranch: [trunk, 'feat/a'] }, { id: 'CARD-B', gitBranch: [trunk] }];
    assert.equal(attributeSession(session({ branches: [trunk] }), board, null).status, 'unattributed');
    const hit = attributeSession(session({ branches: [trunk, 'feat/a'] }), board, null);
    assert.equal(hit.status, 'attributed');
    assert.equal(hit.level, 'branch');
    assert.deepEqual(hit.cardIds, ['CARD-A']);
  }
});

test('分支独占、多分支各独占和共享分支分别归一张、多卡、歧义', () => {
  const single = attributeSession(session({ branches: ['feat/a'] }), cards);
  assert.equal(single.status, 'attributed');
  assert.deepEqual(single.cardIds, ['CARD-A']);
  const shared = attributeSession(session({ branches: ['feat/x'] }), cards);
  assert.equal(shared.status, 'ambiguous');
  assert.deepEqual(shared.candidates, ['CARD-B', 'CARD-C']);
  assert.deepEqual(shared.cardIds, []);
  const multi = attributeSession(session({ branches: ['feat/b', 'feat/a'] }), cards);
  assert.equal(multi.status, 'multi');
  assert.deepEqual(multi.cardIds, ['CARD-A', 'CARD-B']);
  const mixed = attributeSession(session({ branches: ['feat/a', 'feat/x'] }), cards);
  assert.equal(mixed.status, 'ambiguous');
  assert.deepEqual(mixed.candidates, ['CARD-A', 'CARD-B', 'CARD-C']);
});

test('绑定优先于分支；两张绑定为多卡，失效绑定保留未知并继续判', () => {
  const sid = session().sessionId;
  const one = attributeSession(session({ branches: ['feat/b'] }), cards, { [sid]: ['CARD-A'] });
  assert.equal(one.level, 'binding');
  assert.deepEqual(one.cardIds, ['CARD-A']);
  const many = attributeSession(session(), cards, { [sid]: ['CARD-B', 'CARD-A'] });
  assert.equal(many.status, 'multi');
  assert.deepEqual(many.cardIds, ['CARD-A', 'CARD-B']);
  const stale = attributeSession(session({ branches: ['feat/a'] }), cards, { [sid]: ['GHOST-CARD'] });
  assert.equal(stale.level, 'branch');
  assert.deepEqual(stale.unknownCards, ['GHOST-CARD']);
});

test('命令里的 claim 与非主干 --branch 可归因，多命中只算歧义', () => {
  assert.deepEqual(attributeSession(session({ claimIds: ['CARD-A'] }), cards).cardIds, ['CARD-A']);
  assert.equal(attributeSession(session({ claimIds: ['CARD-A'] }), cards).level, 'command');
  assert.deepEqual(attributeSession(session({ branchFlags: ['feat/a'] }), cards).cardIds, ['CARD-A']);
  const many = attributeSession(session({ claimIds: ['CARD-A', 'CARD-B'] }), cards);
  assert.equal(many.status, 'ambiguous');
  assert.deepEqual(many.cardIds, []);
  assert.deepEqual(many.candidates, ['CARD-A', 'CARD-B']);
  assert.equal(attributeSession(session({ branchFlags: ['main'] }), cards).status, 'unattributed');
});

test('命令正则拒绝小写、无连字符和 disclaim；未知卡保留并解释', () => {
  assert.deepEqual(extractCommandSignals(['claim cost-lower claim NOHYPHEN disclaim ABC-DEF']), { claimIds: [], branchFlags: [] });
  const signals = extractCommandSignals(['claim GHOST-CARD-AAAA claim REAL-CARD', '--branch feat/a --branch feat/a', null]);
  assert.deepEqual(signals, { claimIds: ['GHOST-CARD-AAAA', 'REAL-CARD'], branchFlags: ['feat/a'] });
  const board = [{ id: 'REAL-CARD', gitBranch: [] }];
  const ghost = attributeSession(session({ claimIds: ['GHOST-CARD-AAAA'] }), board);
  assert.equal(ghost.status, 'unattributed');
  assert.deepEqual(ghost.unknownCards, ['GHOST-CARD-AAAA']);
  assert.match(ghost.evidence, /GHOST-CARD-AAAA/);
  const real = attributeSession(session({ claimIds: signals.claimIds }), board);
  assert.deepEqual(real.cardIds, ['REAL-CARD']);
  assert.deepEqual(real.unknownCards, ['GHOST-CARD-AAAA']);
});

test('只取用户及助手文字、命令，排除工具结果与无效块', () => {
  assert.deepEqual(signalTextsOfRow({ type: 'user', message: { content: ' claim CARD-A ' } }), [' claim CARD-A ']);
  assert.deepEqual(signalTextsOfRow({ type: 'user', message: { content: [
    { type: 'text', text: 'claim CARD-A' }, { type: 'tool_result', content: 'claim CARD-B' },
  ] } }), ['claim CARD-A']);
  assert.deepEqual(signalTextsOfRow({ type: 'assistant', message: { content: [
    { type: 'text', text: 'hello' }, { type: 'tool_use', name: 'Bash', input: { command: 'claim CARD-A' } },
    { type: 'tool_use', input: {} }, { type: 'tool_use', input: { command: 123 } },
  ] } }), ['hello', 'claim CARD-A']);
  assert.deepEqual(signalTextsOfRow({ type: 'summary', message: { content: 'claim CARD-A' } }), []);
  assert.deepEqual(signalTextsOfRow(null), []);
  assert.deepEqual(signalTextsOfRow('bad'), []);
});

test('绑定 JSONL 跳过坏行、合并去重，并使用无原型字典', () => {
  const parsed = parseBindings(['bad', 'null', '{}', '{"sessionId":" ","taskId":"CARD-A"}',
    '{"sessionId":"s","taskId":"CARD-B"}', '{"sessionId":"s","taskId":"CARD-A"}',
    '{"sessionId":"s","taskId":"CARD-B"}', '{"sessionId":"__proto__","taskId":"CARD-C"}',
  ].join('\n'));
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.deepEqual(parsed.s, ['CARD-A', 'CARD-B']);
  assert.deepEqual(parsed.__proto__, ['CARD-C']);
  assert.equal(Object.getPrototypeOf(parseBindings(null)), null);
});

test('共用判据源码不加载任何依赖', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'sessionAttribution.cjs'), 'utf8');
  assert.equal(source.includes('require('), false);
});
