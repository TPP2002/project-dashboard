'use strict';
const { createHash } = require('node:crypto');
const MAX_FRAME_BYTES = 512 * 1024;
class ProtocolValidationError extends Error {
  constructor(code, path = '$') { super(`${code} at ${path}`); this.name = 'ProtocolValidationError'; this.code = code; this.path = path; }
}
function fail(code, path) { throw new ProtocolValidationError(code, path); }
// Inspect descriptors before reading values: accessors, prototypes and toJSON never run.
function inspect(value, path = '$', depth = 0, ancestors = new Set(), budget = { nodes: 0 }) {
  if (++budget.nodes > 50000 || depth > 32) fail('JSON_LIMIT', path);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > 262144 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail('JSON_STRING', path);
    return;
  }
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('JSON_NUMBER', path); return; }
  if (typeof value !== 'object') fail('JSON_VALUE', path);
  if (ancestors.has(value)) fail('JSON_CYCLE', path);
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('JSON_PROTOTYPE', path);
  if (Array.isArray(value) && (Object.getPrototypeOf(value) !== Array.prototype || value.length > 4096)) fail('JSON_ARRAY', path);
  ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (Array.isArray(value) && keys.length !== value.length + 1) fail('JSON_ARRAY', path);
  for (const key of keys) {
    if (Array.isArray(value) && key === 'length') continue;
    if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) fail('JSON_KEY', path);
    if (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key)) fail('JSON_ARRAY', path);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('JSON_DESCRIPTOR', `${path}.${key}`);
    inspect(descriptor.value, `${path}.${key}`, depth + 1, ancestors, budget);
  }
  ancestors.delete(value);
}
function canonicalJson(value) {
  inspect(value);
  const encode = item => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encode(item[key])}`).join(',')}}`;
  };
  const result = encode(value);
  if (Buffer.byteLength(result, 'utf8') > MAX_FRAME_BYTES) fail('JSON_LIMIT');
  return result;
}
function contentHash(value) { return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex'); }
function clone(value) { return JSON.parse(canonicalJson(value)); }
module.exports = { MAX_FRAME_BYTES, ProtocolValidationError, fail, inspect, canonicalJson, contentHash, clone };
