'use strict';
/**
 * readerReviewExport.cjs —— 审阅台「导出给外脑」纯函数(READER-EXPORT-REVIEW)。
 *
 * 干什么:把某份报告的负责人批注,连同「批阅意见单 + 回流对账 + 带批注的报告原文」
 *        拼成一份 markdown,负责人直接下载或复制,贴给外脑继续讨论。
 *        格式与负责人 2026-09-19 用参考脚本(未入库)手工验证过的输出逐节对齐;
 *        定位规则按工单做成通用版:认报告里任意 1~6 级标题、anchor 取子串匹配,
 *        不再只认参考脚本那种「## 第 N 页 · 」一种标题。
 *
 * 边界:不碰 HTTP、不读盘、不写盘;today 由调用方传入(HTTP 层给「今天」,测试给固定值),
 *      同一份入参永远拼出同一个字符串。导出结果只回给前端,不经服务器落盘、不 commit。
 */

/** 批注文本含问号或「为什么 / 是否 / 能不能」任一 → 追问,否则批注 */
const FOLLOWUP_RE = /[?？]|为什么|是否|能不能/;
/** B 节只收这三种 kind 的边注;一条没有时整节(连标题)都不出现 */
const KEEP_NOTE_KINDS = new Set(['纠正', '改判', '冲突']);
/** 下载文件名里的非法字符(路径分隔符、冒号、引号、通配符、控制符)统一换成 - */
const ILLEGAL_FILENAME_RE = /[/\\:*?"<>]|[\u0000-\u001f]/g;
/** 标题行:1~6 个 # + 空格 + 标题文字;capture 1 = 井号,capture 2 = 标题文字 */
const HEADING_RE = /^(#{1,6}) (.+)$/;
/** 「入库说明」段里允许出现的三种行:一级标题 / 引用块 / 空行 */
const H1_RE = /^#(\s|$)/;
const QUOTE_RE = /^>/;
const BLANK_RE = /^\s*$/;
const SETOFF_RE = /^---\s*$/;

/** 表格单元格清洗:| 转义成 \|;换行按列位换成空格或 <br> */
function escapeCell(value, newline) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r\n/g, '\n').replace(/\n/g, newline);
}

/** 把批注写成 C 节里的引用块:> **【负责人批注 N】**(针对:「…」)+ 逐行加 > 的批注正文 */
function fmtAnno(no, anno) {
  const quote = String((anno && anno.quote) || '').trim();
  const head = `> **【负责人批注 ${no}】**` + (quote ? `(针对:「${quote}」)` : '');
  const lines = String((anno && anno.text) || '').trim().split('\n')
    .map((line) => (line.trim() ? '> ' + line : '>'));
  return head + '\n' + lines.join('\n');
}

/** 扫出 md 里全部标题:按文档顺序,记级别、标题文字与该行起始偏移 */
function listHeadings(md) {
  const out = [];
  let offset = 0;
  for (const line of String(md ?? '').split('\n')) {
    const m = HEADING_RE.exec(line);
    if (m) out.push({ level: m[1].length, title: m[2].trim(), start: offset });
    offset += line.length + 1;
  }
  return out;
}

/** 批注 anchor 是某标题行文字(可能只是子串);取第一个「标题文字包含 anchor」的标题下标,找不到 -1 */
function sectionIndexOf(anchor, headings) {
  const a = String(anchor || '').trim();
  if (!a) return -1;
  for (let i = 0; i < headings.length; i++) if (headings[i].title.includes(a)) return i;
  return -1;
}

/** 小节末尾 = 下一个级别 ≤ 它的标题之前;没有就是文末 */
function sectionEnd(index, headings, docLength) {
  for (let j = index + 1; j < headings.length; j++) {
    if (headings[j].level <= headings[index].level) return headings[j].start;
  }
  return docLength;
}

/**
 * 剔掉开头的「入库说明」:第一个单独成行的 --- 之前(且在前 40 行内)若全是一级标题、
 * 引用块和空行,则这段里的引用块与 --- 剔掉、一级标题保留;形态不合或没有 --- 时原样返回。
 */
function stripIntakeHeader(md) {
  const text = String(md ?? '');
  const lines = text.split('\n');
  const limit = Math.min(lines.length, 40);
  let sep = -1;
  for (let i = 0; i < limit; i++) { if (SETOFF_RE.test(lines[i])) { sep = i; break; } }
  if (sep < 0) return text;
  for (let i = 0; i < sep; i++) {
    if (!(H1_RE.test(lines[i]) || QUOTE_RE.test(lines[i]) || BLANK_RE.test(lines[i]))) return text;
  }
  const kept = [];
  for (let i = 0; i < sep; i++) if (!QUOTE_RE.test(lines[i])) kept.push(lines[i]);
  while (kept.length && BLANK_RE.test(kept[kept.length - 1])) kept.pop();
  return kept.concat(lines.slice(sep + 1)).join('\n');
}

/**
 * 拼整份导出 md。入参:
 *   meta   报告元数据({title, version, ...})
 *   batch  所在批次({baseline, ...})
 *   md     报告原文 markdown
 *   annos  负责人批注数组(内部按 at 升序排,与参考实现一致)
 *   notes  边注层数组([{id, name, notes:[{anchor, kind, text}]}, ...])
 *   today  批阅日期,YYYY-MM-DD
 */
function buildReviewExport({ meta, batch, md, annos, notes, today }) {
  meta = meta || {};
  batch = batch || {};
  // 批注按时间升序(参考实现同款);at 缺失的排最前,排序稳定、同键保原序
  const list = (Array.isArray(annos) ? annos : []).slice().sort((x, y) => {
    const a = String((x && x.at) ?? ''); const b = String((y && y.at) ?? '');
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const flatNotes = [];
  for (const layer of (Array.isArray(notes) ? notes : [])) {
    for (const n of ((layer && layer.notes) || [])) flatNotes.push(n);
  }

  const L = [];
  const version = meta.version ? ` ${meta.version}` : '';
  L.push(`# 批阅意见单 · ${meta.title || ''}${version} → 回运给外脑`);
  L.push('');
  L.push(`> 负责人批阅日期:${today};整理:由审阅台批注账本机械导出(未改一字)。报告事实基线:${batch.baseline || ''}`);
  L.push(`> 共 ${list.length} 条批注。「类型」一栏是整理时按内容归的类,不是负责人写的,负责人可改。`);
  L.push('');
  L.push('## A. 逐条意见(按批注时间顺序)');
  L.push('');
  if (list.length) {
    L.push('| # | 节号/位置 | 报告原文(引用) | 负责人意见(原话) | 类型 | 要求外脑做什么 |');
    L.push('|---|---|---|---|---|---|');
    list.forEach((a, i) => {
      const pos = escapeCell((a && a.anchor) || '全篇', ' ');
      const quote = escapeCell((a && a.quote) || '', ' ');
      const text = escapeCell((a && a.text) || '', '<br>');
      const typ = FOLLOWUP_RE.test(String((a && a.text) || '')) ? '追问' : '批注';
      const ask = typ === '追问' ? '回答负责人的追问,并说明是否需要修订正文' : '按批注修订或回应';
      L.push(`| ${i + 1} | ${pos} | ${quote} | ${text} | ${typ} | ${ask} |`);
    });
  } else {
    L.push('(暂无批注)');
  }
  L.push('');

  // B 节:只收 纠正/改判/冲突 三种边注;一条都没有时整节不出现(连标题也不出现)
  const keep = flatNotes.filter((n) => n && KEEP_NOTE_KINDS.has(n.kind));
  if (keep.length) {
    L.push('## B. 回流对账里外脑该知道的(报告只读了资料包,没看到这些;不需要的整节删掉即可)');
    L.push('');
    L.push('> 以下来自仓库侧对代码与既有拍板记录的核对,已剔除代码路径、文件名。类型含义:纠正=报告说的与现状不符;改判=报告的建议会推翻负责人已拍过的板;冲突=与另一处待拍板的事同问。');
    L.push('');
    keep.forEach((n, j) => {
      L.push(`**B${j + 1}. [${n.kind}] ${n.anchor}**`);
      L.push('');
      // 外脑读的是给外脑的稿子,正文里的「你」换成「负责人」免得误认
      L.push(String(n.text || '').trim().replace(/你/g, '负责人'));
      L.push('');
    });
  }

  // C 节:先剔「入库说明」,再把每条批注插进它所在小节的末尾;编号与 A 表一致
  L.push('## C. 报告原文(负责人批注已插在对应小节末尾)');
  L.push('');
  let body = stripIntakeHeader(md);
  const headings = listHeadings(body);
  const noOf = new Map();
  list.forEach((a, i) => noOf.set(a, i + 1));

  const bySection = new Map();
  const loose = [];
  for (const a of list) {
    const idx = sectionIndexOf(a && a.anchor, headings);
    if (idx >= 0) {
      if (!bySection.has(idx)) bySection.set(idx, []);
      bySection.get(idx).push(a);
    } else {
      loose.push(a);
    }
  }

  if (loose.length) {
    L.push('**未能定位到具体页的批注:**');
    L.push('');
    for (const a of loose) { L.push(fmtAnno(noOf.get(a), a)); L.push(''); }
  }

  // 从后往前插,前面的插入不会挪动后面待插的偏移(参考实现同款)
  const inserts = [];
  for (const [idx, group] of bySection) {
    inserts.push([sectionEnd(idx, headings, body.length), group.map((a) => fmtAnno(noOf.get(a), a)).join('\n\n')]);
  }
  inserts.sort((x, y) => y[0] - x[0]);
  for (const [end, txt] of inserts) {
    body = body.slice(0, end).replace(/\n+$/, '') + '\n\n' + txt + '\n\n' + body.slice(end);
  }

  L.push(body.replace(/\n+$/, ''));
  L.push('');
  return L.join('\n');
}

/** 下载文件名:批阅意见单-<报告标题>-<YYYYMMDD>.md;非法文件名字符换成 -,总长 ≤ 80 字符 */
function exportFileName(title, today) {
  const day = String(today || '').replace(/-/g, '');
  const prefix = '批阅意见单-';
  const suffix = `-${day}.md`;
  const maxTitle = Math.max(1, 80 - prefix.length - suffix.length);
  const head = [...String(title || '').replace(ILLEGAL_FILENAME_RE, '-')].slice(0, maxTitle).join('');
  return prefix + head.replace(/[-\s]+$/, '') + suffix;
}

module.exports = { buildReviewExport, exportFileName };
