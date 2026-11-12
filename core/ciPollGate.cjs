'use strict';
function createCiPollGate({ now = Date.now, idleMs = 120000 } = {}) {
  let clients = 0, lastClient = now();
  return {
    clientConnected() { clients++; lastClient = now(); },
    clientDisconnected() { if (clients > 0 && --clients === 0) lastClient = now(); },
    shouldPoll() { return clients > 0 || now() - lastClient < idleMs; },
  };
}
module.exports = { createCiPollGate };
