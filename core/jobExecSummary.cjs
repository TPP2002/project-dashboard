'use strict';
const fs = require('node:fs');
const readline = require('node:readline');

function readExecSummary(file) {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    const summary = { turns: 0, lastAssistantModel: null, result: null };
    let failed = false;
    lines.on('line', (line) => {
      if (!line.includes('"assistant"') && !line.includes('"result"') && !line.includes('\\u')) return;
      let event;
      try { event = JSON.parse(line); } catch (_) { return; }
      if (event?.type === 'assistant') {
        summary.turns++;
        if (typeof event.message?.model === 'string') summary.lastAssistantModel = event.message.model;
      }
      if (event?.type === 'result') {
        const models = event.modelUsage;
        summary.result = { usage: event.usage,
          modelUsageNames: models && typeof models === 'object' && !Array.isArray(models) ? Object.keys(models) : [],
          model: event.model === undefined ? null : event.model,
          totalCostUsd: event.total_cost_usd === undefined ? null : event.total_cost_usd,
          assistantModel: summary.lastAssistantModel };
      }
    });
    const onError = (error) => { if (!failed) { failed = true; reject(error); lines.close(); } };
    input.once('error', onError);
    lines.once('error', onError);
    lines.once('close', () => { if (!failed) resolve(summary); });
  });
}
function execSummaryOf(file, memo) {
  if (!memo) return readExecSummary(file);
  return memo.async(file, 'exec-summary@1', async () => {
    try { return await readExecSummary(file); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
  }, { persist: true });
}
module.exports = { readExecSummary, execSummaryOf };
