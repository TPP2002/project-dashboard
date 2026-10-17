'use strict';
const { fail, canonicalJson, clone } = require('./json.cjs');
const text = (max = 4096, min = 1) => (v, p) => { if (typeof v !== 'string' || v.length < min || v.length > max) fail('TEXT', p); };
const pattern = re => (v, p) => { text(256)(v, p); if (!re.test(v)) fail('PATTERN', p); };
const id = pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const segment = pattern(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/);
const hash = pattern(/^[0-9a-f]{64}$/);
const sha1 = pattern(/^[0-9a-f]{40}$/);
const ticketId = pattern(/^tk-[0-9a-f]{20}$/);
const integer = (min = 0, max = Number.MAX_SAFE_INTEGER) => (v, p) => { if (!Number.isSafeInteger(v) || v < min || v > max) fail('INTEGER', p); };
const finite = (min = 0) => (v, p) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min) fail('NUMBER', p); };
const count = integer();
const positive = integer(1);
const pid = integer(1, 0xffffffff);
const attemptId = (v, p) => { pattern(/^a[1-9]\d{0,15}$/)(v, p); positive(Number(v.slice(1)), p); };
const birth = (v, p) => { pattern(/^[1-9]\d{0,19}$/)(v, p); if (BigInt(v) > 18446744073709551615n) fail('BIRTH', p); };
const enumeration = values => (v, p) => { if (!values.includes(v)) fail('ENUM', p); };
const bool = enumeration([true, false]);
const literalTrue = enumeration([true]);
const nullable = check => (v, p) => { if (v !== null) check(v, p); };
const list = (check, min = 0, max = 4096, unique = false) => (v, p) => {
  if (!Array.isArray(v) || v.length < min || v.length > max) fail('ARRAY', p);
  v.forEach((x, i) => check(x, `${p}[${i}]`));
  if (unique && new Set(v.map(x => canonicalJson(x))).size !== v.length) fail('DUPLICATE', p);
};
const fields = (required, optional = {}) => (v, p = '$') => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('OBJECT', p);
  for (const [key, check] of Object.entries(required)) { if (!Object.hasOwn(v, key)) fail('MISSING', `${p}.${key}`); check(v[key], `${p}.${key}`); }
  for (const key of Object.keys(v)) {
    if (Object.hasOwn(required, key)) continue;
    if (!Object.hasOwn(optional, key)) fail('UNKNOWN_FIELD', `${p}.${key}`);
    optional[key](v[key], `${p}.${key}`);
  }
};
const iso = (v, p) => {
  text(24)(v, p);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail('TIME', p);
};
const controller = fields({ pid, creationFileTime: birth });
const codeRef = (v, p) => { fields({ kind: enumeration(['commit', 'content']), value: text(64) })(v, p); (v.kind === 'commit' ? sha1 : hash)(v.value, `${p}.value`); };
const categories = ['unit-test', 'e2e-test', 'calib-run', 'perf-bench', 'mutation-test', 'codex-build', 'codex-acceptance', 'other'];
const category = enumeration(categories);
const result = enumeration(['passed', 'failed', 'voided', 'cancelled']);
function validate(check, input) { canonicalJson(input); check(input, '$'); return clone(input); }
module.exports = { text, pattern, id, segment, hash, sha1, ticketId, attemptId, integer, finite, count, positive, pid, birth, enumeration, bool, literalTrue, nullable, list, fields, iso, controller, codeRef, category, result, validate };
