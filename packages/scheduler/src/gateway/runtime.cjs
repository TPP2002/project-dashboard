'use strict';
const { EventEmitter } = require('node:events');
const { bounded, failure, timeout } = require('../transport/framed.cjs');
function createRuntimeScope({ nextGeneration } = {}) {
  const events = new EventEmitter(); events.setMaxListeners(32);
  let notice = { generation: 0, connection: 'disconnected', scope: null }, listeners = 0;
  return {
    publish(connection, scope) {
      let generation = notice.generation + 1, persistenceError;
      try {
        if (nextGeneration) generation = nextGeneration();
        if (!Number.isSafeInteger(generation) || generation <= notice.generation) throw failure('FENCED');
      } catch (error) { persistenceError = error; connection = 'disconnected'; scope = null; generation = notice.generation + 1; }
      notice = { generation, connection, scope: scope ? structuredClone(scope) : null };
      events.emit('change', notice);
      if (persistenceError) throw persistenceError;
    },
    port: Object.freeze({
      async current(options) { timeout(options); return structuredClone(notice); },
      async *changes(afterGeneration, options) {
        timeout(options);
        if (!Number.isSafeInteger(afterGeneration) || afterGeneration < 0 || listeners >= 32) throw failure('SUBSCRIPTION_LIMIT');
        listeners++;
        try {
          while (true) {
            if (notice.generation > afterGeneration) { const value = structuredClone(notice); afterGeneration = value.generation; yield value; continue; }
            let listener;
            try { await bounded(new Promise(resolve => { listener = resolve; events.once('change', listener); }), options); }
            finally { events.removeListener('change', listener); }
          }
        } finally { listeners--; }
      },
    }),
  };
}
module.exports = { createRuntimeScope };
