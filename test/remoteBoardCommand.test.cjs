'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {fixture,must,addArgs,GATEWAY} = require('./remoteBoardFixtures.test.cjs');
function pendingPayload() { return {question:'采用哪一种方式？',options:['甲','乙'],recommended:'甲',background:'背景与影响需要完整说明。'.repeat(8),optionPros:{甲:'甲方案的好处与代价。'.repeat(3),乙:'乙方案的好处与代价。'.repeat(3)},recommendReason:'在当前已确认的施工边界内采用该方式的理由。'.repeat(3)}; }
test('typed owner protocol, entry gates, atomic receipts and restart after lost output',t => {
  const f=fixture(t);
  const before=fs.readFileSync(f.board,'utf8');
  for (const r of [
    f.request('add',{_:['A'],title:'标题','plain-title':'人话'}),
    f.request('add',{_:['A'],title:'标题',model:'test'}),
    f.request('add',{_:['A'],'plain-title':'人话',model:'test'}),
    f.request('set',{field:'status',value:'已完工'}),
    {...f.request('list'),owner:true},
    {...f.request('list'),version:'unknown'},
    {...f.request('list'),authorityEpoch:2},
    f.request('list',{registry:'evil'}),
    f.request('list',{fields:'id,constructor.prototype'}),
    f.request('progress',{_:['A'],percent:'50'}),
    f.request('note',JSON.parse('{"text":"x","constructor.prototype":{}}')),
    f.request('note',{text:'x'.repeat(129*1024)}),
  ]) assert.equal(f.gateway(r).status,1);
  assert.equal(fs.readFileSync(f.board,'utf8'),before);
  const missingModel=f.gateway(f.request('add',{_:['A'],title:'标题'}));
  assert.match(JSON.parse(missingModel.stdout).error,/sonnet·低.*opus·中.*fable·高/s);
  must(f.cli(addArgs('A')));
  const stable=fs.readFileSync(f.board,'utf8');
  for (const args of [
    ['done','A'],['claim','A','--branch','feat/a'],
    ['pending','A','--q','缺三件套','--opt','甲','--opt','乙'],
    ['decide','A','--did','absent','--answer','甲'],
    ['cost','A','--agents','test:1','--tokens','-1'],
  ]) assert.equal(f.cli([...args,'--project','p']).status,1);
  assert.equal(fs.readFileSync(f.board,'utf8'),stable);
  // Wrapper drains a REAL gateway child, deliberately cuts its response, then exits.
  const cut=path.join(f.root,'cut.cjs');
  fs.writeFileSync(cut,`const {spawnSync}=require('node:child_process');const fs=require('node:fs');const r=spawnSync(process.execPath,${JSON.stringify([GATEWAY,'--authority',f.authorityFile])},{input:fs.readFileSync(0),encoding:'utf8',env:process.env});process.stdout.write(r.stdout.slice(0,12));`);
  for (const request of [f.request('note',{_:['A'],text:'仅有一条留言'}),f.request('cost',{_:['A'],agents:'test:1',tokens:12}),f.request('pending',{_:['A'],payload:pendingPayload()})]) {
    const first=spawnSync(process.execPath,[cut],{input:JSON.stringify(request),env:f.env,encoding:'utf8'});
    assert.throws(()=>JSON.parse(first.stdout));
    const after=fs.readFileSync(f.board,'utf8');
    const retry=must(f.gateway(request));
    assert.equal(JSON.parse(retry.stdout).ok,true);
    assert.equal(fs.readFileSync(f.board,'utf8'),after);
    assert.equal(f.gateway({...request,args:{...request.args,author:'different'}}).status,1);
  }
  const b=f.read();
  assert.equal(b.activity.filter(a=>a.text==='仅有一条留言').length,1);
  assert.equal(b.tasks[0].cost.entries.length,1);
  assert.equal(b.tasks[0].decisions.length,1);
  must(f.cli(['done','A','--project','p']));
  const list=must(f.gateway(f.request('list',{all:true})));
  assert.ok(!list.stdout.includes('_commandReceipts'));
  assert.ok(Object.keys(f.read()._commandReceipts).length>=5);
  assert.ok(!fs.existsSync(path.join(f.cloud,'repo')));
});
test('all remote semantic commands use original state machine and field semantics',t => {
  const f=fixture(t); must(f.cli(addArgs('A'))); must(f.cli(addArgs('B')));
  const run=(cmd,args={})=>must(f.gateway(f.request(cmd,{_:['A'],...args})));
  run('claim',{branch:['feat/a','feat/b'],builder:'派单器',scope:['cli/**','core/**']});
  run('progress',{percent:60,next:'下一步',tests:'3/3/1',typecheck:true});
  run('collect-brief',{text:'收单指令'}); run('await-collect',{job:'job-a'});
  run('claim',{branch:'feat/a',builder:'派单器'});
  run('pending',{payload:pendingPayload()});
  run('request-info',{did:'d1',missing:'background,optionPros'});
  run('decide',{did:'d1',answer:'甲'}); run('undecide',{did:'d1',reason:'重新审阅'});
  run('decide',{did:'d1',answer:'乙'}); run('mark-landed',{did:'d1',commit:'abcdef123456'});
  run('block',{by:'B',reason:'依赖'}); run('edit',{title:'新标题',wave:2});
  run('park',{reason:'暂缓',note:'留存'}); run('unpark',{reason:'解除'});
  run('claim',{branch:'feat/a',builder:'派单器'}); run('unclaim',{branch:'feat/a',reason:'交回'});
  run('cost',{agents:'test:1',unknown:'没有可归因用量'}); run('done'); run('reopen',{reason:'重开'}); run('cancel',{reason:'不再需要'});
  for (const command of ['show','brief']) run(command);
  must(f.gateway(f.request('inbox')));
  assert.equal(f.read().tasks[0].status,'已作废');
  assert.equal(f.read().tasks[0].decisions[0].answer,'乙');
});
test('synchronous transaction rejects Promise and clears nested read/mutate context',t => {
  const f=fixture(t); const probe=path.join(f.root,'probe.cjs');
  fs.writeFileSync(probe,`process.env.DASHBOARD_HOME=${JSON.stringify(f.cloud)};delete process.env.DASHBOARD_REMOTE_CONFIG;const assert=require('node:assert/strict');const fs=require('node:fs');const s=require(${JSON.stringify(path.resolve(__dirname,'../cli/store.cjs'))});const proj=require(${JSON.stringify(path.resolve(__dirname,'../core/resolveProject.cjs'))}).resolveProject('p');const before=fs.readFileSync(proj.board,'utf8');assert.throws(()=>s.commandTransaction(proj,{subject:'owner',request:{requestId:'async'},inputHash:'x'},()=>Promise.resolve({ok:true})),/Promise/);assert.equal(s.inCommandTransaction(),false);assert.equal(fs.readFileSync(proj.board,'utf8'),before);s.commandTransaction(proj,{subject:'owner',request:{requestId:'sync'},inputHash:'b'.repeat(64)},()=>{const b=s.readBoard(proj.board);s.mutate(proj,c=>assert.equal(c,b));return {ok:true};});assert.equal(s.inCommandTransaction(),false);`);
  must(spawnSync(process.execPath,[probe],{env:f.env,encoding:'utf8'}));
});
test('local entry keeps machine gates and ordinary local writes preserve remote receipts',t => {
  const f=fixture(t);must(f.cli(addArgs('A')));
  const request=f.request('note',{_:['A'],text:'幂等留言'});const first=must(f.gateway(request));
  const env={...f.env,DASHBOARD_HOME:f.cloud};delete env.DASHBOARD_REMOTE_CONFIG;
  const before=fs.readFileSync(f.board,'utf8');
  for(const args of [
    ['add','B','--title','标题','--plain-title','人话'],
    ['add','B','--title','标题','--model','test'],
    ['done','A'],['claim','A','--branch','feat/a'],
  ]) assert.equal(f.cli([...args,'--project','p'],{env}).status,1);
  const missingModel=f.cli(['add','B','--project','p','--title','标题'],{env});
  assert.match(missingModel.stderr,/sonnet·低.*opus·中.*fable·高/s);
  assert.equal(fs.readFileSync(f.board,'utf8'),before);
  const receipts=f.read()._commandReceipts;
  must(f.cli(['note','A','--project','p','--text','本机未迁移模式写入'],{env}));
  assert.deepEqual(f.read()._commandReceipts,receipts);
  const after=fs.readFileSync(f.board,'utf8');const replay=must(f.gateway(request));
  assert.equal(replay.stdout,first.stdout);assert.equal(fs.readFileSync(f.board,'utf8'),after);
  assert.equal(f.read().activity.filter(a=>a.text==='幂等留言').length,1);
});
test('concurrent semantic appends retain all fields and receipts',async t => {
  const f=fixture(t);must(f.cli(addArgs('A')));
  const decision=path.join(f.root,'decision.json');f.write(decision,pendingPayload());
  await Promise.all([
    ['note','A','--text','并发留言'],
    ['cost','A','--agents','test:1','--tokens','7'],
    ['pending','A','--json-file',decision],
    ['progress','A','--percent','60','--next','保留其它字段'],
  ].map(args=>f.concurrent([...args,'--project','p']).then(must)));
  const board=f.read(),task=board.tasks[0];
  assert.equal(board.activity.filter(a=>a.text==='并发留言').length,1);
  assert.equal(task.cost.entries.length,1);assert.equal(task.decisions.length,1);assert.equal(task.percent,60);
  assert.equal(Object.keys(board._commandReceipts).length,5);assert.equal(board.revision,5);
});
