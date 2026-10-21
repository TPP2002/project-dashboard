'use strict';
// Lightweight construction self-check. The three acceptance suites are left to
// the dispatcher; this file covers pure configuration and serialization only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configuration, boardView } = require('../server/collaborationApi.cjs');
const { username } = require('../core/collaborationAuth.cjs');
const { readPassword } = require('../cli/collaboration.cjs');
const { text, taskView } = require('../core/collaborationPublic.cjs');

test('explicit collaboration origin, trusted TLS and separate local mode', () => {
  assert.equal(configuration({}), null);
  assert.equal(configuration({ DASHBOARD_MODE: 'release' }), null);
  assert.throws(() => configuration({ DASHBOARD_MODE: 'collaboration' }));
  for (const origin of ['http://example.com', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com/#hash']) {
    assert.throws(() => configuration({ DASHBOARD_MODE: 'collaboration', DASHBOARD_PUBLIC_ORIGIN: origin }));
  }
  assert.deepEqual(configuration({ DASHBOARD_MODE: 'collaboration', DASHBOARD_PUBLIC_ORIGIN: 'https://example.com' }), { origin: 'https://example.com', host: '127.0.0.1', secure: true });
  assert.equal(configuration({ DASHBOARD_MODE: 'collaboration', DASHBOARD_PUBLIC_ORIGIN: 'http://127.0.0.1:4567', DASHBOARD_HOST: '0.0.0.0' }).secure, false);
});
test('member serialization is a positive whitelist including nested free text', () => {
  const view = boardView({ schemaVersion: '1.0', project: { id: 'alpha', name: 'Alpha', mainRepo: 'PRIVATE', cost: 'PRIVATE' },
    tasks: [{ id: 'ONE', title: 'C:\\path\\to\\private-root /home/private/path', status: '待开工', percent: 0, cost: 'PRIVATE', collectBrief: 'PRIVATE', decisions: ['PRIVATE'], worktree: ['PRIVATE'] }],
    activity: [{ type: 'message', text: 'PRIVATE' }, { type: 'collaboration:progress', userId: 'member', taskId: 'ONE', text: 'PRIVATE', note: 'PRIVATE' }] });
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE|C:|\/home\/private/);
  assert.equal(view.tasks[0].percent, 0); assert.equal(view.activity.length, 1);
  assert.equal(view.activity[0].userId, 'member');
});
test('stable username normalization and protected password file validation', () => {
  assert.equal(username(' ＯＷＮＥＲ '), 'owner');
  for (const bad of ['a', '../owner', 'x'.repeat(65), null]) assert.throws(() => username(bad));
  assert.throws(() => readPassword(undefined));
});

test('Unix path redaction recognizes non-ASCII punctuation without touching URLs or relative paths', () => {
  assert.equal(text('路径：/home/alice/secret'), '路径：[private path]');
  assert.equal(text('（/srv/data）'), '（[private path]');
  assert.equal(text('路径，/srv/data'), '路径，[private path]');
  assert.equal(text('/srv/data'), '[private path]');
  assert.equal(text('路径：C:\\path\\to\\private-file'), '路径：[private path]');
  for (const unchanged of ['https://host/path', '网址：https://host/path', 'src/app', '路径：src/app',
    '//host/path', '路径：//host/path', './src/app', '../src/app', '~/src/app', '_/src/app', '-/src/app']) {
    assert.equal(text(unchanged), unchanged);
  }
});

test('message JSON has a byte budget and retains a contiguous newest suffix', () => {
  const task = { id: 'BUDGET', status: '施工中' };
  const activity = Array.from({ length: 60 }, (_, i) => ({ taskId: task.id, kind: 'message',
    ts: String(i), author: 'Person', userId: 'member', text: '汉'.repeat(2000) }));
  const view = taskView(task, { id: 'member', role: 'member' }, activity);
  assert.ok(view.messages.length > 0 && view.messages.length < 50);
  assert.ok(Buffer.byteLength(JSON.stringify(view.messages), 'utf8') <= 65536);
  const expected = activity.slice(-view.messages.length).map(({ ts, author, userId, text }) => ({ ts, author, text, userId }));
  assert.deepEqual(view.messages, expected);
  const previous = activity[activity.length - view.messages.length - 1];
  const previousMessage = { ts: previous.ts, author: previous.author, text: previous.text, userId: previous.userId };
  assert.ok(Buffer.byteLength(JSON.stringify([previousMessage, ...view.messages]), 'utf8') > 65536);
  const oversized = [...activity, { ...activity.at(-1), text: '汉'.repeat(22000) }];
  assert.deepEqual(taskView(task, null, oversized).messages, []);
});

test('role-aware board views expose actions and only the latest fifty scrubbed messages', () => {
  const member = { id: 'member', role: 'member', disabled: false };
  const task = { id: 'ONE', title: 'Task', status: '施工中', assigneeUserId: 'member', createdByUserId: 'member',
    blockReason: 'Waiting C:\\path\\to\\private-path', cancelReason: '/home/private/cancel' };
  const activity = Array.from({ length: 55 }, (_, i) => ({ ts: String(i), taskId: 'ONE', kind: 'message', type: 'note', author: 'Person', userId: 'member', text: 'message ' + i + ' /home/private/message' }));
  activity.push({ taskId: 'OTHER', kind: 'message', text: 'hidden' }, { taskId: 'ONE', type: 'note', text: 'not a message' });
  const board = { schemaVersion: '1.0', project: { id: 'alpha', name: 'Alpha' }, tasks: [task], activity };
  const view = boardView(board, member).tasks[0];
  assert.deepEqual(view.actions, ['note', 'priority', 'unclaim', 'park', 'done', 'cancel']);
  assert.equal(view.messages.length, 50); assert.equal(view.messages[0].ts, '5'); assert.equal(view.messages.at(-1).ts, '54');
  assert.deepEqual(Object.keys(view.messages[0]).sort(), ['author', 'text', 'ts', 'userId']);
  assert.equal(view.messages[0].userId, 'member'); assert.equal(view.messages[0].author, 'Person');
  assert.equal(view.messages[0].text, 'message 5 [private path]');
  assert.equal(view.blockReason, 'Waiting [private path]'); assert.equal(view.cancelReason, '[private path]');
  assert.equal(view.createdByUserId, 'member'); assert.equal(view.aiWork, false);
  assert.deepEqual(boardView(board, { ...member, role: 'viewer' }).tasks[0].actions, []);
  task.builder = '派单器'; task.gitBranch = ['private-branch']; task.prNumbers = [33]; task.commitShas = ['abcdef1'];
  const ai = boardView(board, member).tasks[0];
  assert.equal(ai.aiWork, true); assert.deepEqual(ai.actions, ['note', 'priority']);
  assert.doesNotMatch(JSON.stringify(ai), /派单器|private-branch|abcdef1|"builder"|"gitBranch"|"prNumbers"|"commitShas"/);
});
