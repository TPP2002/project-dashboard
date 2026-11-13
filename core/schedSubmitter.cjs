'use strict';

function formatSubmitter({ clientHeader, remoteAddress, userAgent }) {
  const client = clientHeader === 'sched-console' ? 'page' : 'api';
  const addr = (remoteAddress || '').replace(/^::ffff:/, '') || 'unknown';
  const ua = (userAgent || '').replace(/[\x00-\x1f\x7f;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'none';
  return `dashboard;client=${client};addr=${addr};ua=${ua}`;
}
function parseSubmitter(text) {
  if (!text) return null;
  if (text === 'dashboard') return { legacy: true };
  if (!text.startsWith('dashboard;')) return { raw: text };
  const fields = {};
  for (const part of text.split(';').slice(1)) {
    const i = part.indexOf('='); if (i >= 0) fields[part.slice(0, i)] = part.slice(i + 1);
  }
  return { client: fields.client, addr: fields.addr, ua: fields.ua };
}
module.exports = { formatSubmitter, parseSubmitter };
