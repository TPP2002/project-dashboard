'use strict';

/** 只比较发布副本身份；印章缺失或无有效 commit 时不宣称服务落后。 */
function releaseBehindOf(runningCommit, stampCommit, mode) {
  return mode === 'release' && typeof stampCommit === 'string' && stampCommit.trim().length > 0
    && runningCommit !== stampCommit;
}

module.exports = { releaseBehindOf };
