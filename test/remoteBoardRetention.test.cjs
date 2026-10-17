'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {fixture,must,GATEWAY} = require('./remoteBoardFixtures.test.cjs');
const {requestId,DEFAULTS,size} = require('../core/boardCommandRetention.cjs');
function at(f,r,now) {
  return spawnSync(process.execPath,['-e',`Date.now=()=>${now};process.argv=[process.execPath,${JSON.stringify(GATEWAY)},'--authority',${JSON.stringify(f.authorityFile)}];require(${JSON.stringify(GATEWAY)}).main();`],{input:JSON.stringify(r),encoding:'utf8',env:f.env,cwd:f.repo});
}
function setup(f,policy={}) { f.authority.receiptPolicy=policy;f.write(f.authorityFile,f.authority); }
const note = (f,text,stamp) => f.request('note',{text},requestId(stamp));
test('count GC advances a durable floor; lost ACK and restart cannot execute evicted IDs again',t=>{
  const f=fixture(t),now=Date.now();setup(f,{maxCount:2});
  const requests=[0,1,2].map(i=>note(f,'唯一留言'+i,now-10+i));
  for(const r of requests) must(at(f,r,now));
  const b=f.read();assert.equal(Object.keys(b._commandReceipts).length,2);
  assert.equal(b._commandRetention.rejectBefore,now-9);
  const before=fs.readFileSync(f.board,'utf8');
  for(let i=0;i<2;i++) {
    const old=at(f,requests[0],now+1);assert.equal(old.status,1);assert.match(old.stdout,/expired/);
    must(at(f,requests[1],now+1)); // another real process, same persisted receipt
  }
  assert.equal(fs.readFileSync(f.board,'utf8'),before);
  assert.equal(f.read().activity.filter(a=>a.text==='唯一留言0').length,1);
  const mismatch=at(f,{...requests[1],args:{_:[],text:'变更内容'}},now+1);
  assert.equal(mismatch.status,1);assert.match(mismatch.stdout,/不同内容/);
  assert.equal(fs.readFileSync(f.board,'utf8'),before);
});
test('same-millisecond receipts are evicted together; a full same-ms group fails atomically',t=>{
  const f=fixture(t),now=Date.now();setup(f,{maxCount:2});
  const a=note(f,'同毫秒甲',now),b=note(f,'同毫秒乙',now),c=note(f,'同毫秒丙',now);
  must(at(f,a,now));must(at(f,b,now));
  const before=fs.readFileSync(f.board,'utf8');
  assert.equal(at(f,c,now).status,1);assert.equal(fs.readFileSync(f.board,'utf8'),before);
  must(at(f,note(f,'下一毫秒',now+1),now+1));
  assert.equal(Object.keys(f.read()._commandReceipts).length,1);
  assert.equal(f.read()._commandRetention.rejectBefore,now+1);
  for(const r of [a,b,c]) { const result=at(f,r,now+2);assert.equal(result.status,1);assert.match(result.stdout,/expired/); }
  assert.equal(f.read().activity.length,3);
});
test('age retention and rollback never lower rejectBefore; future timestamps are bounded to five minutes',t=>{
  const f=fixture(t),now=Date.now();setup(f,{retainMs:1000});
  const old=note(f,'旧结果',now);must(at(f,old,now));
  const current=note(f,'新结果',now+2000);must(at(f,current,now+2000));
  const floor=f.read()._commandRetention.rejectBefore;
  const bytes=fs.readFileSync(f.board,'utf8');
  assert.equal(at(f,old,now).status,1);
  assert.equal(at(f,note(f,'回退时钟新请求',now+1),now).status,1);
  assert.equal(at(f,note(f,'过度未来',now+300001),now).status,1);
  assert.equal(fs.readFileSync(f.board,'utf8'),bytes);
  must(at(f,current,now));
  assert.equal(f.read()._commandRetention.rejectBefore,floor);
  assert.equal(f.read()._commandRetention.lastNow,now+2000);
  assert.equal(DEFAULTS.retainMs,7*86400000);
});
test('byte capacity is bounded and eviction is timestamp based across owners and projects',t=>{
  const f=fixture(t),now=Date.now();setup(f,{maxBytes:800});
  const requests=Array.from({length:6},(_,i)=>note(f,'字节边界'+i,now-20+i));
  for(const r of requests) must(at(f,r,now));
  assert.ok(size(f.read()._commandReceipts)<=800);
  assert.ok(Object.keys(f.read()._commandReceipts).length<requests.length);
  assert.equal(at(f,requests[0],now).status,1);
  const shared=note(f,'多主体编号',now+1);must(at(f,shared,now+1));
  f.authority.ownerId='second-owner';f.write(f.authorityFile,f.authority);
  must(at(f,shared,now+1));assert.equal(f.read().activity.filter(a=>a.text==='多主体编号').length,2);
  const qboard=path.join(f.cloud,'q.json');f.write(qboard,require('../core/boardSchema.cjs').emptyBoard({id:'q',name:'q'}));
  const reg=JSON.parse(fs.readFileSync(f.authority.registryPath,'utf8'));reg.projects.q={mainRepo:f.cloud,board:qboard};f.write(f.authority.registryPath,reg);
  f.authority.projects.q={};f.write(f.authorityFile,f.authority);
  must(at(f,{...shared,projectId:'q'},now+1));
  assert.equal(JSON.parse(fs.readFileSync(qboard,'utf8')).activity.length,1);
});
test('prototype receipts remain intact and block new writes; v1 and malformed IDs never re-execute',t=>{
  const f=fixture(t),b=f.read();b.revision=1;
  b._commandReceipts={['a'.repeat(64)]:{inputHash:'b'.repeat(64),revision:1,result:{ok:true}}};f.write(f.board,b);
  const before=fs.readFileSync(f.board,'utf8');
  const blocked=f.gateway(f.request('note',{text:'不可遗忘旧收据'}));
  assert.equal(blocked.status,1);assert.match(blocked.stdout,/原型回执/);
  for(const r of [{...f.request('note',{text:'旧协议'}),version:'board-command.v1'},f.request('note',{text:'无戳'},'00000000-0000-4000-8000-000000000001')]) assert.equal(f.gateway(r).status,1);
  assert.equal(fs.readFileSync(f.board,'utf8'),before);
});
test('large clock rollback still replays a retained exact result but rejects a future NEW ID',t=>{
  const f=fixture(t),now=Date.now(),r=note(f,'回退前已确认',now+600000);
  must(at(f,r,now+600000));const bytes=fs.readFileSync(f.board,'utf8');
  must(at(f,r,now));assert.equal(at(f,note(f,'未执行未来编号',now+600000),now).status,1);
  assert.equal(fs.readFileSync(f.board,'utf8'),bytes);
});
