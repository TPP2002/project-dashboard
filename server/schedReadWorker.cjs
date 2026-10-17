'use strict';
/** Run the existing complete readers in this worker, including their private bounded caches. */
const { parentPort } = require('node:worker_threads');
const read = require('../core/schedRead.cjs');

parentPort.on('message', ({ id, action, share, query = {}, nowMs }) => {
  try {
    let value;
    if (action === 'snapshot') value = read.snapshot(share, nowMs);
    else if (action === 'tickets') value = read.ticketPage(share, query);
    else if (action === 'tickets.csv') value = read.exportTickets(share, query);
    else if (action.startsWith('ticket/')) {
      const ticket = read.ticketDetail(share, action.slice(7));
      value = { ok: true, ticket, ...(query.related === '0' ? {} : { related: read.relatedTickets(share, ticket) }) };
    } else throw new Error('未知调度读取');
    parentPort.postMessage({ id, ok: true, value });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: {
      message: error.message, name: error.name, code: error.code, status: error.status,
    } });
  }
});
