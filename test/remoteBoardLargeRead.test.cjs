'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {fixture,must,ROOT}=require('./remoteBoardFixtures.test.cjs');
const p=require('../core/boardCommand.cjs');
const digest=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
test('real stdio reads a >=20MiB synthetic board completely with bounded transport and frozen old path',t=>{
  const f=fixture(t),board=f.read();
  board.tasks=Array.from({length:180},(_,i)=>({id:'T'+i,title:'任务 '+i,status:'未开工',wave:0,description:('记录 '+i+' 中文 "字面"\n').repeat(6000),gitBranch:[],decisions:[],deps:{}}));
  board.activity=Array.from({length:70},(_,i)=>({ts:new Date().toISOString(),taskId:'T'+i,type:'note',text:'流水'+i+'测'.repeat(3000)}));
  assert.ok(Buffer.byteLength(JSON.stringify(board))>=20*1024*1024);
  f.write(f.board,board);
  const old=fs.readFileSync(f.old,'utf8'),cloud=fs.readFileSync(f.board,'utf8');
  // The client, transport and gateway are real processes; no substituted JSON response.
  const probe=`const c=require(${JSON.stringify(path.join(ROOT,'cli/remoteClient.cjs'))});const b=c.perform('projection','p',{_:[]}).board;process.stdout.write(JSON.stringify(b));`;
  const result=must(spawnSync(process.execPath,['-e',probe],{env:f.env,cwd:f.repo,encoding:'utf8',timeout:190000,maxBuffer:p.MAX_RESPONSE_BYTES}));
  const received=JSON.parse(result.stdout);
  assert.equal(received.tasks.length,board.tasks.length);assert.equal(received.activity.length,board.activity.length);
  for(let i=0;i<board.tasks.length;i++) assert.equal(digest(received.tasks[i]),digest(board.tasks[i]),'task '+i);
  for(let i=0;i<board.activity.length;i++) assert.deepEqual(received.activity[i],board.activity[i]);
  assert.deepEqual(received.project,board.project);
  assert.equal(digest(received),digest(board));
  assert.equal(fs.readFileSync(f.board,'utf8'),cloud);assert.equal(fs.readFileSync(f.old,'utf8'),old);
  assert.equal(p.MAX_BYTES,512*1024);assert.equal(p.MAX_RESPONSE_BYTES,64*1024*1024);assert.equal(p.TRANSPORT_TIMEOUT,180000);
});
test('real malformed and oversized stdio output fail without old board access or writes',t=>{
  const f=fixture(t),old=fs.readFileSync(f.old,'utf8'),cloud=fs.readFileSync(f.board,'utf8');
  for(const script of ['process.stdout.write("{")','process.stdout.write("x".repeat(64*1024*1024+1))']) {
    f.remote.projects.p.transport.args=['-e',script];f.write(f.remoteFile,f.remote);
    const result=f.cli(['snapshot','--project','p']);assert.equal(result.status,1);
    assert.equal(fs.readFileSync(f.old,'utf8'),old);assert.equal(fs.readFileSync(f.board,'utf8'),cloud);
    assert.ok(!fs.existsSync(path.join(f.local,'remote-artifacts')));
  }
});
test('real idle transport hits the 180-second hard deadline without writing artifacts',{timeout:195000},t=>{
  const f=fixture(t),old=fs.readFileSync(f.old,'utf8'),cloud=fs.readFileSync(f.board,'utf8');
  f.remote.projects.p.transport.args=['-e','setInterval(()=>{},1000)'];f.write(f.remoteFile,f.remote);
  const result=f.cli(['snapshot','--project','p'],{timeout:190000});
  assert.equal(result.status,1);assert.match(result.stderr,/连接\/执行失败/);
  assert.ok(!fs.existsSync(path.join(f.local,'remote-artifacts')));
  assert.equal(fs.readFileSync(f.old,'utf8'),old);assert.equal(fs.readFileSync(f.board,'utf8'),cloud);
});
