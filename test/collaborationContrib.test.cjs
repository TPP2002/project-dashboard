'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { memberContributions } = require('../core/collaborationContrib.cjs');

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const TS = '2026-10-20T10:00:00.000Z';
const USERS = [
  { id: 'a', displayName: 'Alice', role: 'owner' },
  { id: 'b', displayName: 'Bob', role: 'member' },
  { id: 'c', displayName: 'Carol', role: 'member' },
];
const activity = (type, extra = {}) => ({ type, ts: TS, userId: 'a', author: 'Old Alice', ...extra });
const calculate = (board, options = {}) => memberContributions(board, { users: USERS, now: NOW, ...options });
const byId = (result, id) => result.members.find(member => member.userId === id);

test('card snapshot counts creation, owner and collaborators without duplicate credit', () => {
  const collaborators = [{ userId: 'a', name: 'Alice' }, { userId: 'b', name: 'Bob' }, { userId: 'b', name: 'Bob' }];
  const result = calculate({ tasks: [
    { status: '已完工', createdByUserId: 'a', assigneeUserId: 'a', collaborators },
    { status: '施工中', createdByUserId: 'b', assigneeUserId: 'a', collaborators },
    { status: '已完工', createdByUserId: 'a', assigneeUserId: 'b', collaborators: [{ userId: 'a' }] },
    { status: '施工中', assigneeUserId: 'b', collaborators: [{ userId: 'a' }] },
    { status: '待开工', createdByUserId: 'a', assigneeUserId: 'a', collaborators },
    { status: '待收单', assigneeUserId: 'a', collaborators },
    { status: '已作废', assigneeUserId: 'a', collaborators },
    { status: '已搁置', assigneeUserId: 'a', collaborators },
  ], activity: [] });
  for (const id of ['a', 'b']) {
    const row = byId(result, id);
    assert.equal(row.created, id === 'a' ? 3 : 1);
    assert.equal(row.completedAsOwner, 1);
    assert.equal(row.completedAsCollaborator, 1);
    assert.equal(row.inProgressAsOwner, 1);
    assert.equal(row.inProgressAsCollaborator, 1);
    assert.equal(row.ops, 0);
    assert.equal(row.lastActiveAt, null);
  }
});

test('activity totals distinguish claim, progress, message, all six status operations and AI delegation', () => {
  const events = [
    activity('collaboration:claim', { via: 'ai', tokenLabel: 'assistant' }),
    activity('collaboration:claim'),
    activity('collaboration:progress'), activity('collaboration:progress'),
    activity('note', { kind: 'message', via: 'ai' }), activity('note', { kind: 'message' }),
    ...['unclaim', 'park', 'unpark', 'done', 'cancel', 'reopen'].map(type => activity(type, type === 'done' ? { via: 'ai' } : {})),
    activity('note', { kind: 'system', ts: '2026-10-21T11:00:00.000Z' }),
    activity('claim'), activity('progress'),
  ];
  const row = byId(calculate({ tasks: [], activity: events }), 'a');
  assert.deepEqual({ ...row, weekly: undefined }, {
    userId: 'a', name: 'Alice', role: 'owner', unknownUser: false,
    created: 0, claimed: 2, completedAsOwner: 0, completedAsCollaborator: 0,
    inProgressAsOwner: 0, inProgressAsCollaborator: 0,
    messages: 2, progressUpdates: 2, statusChanges: 6, aiOps: 3, ops: 15,
    lastActiveAt: '2026-10-21T11:00:00.000Z', weekly: undefined,
  });
  assert.deepEqual(row.weekly.at(-1), { weekStart: '2026-10-19T00:00:00.000Z', completed: 1, messages: 2, ops: 15 });
  assert.ok(row.weekly.slice(0, -1).every(w => w.completed === 0 && w.messages === 0 && w.ops === 0));
});

test('message kind is counted independently of activity type; token labels do not imply AI', () => {
  const result = calculate({ activity: [
    activity('custom', { kind: 'message', tokenLabel: 'ai-looking-label' }),
    activity('custom', { via: 'ai' }), activity('custom', { via: 'AI' }),
  ] });
  const row = byId(result, 'a');
  assert.equal(row.messages, 1);
  assert.equal(row.aiOps, 1);
  assert.equal(row.ops, 3);
  assert.equal(row.weekly.at(-1).messages, 1);
});

test('unsigned legacy activity and completed cards without an assignee are retained separately', () => {
  const result = calculate({ tasks: [
    { status: '已完工' }, { status: '已完工', assigneeUserId: null },
    { status: '已完工', assigneeUserId: '', collaborators: [{ userId: 'b' }] },
    { status: '施工中' }, { status: '已作废' },
    { status: '已完工', assigneeUserId: 'a' },
  ], activity: [
    { type: 'note', kind: 'message', ts: TS, author: 'Alice' },
    { type: 'done', ts: TS, userId: null, via: 'ai' },
    { type: 'park', ts: TS, userId: '' },
    { type: 'progress', ts: TS },
    ...['unclaim', 'unpark', 'cancel', 'reopen'].map(type => ({ type, ts: TS })),
    activity('note', { kind: 'message' }),
  ] });
  assert.equal(result.unattributed.completedWithoutMember, 3);
  assert.equal(result.unattributed.messages, 1);
  assert.equal(result.unattributed.statusChanges, 6);
  assert.equal(result.unattributed.ops, 8);
  assert.deepEqual(result.unattributed.weekly.at(-1), {
    weekStart: '2026-10-19T00:00:00.000Z', completed: 1, messages: 1, ops: 8,
  });
  assert.equal(byId(result, 'a').ops, 1);
  assert.equal(byId(result, 'b').completedAsCollaborator, 1);
  assert.equal(result.members.length, USERS.length);
});

test('unknown users use the chronologically latest author, irrespective of array order', () => {
  const result = calculate({ tasks: [{ status: '已完工', createdByUserId: 'gone', assigneeUserId: 'gone' }], activity: [
    activity('done', { userId: 'gone', author: 'New name', ts: '2026-10-21T10:00:00Z' }),
    activity('note', { userId: 'gone', author: 'Old name', kind: 'message', ts: '2026-10-20T10:00:00Z' }),
    activity('note', { userId: 'gone', author: 'Bad timestamp name', ts: 'bad' }),
  ] });
  const row = byId(result, 'gone');
  assert.equal(row.name, 'New name');
  assert.equal(row.unknownUser, true);
  assert.equal(row.role, null);
  assert.equal(row.created, 1);
  assert.equal(row.completedAsOwner, 1);
  assert.equal(row.messages, 1);
  assert.equal(row.ops, 2);
  assert.equal(row.lastActiveAt, '2026-10-21T10:00:00Z');
  assert.equal(result.skipped, 1);
});

test('task-only identities retain contribution even if absent from the user list and activity log', () => {
  const result = calculate({ tasks: [
    { status: '已完工', createdByUserId: 'creator', assigneeUserId: 'owner', assigneeName: 'Former owner', collaborators: [{ userId: 'helper', name: 'Former helper' }] },
  ] });
  assert.equal(byId(result, 'creator').created, 1);
  assert.equal(byId(result, 'owner').name, 'Former owner');
  assert.equal(byId(result, 'owner').completedAsOwner, 1);
  assert.equal(byId(result, 'helper').name, 'Former helper');
  assert.equal(byId(result, 'helper').completedAsCollaborator, 1);
  assert.equal(byId(result, 'helper').lastActiveAt, null);
});

test('all registered members appear with zero counters and empty weekly buckets', () => {
  const result = calculate({ tasks: [], activity: [] });
  assert.equal(result.members.length, 3);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.range, { from: '2026-08-31T00:00:00.000Z', to: '2026-10-21T12:00:00.000Z', weeks: 8 });
  for (const user of USERS) {
    const row = byId(result, user.id);
    assert.equal(row.name, user.displayName);
    assert.equal(row.role, user.role);
    assert.equal(row.unknownUser, false);
    assert.equal(row.lastActiveAt, null);
    for (const key of ['created', 'claimed', 'completedAsOwner', 'completedAsCollaborator', 'inProgressAsOwner', 'inProgressAsCollaborator', 'messages', 'progressUpdates', 'statusChanges', 'aiOps', 'ops']) assert.equal(row[key], 0, key);
    assert.equal(row.weekly.length, 8);
    assert.ok(row.weekly.every(w => w.completed === 0 && w.messages === 0 && w.ops === 0));
  }
  assert.deepEqual(calculate({}).members, result.members);
});

test('UTC Sunday 23:59 and Monday 00:00 land in adjacent weeks for members and unsigned activity', () => {
  const dates = ['2026-10-18T23:59:59.999Z', '2026-10-19T00:00:00.000Z'];
  const events = dates.flatMap(ts => [activity('done', { ts }), activity('note', { ts, userId: undefined, kind: 'message' })]);
  const result = calculate({ activity: events }, { weeks: 2 });
  assert.deepEqual(byId(result, 'a').weekly, [
    { weekStart: '2026-10-12T00:00:00.000Z', completed: 1, messages: 0, ops: 1 },
    { weekStart: '2026-10-19T00:00:00.000Z', completed: 1, messages: 0, ops: 1 },
  ]);
  assert.deepEqual(result.unattributed.weekly, [
    { weekStart: '2026-10-12T00:00:00.000Z', completed: 0, messages: 1, ops: 1 },
    { weekStart: '2026-10-19T00:00:00.000Z', completed: 0, messages: 1, ops: 1 },
  ]);
});

test('week range includes its start and now, excludes older/future activity from trends only', () => {
  const events = [
    '2026-10-11T23:59:59.999Z', '2026-10-12T00:00:00.000Z',
    '2026-10-21T12:00:00.000Z', '2026-10-21T12:00:00.001Z',
    '2026-10-26T00:00:00.000Z',
  ].map(ts => activity('done', { ts }));
  const result = calculate({ activity: events }, { weeks: 2 });
  const row = byId(result, 'a');
  assert.deepEqual(row.weekly.map(w => w.completed), [1, 1]);
  assert.equal(row.statusChanges, 5);
  assert.equal(row.ops, 5);
  assert.equal(row.lastActiveAt, '2026-10-26T00:00:00.000Z');
  assert.equal(row.completedAsOwner, 0, 'done activity does not invent a currently completed card');
  assert.equal(result.skipped, 0);
});

test('UTC offsets, numeric timestamps and zone-less ISO dates use the same UTC boundary', () => {
  const result = calculate({ activity: [
    activity('done', { ts: '2026-10-19T07:59:59.999+08:00' }),
    activity('done', { ts: Date.parse('2026-10-19T00:00:00Z') }),
    activity('done', { ts: '2026-10-19T00:00:00' }),
    activity('done', { ts: '2026-10-19' }),
  ] }, { weeks: 2 });
  assert.deepEqual(byId(result, 'a').weekly.map(w => w.completed), [1, 3]);
});

test('Monday and Sunday now values, year rollover and custom week counts are handled in UTC', () => {
  assert.equal(calculate({}, { now: Date.parse('2026-10-18T23:59:59Z'), weeks: 1 }).range.from, '2026-10-12T00:00:00.000Z');
  assert.equal(calculate({}, { now: Date.parse('2026-10-19T00:00:00Z'), weeks: 1 }).range.from, '2026-10-19T00:00:00.000Z');
  const result = calculate({}, { now: Date.parse('2027-01-01T00:00:00Z'), weeks: 2 });
  assert.deepEqual(byId(result, 'a').weekly.map(w => w.weekStart), ['2026-12-21T00:00:00.000Z', '2026-12-28T00:00:00.000Z']);
});

test('invalid timestamps are skipped entirely, counted and do not throw or create phantom users', () => {
  const invalid = [undefined, null, '', '  ', 'not-a-date', NaN, Infinity, -Infinity, 9e15, {}, [], true];
  const events = invalid.flatMap(ts => [
    activity('done', { ts, userId: 'phantom', kind: 'message', via: 'ai' }),
    activity('done', { ts, userId: undefined, kind: 'message' }),
  ]);
  const result = calculate({ activity: [...events, activity('done', { ts: 0 })] });
  assert.equal(result.skipped, invalid.length * 2);
  assert.equal(result.members.length, USERS.length);
  assert.equal(result.unattributed.ops, 0);
  const row = byId(result, 'a');
  assert.equal(row.ops, 1);
  assert.equal(row.lastActiveAt, 0);
  assert.equal(row.statusChanges, 1);
  assert.ok(row.weekly.every(w => w.ops === 0));
});

test('sorting uses combined completions, then all-time ops, then name', () => {
  const users = ['Zulu', 'Bob', 'Alice', 'Aaron', 'Zed', 'Same', 'Same'].map((displayName, i) => ({ id: String(i), displayName, role: 'member' }));
  const result = calculate({ tasks: [
    { status: '已完工', assigneeUserId: '0', collaborators: [{ userId: '1' }, { userId: '2' }] },
    { status: '已完工', assigneeUserId: '1', collaborators: [{ userId: '0' }, { userId: '2' }] },
  ], activity: [
    ...Array.from({ length: 3 }, () => activity('note', { userId: '0' })),
    ...Array.from({ length: 2 }, () => activity('note', { userId: '1' })),
    ...Array.from({ length: 2 }, () => activity('note', { userId: '2' })),
    ...Array.from({ length: 10 }, () => activity('note', { userId: '3' })),
    activity('note', { userId: '4', ts: '2020-01-01T00:00:00Z' }),
  ] }, { users: [...users].reverse() });
  assert.deepEqual(result.members.map(m => m.userId), ['0', '2', '1', '3', '4', '5', '6']);
});

test('repeated calls are byte-identical, never mutate inputs, and do not share result buckets', () => {
  const board = { tasks: [{ status: '已完工', assigneeUserId: 'a', collaborators: [{ userId: 'b', name: 'Bob' }] }], activity: [activity('done'), activity('note', { userId: 'outsider', author: 'Outside', kind: 'message' })] };
  const options = { users: structuredClone(USERS), now: NOW, weeks: 3 };
  const before = JSON.stringify({ board, options });
  function freeze(value) {
    if (!value || typeof value !== 'object') return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  freeze(board); freeze(options);
  const first = memberContributions(board, options);
  const second = memberContributions(board, options);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify({ board, options }), before);
  first.members[0].weekly[0].ops = 999;
  assert.equal(JSON.stringify(memberContributions(board, options)), JSON.stringify(second));
  assert.equal(first.unattributed.weekly[0].ops, 0);
  assert.equal(first.members[1].weekly[0].ops, 0);
});

test('callers must supply a valid now and a positive integer week count', () => {
  for (const now of [undefined, null, NaN, Infinity, '2026-10-21', 9e15]) assert.throws(() => calculate({}, { now }), /now/);
  for (const weeks of [0, -1, 1.5, NaN, Infinity, '8']) assert.throws(() => calculate({}, { weeks }), /weeks/);
  assert.throws(() => memberContributions({}), /now/);
});

test('5000 cards and 50000 activities are aggregated within one second', t => {
  const users = Array.from({ length: 100 }, (_, i) => ({ id: `u${i}`, displayName: `Member ${i}`, role: 'member' }));
  const tasks = Array.from({ length: 5000 }, (_, i) => ({
    id: `T${i}`, status: i % 2 ? '施工中' : '已完工',
    createdByUserId: `u${i % 100}`, assigneeUserId: `u${i % 100}`,
    collaborators: [{ userId: `u${i % 100}` }, { userId: `u${(i + 1) % 100}` }],
  }));
  const activityLog = Array.from({ length: 50000 }, (_, i) => ({
    ts: new Date(NOW - (i % 56) * 86400000).toISOString(),
    userId: `u${i % 100}`, author: `Member ${i % 100}`,
    type: ['collaboration:claim', 'collaboration:progress', 'note', 'done', 'park'][i % 5],
    kind: i % 5 === 2 ? 'message' : undefined, via: i % 3 === 0 ? 'ai' : undefined,
  }));
  const start = performance.now();
  const result = memberContributions({ tasks, activity: activityLog }, { users, now: NOW });
  const elapsed = performance.now() - start;
  t.diagnostic(`5000 cards + 50000 activities: ${elapsed.toFixed(2)} ms`);
  assert.ok(elapsed < 1000, `expected under 1000 ms, got ${elapsed.toFixed(2)} ms`);
  const sum = key => result.members.reduce((n, row) => n + row[key], 0);
  assert.equal(result.members.length, 100);
  assert.equal(sum('created'), 5000);
  assert.equal(sum('completedAsOwner'), 2500);
  assert.equal(sum('completedAsCollaborator'), 2500);
  assert.equal(sum('inProgressAsOwner'), 2500);
  assert.equal(sum('inProgressAsCollaborator'), 2500);
  assert.equal(sum('ops'), 50000);
  assert.equal(sum('messages'), 10000);
  assert.equal(sum('statusChanges'), 20000);
  assert.equal(sum('claimed'), 10000);
  assert.equal(sum('progressUpdates'), 10000);
  assert.equal(sum('aiOps'), 16667);
  assert.equal(result.skipped, 0);
});
