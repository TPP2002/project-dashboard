'use strict';
const fs = require('node:fs');
const path = require('node:path');
function readMergedActivity(boardPath) {
  const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  const entries = [...(board.activity || [])];
  const dir = path.dirname(boardPath);
  for (const name of fs.readdirSync(dir).filter(n => /^activity-\d{6}\.json$/.test(n)).sort()) {
    const rows = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    if (!Array.isArray(rows)) throw new Error('归档活动必须是数组');
    entries.push(...rows);
  }
  const seen = new Set();
  return entries.filter(a => { const key = JSON.stringify([a.ts, a.taskId, a.text]); if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
}
module.exports = { readMergedActivity };
