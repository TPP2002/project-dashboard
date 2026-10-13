'use strict';
/**
 * taskBuilder.cjs —— 施工方式(builder)的唯一真相源(DASH-CLAIM-BUILDER-GATE-1010)。
 *
 * 每张卡动代码前必须 claim,claim 必须标「施工方式」:活是派单器派出、收单员施工的(派单器),
 * 还是本对话自干(对上开工须知/派单简报例外表的编号,①~④)。合法值就这五个、一字不差;
 * 缺省与编号外一律拒收,报错里给可复制模板。枚举、判别与校验收在这一份,
 * claim / list / boardSchema / done 共用,不许各写各的。
 *
 * 【旧卡兼容】builder 是可选字段:本规矩生效前的老卡没有它,照常读、照常收官、--collect 照旧;
 *   只有新发起的 claim 才强制落卡。列表里没标的显示「未标」。
 * 【自干例外留痕】自干例外「为什么符合例外」以本卡的 note/message 留言为证据,且留言要【明确写明】:
 *   「施工方=<本卡的施工方式>;理由=<为什么符合例外>」(与提示里给的可复制样式一致),
 *   不从任意留言里猜("CI 还在排队"这类不算)。done 时缺证据只提示、不拦收官、不碰 cost 闸、
 *   --collect 不提示。认领流水本身不算理由。
 */

/** 合法施工方式,一字不差。 */
const BUILDER_VALUES = ['派单器', '自干:例外①', '自干:例外②', '自干:例外③', '自干:例外④'];
/** 派单器这条正路单独起个名字,提示文案里要用。 */
const BUILDER_DISPATCHER = '派单器';
/** 自干例外值共有的前缀;裸「自干」不是合法值。 */
const BUILDER_SELF_PREFIX = '自干:';
/** builder 字段缺失(老卡)在列表里的显示字样。 */
const BUILDER_UNMARKED = '未标';

function isBuilderValue(v) { return BUILDER_VALUES.includes(v); }

/** 是否自干例外(①~④)。裸「自干」不在枚举里,自然到不了这里;这里再对一遍枚举防串号。 */
function isSelfRunBuilder(v) {
  return typeof v === 'string' && v.startsWith(BUILDER_SELF_PREFIX) && isBuilderValue(v);
}

/** 合法值一行清单(报错/帮助/协议共用)。 */
function builderValuesLine() { return BUILDER_VALUES.join(' / '); }

/** claim 缺参/非法值的拒收文案:合法值清单 + 可直接复制的完整模板。 */
function claimBuilderTemplate() {
  return 'claim 必须带 --builder <施工方式>(机器闸;合法值五选一,一字不差):\n' +
    '  派单器          活由派单器派出、收单员施工\n' +
    '  自干:例外①~④    本对话自干,编号必须对上开工须知/派单简报例外表的第①~④条(裸「自干」不收)\n' +
    '  可复制模板(占位符自己替换;自干就把值换成对应例外编号):\n' +
    '    claim <卡号> --project <项目id> --branch <分支名> --builder "派单器" --scope "<会改的文件>"';
}

/**
 * claim 的 --builder 解析:缺省、裸 flag、空串、编号外一律抛错(文案含模板);合法则返回去空白的值。
 * 必须在拿锁改卡之前调用 —— 拒收时一个字段都不写。
 */
function resolveClaimBuilder(raw) {
  if (raw === undefined || raw === true || String(raw).trim() === '') {
    throw new Error('缺 --builder <施工方式>。\n' + claimBuilderTemplate());
  }
  const v = String(raw).trim();
  if (!isBuilderValue(v)) {
    throw new Error(`--builder 非法:「${v}」。\n` + claimBuilderTemplate());
  }
  return v;
}

/** list --builder 的取值校验:没给返回 undefined(不筛选);给了就必须是合法值,按值精确匹配。 */
function resolveListBuilder(raw) {
  if (raw === undefined) return undefined;
  if (raw === true || String(raw).trim() === '') {
    throw new Error('缺值。用法: list --builder <施工方式>,合法值五选一: ' + builderValuesLine());
  }
  const v = String(raw).trim();
  if (!isBuilderValue(v)) {
    throw new Error(`--builder 非法:「${v}」。合法值五选一(精确匹配): ${builderValuesLine()}`);
  }
  return v;
}

/** 正则元字符转义(builder 值要拼进判别正则,别裸拼)。 */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 本卡活动流里有没有一句留言(note 命令写的 type=note 且 kind=message)【明确写明】本卡的
 * 自干例外与理由 —— 判据认清晰格式,不从任意留言里推断:
 *   文本含「施工方=<本卡的施工方式>」(值后必须收尾/断开,"施工方=自干:例外①②"这种串号不算)
 *   且含「理由=<非空>」。两样齐了才算证据。
 * 只认挂在【本卡】上的;认领/交活这类记账流水(type 不是 note,或没有 kind)不算理由;
 * 老卡没标施工方式(builder 为空)谈不上证据。
 */
function hasSelfRunReasonEvidence(board, taskId, builder) {
  if (!builder) return false;
  const textOf = (a) => String((a && a.text) || '');
  const statesThisBuilder = new RegExp(`施工方\\s*=\\s*${escapeRegExp(builder)}(?![^\\s;；,，、。])`);
  return ((board && board.activity) || []).some((a) =>
    a && a.taskId === taskId && a.type === 'note' && a.kind === 'message'
    && statesThisBuilder.test(textOf(a))
    && /理由\s*=\s*\S/.test(textOf(a)));
}

/**
 * done 的自干例外理由提示:施工方式是自干例外、但卡上还没有一句写明例外与理由的留言作证据时,
 * 给人话提醒。只提示,不拦收官、不碰 cost 闸;--collect 由调用方短路不给提示。非自干 / 老卡没标 → null。
 */
function selfRunReasonHint(task, board) {
  const t = task || {};
  if (!isSelfRunBuilder(t.builder)) return null;
  if (hasSelfRunReasonEvidence(board, t.id, t.builder)) return null;
  return `本卡施工方式是「${t.builder}」(自干例外),但卡上还没有一句留言写明为什么符合例外。`
    + `收官前补一句留痕:note ${t.id} --project <项目id> --text "施工方=${t.builder};理由=<为什么符合例外>"(本提示只提醒,不拦收官)`;
}

module.exports = {
  BUILDER_VALUES, BUILDER_DISPATCHER, BUILDER_SELF_PREFIX, BUILDER_UNMARKED,
  isBuilderValue, isSelfRunBuilder, builderValuesLine, claimBuilderTemplate,
  resolveClaimBuilder, resolveListBuilder, hasSelfRunReasonEvidence, selfRunReasonHint,
};
