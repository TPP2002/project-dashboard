'use strict';
const { memberActions, aiWork } = require('./collaborationRules.cjs');
// Command receipts are storage-only idempotency metadata, including in nested
// CLI responses. Apply at serialization without mutating the cached ledger.
function publicJson(key, value) {
  return key === '_commandReceipts' || key === '_commandRetention' ? undefined : value;
}
// Field whitelist and text scrubber shared by HTTP boards and CLI receipts.
function text(value) {
  if (typeof value !== 'string') return undefined;
  return value.replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s<>"']+/g, '[private path]')
    .replace(/(^|[\s("'=])\/(?!\/)[\w.~-]+(?:\/[^\s<>"']*)?/g, '$1[private path]');
}
function taskView(t, user, activity = []) {
  const out = {};
  for (const k of ['id', 'title', 'plainTitle', 'description', 'status', 'assigneeUserId', 'assigneeName', 'lastProgressAt', 'blockReason', 'cancelReason', 'createdByUserId']) {
    if (typeof t[k] === 'string') out[k] = text(t[k]);
  }
  for (const k of ['percent', 'wave']) if (Number.isInteger(t[k])) out[k] = t[k];
  for (const k of ['blockReason', 'cancelReason', 'createdByUserId']) out[k] = text(t[k]) ?? null;
  if (t.dates && typeof t.dates === 'object') {
    out.dates = {};
    for (const k of ['start', 'done', 'design']) if (typeof t.dates[k] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.dates[k])) out.dates[k] = t.dates[k];
  }
  out.actions = memberActions(t, user);
  out.aiWork = aiWork(t);
  out.messages = activity.filter(a => a.taskId === t.id && a.kind === 'message').slice(-50)
    .map(a => ({ ts: text(a.ts) ?? null, author: text(a.author) ?? null, text: text(a.text) ?? '', userId: text(a.userId) ?? null }));
  return out;
}
module.exports = { publicJson, taskView, text };
