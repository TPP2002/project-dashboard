'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCiPollGate } = require('../core/ciPollGate.cjs');
test('离开两分钟后停止，连接后恢复，多连接断开独立计数', () => {
  let time = 0; const gate = createCiPollGate({ now: () => time });
  time = 120000; assert.equal(gate.shouldPoll(), false);
  gate.clientConnected(); gate.clientConnected(); assert.equal(gate.shouldPoll(), true);
  gate.clientDisconnected(); time += 200000; assert.equal(gate.shouldPoll(), true);
  gate.clientDisconnected(); time += 119999; assert.equal(gate.shouldPoll(), true);
  time++; assert.equal(gate.shouldPoll(), false);
  gate.clientConnected(); assert.equal(gate.shouldPoll(), true);
});
