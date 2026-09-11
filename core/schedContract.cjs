'use strict';
/** 调度 v1 契约移植；规范编码与错误文案由 contract-golden.json 钉住。 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isUtf8 } = require('node:buffer');

const SCHED_FORMAT_VERSION = 1;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const RESERVATION_LEVELS = [0, 5, 10, 15];
const productionSources = { now: () => Date.now(), nonce: () => randomUUID() };

function requireRecord(value, label = '对象') {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`[cluster-lifecycle] ${label} 必须是 JSON object`);
  }
  return value;
}
function text(value, label = '文本') {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`[cluster-lifecycle] ${label} 必须是非空字符串`);
  return value;
}
function segment(value) {
  const result = text(value, '路径段');
  if (!SAFE_SEGMENT.test(result)) throw new Error(`[cluster-lifecycle] 路径段 含不允许的路径字符:${result}`);
  if (result === '.' || result === '..') throw new Error('[sched] 路径段不能是 . 或 ..');
  return result;
}
function integer(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error('[sched] 必须是范围内的安全整数');
  return value;
}
function isoTime(value) {
  const result = text(value, 'ISO 时间');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)
    || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) throw new Error('[sched] 时间必须为 UTC 毫秒 ISO');
  return result;
}
function oneOf(values) {
  return value => { if (!values.includes(value)) throw new Error(`[sched] 枚举值不合法:${String(value)}`); };
}
function list(check, minimum = 0, unique = false) {
  return value => {
    if (!Array.isArray(value) || value.length < minimum) throw new Error('[sched] 数组不合法');
    value.forEach(item => check(item));
    if (unique && new Set(value).size !== value.length) throw new Error('[sched] 数组含重复项');
  };
}
function fields(value, required, optional = {}) {
  const record = requireRecord(value);
  for (const [name, check] of Object.entries(required)) check(record[name]);
  for (const name of Object.keys(record)) {
    if (Object.hasOwn(required, name)) continue;
    const check = Object.hasOwn(optional, name) ? optional[name] : undefined;
    if (!check) throw new Error(`[sched] 未知字段:${name}`);
    check(record[name]);
  }
}
function ticketId(value) {
  const result = text(value, 'ticketId');
  if (!/^tk-[0-9a-f]{20}$/.test(result)) throw new Error('[sched] 单号不合法');
  return result;
}

/** 与上游 canonicalLifecycleJson 相同：排序后建对象，再用 JSON.stringify 编码。 */
function canonicalJson(value) {
  function canonicalize(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) {
      // for..of 同上游检查稀疏数组；空洞等价 undefined，必须拒收。
      const result = [];
      for (const child of item) result.push(canonicalize(child));
      return result;
    }
    if (typeof item === 'object' && item !== null && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      const sorted = {};
      for (const key of Object.keys(item).sort()) {
        if (key === '__proto__') throw new Error('[sched] 禁止 __proto__ 字段');
        sorted[key] = canonicalize(item[key]);
      }
      return sorted;
    }
    throw new Error('[sched] 仅接受完整 JSON 值');
  }
  return JSON.stringify(canonicalize(value));
}
function contentHash(value) { return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex'); }
function deriveTicketId(project, key) { text(project); segment(key); return `tk-${contentHash([project, key]).slice(0, 20)}`; }

function validateReserve(data, withMachine = true) {
  fields(data, { ...(withMachine ? { machine: segment } : {}), requestedCores: oneOf(RESERVATION_LEVELS) }, { durationMinutes: oneOf([60, 180]) });
  if (data.requestedCores === 0 && data.durationMinutes !== undefined) throw new Error('[sched] 零核预留不能带期限');
  return data;
}
function validateCommand(value) {
  const data = {
    'jump-queue': v => fields(v, { ticketId }), cancel: v => fields(v, { ticketId }),
    reserve: v => validateReserve(v),
    'owner-hold': v => fields(v, { machine: segment }), 'owner-release': v => fields(v, { machine: segment }),
  };
  fields(value, { commandId: segment, kind: oneOf(Object.keys(data)), data: v => requireRecord(v, '指令 data'), submitter: text, createdAt: isoTime, expiresAt: isoTime });
  data[value.kind](value.data);
  if (value.expiresAt < value.createdAt) throw new Error('[sched] 指令期限早于创建时间');
  return value;
}
function validateReceipt(value) {
  const receipt = requireRecord(value, '指令回执');
  fields(value, { commandId: segment, status: oneOf(['executed', 'rejected', 'expired']), at: isoTime,
    ...(receipt.status === 'executed' ? {} : { reason: text }) });
  return value;
}
function assertWritableFormat(value) {
  const record = requireRecord(value, 'format');
  if (integer(record.formatVersion, 1) > SCHED_FORMAT_VERSION) throw new Error('[sched] 共享盘格式比本代码新，拒绝写入');
  fields(value, { formatVersion: oneOf([SCHED_FORMAT_VERSION]), capabilities: list(text, 0, true), createdAt: isoTime });
  return value;
}
function schedPaths(share) {
  const root = path.join(share, 'sched');
  const control = path.join(root, '_control');
  return { root, control, format: path.join(control, 'format.json'), dispatcher: path.join(control, 'dispatcher.json'),
    heartbeat: path.join(control, 'dispatcher-heartbeat.json'), staging: path.join(root, '_staging'),
    tickets: path.join(root, 'tickets'), commands: path.join(root, 'commands'), commandReceipts: path.join(root, 'commands', '_receipts') };
}
function readJson(file) {
  const raw = fs.readFileSync(file);
  if (!isUtf8(raw)) throw new Error(`[sched] 文件不是有效 UTF-8:${file}`);
  return JSON.parse(raw.toString('utf8'));
}

/** 只创建 commands/<id>.json；版本不可读/更高即拒写，目录必须已经初始化。 */
function writeCommand(share, command, sources = productionSources) {
  const paths = schedPaths(share);
  assertWritableFormat(readJson(paths.format));
  validateCommand(command);
  const bytes = canonicalJson(command);
  const target = path.join(paths.commands, `${command.commandId}.json`);
  const staging = path.join(paths.staging, `.dashboard-${segment(sources.nonce())}.tmp`);
  // wx 失败时文件不属于本次调用，不能在 finally 删除它。
  fs.writeFileSync(staging, bytes, { encoding: 'utf8', flag: 'wx' });
  try { fs.linkSync(staging, target); }
  finally {
    try { fs.unlinkSync(staging); }
    catch (error) { console.warn(`[sched] 暂存清理失败:${error.message}`); }
  }
  return target;
}

/** 完整一拍展示缓存；只校验，不重算准入、保护锁或兑现值。 */
function validateHeartbeat(value) {
  const count = v => integer(v), positive = v => integer(v, 1);
  const nonNegative = v => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error('[sched] 心跳核数或偏好不合法'); };
  const nullable = check => v => { if (v !== null) check(v); };
  const boolean = oneOf([true, false]);
  fields(value, {
    machine: segment, pid: positive, protocol: positive, head: v => { if (typeof v !== 'string' || !/^[0-9a-f]{40}$/.test(v)) throw new Error('[sched] 心跳代码版本不合法'); },
    at: isoTime, tick: positive, cursorSeq: count, queued: count, granted: count,
    machines: list(v => fields(v, {
      name: segment, preference: nonNegative, quotaCores: count, grantedCores: count, externalLoadCores: nonNegative,
      availableCores: nonNegative, overCommitted: boolean, fresh: boolean, online: boolean,
      ci: oneOf(['active', 'idle', 'unknown']), ownerHold: boolean,
      reservation: nullable(r => fields(r, { requestedCores: oneOf(RESERVATION_LEVELS), fulfilledCores: nonNegative, untilAt: nullable(isoTime) })),
      heartbeatAt: nullable(isoTime), loadSampledAt: nullable(isoTime),
    })),
    queue: list(v => fields(v, { ticketId, position: positive, band: oneOf([0, 1]), requestedCores: positive,
      allowedMachines: list(segment, 1, true), queuedAt: isoTime, state: oneOf(['queued', 'unsatisfiable']), reason: nullable(text) })),
    locks: list(v => fields(v, { machine: segment, byTicketId: ticketId })),
  });
  const ordered = names => names.every((name, index) => index === 0 || names[index - 1] < name);
  if (!ordered(value.machines.map(m => m.name)) || !ordered(value.locks.map(l => l.machine))) throw new Error('[sched] 心跳机器或保护锁未按名字排序');
  for (const machine of value.machines) {
    if ((machine.name === value.machine) !== (machine.reservation !== null)
      || (machine.reservation && machine.reservation.fulfilledCores > machine.reservation.requestedCores)) throw new Error('[sched] 心跳预留归属或兑现核数不合法');
  }
  value.queue.forEach((ticket, index) => {
    if (ticket.position !== index + 1 || (ticket.state === 'queued') !== (ticket.reason === null)) throw new Error('[sched] 心跳排队名次或原因不合法');
  });
  return value;
}

module.exports = { SCHED_FORMAT_VERSION, SAFE_SEGMENT, RESERVATION_LEVELS, productionSources,
  requireRecord, text, segment, integer, isoTime, oneOf, list, fields, ticketId, canonicalJson, contentHash, deriveTicketId,
  validateReserve, validateCommand, validateReceipt, assertWritableFormat, schedPaths, readJson, writeCommand, validateHeartbeat };
