'use strict';
const CSV_LIMIT = 10000;
const CSV_COLUMNS = Object.freeze(['单号', '项目', '派单方', '类别', '作业', '机器', '申请核', '授予核', '状态', '结果', '挂号时刻', '开跑时刻', '结束时刻', '耗时', '原因']);

function cell(value) {
  let text = value == null ? '' : String(value);
  // 数据可能以公式字符起头；Excel 打开时只能把它当文本，不执行内容。
  if (/^[\s]*[=+@-]|^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** 每张逻辑单一行，机器/结果取当前执行，耗时取该单累计执行毫秒数；空值留空。 */
function ticketCsv(tickets) {
  if (tickets.length > CSV_LIMIT) throw Object.assign(new Error('导出超过 10000 行，请收紧筛选条件后再导出'), { status: 413 });
  const rows = tickets.map(ticket => {
    const request = ticket.request, attempt = ticket.attempts.find(item => item.attemptId === ticket.currentAttemptId);
    return [ticket.ticketId, request.project, request.submitter, request.category, request.work.type,
      attempt?.permit?.machine ?? attempt?.intent?.machine, request.requestedCores, attempt?.grantedCores,
      ticket.state, attempt?.result?.outcome, ticket.createdAt, attempt?.startedAt, ticket.endedAt,
      ticket.timing.runningMs, attempt?.result?.reason ?? ticket.unsatisfiableReason];
  });
  return '\uFEFF' + [CSV_COLUMNS, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { ticketCsv, CSV_COLUMNS, CSV_LIMIT };
