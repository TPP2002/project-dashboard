'use strict';
const { resolveProject, readRegistry } = require('../core/resolveProject.cjs');
const { readBoardOrNull } = require('./store.cjs');
const { readMergedActivity } = require('../core/activityArchive.cjs');
const d = require('../core/delegatedDecision.cjs');
const list = v => v === undefined ? [] : Array.isArray(v) ? v : [v];
const val = v => typeof v === 'string' ? v.trim() : '';
const project = flags => resolveProject(flags.project, { registryPath: flags.registry });
const load = p => d.collectDelegations(p.id, readMergedActivity(p.board)).records;
function delegateToNote(flags) {
  const p = project(flags), records = load(p), taskId = (flags._ || [])[0] || null;
  let item, text, action;
  if (flags.overturn !== undefined) {
    if (['kind', 'symptom', 'chose', 'alt', 'juror'].some(k => flags[k] !== undefined)) throw new Error('推翻时不能同时填写代定参数');
    const code = val(flags.overturn).replace(/^#/, '');
    let hits = records.filter(r => r.code === code);
    if (taskId) hits = hits.filter(r => r.taskId === taskId);
    if (!hits.length) throw new Error('没有找到对应的代定记录，或卡号不匹配');
    if (hits.length > 1) throw new Error('短号命中多条记录，请带卡号：' + hits.map(r => r.taskId || '（项目级）').join('、'));
    item = hits[0]; if (item.overturned) throw new Error('这条代定已经被推翻');
    if (flags.reason !== undefined && !val(flags.reason)) throw new Error('原因必须是文本');
    text = d.formatOverturnNote(item.code, flags.reason); action = '推翻';
  } else {
    const kind = d.normalizeKind(flags.kind);
    if (!kind || !val(flags.symptom) || !val(flags.chose) || !val(flags.alt)) throw new Error('请填写类别、现象、选择和另一条路；类别：' + d.DELEGATE_KINDS.map(k => k.label).join('、'));
    if (['symptom', 'chose', 'alt', 'juror'].some(k => flags[k] !== undefined && (typeof flags[k] !== 'string' || /[|｜\r\n]/.test(flags[k])))) throw new Error('现象、选择、另一条路和会审不能含竖线或换行');
    const board = readBoardOrNull(p.board);
    if (!taskId || !board || !(board.tasks || []).some(t => t.id === taskId)) throw new Error('卡号不存在');
    item = { taskId, kindKey: kind.key, kindLabel: kind.label, symptom: val(flags.symptom), chose: val(flags.chose), alt: val(flags.alt), juror: val(flags.juror) };
    const code = d.pickShortCode(p.id, records, item);
    if (typeof code !== 'string') throw new Error(`已有相同代定：${code.duplicate}`);
    item.code = code; text = d.formatDelegateNote(item); action = '代定';
  }
  const noteFlags = { _: item.taskId ? [item.taskId] : [], text, project: flags.project, registry: flags.registry, author: flags.author, json: flags.json };
  const post = res => {
    res.text = `已记录${action} ${item.taskId || '（项目级）'}#${item.code}（${item.kindLabel}）`;
    if (action === '推翻') {
      const count = load(p).filter(r => r.kindKey === item.kindKey && r.overturned).length;
      if (count >= d.OVERTURN_HINT_AT) res.text += `\n这一类在本项目已被推翻 ${count} 次，请在回报里提一句，由负责人定这一类要不要改成先问；不自动改。`;
    }
    return res;
  };
  return { flags: noteFlags, post };
}
function delegate(flags) { const result = delegateToNote(flags); return result.post(require('./commands.cjs').note(result.flags)); }
function delegated(flags) {
  if ((flags.search !== undefined) === (flags.stats !== undefined)) throw new Error('请指定 --search <关键词> 或 --stats');
  const kind = flags.kind === undefined ? null : d.normalizeKind(flags.kind);
  if (flags.kind !== undefined && !kind) throw new Error('类别不认识');
  const terms = [...list(flags.search).filter(x => typeof x === 'string'), ...(flags._ || [])].join(' ').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (flags.search !== undefined && !terms.length) throw new Error('请填写搜索关键词');
  let limit = 30;
  if (flags.limit !== undefined) { limit = Number(flags.limit); if (flags.limit === true || !Number.isInteger(limit) || limit < 1 || flags.stats !== undefined) throw new Error('--limit 须为正整数且仅用于搜索'); }
  const entries = readRegistry(flags.registry).projects || {};
  const ids = flags.project ? [flags.project] : Object.keys(entries), skipped = [], hits = [], stats = [];
  for (const id of ids) {
    try {
      const p = resolveProject(id, { registryPath: flags.registry });
      const records = load(p).filter(r => !kind || r.kindKey === kind.key);
      if (flags.search !== undefined) {
        for (const r of records) {
          const hay = [r.kindLabel, r.kindKey, r.symptom, r.chose, r.alt, r.juror, r.taskId, r.code].join(' ').toLowerCase();
          if (terms.every(t => hay.includes(t))) hits.push({ project: id, projectName: p.name, taskId: r.taskId, code: r.code, kind: r.kindLabel, kindKey: r.kindKey, symptom: r.symptom, chose: r.chose, alt: r.alt, juror: r.juror, at: r.at, by: r.by, overturned: r.overturned, hasWrittenCode: r.hasWrittenCode });
        }
      } else {
        for (const key of [...new Set(records.map(r => r.kindKey))]) {
          const rows = records.filter(r => r.kindKey === key), overturned = rows.filter(r => r.overturned).length;
          stats.push({ project: id, projectName: p.name, kind: key === 'other' ? '其他（六类之外）' : rows[0].kindLabel, kindKey: key, total: rows.length, overturned, hint: overturned >= d.OVERTURN_HINT_AT });
        }
      }
    } catch (e) { if (flags.project) throw e; skipped.push({ project: id, reason: e.message }); }
  }
  const skipText = skipped.map(s => `跳过：${s.project}（${s.reason}）`);
  if (flags.search !== undefined) {
    hits.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const total = hits.length, shown = hits.slice(0, limit);
    const lines = shown.map(r => `[${r.projectName}] ${r.taskId || '（项目级）'}#${r.code} 【${r.kind}】${r.symptom} | 选了 ${r.chose} | 另一条路 ${r.alt}${r.juror ? ' | 会审：' + r.juror : ''}（${String(r.at).slice(0, 10)}，${r.by}${r.overturned ? '；已推翻' : ''}）`);
    lines.push(total ? `共 ${total} 条${total > limit ? `（只显示前 ${limit} 条）` : ''}` : '没有找到');
    return { ok: true, hits: shown, total, skipped, text: [...lines, ...skipText].join('\n') };
  }
  const lines = stats.map(s => `[${s.projectName}] ${s.kind}：代定 ${s.total} 条，被推翻 ${s.overturned} 次${s.hint ? '（建议提一句：由负责人定是否改成先问）' : ''}`);
  return { ok: true, stats: stats.map(({ projectName, ...s }) => s), skipped, text: [...lines, ...skipText].join('\n') };
}
module.exports = { delegateToNote, delegate, delegated };
