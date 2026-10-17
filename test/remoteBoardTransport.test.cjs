'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {fixture,must,addArgs,GATEWAY,CLI}=require('./remoteBoardFixtures.test.cjs');
const {transportSpec}=require('../cli/remoteClient.cjs');
test('fixed SSH argv quotes deployment tokens; command body stays on JSON stdin',t=>{
  const spec=transportSpec({transport:{type:'ssh',host:'owner@board.example.invalid',entry:['docker','exec','-i','board','node','/app/cli/remoteGateway.cjs','--authority',"/srv/owner's board/authority.json"]}});
  assert.equal(spec.executable,'ssh');
  assert.deepEqual(spec.argv.slice(0,-1),['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ForwardAgent=no','--','owner@board.example.invalid']);
  assert.match(spec.argv.at(-1),/'docker' 'exec' '-i'/);
  assert.ok(spec.argv.at(-1).includes("'\\''"));
  for(const host of ['-oProxyCommand=evil','owner@host x','host;evil','@host']) assert.throws(()=>transportSpec({transport:{type:'ssh',host,entry:['node','gateway']}}));
  const f=fixture(t); const capture=path.join(f.root,'capture.cjs'), received=path.join(f.root,'received.json');
  fs.writeFileSync(capture,`const fs=require('node:fs');const {spawnSync}=require('node:child_process');const input=fs.readFileSync(0,'utf8');fs.writeFileSync(${JSON.stringify(received)},JSON.stringify({argv:process.argv.slice(2),input}));const r=spawnSync(process.execPath,${JSON.stringify([GATEWAY,'--authority',f.authorityFile])},{input,env:process.env,encoding:'utf8'});process.stdout.write(r.stdout);process.exitCode=r.status;`);
  f.remote.projects.p.transport.args=[capture];f.write(f.remoteFile,f.remote);
  const title='中文 "引号"\n下一行 $(not-a-command) `literal` & ;';
  // addArgs already supplies --title: replace its scalar value rather than duplicate the flag.
  const args=addArgs('A');args[args.indexOf('--title')+1]=title;
  must(f.cli(args));
  const got=JSON.parse(fs.readFileSync(received,'utf8'));
  assert.deepEqual(got.argv,[]);
  assert.equal(JSON.parse(got.input).args.title,title);
  assert.equal(f.read().tasks[0].title,title);
  assert.ok(!fs.existsSync(path.join(f.repo,'not-a-command')));
});
test('BOM JSON inputs, batch add, pending, collect brief, repeated flags and JSON dual semantics',t=>{
  const f=fixture(t); const batch=path.join(f.root,'batch.json');
  fs.writeFileSync(batch,'\uFEFF'+JSON.stringify([{id:'A',title:'中文任务',plainTitle:'向共同看板登记同一份任务',model:'test',scope:['cli/**','core/**']} ]));
  must(f.cli(['add','--project','p','--json-file',batch,'--json']));
  must(f.cli(['claim','A','--project','p','--branch','feat/中文"换行','--branch','feat/two','--builder','派单器','--json']));
  assert.deepEqual(f.read().tasks[0].gitBranch,['feat/中文"换行','feat/two']);
  const payload={question:'选哪个？',options:['甲','乙'],recommended:'甲',background:'完整背景信息。'.repeat(12),optionPros:{甲:'该选项好处与代价。'.repeat(4),乙:'另选项好处与代价。'.repeat(4)},recommendReason:'说明为什么选择当前的方案。'.repeat(4)};
  const decision=path.join(f.root,'decision.json');fs.writeFileSync(decision,'\uFEFF'+JSON.stringify(payload));
  must(f.cli(['pending','A','--project','p','--json-file',decision,'--json']));
  const brief=path.join(f.root,'brief.txt');fs.writeFileSync(brief,'\uFEFF第一行 "你好"\n第二行');
  must(f.cli(['collect-brief','A','--project','p','--file',brief]));
  assert.equal(f.read().tasks[0].collectBrief.text,'第一行 "你好"\n第二行');
  const stdinBatch=JSON.stringify([{id:'B',title:'第二张',plainTitle:'另一个使用者记录共同任务',model:'test'}]);
  must(f.cli(['add','--project','p','--json'],{input:'\uFEFF'+stdinBatch}));
  assert.equal(f.read().tasks.length,2);
  must(f.cli(['add','C','--project','p','--title','单卡','--plain-title','有卡号时只输出结果','--model','test','--json']));
  const original=fs.readFileSync(f.old,'utf8');
  must(f.cli(['set','A','--field','status','--value','"已完工"','--project','p']));
  assert.equal(f.read().tasks.find(t=>t.id==='A').status,'已完工');
  const invalidPatch=f.cli(['backfill','--patch','x','--project','p']);
  assert.equal(invalidPatch.status,1);assert.match(invalidPatch.stderr,/ENOENT|no such file|找不到/i);
  const invalidArchive=f.cli(['archive-activity','--project','p']);
  assert.equal(invalidArchive.status,1);assert.match(invalidArchive.stderr,/before/);
  for(const args of [['render-index'],['snapshot'],['precheck','--no-fetch'],['doctor','--quick'],['docs-audit']]) must(f.cli([...args,'--project','p']));
  const snapDir=path.join(f.local,'remote-artifacts','p','snapshots');
  const snap=JSON.parse(fs.readFileSync(path.join(snapDir,fs.readdirSync(snapDir)[0]),'utf8'));
  assert.deepEqual(snap.tasks,f.read().tasks);
  assert.ok(fs.readFileSync(path.join(f.local,'remote-artifacts','p','INDEX.md'),'utf8').includes('单卡'));
  assert.equal(fs.readFileSync(f.old,'utf8'),original);
  const result=must(f.cli(['brief','A','--project','p']));assert.ok(result.stdout.includes(CLI.replace(/\\/g,'/')));
});
test('disconnect and wrong response never touch writable old board; retry keeps request ID',t=>{
  const f=fixture(t);must(f.cli(addArgs('A')));
  const old=fs.readFileSync(f.old,'utf8');
  f.remote.projects.p.transport.args=['-e','process.exit(1)'];f.write(f.remoteFile,f.remote);
  const failed=f.cli(['note','A','--project','p','--text','断网留言']);
  assert.equal(failed.status,1);assert.match(failed.stderr,/结果待确认 requestId=/);
  const id=/requestId=([a-f0-9-]+)/.exec(failed.stderr)[1];
  const outbox=path.join(f.local,'remote-outbox',id+'.json');
  const immutable=JSON.parse(fs.readFileSync(outbox,'utf8')).request;
  assert.equal(immutable.requestId,id);
  const wrong=f.remote.projects.p.transport.args=['-e','process.stdout.write(JSON.stringify({version:"wrong",ok:true}))'];f.write(f.remoteFile,f.remote);
  void wrong;
  assert.equal(f.cli(['show','A','--project','p']).status,1);
  assert.equal(fs.readFileSync(f.old,'utf8'),old);
  f.remote.projects.p.transport.args=[GATEWAY,'--authority',f.authorityFile];f.write(f.remoteFile,f.remote);
  must(f.cli(['remote-retry',id]));must(f.cli(['remote-retry',id]));
  assert.equal(f.read().activity.filter(a=>a.text==='断网留言').length,1);
  assert.deepEqual(JSON.parse(fs.readFileSync(outbox,'utf8')).request,immutable);
  assert.equal(fs.readFileSync(f.old,'utf8'),old);
  const guard=spawnSync(process.execPath,['-e',`const p=require(${JSON.stringify(path.resolve(__dirname,'../core/resolveProject.cjs'))}).resolveProject('p');const s=require(${JSON.stringify(path.resolve(__dirname,'../cli/store.cjs'))});s.readBoard(p.board)`],{env:f.env,encoding:'utf8'});
  assert.equal(guard.status,1);assert.match(guard.stderr,/禁止读写本机旧板/);
  fs.writeFileSync(f.remoteFile,'broken');
  assert.equal(f.cli(['note','A','--project','p','--text','不可回退']).status,1);
  assert.equal(fs.readFileSync(f.old,'utf8'),old);
});
test('exclusive authority initialization never overwrites existing config',t=>{
  const f=fixture(t), dest=path.join(f.root,'new-authority.json');
  must(spawnSync(process.execPath,[GATEWAY,'--init',dest],{input:JSON.stringify(f.authority),encoding:'utf8',env:f.env}));
  const bytes=fs.readFileSync(dest,'utf8');
  const again=spawnSync(process.execPath,[GATEWAY,'--init',dest],{input:'{}',encoding:'utf8',env:f.env});
  assert.equal(again.status,1);assert.equal(fs.readFileSync(dest,'utf8'),bytes);
});
test('invalid bindings and missing/oversize file arguments fail before remote mutation',t=>{
  const f=fixture(t);must(f.cli(addArgs('A')));
  const cloud=fs.readFileSync(f.board,'utf8'),old=fs.readFileSync(f.old,'utf8'),good=JSON.stringify(f.remote);
  for(const binding of [null,false,{},[],{...f.remote.projects.p,authorityEpoch:0}]) {
    f.write(f.remoteFile,{version:1,projects:{p:binding}});
    const result=f.cli(['note','A','--project','p','--text','不得退回旧板']);
    assert.equal(result.status,1);assert.match(result.stderr,/拒绝本机回退/);
  }
  fs.writeFileSync(f.remoteFile,good);
  // A literal file named "true" must not turn a missing --json-file value into an input path.
  fs.writeFileSync(path.join(f.repo,'true'),JSON.stringify([{id:'B',title:'不得创建',plainTitle:'路径缺值',model:'test'}]));
  for(const args of [
    ['add','--json-file'],['pending','A','--json-file'],['collect-brief','A','--file'],
  ]) assert.equal(f.cli([...args,'--project','p']).status,1);
  const large=path.join(f.root,'large.txt');fs.writeFileSync(large,'x'.repeat(512*1024+1));
  assert.equal(f.cli(['collect-brief','A','--project','p','--file',large]).status,1);
  assert.equal(fs.readFileSync(f.board,'utf8'),cloud);assert.equal(fs.readFileSync(f.old,'utf8'),old);
});
test('tampered retry IDs are rejected before a gateway can append a second write',t=>{
  const f=fixture(t);must(f.cli(addArgs('A')));
  f.remote.projects.p.transport.args=['-e','process.exit(1)'];f.write(f.remoteFile,f.remote);
  const failed=f.cli(['note','A','--project','p','--text','不可换编号']);
  const id=/requestId=([a-f0-9-]+)/.exec(failed.stderr)[1];
  const file=path.join(f.local,'remote-outbox',id+'.json');const saved=JSON.parse(fs.readFileSync(file,'utf8'));
  saved.request.requestId='00000000-0000-4000-8000-000000000001';f.write(file,saved);
  f.remote.projects.p.transport.args=[GATEWAY,'--authority',f.authorityFile];f.write(f.remoteFile,f.remote);
  const before=fs.readFileSync(f.board,'utf8');const result=f.cli(['remote-retry',id]);
  assert.equal(result.status,1);assert.match(result.stderr,/文件编号不符/);assert.equal(fs.readFileSync(f.board,'utf8'),before);
});
test('confirmed claim and done keep session bindings local, never infer them on the gateway',t=>{
  const f=fixture(t);must(f.cli(addArgs('A')));
  const first='00000000-0000-4000-8000-000000000001',second='00000000-0000-4000-8000-000000000002';
  must(f.cli(['claim','A','--project','p','--branch','feat/session','--builder','派单器'],{env:{...f.env,CLAUDE_CODE_SESSION_ID:first}}));
  must(f.cli(['cost','A','--project','p','--agents','test:1','--unknown','隔离测试无实付额度']));
  must(f.cli(['done','A','--project','p'],{env:{...f.env,CLAUDE_CODE_SESSION_ID:second}}));
  const {readBindings,bindingsPathOf}=require('../core/sessionBindings.cjs');
  const bindings=readBindings(f.old);
  assert.deepEqual(bindings[first],['A']);assert.deepEqual(bindings[second],['A']);
  assert.ok(!fs.existsSync(bindingsPathOf(f.board)));
});
