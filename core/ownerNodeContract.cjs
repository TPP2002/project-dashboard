'use strict';
// A semantic protocol. HTTP routes, arbitrary argv and filesystem roots never cross it.
const crypto = require('node:crypto');
const VERSION = 'owner-node.v1';
const MAX_FRAME = 512 * 1024;
const MAX_CHUNK = 128 * 1024;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (max, re) => v => typeof v === 'string' && v.length > 0 && v.length <= max && (!re || re.test(v));
const id = v => str(128, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/)(v) && !['__proto__','constructor','prototype'].includes(v);
const hash = str(64, /^[a-f0-9]{64}$/);
const integer = max => v => Number.isSafeInteger(v) && v >= 0 && v <= max;
const bool = v => typeof v === 'boolean';
const choice = (...values) => v => values.includes(v);
const uuid = str(36, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
const relative = v => str(2048)(v) && !/[\\:\0]/.test(v) && !v.startsWith('/') && v.split('/').every(p => p && p !== '.' && p !== '..');
function fields(value, required, optional = {}) {
  if (!record(value) || Object.keys(value).some(k => !Object.hasOwn(required, k) && !Object.hasOwn(optional, k))) fail('Unexpected fields');
  for (const [k, check] of Object.entries(required)) if (!check(value[k])) fail('Invalid ' + k);
  for (const [k, check] of Object.entries(optional)) if (Object.hasOwn(value, k) && !check(value[k])) fail('Invalid ' + k);
  return value;
}
const project = { projectId: id };
const slug = str(49, /^[a-z0-9][a-z0-9-]*$/);
const key = str(40, /^[A-Za-z0-9_-]+$/);
const message = str(8000);
const operations = {
  'dispatch.launch': [{ ...project, mode: choice('task','project','decision'), text: str(60000) }, { taskId: id, decisionId: id }],
  'jobs.list': [project, {}],
  'jobs.get': [{ ...project, slug }, { tail: bool }],
  'jobs.task': [{ ...project, slug }, {}],
  'jobs.dispatch': [{ ...project, slug }, { taskText: str(240 * 1024) }],
  'jobs.say': [{ ...project, slug, message }, {}],
  'jobs.collect': [{ ...project, slug }, {}],
  'sessions.list': [project, { limit: integer(500), days: integer(365) }],
  'sessions.get': [{ ...project, sessionId: uuid }, { tail: integer(1000) }],
  'sessions.resume': [{ ...project, sessionId: uuid, message }, { sandboxMode: choice('read-only','workspace-write') }],
  'sessions.quota': [project, {}],
  'sessions.report': [project, { days: choice(1,7) }],
  'usage.changes': [{ cursor: integer(Number.MAX_SAFE_INTEGER) }, { limit: integer(100), batch: id, offset: integer(Number.MAX_SAFE_INTEGER) }],
  'usage.details': [{ ...project, kind: choice('sessions','jobs') }, { days: integer(365), fromDate: str(10,/^\d{4}-\d{2}-\d{2}$/), toDate: str(10,/^\d{4}-\d{2}-\d{2}$/), model: str(128), card: id, engine: id }],
  'usage.balance': [project, {}],
  'project.doc.get': [{ ...project, relativePath: relative }, {}],
  'project.facts': [project, {}],
  'ci.snapshot': [project, {}],
  'reader.sources.get': [{ ...project, kind: choice('manifest','report'), }, { key }],
  'audition.sources.get': [{ ...project, kind: choice('index','batch','file') }, { key, relativePath: relative }],
  'reader.annotations.export': [{ ...project, key, object: v => {try {descriptor(v);return true;}catch{return false;}}, contentVersion: hash }, {}],
  'audition.annotations.export': [{ ...project, key, object: v => {try {descriptor(v);return true;}catch{return false;}}, contentVersion: hash }, {}],
  'object.write': [{ object: v => {try{descriptor(v);return true;}catch{return false;}}, offset: integer(32 * 1024 * 1024), data: str(4 * Math.ceil(MAX_CHUNK / 3),/^[A-Za-z0-9+/]*={0,2}$/) }, {}],
  'object.read': [{ object: v => { try { descriptor(v); return true; } catch { return false; } }, offset: integer(32 * 1024 * 1024), length: v => integer(MAX_CHUNK)(v) && v > 0 }, {}],
};
const writes = new Set(['dispatch.launch','jobs.dispatch','jobs.say','jobs.collect','sessions.resume','reader.annotations.export','audition.annotations.export','object.write']);
function validateOperation(op, args) {
  if (!Object.hasOwn(operations, op)) fail('Unknown operation');
  fields(args, ...operations[op]);
  if (op === 'reader.sources.get' && args.kind === 'report' && !key(args.key)) fail('Missing key');
  if (op === 'audition.sources.get' && ((args.kind === 'batch' && !key(args.key)) || (args.kind === 'file' && !relative(args.relativePath)))) fail('Missing source selector');
  return args;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
function descriptor(value) { return fields(value, { nodeId: id, projectId: id, kind: id, hash, size: integer(32 * 1024 * 1024) }); }
function request(value) {
  fields(value, { version: choice(VERSION), direction: choice('request'), generation: uuid, sequence: v => integer(Number.MAX_SAFE_INTEGER)(v) && v > 0, nonce: uuid, operation: v => Object.hasOwn(operations,v), args: record }, { operationId: uuid, hash });
  validateOperation(value.operation, value.args);
  if (writes.has(value.operation) && (!uuid(value.operationId) || value.hash !== digest({ operation: value.operation, args: value.args }))) fail('Write identity mismatch');
  return value;
}
function reply(value) {
  fields(value, { version: choice(VERSION), direction: choice('reply'), generation: uuid, sequence: v => integer(Number.MAX_SAFE_INTEGER)(v) && v > 0, nonce: uuid, ok: bool }, { result: () => true, error: v => record(v) && Object.keys(v).every(k => ['status','message'].includes(k)) && integer(599)(v.status) && str(300)(v.message) });
  if (value.ok ? !Object.hasOwn(value,'result') || Object.hasOwn(value,'error') : !value.error || Object.hasOwn(value,'result')) fail('Invalid reply');
  return value;
}
module.exports = { VERSION, MAX_FRAME, MAX_CHUNK, fail, fields, id, uuid, relative, descriptor, request, reply, validateOperation, writes, digest, canonical };
