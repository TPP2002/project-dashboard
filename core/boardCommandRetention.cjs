'use strict';
const crypto = require('node:crypto');
const DAY = 86400000;
const DEFAULTS = Object.freeze({ retainMs: 7 * DAY, maxCount: 10000, maxBytes: 8 * 1024 * 1024 });
function requestId(now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('非法请求创建时间');
  return `${now}-${crypto.randomBytes(16).toString('hex')}`;
}
function createdAt(id) {
  const m = typeof id === 'string' && /^(0|[1-9][0-9]{0,15})-([a-f0-9]{32})$/.exec(id);
  if (!m || !Number.isSafeInteger(Number(m[1]))) throw new Error('requestId 必须包含不可变创建毫秒戳和随机数');
  return Number(m[1]);
}
function policy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !Object.hasOwn(DEFAULTS,k))) throw new Error('非法回执保留配置');
  const p = { ...DEFAULTS, ...value };
  for (const k of Object.keys(DEFAULTS)) if (!Number.isSafeInteger(p[k]) || p[k] < 1 || p[k] > DEFAULTS[k]) throw new Error('回执配置超出生产界限: ' + k);
  return p;
}
function size(receipts) { return Buffer.byteLength(JSON.stringify(receipts)); }
function prepare(board, id, configured, now = Date.now()) {
  const p = policy(configured);
  const stamp = createdAt(id);
  const receipts = { ...(board._commandReceipts || {}) };
  // v1 receipts have no trustworthy creation time. Never discard them and re-execute.
  if (Object.values(receipts).some(r => !Number.isSafeInteger(r.createdAt))) throw new Error('原型回执需主控显式迁移；保留旧回执并拒绝新协议写入');
  const previous = board._commandRetention;
  if (previous && (previous.version !== 2 || !Number.isSafeInteger(previous.rejectBefore) || !Number.isSafeInteger(previous.lastNow))) throw new Error('回执水位损坏，拒绝写入');
  const clock = Math.max(now, previous?.lastNow || 0);
  let rejectBefore = Math.max(previous?.rejectBefore || 0, clock - p.retainMs, 0);
  const prune = () => { for (const [k,r] of Object.entries(receipts)) if (r.createdAt < rejectBefore) delete receipts[k]; };
  prune();
  function check() { if (stamp < rejectBefore) throw new Error('expired：请求已过保留水位，结果待核对；禁止更换编号自动重执行'); }
  check();
  function finish() {
    while (Object.keys(receipts).length > p.maxCount || size(receipts) > p.maxBytes) {
      const earliest = Math.min(...Object.values(receipts).map(r => r.createdAt));
      if (!Number.isFinite(earliest)) throw new Error('回执容量配置过小');
      rejectBefore = Math.max(rejectBefore, earliest + 1);
      prune();
      check(); // Must retain THIS operation's receipt or roll the entire transaction back.
    }
    board._commandReceipts = receipts;
    board._commandRetention = { version: 2, rejectBefore, lastNow: Math.max(clock,rejectBefore) };
  }
  return { receipts, stamp, finish, checkNew() { if (stamp > now + 300000) throw new Error('requestId 过度未来（最多5分钟）'); } };
}
module.exports = { DEFAULTS, requestId, createdAt, policy, prepare, size };
