'use strict';
const { EventEmitter } = require('node:events');
const { TextDecoder } = require('node:util');
const protocol = require('../protocol/contract.cjs');

function failure(code) {
  return ['TIMEOUT', 'DISCONNECTED', 'FENCED', 'NOT_CONFIGURED', 'IO_FAILURE'].includes(code)
    ? Object.assign(new Error(code), { code }) : new protocol.ProtocolValidationError(code);
}
function timeout(options, maximum = 60000) {
  const n = options?.timeoutMs;
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) throw failure('TIMEOUT_RANGE');
  return n;
}
function bounded(promise, options, onTimeout = () => {}) {
  const ms = timeout(options);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { onTimeout(); reject(failure('TIMEOUT')); }, ms);
    Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
const jsonCodec = {
  encode(value) { return `${protocol.canonicalJson(value)}\n`; },
  decode(bytes) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    if (`${protocol.canonicalJson(value)}\n` !== text) throw failure('FRAME_CANONICAL');
    return value;
  },
};
function validateGreeting(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'authorityEpoch,authorityId,transport' ||
      value.transport !== 'scheduler-gateway-hello.v1' || typeof value.authorityId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.authorityId) ||
      !Number.isSafeInteger(value.authorityEpoch) || value.authorityEpoch < 1) throw failure('TRANSPORT_GREETING');
  return value;
}

/** No unbounded line reader or outbound queue. A stalled consumer closes the connection. */
class FramedStream extends EventEmitter {
  constructor(readable, writable, { codec = protocol, timeoutMs = 10000, expectGreeting = false } = {}) {
    super();
    this.reader = readable; this.writer = writable; this.codec = codec;
    this.timeoutMs = timeout({ timeoutMs }); this.closed = false;
    this.expectGreeting = expectGreeting; this.greeting = null; this.outgoingStarted = false;
    this.buffer = Buffer.alloc(0); this.queuedBytes = 0; this.tail = Promise.resolve();
    this.onData = bytes => {
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const end = bytes.indexOf(10, offset);
          const stop = end === -1 ? bytes.length : end + 1;
          const part = bytes.subarray(offset, stop);
          const limit = this.expectGreeting && this.greeting === null ? 4096 : protocol.MAX_FRAME_BYTES;
          if (this.buffer.length + part.length > limit) throw failure('FRAME_TOO_LARGE');
          this.buffer = Buffer.concat([this.buffer, part]); offset = stop;
          if (end !== -1) {
            const frame = this.buffer; this.buffer = Buffer.alloc(0);
            if (this.expectGreeting && this.greeting === null) {
              this.greeting = validateGreeting(jsonCodec.decode(frame)); this.emit('greeting', this.greeting);
            } else this.emit('frame', (this.codec.decodeFrame ?? this.codec.decode)(frame));
            if (this.closed) return;
          }
        }
      } catch (error) { this.close(error); }
    };
    readable.on('data', this.onData);
    readable.on('error', error => this.close(error));
    writable.on('error', error => this.close(error));
    readable.on('end', () => this.close(failure('DISCONNECTED')));
    readable.on('close', () => this.close(failure('DISCONNECTED')));
  }
  send(value, options = { timeoutMs: this.timeoutMs }) {
    if (this.closed) return Promise.reject(failure('DISCONNECTED'));
    let bytes;
    try {
      bytes = Buffer.from((this.codec.encodeFrame ?? this.codec.encode)(value));
      if (bytes.length > protocol.MAX_FRAME_BYTES || this.queuedBytes + bytes.length > protocol.MAX_FRAME_BYTES) throw failure('BUFFER_PRESSURE');
      timeout(options);
    } catch (error) { return Promise.reject(error); }
    this.outgoingStarted = true;
    return this.enqueue(bytes, options);
  }
  sendGreeting(value) {
    validateGreeting(value);
    if (this.outgoingStarted) throw failure('TRANSPORT_GREETING_POSITION');
    const bytes = Buffer.from(jsonCodec.encode(value));
    if (bytes.length > 4096) throw failure('FRAME_TOO_LARGE');
    this.outgoingStarted = true;
    return this.enqueue(bytes, { timeoutMs: this.timeoutMs });
  }
  async waitGreeting(options) {
    if (this.greeting) return this.greeting;
    if (this.closed) throw failure('DISCONNECTED');
    let receive, close;
    try {
      return await bounded(new Promise((resolve, reject) => {
        receive = resolve; close = reject; this.once('greeting', receive); this.once('closed', close);
      }), options, () => this.close(failure('TIMEOUT')));
    } finally { this.removeListener('greeting', receive); this.removeListener('closed', close); }
  }
  enqueue(bytes, options) {
    if (this.closed) return Promise.reject(failure('DISCONNECTED'));
    if (bytes.length > protocol.MAX_FRAME_BYTES || this.queuedBytes + bytes.length > protocol.MAX_FRAME_BYTES) return Promise.reject(failure('BUFFER_PRESSURE'));
    this.queuedBytes += bytes.length;
    const write = this.tail.then(() => {
      if (this.closed) throw failure('DISCONNECTED');
      return new Promise((resolve, reject) => this.writer.write(bytes, error => error ? reject(error) : resolve()));
    });
    const result = bounded(write, options, () => this.close(failure('TIMEOUT')));
    this.tail = result.catch(error => this.close(error)).finally(() => { this.queuedBytes -= bytes.length; });
    return result;
  }
  close(error = failure('DISCONNECTED')) {
    if (this.closed) return;
    this.closed = true; this.buffer = Buffer.alloc(0);
    this.reader.removeListener('data', this.onData);
    this.reader.destroy(); if (this.writer !== this.reader) this.writer.destroy();
    this.emit('closed', error);
  }
}

/** Envelope correlation is the frozen protocol's validator, including object ranges and identities. */
class EnvelopeLink extends EventEmitter {
  constructor(stream, { authenticate, requestKinds, onRequest, maxPending = 32 }) {
    super(); this.stream = stream; this.pending = new Map(); this.maxPending = maxPending;
    this.inflight = 0; this.inflightBytes = 0; this.requestTail = Promise.resolve();
    stream.on('closed', error => {
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear(); this.emit('closed', error);
    });
    stream.on('frame', envelope => {
      try {
        const disposition = authenticate(envelope);
        if (disposition === false) return; // duplicate/out-of-order never refreshes observation time
        let match;
        for (const [id, pending] of this.pending) {
          try { protocol.validateResponse(pending.request, envelope); match = [id, pending]; break; }
          catch (error) { if (!(error instanceof protocol.ProtocolValidationError)) throw error; }
        }
        if (match) { this.pending.delete(match[0]); match[1].resolve(envelope); return; }
        if (envelope.kind === 'result' || !requestKinds.includes(envelope.kind)) throw failure('UNKNOWN_REPLY');
        const size = Buffer.byteLength(protocol.encodeFrame(envelope));
        if (++this.inflight > maxPending || (this.inflightBytes += size) > protocol.MAX_FRAME_BYTES) throw failure('BUFFER_PRESSURE');
        this.requestTail = this.requestTail.then(async () => {
          if (stream.closed) return;
          const reply = await bounded(onRequest(envelope), { timeoutMs: stream.timeoutMs });
          if (reply) { protocol.validateResponse(envelope, reply); await stream.send(reply); }
        }).catch(error => stream.close(error)).finally(() => { this.inflight--; this.inflightBytes -= size; });
      } catch (error) { stream.close(error); }
    });
  }
  exchange(request, options) {
    timeout(options);
    if (this.stream.closed) return Promise.reject(failure('DISCONNECTED'));
    if (this.pending.size >= this.maxPending || this.pending.has(request.messageId)) return Promise.reject(failure('BUFFER_PRESSURE'));
    const promise = new Promise((resolve, reject) => {
      this.pending.set(request.messageId, { request, resolve, reject });
      this.stream.send(request, options).catch(reject);
    });
    // Late results from a timed-out request must never become a fresh grant.
    return bounded(promise, options, () => this.stream.close(failure('TIMEOUT')))
      .finally(() => this.pending.delete(request.messageId));
  }
  close() { this.stream.close(); }
}
module.exports = { FramedStream, EnvelopeLink, jsonCodec, validateGreeting, failure, timeout, bounded };
