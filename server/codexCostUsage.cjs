'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const { unwrapEvent } = require('./codexSessionData.cjs');
const { localDate } = require('./codexMetrics.cjs');

const costCache = new Map();

/** 跨日会话逐行算累计 token 的增量；任何时刻内存里只留一行。 */
function scanTokenTotalsByDay(file) {
  const size = fs.statSync(file).size;
  const cached = costCache.get(file);
  if (cached && cached.size === size) return Promise.resolve(cached.result);
  return new Promise((resolve) => {
    const dailyTokens = {};
    let previousTotal = 0;
    const input = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (!line.includes('"token_count"')) return;
      let event;
      try { event = JSON.parse(line); } catch (_) { return; }
      const inner = unwrapEvent(event);
      if (inner.type !== 'token_count') return;
      const total = Number(inner.payload.info?.total_token_usage?.total_tokens);
      const date = localDate(event.timestamp);
      if (!Number.isFinite(total) || total < 0 || !date) return;
      const delta = total >= previousTotal ? total - previousTotal : total;
      dailyTokens[date] = (dailyTokens[date] || 0) + delta;
      previousTotal = total;
    });
    const finish = () => {
      const tokensUsed = Object.values(dailyTokens).reduce((sum, value) => sum + value, 0);
      const result = { dailyTokens, tokensUsed };
      costCache.set(file, { size, result });
      resolve(result);
    };
    lines.once('close', finish);
    input.once('error', () => {
      try { lines.close(); } catch (_) {}
    });
  });
}

module.exports = { scanTokenTotalsByDay };
