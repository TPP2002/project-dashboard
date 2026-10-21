'use strict';
const PRIORITIES = Object.freeze(['urgent', 'high', 'medium', 'low', 'optional']);
const LABELS = Object.freeze({ urgent: '紧急', high: '高', medium: '中', low: '低', optional: '可选' });
function normalizePriority(value) {
  return typeof value === 'string' ? PRIORITIES.find(p => p === value || LABELS[p] === value) || null : null;
}
function rank(task) { return PRIORITIES.indexOf(normalizePriority(task.priority) || 'medium'); }
function canPrioritize(task) { return !['已完工', '已作废'].includes(task.status); }
module.exports = { PRIORITIES, LABELS, normalizePriority, rank, canPrioritize };
