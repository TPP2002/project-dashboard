'use strict';
// Transport-neutral owner command protocol. No identity or filesystem capabilities in bodies.
const crypto = require('node:crypto');
const VERSION = 'board-command.v1';
const MAX_BYTES = 512 * 1024;
const READ = new Set(['list', 'show', 'brief', 'inbox', 'claim-check']);
const FIELDS = {
  add: 'title plain-title model scope wave desc status payload',
  claim: 'branch builder scope brief', unclaim: 'branch reason',
  progress: 'percent next tests typecheck', 'await-collect': 'job outcome finished-at engine',
  'collect-brief': 'text', pending: 'payload did', decide: 'did answer no-promote',
  undecide: 'did reason', park: 'reason note', unpark: 'reason', block: 'by reason',
  done: 'pr commit collect', cancel: 'reason', reopen: 'reason', note: 'text task from',
  'request-info': 'did missing', edit: 'title plain-title desc model wave',
  'mark-landed': 'did all commit', cost: 'agents tokens rmb credits credit-unit unknown note',
  list: 'all status wave builder brief fields', show: 'full pending', brief: '',
  inbox: 'tid limit all', 'claim-check': 'branch',
  'git-facts': 'facts', 'sync-progress': 'branch percent',
};
const MULTI = new Set(['scope', 'branch', 'by', 'pr', 'commit']);
const BOOL = new Set(['brief','no-promote','collect','all','full','pending','typecheck']);
const NUM = new Set(['wave','percent','tokens','rmb','credits','limit','pr']);
const BAD = new Set(['__proto__', 'constructor', 'prototype']);
function safeTree(value, depth = 0) {
  if (depth > 16) throw new Error('参数嵌套过深');
  if (typeof value === 'string' && value.length > 128 * 1024) throw new Error('文本超过上限');
  if (Array.isArray(value)) {
    if (value.length > 2000) throw new Error('数组超过上限');
    value.forEach(v => safeTree(v, depth + 1));
  } else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (key.split('.').some(k => BAD.has(k))) throw new Error('禁止原型点路径');
      safeTree(v, depth + 1);
    }
  }
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function inputHash(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function validate(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('请求必须是对象');
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_BYTES) throw new Error('请求超过大小上限');
  safeTree(request);
  for (const key of Object.keys(request)) if (!['version','authorityId','authorityEpoch','requestId','projectId','command','args'].includes(key)) throw new Error('未知请求字段: ' + key);
  if (request.version !== VERSION) throw new Error('未知协议版本');
  for (const key of ['authorityId','requestId','projectId']) if (typeof request[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(request[key])) throw new Error('非法 ' + key);
  if (!Number.isSafeInteger(request.authorityEpoch) || request.authorityEpoch < 1) throw new Error('非法 authorityEpoch');
  if (typeof request.command !== 'string' || !Object.hasOwn(FIELDS,request.command)) throw new Error('远程未适配命令: ' + request.command);
  const spec = FIELDS[request.command];
  const args = request.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('args 必须是 typed 对象');
  const allowed = new Set(['_', 'author', ...spec.split(' ').filter(Boolean)]);
  for (const [key, value] of Object.entries(args)) {
    if (!allowed.has(key)) throw new Error('命令不接受参数: ' + key);
    if (key === '_') { if (!Array.isArray(value) || value.length > 1 || value.some(v => typeof v !== 'string' || !/^[A-Z0-9][A-Z0-9-]*$/.test(v))) throw new Error('非法任务位置参数'); continue; }
    if (['payload','facts'].includes(key)) { if (!value || typeof value !== 'object') throw new Error('非法结构化参数'); continue; }
    const multi = MULTI.has(key) && (key !== 'branch' || ['claim','unclaim'].includes(request.command));
    const values = Array.isArray(value) && multi ? value : [value];
    for (const v of values) {
      if (BOOL.has(key)) { if (typeof v !== 'boolean') throw new Error(key + ' 应为布尔值'); }
      else if (NUM.has(key)) {
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(key + ' 应为数字');
        if (!['rmb','credits'].includes(key) && !Number.isSafeInteger(v)) throw new Error(key + ' 应为整数');
      }
      else if (typeof v !== 'string') throw new Error(key + ' 应为字符串');
    }
  }
  if (request.command === 'pending' && args.payload !== undefined) {
    const v = args.payload;
    if (Array.isArray(v) || Object.keys(v).some(k => !['question','options','recommended','background','optionPros','recommendReason','allowCustom'].includes(k))) throw new Error('待拍板 payload 字段非法');
    for (const key of ['question','recommended','background','recommendReason']) if (typeof v[key] !== 'string') throw new Error('待拍板文本类型非法: ' + key);
    if (!Array.isArray(v.options) || v.options.some(x => typeof x !== 'string') || !v.optionPros || Array.isArray(v.optionPros) || typeof v.optionPros !== 'object' || Object.values(v.optionPros).some(x => typeof x !== 'string')) throw new Error('待拍板选项类型非法');
    if (v.allowCustom !== undefined && typeof v.allowCustom !== 'boolean') throw new Error('allowCustom 应为布尔值');
  }
  if (typeof args.fields === 'string' && args.fields.split(',').some(field => field.trim().split('.').some(key => BAD.has(key)))) throw new Error('禁止原型点路径');
  return request;
}
function publicResult(value) {
  if (Array.isArray(value)) return value.map(publicResult);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== '_commandReceipts').map(([k,v]) => [k, publicResult(v)]));
}
module.exports = { VERSION, MAX_BYTES, READ, FIELDS, MULTI, BOOL, NUM, validate, canonical, inputHash, publicResult };
