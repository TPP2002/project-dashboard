'use strict';
/** 提交说明的归属判定：约定位置与正文分开，窗口重扫不把顺带提及当成施工。 */
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 同一次提交扫描共用匹配器；空卡表也能识别 PR，但不会产生空卡号。 */
function buildMatcher(ids) {
  const source = ids.map(escapeRe).join('|') || '(?!)';
  return {
    all: new RegExp('(?:^|[^A-Za-z0-9-])(' + source + ')(?![A-Za-z0-9-])', 'g'),
    start: new RegExp('^(' + source + ')(?![A-Za-z0-9-])'),
  };
}

function cardIds(text, matcher) {
  const ids = [], re = matcher.all, saved = re.lastIndex;
  re.lastIndex = 0;
  let match;
  while ((match = re.exec(text))) ids.push(match[1]);
  re.lastIndex = saved;
  return ids;
}

const CLOSE_TO_OPEN = { ')': '(', '）': '（', '】': '【', ']': '[' };
const OPEN = new Set(Object.values(CLOSE_TO_OPEN));

/** 从右向左配对，内层括号与外层共用栈，不能把 auto-merge 的半截当成一组。 */
function lastGroupStart(text, end) {
  if (!CLOSE_TO_OPEN[text[end - 1]]) return -1;
  const stack = [];
  for (let i = end - 1; i >= 0; i--) {
    const ch = text[i];
    if (CLOSE_TO_OPEN[ch]) stack.push(CLOSE_TO_OPEN[ch]);
    else if (OPEN.has(ch)) {
      if (stack.pop() !== ch) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** 删除卡号时保留正则吃掉的左边界；否则 (!卡号) 会被误判成纯标注。 */
function annotationRefs(text, matcher) {
  const ids = [], prs = [], saved = matcher.all.lastIndex;
  const rest = text.replace(matcher.all, (match, id) => {
    ids.push(id);
    return match.slice(0, -id.length);
  }).replace(/(?:PR\s*)?#(\d+)/g, (match, number) => {
    prs.push(Number(number));
    return '';
  }).replace(/[\s,，、/+&;；]/g, '');
  matcher.all.lastIndex = saved;
  return rest ? null : { ids, prs };
}

/**
 * 输入完整 subject 与 buildMatcher 的结果，返回去重且按首次出现排序的卡号/PR。
 * 只做字符串判定，不读 git/看板；共用正则的游标在调用后保持原样。
 */
function subjectRefs(subject, matcher) {
  const structural = new Set(), prs = new Set();
  const mark = (text) => { for (const id of cardIds(text, matcher)) structural.add(id); };
  let body = subject;
  // 外壳可相套；默认 GitHub 合并说明不剥 from/分支，后半截仍是普通文字。
  for (;;) {
    const merge = /^Merge PR #(\d+):\s*/.exec(body);
    if (merge) {
      prs.add(Number(merge[1]));
      body = body.slice(merge[0].length);
    } else if (body.startsWith('Revert "') && body.endsWith('"')) {
      body = body.slice(8, -1);
    } else {
      const github = /^Merge pull request #(\d+)\b/.exec(body);
      if (github) prs.add(Number(github[1]));
      break;
    }
  }

  let head = body;
  for (;;) {
    const prefix = /^[A-Za-z][\w-]*(?:\([^()]*\))?!?[:：]\s*/.exec(head);
    const label = prefix ? null : /^[[【〖]([^\]】〗]*)[\]】〗]\s*/.exec(head);
    if (!prefix && !label) break;
    mark(prefix ? prefix[0] : label[1]);
    head = head.slice((prefix || label)[0].length);
  }
  let leading = matcher.start.exec(head);
  while (leading) {
    structural.add(leading[1]);
    head = head.slice(leading[0].length);
    const separator = /^\s*[+/、,，&]\s*/.exec(head);
    if (!separator) break;
    head = head.slice(separator[0].length);
    leading = matcher.start.exec(head);
  }

  let end = body.trimEnd().length;
  for (let count = 0; count < 6; count++) {
    const start = lastGroupStart(body, end);
    if (start < 0) break;
    mark(body.slice(start, end));
    end = body.slice(0, start).trimEnd().length;
  }

  // 仅扫描最内层组；去掉卡号、PR 与允许的分隔符后必须没有说明文字。
  const groups = /[(（【\[]([^()（）【】\[\]]*)[)）】\]]/g;
  let group;
  while ((group = groups.exec(body))) {
    const refs = annotationRefs(group[1], matcher);
    if (!refs) continue;
    for (const id of refs.ids) structural.add(id);
    for (const pr of refs.prs) prs.add(pr);
  }
  const all = [...new Set(cardIds(subject, matcher))];
  return {
    structural: all.filter((id) => structural.has(id)),
    prose: all.filter((id) => !structural.has(id)),
    prs: [...prs],
  };
}

module.exports = { subjectRefs, buildMatcher };
