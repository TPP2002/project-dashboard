'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const aliases = {
  ui: ['界面', 'ui', '页面', '外观', '视觉'], gameplay: ['玩法与数值', 'gameplay', '玩法', '数值'],
  copy: ['文案', 'copy', '文字'], data: ['数据与口径', 'data', '数据', '口径'],
  external: ['对外', 'external', '外部'], tech: ['技术与流程', 'tech', '技术', '流程'],
};
const DELEGATE_KINDS = Object.entries(aliases).map(([key, values]) => ({ key, label: values[0] }));
const askAliases = { goal: ['改目标', '目标'], spend: ['花钱超线', '花钱', '超线', '预算'], irreversible: ['收不回的事', '收不回', '不可逆'], 'owner-only': ['要他本人做', '本人', '他本人'], taste: ['口味题', '口味'], rule: ['改规矩', '规矩', '规则'] };
const ASK_KINDS = Object.fromEntries(Object.entries(askAliases).map(([key, v]) => [key, v[0]]));
const DECIDED_BY = { owner: '负责人拍板', delegated: '对话代定' };
const clean = v => typeof v === 'string' ? v.trim() : '';
function normalizeKind(value) {
  const s = clean(value).toLowerCase();
  const key = Object.keys(aliases).find(k => aliases[k].some(v => v.toLowerCase() === s));
  return key ? { key, label: aliases[key][0] } : null;
}
function normalizeAskKind(value) {
  const s = clean(value).toLowerCase();
  return Object.keys(askAliases).find(k => k === s || askAliases[k].includes(s)) || null;
}
function normalizeDecidedBy(value) {
  const s = clean(value).toLowerCase();
  return ['owner', '负责人', '负责人拍板'].includes(s) ? 'owner' : ['delegated', '对话代定', '代定'].includes(s) ? 'delegated' : null;
}
const OVERTURN_HINT_AT = 3;
function shortCode(project, taskId, kindKey, symptom, chose, alt, length = 6) {
  return crypto.createHash('sha1').update([project, taskId, kindKey, symptom, chose, alt].map(clean).join('\n'), 'utf8').digest('hex').slice(0, length);
}
function pickShortCode(project, records, item) {
  const args = [project, item.taskId || '', item.kindKey, item.symptom, item.chose, item.alt];
  const code = shortCode(...args);
  const same = records.filter(r => r.code === code || r.code === shortCode(...args, 8));
  const duplicate = same.find(r => (r.taskId || '') === (item.taskId || '') && r.kindKey === item.kindKey && ['symptom', 'chose', 'alt'].every(k => clean(r[k]) === clean(item[k])));
  return duplicate ? { duplicate: duplicate.code } : same.length ? shortCode(...args, 8) : code;
}
function formatDelegateNote(item) {
  return `【代定·${item.kindLabel}#${item.code}】${clean(item.symptom)} | ${clean(item.chose)} | ${clean(item.alt)}` + (clean(item.juror) ? ` | 会审：${clean(item.juror)}` : '');
}
function formatOverturnNote(code, reason) { return `【推翻代定#${code}】${clean(reason) || '（未写原因）'}`; }
function parseDelegateNote(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/^【代定[·・.]?\s*([^】#]+?)(?:#([a-fA-F0-9]{6,8}))?】([\s\S]*)$/);
  if (!m) return null;
  const label = clean(m[1]); const kind = normalizeKind(label); const parts = m[3].split(/[|｜]/).map(clean);
  const symptom = parts.shift() || '', chose = parts.shift() || '';
  let juror = ''; const j = parts.length > 1 && /^会审/.test(parts[1]) ? 1 : -1;
  if (j >= 0) juror = parts.splice(j, 1)[0].replace(/^会审\s*[:：]?\s*/, '');
  return { kindLabel: kind ? kind.label : label, kindKey: kind ? kind.key : 'other', code: m[2] || null, symptom, chose, alt: parts.join(' | '), juror };
}
function parseOverturnNote(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/^【推翻代定#([a-fA-F0-9]{6,8})】([\s\S]*)$/);
  return m ? { code: m[1], reason: clean(m[2]) } : null;
}
function collectDelegations(project, activity) {
  const records = [], overturnedCodes = new Set(), reasons = new Map();
  for (const a of activity || []) {
    const o = parseOverturnNote(a.text); if (o) { overturnedCodes.add(o.code); reasons.set(o.code, o.reason); }
    const d = parseDelegateNote(a.text); if (!d) continue;
    const taskId = a.taskId || null, hasWrittenCode = !!d.code;
    const code = d.code || shortCode(project, taskId || '', d.kindKey, d.symptom, d.chose, d.alt);
    records.push({ ...d, taskId, code, at: a.ts || '', by: a.author || '', hasWrittenCode });
  }
  for (const r of records) { r.overturned = overturnedCodes.has(r.code); r.overturnReason = reasons.get(r.code) || ''; }
  return { records, overturnedCodes };
}
function isDelegatedProject(entry) {
  try {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.delegatedDecision === 'boolean') return entry.delegatedDecision;
    return ['codeRepo', 'mainRepo'].some(k => { try { return typeof entry[k] === 'string' && fs.statSync(path.join(entry[k], 'docs', '授权页.md')).isFile(); } catch { return false; } });
  } catch { return false; }
}
const ENFORCE_ASK_KIND = Symbol.for('ENFORCE_ASK_KIND');
function isEntry(flags) {
  try { return isDelegatedProject(require('./resolveProject.cjs').readRegistry(flags.registry).projects[flags.project]); } catch { return false; }
}
function markEntryEnforcement(flags) { if (isEntry(flags)) Object.defineProperty(flags, ENFORCE_ASK_KIND, { value: true }); }
function entryHint(cmd, flags) { return cmd === 'decide' && flags.by === undefined && isEntry(flags) ? '没写 --by，这条记为未标' : ''; }
function askKindRefusal() { return '必须指定待拍板类别：改目标、花钱超线、收不回的事、要他本人做、口味题、改规矩；六种都不属于就不要登记待拍板，自己定，用 delegate 留一行'; }
module.exports = { DELEGATE_KINDS, normalizeKind, ASK_KINDS, normalizeAskKind, DECIDED_BY, normalizeDecidedBy, OVERTURN_HINT_AT, shortCode, pickShortCode, formatDelegateNote, formatOverturnNote, parseDelegateNote, parseOverturnNote, collectDelegations, isDelegatedProject, ENFORCE_ASK_KIND, markEntryEnforcement, entryHint, askKindRefusal };
