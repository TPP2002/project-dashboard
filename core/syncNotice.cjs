'use strict';
const fs = require('node:fs');
const path = require('node:path');

function unseenRejected(proj) {
  if (!proj?.cloud) return [];
  try {
    const rejected = JSON.parse(fs.readFileSync(path.join(proj.syncDir, 'rejected.json'), 'utf8'));
    return Array.isArray(rejected.items) ? rejected.items.filter(item => item && !item.seen
      && typeof item.command === 'string' && Array.isArray(item.taskIds)
      && item.taskIds.every(id => typeof id === 'string') && typeof item.error === 'string'
      && (item.reason === undefined || typeof item.reason === 'string')) : [];
  } catch { return []; }
}
function noticeLine(items) {
  if (!items.length) return '';
  const item = items[0];
  return `⚠ 云端退回了你 ${items.length} 条改动:${item.command} ${(item.taskIds || []).join(',')}(${item.reason || item.error})` +
    `${items.length > 1 ? '等' : ''}。看 board.cmd cloud status`;
}
module.exports = { unseenRejected, noticeLine };
