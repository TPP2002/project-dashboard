'use strict';
/**
 * taskTitle.cjs —— 三层结构(id / plainTitle 人话 / title 技术说明)在【后台侧】的统一读取入口。
 *
 * 前端已有同名收口 `web/src/utils/taskTitle.ts`(AUD-UI-PLAINTITLE-EVERYWHERE);
 * CLI 与 server 是 CommonJS、进不了那份 TS,所以在 core 里放一份同口径实现。
 * 两侧的 60 字截断由 test/cliOutputSlim.test.cjs 的一条用例锁死——改一边不改另一边会当场红。
 */

/** 人话标题的应急截断长度;与 web/src/utils/taskTitle.ts 的 PLAIN_TITLE_TRUNCATE_LEN 必须一致。 */
const PLAIN_TITLE_TRUNCATE_LEN = 60;

/** 给人看的标题:有 plainTitle 用它;老卡没有就把技术说明截 60 字应急,不整段糊脸上。 */
function humanTitle(task) {
  const t = task || {};
  if (t.plainTitle) return String(t.plainTitle);
  const title = String(t.title || '');
  return title.length > PLAIN_TITLE_TRUNCATE_LEN
    ? title.slice(0, PLAIN_TITLE_TRUNCATE_LEN) + '…'
    : title;
}

/** 给模型看的技术说明原文,只在需要展开细节的地方读它。 */
function specText(task) {
  return String((task && task.title) || '');
}

/** 老卡没有人话标题——用来决定要不要提示补齐。 */
function missingPlainTitle(task) {
  return !(task && task.plainTitle);
}

module.exports = { humanTitle, specText, missingPlainTitle, PLAIN_TITLE_TRUNCATE_LEN };
