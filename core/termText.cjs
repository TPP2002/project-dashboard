'use strict';
/**
 * termText.cjs —— 终端文本排版的最小公共件(AUD-CLI-BRIEF-AND-HELP)。
 *
 * 中日韩文字与全角标点在等宽终端里占两列。按 `String.length` 补空格,中文行永远对不齐——
 * list 的表格和 --help 的参数表都吃这个亏,所以口径收在这里一处。
 */

/** 这个字符在终端里占几列(CJK/全角 2,其余 1)。 */
function charWidth(codePoint) {
  const c = codePoint;
  const wide = c >= 0x1100 && (
    c <= 0x115f || c === 0x2329 || c === 0x232a
    || (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f)
    || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
    || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60)
    || (c >= 0xffe0 && c <= 0xffe6)
  );
  return wide ? 2 : 1;
}

/** 一段文字在终端里占几列。 */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

/** 右补空格到指定显示宽度(不截断:宁可撑破一列,也不许把内容切掉)。 */
function padRight(s, width) {
  const pad = width - displayWidth(s);
  return pad > 0 ? String(s) + ' '.repeat(pad) : String(s);
}

/** 左补空格到指定显示宽度(数值列右对齐用)。 */
function padLeft(s, width) {
  const pad = width - displayWidth(s);
  return pad > 0 ? ' '.repeat(pad) + String(s) : String(s);
}

module.exports = { charWidth, displayWidth, padRight, padLeft };
