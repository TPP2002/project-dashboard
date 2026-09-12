'use strict';

/** 交接节点按执行号归组，不把上次的已投递接到本次意图上。台账不可读时保留快照时间线并明示降级。 */
function ticketRelations(ticket, tickets, history) {
  const events = history.readable ? history.events.filter(event => event.ticketId === ticket.ticketId) : ticket.timeline;
  const handoffs = new Map();
  for (const attempt of ticket.attempts) if (attempt.intent) handoffs.set(attempt.attemptId, {
    attemptId: attempt.attemptId, intentAt: null, dispatchedAt: null,
    machine: attempt.intent.machine, submissionId: attempt.intent.submissionId ?? null,
  });
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!['dispatch-intent', 'dispatched'].includes(event.type) || !event.attemptId) continue;
    const step = handoffs.get(event.attemptId) || { attemptId: event.attemptId, intentAt: null, dispatchedAt: null, machine: null, submissionId: null };
    if (event.type === 'dispatch-intent') {
      step.intentAt = event.at; step.machine = event.data.intent?.machine ?? step.machine;
      step.submissionId = event.data.intent?.submissionId ?? step.submissionId;
    } else { step.dispatchedAt = event.at; step.submissionId = event.data.submissionId ?? step.submissionId; }
    handoffs.set(event.attemptId, step);
  }
  const children = tickets.filter(child => child.request.parentTicketId === ticket.ticketId)
    .sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.ticketId < b.ticketId ? -1 : 1)
    .map(child => ({ ticketId: child.ticketId, title: child.request.title, state: child.state }));
  return { readable: history.readable, reason: history.reason, children, handoffs: [...handoffs.values()] };
}

module.exports = { ticketRelations };
