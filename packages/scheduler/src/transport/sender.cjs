'use strict';
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const p = require('../protocol/contract.cjs');
const { failure, timeout, bounded } = require('./framed.cjs');

/** Sequence is allocated by the gateway before enqueue. A reserved position blocks later sends,
 * not replies already in flight. The bounded preparation is never a durable live-message outbox. */
class SerialSender {
  constructor() { this.tail = Promise.resolve(); this.count = 0; this.bytes = 0; this.closed = false; this.prepared = new Map(); }
  enqueue(frame, action, options, wait = Promise.resolve()) {
    timeout(options);
    if (this.closed) throw failure('DISCONNECTED');
    const size = Buffer.byteLength(p.encodeFrame(frame));
    if (this.count >= 32 || this.bytes + size > p.MAX_FRAME_BYTES) throw failure('BUFFER_PRESSURE');
    this.count++; this.bytes += size;
    const deadline = performance.now() + options.timeoutMs;
    let resolve, reject, cancelled = false;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; }); result.catch(() => {});
    const position = this.tail.then(() => wait).then(() => {
      if (this.closed || cancelled) throw failure('FENCED');
      const timeoutMs = Math.ceil(deadline - performance.now());
      if (timeoutMs <= 0) throw failure('TIMEOUT');
      // Do not adopt the network response into the serial tail: reverse RPC must remain possible.
      resolve(action({ timeoutMs }));
    }).catch(reject).finally(() => { this.count--; this.bytes -= size; });
    this.tail = position;
    return bounded(result, options, () => { cancelled = true; });
  }
  prepare(peer, frame, action, options) {
    const ms = Math.min(timeout(options), 5000), id = randomUUID();
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    const slot = { peer: p.canonicalJson(peer), frame, release, requested: false, expired: false };
    slot.timer = setTimeout(() => {
      slot.expired = true; this.prepared.delete(id); release();
    }, ms);
    try {
      slot.result = this.enqueue(frame, callOptions => {
        if (slot.expired || !slot.requested) throw failure('PREPARATION_EXPIRED');
        return action(callOptions);
      }, { timeoutMs: Math.min(60000, ms + options.timeoutMs) }, wait);
    } catch (error) { clearTimeout(slot.timer); release(); throw error; }
    slot.result.catch(() => {});
    this.prepared.set(id, slot);
    return { preparationId: id, envelope: p.decodeFrame(p.encodeFrame(frame)) };
  }
  async sendPrepared(peer, id, options) {
    timeout(options); const slot = this.prepared.get(id);
    if (!slot || this.closed || slot.expired) throw failure('PREPARATION_EXPIRED');
    if (slot.peer !== p.canonicalJson(peer)) throw failure('PREPARATION_PEER');
    this.prepared.delete(id); clearTimeout(slot.timer); slot.requested = true; slot.release();
    return { envelope: p.decodeFrame(p.encodeFrame(slot.frame)), reply: await bounded(slot.result, options, () => { slot.expired = true; }) };
  }
  close() {
    this.closed = true;
    for (const slot of this.prepared.values()) { slot.expired = true; clearTimeout(slot.timer); slot.release(); }
    this.prepared.clear();
  }
}
module.exports = { SerialSender };
