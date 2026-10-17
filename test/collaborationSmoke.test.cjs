'use strict';
// Lightweight construction self-check. The three acceptance suites are left to
// the dispatcher; this file covers pure configuration and serialization only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configuration, boardView } = require('../server/collaborationApi.cjs');
const { username } = require('../core/collaborationAuth.cjs');
const { readPassword } = require('../cli/collaboration.cjs');

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
    tasks: [{ id: 'ONE', title: 'C:\\private\\root /home/private/path', status: '待开工', percent: 0, cost: 'PRIVATE', collectBrief: 'PRIVATE', decisions: ['PRIVATE'], worktree: ['PRIVATE'] }],
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
