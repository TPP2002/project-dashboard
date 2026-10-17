'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const C = require('./ownerNodeContract.cjs');
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  if (process.platform !== 'win32') { const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } }
}
function read(file, missing) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return missing; throw error; } }
class Journal {
  constructor(root) { this.file = path.join(root,'operations.json'); this.rows = read(this.file, {}); this.active = new Map(); }
  async run(request, action) {
    C.request(request);
    if (!C.writes.has(request.operation)) return action();
    const id = request.operationId, previous = this.rows[id];
    if (previous) {
      if (previous.hash !== request.hash) C.fail('Operation ID reused with different content',409);
      if (previous.phase === 'done') return previous.result;
      if (this.active.has(id)) return this.active.get(id);
      if (!request.operation.endsWith('.annotations.export') && request.operation !== 'object.write') C.fail('Launch outcome unknown; reconciliation required',409);
      // Fixed content-addressed writes can recover by reapplying the identical bytes.
      delete this.rows[id];
    }
    const a = request.args;
    const resource = request.operation === 'object.write' ? C.digest(a.object) + ':' + a.offset : [a.projectId, a.slug || a.sessionId || a.taskId || 'project', request.operation.includes('export') ? request.operation + ':' + a.key : 'launch'].join(':');
    if (Object.values(this.rows).some(row => row.resource === resource && row.phase !== 'done')) C.fail('Previous operation outcome unknown; reconciliation required',409);
    this.rows[id] = { hash: request.hash, resource, operation: request.operation, phase: 'intent', at: new Date().toISOString() };
    atomic(this.file, this.rows); // Before any spawn or business write. A crash leaves a durable hold.
    const running = Promise.resolve().then(action).then(result => {
      this.rows[id] = { ...this.rows[id], phase: 'done', result }; atomic(this.file,this.rows); return result;
    }).finally(() => this.active.delete(id));
    this.active.set(id,running); return running;
  }
}
const {exclusive}=require('./ownerNodeLock.cjs');
class Objects {
  constructor(root,nodeId) { this.root = path.join(root,'objects'); this.nodeId = nodeId; fs.mkdirSync(this.root,{recursive:true,mode:0o700}); }
  put(projectId,kind,bytes) {
    const ref = C.descriptor({ nodeId:this.nodeId, projectId, kind, hash:C.digest(bytes), size:bytes.length });
    const file = path.join(this.root,C.digest(ref));
    if (!fs.existsSync(file)) { const fd=fs.openSync(file,'wx',0o600); try { fs.writeFileSync(fd,bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    return ref;
  }
  chunk({ object,offset,length }) {
    C.descriptor(object);
    if (object.nodeId !== this.nodeId || offset > object.size || length > C.MAX_CHUNK) C.fail('Object binding mismatch',403);
    const file = path.join(this.root,C.digest(object)), fd = fs.openSync(file,'r');
    try {
      if (fs.fstatSync(fd).size !== object.size) throw new Error('Object size mismatch');
      const bytes=Buffer.alloc(Math.min(length,object.size-offset)); const count=fs.readSync(fd,bytes,0,bytes.length,offset);
      if (count !== bytes.length) throw new Error('Incomplete object');
      return { object,offset,data:bytes.toString('base64'),hash:C.digest(bytes) };
    } finally { fs.closeSync(fd); }
  }
  write({object,offset,data}) {
    C.descriptor(object);
    if(object.nodeId!==this.nodeId||!['reader-export','audition-export'].includes(object.kind))C.fail('Upload binding mismatch',403);
    const bytes=Buffer.from(data,'base64');
    if(bytes.toString('base64')!==data||!bytes.length||bytes.length>C.MAX_CHUNK||offset+bytes.length>object.size)C.fail('Upload bounds');
    const file=path.join(this.root,C.digest(object)),stage=file+'.part';
    if(fs.existsSync(file))return {complete:true,object};
    const fd=fs.openSync(stage,fs.existsSync(stage)?'r+':'wx',0o600);
    try{fs.writeSync(fd,bytes,0,bytes.length,offset);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    if(offset+bytes.length===object.size){const content=fs.readFileSync(stage);if(content.length!==object.size||C.digest(content)!==object.hash)C.fail('Incomplete upload',409);fs.renameSync(stage,file);return {complete:true,object};}
    return {complete:false,object};
  }
  content(object) {C.descriptor(object);if(object.nodeId!==this.nodeId)C.fail('Object node mismatch',403);const bytes=fs.readFileSync(path.join(this.root,C.digest(object)));if(bytes.length!==object.size||C.digest(bytes)!==object.hash)C.fail('Object integrity failure',409);return bytes;}
}
module.exports = { atomic, read, Journal, exclusive, Objects };
