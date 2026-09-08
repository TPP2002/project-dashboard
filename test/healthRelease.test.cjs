'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { releaseBehindOf } = require('../core/releaseCheck.cjs');

// 采用工单允许的纯函数方案：服务逐次读印章，身份与 commit 比较直接单测，
// 无需复制整套服务来伪造发布目录，也不启动或接管本机的看板。
test('发布服务与最新副本 commit 不同才提示换新，同 commit 不提示', () => {
  assert.equal(releaseBehindOf('abcdef1', 'abcdef2', 'release'), true);
  assert.equal(releaseBehindOf('abcdef1', 'abcdef1', 'release'), false);
  assert.equal(releaseBehindOf(null, 'abcdef2', 'release'), true);
});

test('开发实例恒不提示，安装版与未知身份也不按发布副本判断', () => {
  for (const mode of ['dev', 'installed', undefined, 'unknown']) {
    assert.equal(releaseBehindOf('abcdef1', 'abcdef2', mode), false);
    assert.equal(releaseBehindOf(null, 'abcdef2', mode), false);
  }
});

test('印章无法读取、缺 commit 或 commit 非有效字符串时不提示', () => {
  for (const stampCommit of [null, undefined, '', '   ', 123, {}, []]) {
    assert.equal(releaseBehindOf('abcdef1', stampCommit, 'release'), false);
  }
});
