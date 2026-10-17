'use strict';
const { randomUUID } = require('node:crypto');
const C = require('./ownerNodeContract.cjs');
function framed(input, output, receive, onClose = () => {}) {
  let buffer = Buffer.alloc(0), closed = false;
  function close(error) { if (closed) return; closed = true; input.destroy?.(); if (input !== output) output.destroy?.(); onClose(error || new Error('Node offline')); }
  input.on('data', chunk => {
    try {
      // Never retain more than a single bounded frame, even when a sender batches writes.
      let offset = 0;
      while (offset < chunk.length) {
        let need = buffer.length < 4 ? 4 - buffer.length : 4 + buffer.readUInt32BE(0) - buffer.length;
        const take = Math.min(need, chunk.length - offset);
        buffer = Buffer.concat([buffer, chunk.subarray(offset, offset + take)]); offset += take;
        if (buffer.length < 4) continue;
        const size = buffer.readUInt32BE(0);
        if (!size || size > C.MAX_FRAME) throw new Error('Frame limit');
        if (buffer.length === size + 4) { const message = JSON.parse(buffer.subarray(4).toString('utf8')); buffer = Buffer.alloc(0); receive(message); }
      }
    } catch (error) { close(error); }
  });
  input.on('error', close); output.on('error', close);
  input.on('end', () => close()); input.on('close', () => close());
  return {
    send(value) {
      if (closed) throw new Error('Node offline');
      const body = Buffer.from(JSON.stringify(value));
      if (!body.length || body.length > C.MAX_FRAME || output.writableLength > 2 * C.MAX_FRAME) throw new Error('Frame/backpressure limit');
      const header = Buffer.alloc(4); header.writeUInt32BE(body.length); output.write(Buffer.concat([header, body]));
    }, close,
  };
}
function peer(input, output, { initiate = false, handler, timeoutMs = 30000, onClose = () => {} } = {}) {
  let generation = initiate ? randomUUID() : null, seq = 0, received = 0, active = 0, stopped = false;
  const pending = new Map();
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  ready.catch(() => {});
  const handshakeTimer = setTimeout(() => { if (!generation) wire.close(new Error('Handshake timeout')); }, 10000);
  ready.finally(() => clearTimeout(handshakeTimer)).catch(() => {});
  const wire = framed(input, output, message => {
    if (!generation) {
      C.fields(message, { version: v => v === C.VERSION, direction: v => v === 'hello', generation: C.uuid });
      generation = message.generation; readyResolve(); return;
    }
    if (message.direction === 'reply') {
      C.reply(message);
      const item = pending.get(message.sequence);
      if (!item || message.generation !== generation || message.nonce !== item.nonce) throw new Error('Unbound response');
      pending.delete(message.sequence); clearTimeout(item.timer);
      message.ok ? item.resolve(message.result) : item.reject(Object.assign(new Error(message.error.message), { status: message.error.status }));
      return;
    }
    C.request(message);
    if (!handler || message.generation !== generation || message.sequence <= received || active >= 16) throw new Error('Invalid request direction/generation/sequence');
    received = message.sequence; active++;
    const base = { version: C.VERSION, direction: 'reply', generation, sequence: message.sequence, nonce: message.nonce };
    Promise.resolve().then(() => handler(message)).then(result => {
      wire.send({ ...base, ok: true, result });
    }, error => {
      // Do not serialize arbitrary errors containing local paths, secrets or tool output.
      wire.send({ ...base, ok: false, error: { status: error.status || 503, message: error.publicMessage || 'Owner node operation unavailable; check node recovery state' } });
    }).catch(error => wire.close(error)).finally(() => { active--; });
  }, error => {
    stopped = true; readyReject(error);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Object.assign(new Error('Owner node offline; outcome may be unknown'), { status: 503 })); }
    pending.clear(); onClose(error);
  });
  if (initiate) { wire.send({ version: C.VERSION, direction: 'hello', generation }); readyResolve(); }
  return {
    ready, close: wire.close,
    call(operation, args, identity = {}) {
      C.validateOperation(operation, args);
      if (!generation) return ready.then(() => this.call(operation,args,identity));
      if (stopped || pending.size >= 16) C.fail('Owner node unavailable', 503);
      const request = { version: C.VERSION, direction: 'request', generation, sequence: ++seq, nonce: randomUUID(), operation, args, ...identity };
      C.request(request);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { wire.close(new Error('Node timeout')); }, timeoutMs);
        pending.set(seq, { nonce: request.nonce, resolve, reject, timer });
        try { wire.send(request); } catch (error) { wire.close(error); }
      });
    },
  };
}
module.exports = { framed, peer };
