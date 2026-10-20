'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { contributionView } = require('../core/collaborationContribView.cjs');
const { memberContributions } = require('../core/collaborationContrib.cjs');
const NOW = Date.parse('2026-10-21T12:00:00Z');
const TS = '2026-10-20T10:00:00Z';
const users = [
  { id: 'identity-alice', displayName: 'Alice Private', role: 'owner', disabled: false },
  { id: 'identity-bob', displayName: 'Bob Private', role: 'member', disabled: false },
  { id: 'identity-carol', displayName: 'Carol Private', role: 'viewer', disabled: true },
];
const event = (type, extra = {}) => ({ type, ts: TS, userId: users[0].id, taskId: 'ONE', author: 'Old name', ...extra });
const view = (board, extra = {}) => contributionView(board, { users, now: NOW, role: 'owner', ...extra });
const fixture = () => ({ tasks: [
  { id: 'ONE', title: 'Task', status: '已完工', assigneeUserId: users[0].id, createdByUserId: users[0].id, collaborators: [{ userId: users[1].id }] },
  { id: 'TWO', status: '已完工', collaborators: [] },
  { id: 'THREE', status: '施工中', assigneeUserId: users[0].id, collaborators: [{ userId: users[1].id }], createdByUserId: users[1].id },
  { id: 'FOUR', status: '施工中' },
  { id: 'FIVE', status: '待开工', createdByUserId: users[0].id },
  { id: 'SIX', status: '已作废', collaborators: [{ userId: users[2].id }] },
], activity: [event('done'), event('note', { kind: 'message', via: 'ai' }),
  event('custom', { kind: 'message', userId: undefined }), event('collaboration:progress', { userId: users[1].id }),
  event('note', { via: 'ai', userId: undefined, ts: '2020-01-01' }),
  event('note', { kind: 'message', via: 'ai', ts: 'invalid' }),
] });

test('totals count exact snapshot statuses and all activities, independently of week range and timestamp validity', () => {
  const result = view(fixture(), { weeks: 4 });
  assert.deepEqual(result.totals, { completed: 2, completedWithCollaborators: 1, inProgress: 2, activeMembers: 2,
    createdByMembers: 3, createdOther: 3, messages: 3, aiOps: 3, attributedOps: 4 });
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.totals, view(fixture(), { weeks: 12 }).totals);
  assert.equal(result.members.find(m => m.userId === users[2].id).ops, 0);
});

test('weekly merges people and unsigned without double counting reassigned unsigned completions', () => {
  const board = fixture();
  board.activity.push(event('done', { userId: undefined }));
  const result = view(board, { weeks: 4 });
  assert.equal(result.weekly.length, 4);
  assert.deepEqual(result.weekly.at(-1), { weekStart: '2026-10-19T00:00:00.000Z', completed: 2, messages: 2, ops: 5 });
  const raw = memberContributions(board, { users, now: NOW, weeks: 4 });
  assert.deepEqual(result.membersWeekly, raw.members.map(m => ({ userId: m.userId, weekly: m.weekly })));
  assert.deepEqual(result.unattributed, raw.unattributed);
});

test('viewer allowlist recursively contains no person fields, user IDs or display names', () => {
  const board = fixture();
  board.activity.push(event('done', { userId: 'former-secret-id', author: 'Former Secret' }));
  const result = view(board, { role: 'viewer' });
  assert.deepEqual(Object.keys(result).sort(), ['range', 'scope', 'totals', 'weekly']);
  assert.equal(result.scope, 'summary');
  const forbidden = new Set(['members', 'unattributed', 'recent', 'membersWeekly', 'userId', 'name', 'displayName']);
  function inspect(value) {
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      assert.ok(!forbidden.has(key), key); inspect(child);
    }
  }
  inspect(result);
  const json = JSON.stringify(result);
  for (const value of [...users.flatMap(u => [u.id, u.displayName]), 'former-secret-id', 'Former Secret']) assert.ok(!json.includes(value), value);
  assert.deepEqual(result.weekly, view(board).weekly);
  assert.deepEqual(result.totals, view(board).totals);
});

test('full recent infers every action, strict create predicate, unknown types and exact AI marker', () => {
  const cases = [
    [event('note', { text: '新建任务 ONE' }), 'create'],
    [event('note', { text: '新建任务 ONE', kind: 'message', via: 'ai' }), 'message'],
    ...['claim', 'progress', 'join', 'leave'].map(a => [event('collaboration:' + a), a]),
    [event('collaboration:remove-collaborator'), 'removeCollaborator'],
    ...['unclaim', 'park', 'unpark', 'done', 'cancel', 'reopen'].map(a => [event(a), a]),
    [event('note', { text: '新建任务 ONE', kind: 'system' }), 'other'],
    [event('note', { text: '新建任务 ONE', kind: '' }), 'other'],
    [event('custom', { text: '新建任务 ONE' }), 'other'],
    [event('note', { text: '前缀 新建任务 ONE' }), 'other'],
    [event('toString', { via: 'AI' }), 'other'],
  ];
  const result = view({ activity: cases.map(c => c[0]) }, { role: 'member' });
  assert.equal(result.scope, 'full');
  assert.deepEqual(result.recent.map(r => r.action), cases.map(c => c[1]).reverse());
  assert.equal(result.recent.filter(r => r.viaAi).length, 1);
  assert.equal(result.recent.find(r => r.action === 'message').viaAi, true);
  assert.equal(Object.hasOwn(result.recent.find(r => r.action === 'create'), 'viaAi'), false);
  assert.deepEqual(result, view({ activity: cases.map(c => c[0]) }));
});

test('recent is chronological newest 20, only signed, timezone stable and sanitized by field allowlist', () => {
  const activity = Array.from({ length: 24 }, (_, i) => event('note', { ts: NOW - i * 1000,
    text: 'SECRET RAW', reason: 'SECRET REASON', branch: 'SECRET BRANCH', pr: 123, cost: 999 }));
  activity.reverse();
  activity.push(event('note', { ts: NOW + 1, userId: undefined }));
  const result = view({ tasks: [{ id: 'ONE', title: 'Work C:\\private\\file /home/secret' }], activity }, {
    users: [{ ...users[0], displayName: 'Name C:\\private\\name' }],
  });
  assert.equal(result.recent.length, 20);
  assert.deepEqual(result.recent.map(r => r.ts), Array.from({ length: 20 }, (_, i) => NOW - i * 1000));
  assert.equal(result.recent[0].name, 'Name [private path]');
  assert.equal(result.recent[0].taskTitle, 'Work [private path] [private path]');
  assert.deepEqual(Object.keys(result.recent[0]).sort(), ['action', 'name', 'taskId', 'taskTitle', 'ts', 'userId']);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|C:\\|\/home\/secret/);
  const times = view({ activity: [event('done', { ts: '2026-10-20 10:00' }), event('done', { ts: '2026-10-20T10:00:01Z' }), event('done', { ts: 'invalid' })] });
  assert.deepEqual(times.recent.map(r => r.ts), ['2026-10-20T10:00:01Z', '2026-10-20 10:00', null]);
});

test('same inputs produce byte-identical outputs without mutating frozen inputs', () => {
  const board = fixture(); const options = { users: structuredClone(users), now: NOW, weeks: 8, role: 'member' };
  const before = JSON.stringify({ board, options });
  function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } }
  freeze(board); freeze(options);
  assert.equal(JSON.stringify(contributionView(board, options)), JSON.stringify(contributionView(board, options)));
  assert.equal(JSON.stringify({ board, options }), before);
});

test('empty board has zero totals and requested empty buckets; unknown roles fail closed', () => {
  const result = view({}, { role: 'viewer', weeks: 12 });
  assert.ok(Object.values(result.totals).every(n => n === 0));
  assert.equal(result.weekly.length, 12);
  assert.ok(result.weekly.every(w => !w.ops && !w.messages && !w.completed));
  for (const role of [undefined, 'admin', '']) assert.throws(() => view({}, { role }), /role/);
});
