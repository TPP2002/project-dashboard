'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {fixture,must,addArgs,ROOT,GATEWAY}=require('./remoteBoardFixtures.test.cjs');
const protocol=require('../core/boardCommand.cjs');
function git(f,args) {return must(spawnSync('git',args,{env:f.env,cwd:f.repo,encoding:'utf8',windowsHide:true}));}
function init(f) {
  git(f,['init','-b','main']);git(f,['config','user.name','Owner']);git(f,['config','user.email','owner@example.invalid']);
  fs.writeFileSync(path.join(f.repo,'local.txt'),'本机事实');git(f,['add','.']);git(f,['commit','-m','initial']);
}
function artifactRoot(f) {return path.join(f.local,'remote-artifacts','p');}
function disconnect(f) {f.remote.projects.p.transport.args=['-e','process.exit(1)'];f.write(f.remoteFile,f.remote);}
function reconnect(f) {f.remote.projects.p.transport.args=[GATEWAY,'--authority',f.authorityFile];f.write(f.remoteFile,f.remote);}
test('maintenance reads live owner projection and scans local Git/docs; old board can be unreadable',t=>{
  const f=fixture(t);init(f);must(f.cli(addArgs('A')));
  // Directory at old board path makes any JSON read or overwrite impossible on all platforms.
  fs.unlinkSync(f.old);fs.mkdirSync(f.old);
  const frozenBefore=fs.readdirSync(path.dirname(f.old));
  must(f.cli(['hooks-install','--project','p','--registry',f.registry]));
  assert.match(fs.readFileSync(path.join(f.repo,'.git','hooks','post-commit'),'utf8'),/render-index/);
  fs.writeFileSync(path.join(f.repo,'local.txt'),'第二次');git(f,['add','.']);git(f,['commit','-m','feat(A): 本机提交 (#14)']);
  assert.ok(fs.existsSync(path.join(artifactRoot(f),'INDEX.md')));
  const sha=git(f,['rev-parse','HEAD']).stdout.trim();
  assert.ok(f.read().tasks[0].commitShas.includes(sha.slice(0,12)));
  must(f.cli(['snapshot','--project','p','--stamp','current']));
  const snap=JSON.parse(fs.readFileSync(path.join(artifactRoot(f),'snapshots','current.json'),'utf8'));
  assert.deepEqual(snap.tasks,f.read().tasks);assert.ok(!snap._commandReceipts);assert.ok(!snap._commandRetention);
  const precheck=must(f.cli(['precheck','--project','p','--no-fetch']));assert.match(precheck.stdout,/本机|当前分支/);
  must(f.cli(['doctor','--project','p','--quick','--fix','--branches']));
  must(f.cli(['doctor','--project','p','--branches']));
  const index=path.join(f.root,'explicit-index.md');fs.writeFileSync(index,'人工内容\n<!--dashboard:status:begin -->\n旧内容\n<!--dashboard:status:end-->\n结尾');
  must(f.cli(['render-index','--project','p','--index',index]));assert.match(fs.readFileSync(index,'utf8'),/^人工内容/);
  for(const args of [['snapshot','--out',path.dirname(f.old)],['render-index','--index',path.join(path.dirname(f.old),'INDEX.md')],['docs-audit','--out',path.join(path.dirname(f.old),'report.txt')]]) assert.equal(f.cli([...args,'--project','p']).status,1);
  assert.deepEqual(fs.readdirSync(path.dirname(f.old)),frozenBefore);
  assert.ok(!fs.existsSync(path.join(f.cloud,'.git')));
});
test('offline maintenance leaves no reports, success stamps, frozen files, or cloud mutations',t=>{
  const f=fixture(t);init(f);must(f.cli(addArgs('A')));
  const cloud=fs.readFileSync(f.board,'utf8'),old=fs.readFileSync(f.old,'utf8');disconnect(f);
  for(const args of [['snapshot'],['render-index'],['precheck'],['doctor','--quick'],['doctor','--fix','--branches'],['docs-audit','--create-card','--monthly-tick']]) {
    assert.equal(f.cli([...args,'--project','p']).status,1,args.join(' '));
    assert.ok(!fs.existsSync(artifactRoot(f)));
    assert.equal(fs.readFileSync(f.board,'utf8'),cloud);assert.equal(fs.readFileSync(f.old,'utf8'),old);
  }
});
test('doctor fixes Git facts and constrained branch semantics; concurrent claim invalidates cleanup',t=>{
  const f=fixture(t);init(f);for(const id of ['A','B']) must(f.cli(addArgs(id)));
  fs.writeFileSync(path.join(f.repo,'local.txt'),'实现');git(f,['add','.']);git(f,['commit','-m','feat(A): 真实修复 (#22)']);
  const old=fs.readFileSync(f.old,'utf8');
  must(f.cli(['doctor','--project','p','--fix']));
  assert.deepEqual(f.read().tasks[0].prNumbers,[22]);
  assert.ok(fs.readdirSync(path.join(artifactRoot(f),'doctor')).length>0);
  // Seed historical mistaken branch registration in the temporary cloud fixture only.
  let b=f.read();b.tasks[0].gitBranch=['feat/B'];b.tasks[1].gitBranch=['feat/B'];f.write(f.board,b);
  must(f.cli(['doctor','--project','p','--branches','--fix','--tier','suspect']));
  assert.deepEqual(f.read().tasks[0].gitBranch,[]);assert.deepEqual(f.read().tasks[1].gitBranch,['feat/B']);
  b=f.read();b.tasks[0].gitBranch=['feat/B'];f.write(f.board,b);
  const expected=protocol.inputHash(protocol.publicResult(b));
  const cleanup=f.request('branch-cleanup',{payload:{expected,tier:'suspect',trunk:'main',entries:[{taskId:'A',branch:'feat/B',otherIds:['B'],verdict:'suspect',evidence:'name'}]}});
  must(f.cli(['claim','A','--project','p','--branch','feat/B','--builder','派单器']));
  const before=fs.readFileSync(f.board,'utf8'),result=f.gateway(cleanup);
  assert.equal(result.status,1);assert.match(result.stdout,/并发变化/);assert.equal(fs.readFileSync(f.board,'utf8'),before);
  assert.equal(fs.readFileSync(f.old,'utf8'),old);
});
test('docs-audit card uses three fields, survives lost ACK, and monthly stamp waits for confirmation',t=>{
  const f=fixture(t);const docs=path.join(f.repo,'docs','plans');fs.mkdirSync(docs,{recursive:true});fs.writeFileSync(path.join(docs,'unlabelled.md'),'# 本机待核对文档');
  const cut=path.join(f.root,'cut-audit.cjs');
  fs.writeFileSync(cut,`const fs=require('node:fs');const {spawnSync}=require('node:child_process');const input=fs.readFileSync(0,'utf8');const r=spawnSync(process.execPath,${JSON.stringify([GATEWAY,'--authority',f.authorityFile])},{input,env:process.env,encoding:'utf8'});process.stdout.write(JSON.parse(input).command==='audit-card'?r.stdout.slice(0,10):r.stdout);process.exitCode=r.status;`);
  f.remote.projects.p.transport.args=[cut];f.write(f.remoteFile,f.remote);
  const args=['docs-audit','--project','p','--create-card','--monthly-tick'];
  assert.equal(f.cli(args).status,1);assert.ok(!fs.existsSync(artifactRoot(f)));
  const pending=fs.readdirSync(path.join(f.local,'remote-outbox')).map(n=>JSON.parse(fs.readFileSync(path.join(f.local,'remote-outbox',n),'utf8'))).find(e=>e.request.command==='audit-card');
  assert.equal(pending.state,'unconfirmed');const immutable=protocol.inputHash(pending.request);
  const card=f.read().tasks[0];assert.ok(card.title);assert.ok(card.plainTitle);assert.ok(card.modelHint);
  reconnect(f);must(f.cli(['remote-retry',pending.request.requestId]));must(f.cli(['remote-retry',pending.request.requestId]));
  assert.equal(protocol.inputHash(JSON.parse(fs.readFileSync(path.join(f.local,'remote-outbox',pending.request.requestId+'.json'),'utf8')).request),immutable);
  must(f.cli(args));assert.ok(fs.existsSync(path.join(artifactRoot(f),'docs-audit-state.json')));
  assert.equal(f.read().tasks.length,1);assert.equal(f.read().activity.filter(a=>a.text.startsWith('新建任务 DOCS-AUDIT-')).length,1);
});
test('owner task management is bounded and cannot modify metadata, paths, project, or prototypes',t=>{
  const f=fixture(t);must(f.cli(addArgs('A')));const old=fs.readFileSync(f.old,'utf8');
  must(f.cli(['set','A','--project','p','--field','tests','--value','"7/7"']));assert.equal(f.read().tasks[0].tests,'7/7');
  const patch=path.join(f.root,'patch.json');f.write(patch,{A:{'deps.relatedTasks':[],'description':'云端补充'}});
  must(f.cli(['backfill','--project','p','--patch',patch]));assert.equal(f.read().tasks[0].description,'云端补充');must(f.cli(['backfill','--project','p']));
  for(const field of ['id','project.id','registry','revision','_commandReceipts','_commandRetention.rejectBefore','constructor.prototype.x','file','board','root']) {
    const before=fs.readFileSync(f.board,'utf8');assert.equal(f.cli(['set','A','--project','p','--field',field,'--value','"x"']).status,1);assert.equal(fs.readFileSync(f.board,'utf8'),before);
  }
  const invalid=f.request('backfill-patch',{payload:JSON.parse('{"A":{"deps.__proto__.x":true}}')});assert.equal(f.gateway(invalid).status,1);
  const badSchema=f.cli(['set','A','--project','p','--field','percent','--value','101']);assert.equal(badSchema.status,1);
  let b=f.read();b.activity.push({ts:'2020-01-02T00:00:00.000Z',type:'note',taskId:'A',text:'待归档'});f.write(f.board,b);
  const request=f.request('archive-activity',{before:'2021-01'});const first=must(f.gateway(request));must(f.gateway(request));
  const result=JSON.parse(first.stdout).result;assert.equal(result.moved,1);assert.ok(result.files[0].objectId);assert.ok(!('path' in result.files[0]));
  const archive=JSON.parse(fs.readFileSync(path.join(f.cloud,result.files[0].objectId),'utf8'));assert.equal(archive.filter(a=>a.text==='待归档').length,1);
  assert.equal(f.read().activity.filter(a=>a.text==='待归档').length,0);assert.equal(fs.readFileSync(f.old,'utf8'),old);
});
test('import uses immutable semantic batches, records partial completion, and preserves existing history',t=>{
  const f=fixture(t);must(f.cli(addArgs('A')));
  const input=path.join(f.root,'tasks.md');fs.writeFileSync(input,Array.from({length:65},(_,i)=>`| P${i} | 导入任务${i} | 未开工 | 本机记录 |`).join('\n'));
  const drop=path.join(f.root,'drop-import.cjs');
  fs.writeFileSync(drop,`const fs=require('node:fs');const {spawnSync}=require('node:child_process');const input=fs.readFileSync(0,'utf8');const req=JSON.parse(input);if(req.command==='import-batch'&&req.args.payload.index===1)process.exit(1);const r=spawnSync(process.execPath,${JSON.stringify([GATEWAY,'--authority',f.authorityFile])},{input,env:process.env,encoding:'utf8'});process.stdout.write(r.stdout);process.exitCode=r.status;`);
  f.remote.projects.p.transport.args=[drop];f.write(f.remoteFile,f.remote);
  const args=['import','--project','p','--from',input];const first=f.cli(args);assert.equal(first.status,1);assert.match(first.stderr,/部分确认 1\/2/);
  assert.equal(f.read().tasks.length,51);
  const dir=path.join(artifactRoot(f),'imports');const planFile=path.join(dir,fs.readdirSync(dir)[0]);const before=JSON.parse(fs.readFileSync(planFile,'utf8'));
  assert.equal(before.confirmed,1);reconnect(f);must(f.cli(args));must(f.cli(args));
  const after=JSON.parse(fs.readFileSync(planFile,'utf8'));assert.deepEqual(after.requests,before.requests);assert.equal(after.confirmed,2);
  assert.equal(f.read().tasks.length,66);assert.ok(f.read().tasks.some(t=>t.id==='A'));
  assert.equal(f.read().activity.filter(a=>a.text.startsWith('import 语义批次')).length,2);
});
test('fixed administrator initialization and explicit binding never create or overwrite a local authority',t=>{
  const f=fixture(t),adminBinding=path.join(f.root,'admin-binding.json');f.authority.admin=true;f.write(f.authorityFile,f.authority);
  const binding={...f.remote.projects.p,transport:{type:'stdio',executable:process.execPath,args:[GATEWAY,'--init-project',f.authorityFile]}};f.write(adminBinding,binding);
  const args=['remote-project-init','--id','new-project','--name','新项目','--binding-file',adminBinding];must(f.cli(args));must(f.cli(args));
  const cloudBoard=path.join(f.cloud,'projects','new-project','board.json');const bytes=fs.readFileSync(cloudBoard,'utf8');
  assert.equal(f.authority.projects['new-project'],undefined); // init does not grant permissions
  assert.equal(f.cli(['remote-project-init','--id','new-project','--name','覆盖名字','--binding-file',adminBinding]).status,1);assert.equal(fs.readFileSync(cloudBoard,'utf8'),bytes);
  const normal=f.request('project-init',{name:'非法普通入口'});assert.equal(f.gateway(normal).status,1);
  f.authority.projects['new-project']={repoBindings:{'repo-p':{ownerIds:['owner-device']}}};f.write(f.authorityFile,f.authority);
  const bindFile=path.join(f.root,'binding.json');f.write(bindFile,f.remote.projects.p);
  must(f.cli(['remote-bind','--id','new-project','--root',f.repo,'--binding-file',bindFile]));
  assert.ok(!fs.existsSync(path.join(f.repo,'.dashboard','board.json')));
  const cfg=fs.readFileSync(f.remoteFile,'utf8'),reg=fs.readFileSync(f.registry,'utf8');
  assert.equal(f.cli(['remote-bind','--id','new-project','--root',f.repo,'--binding-file',bindFile]).status,1);
  assert.equal(fs.readFileSync(f.remoteFile,'utf8'),cfg);assert.equal(fs.readFileSync(f.registry,'utf8'),reg);
  const old=fs.readFileSync(f.old,'utf8');
  must(f.cli(['register','--id','p','--root',f.repo,'--remote-binding',bindFile,'--update']));assert.equal(fs.readFileSync(f.old,'utf8'),old);
  fs.writeFileSync(path.join(f.repo,'TASKS.md'),'| P9 | 显式接入任务 | 未开工 | 新任务 |');
  must(f.cli(['enroll','--id','p','--name','测试','--root',f.repo,'--remote-binding',bindFile,'--update','--no-hooks']));
  assert.ok(f.read().tasks.some(t=>t.id==='P9'));assert.equal(fs.readFileSync(f.old,'utf8'),old);
  assert.equal(f.cli(['register','--id','unbound-new','--root',f.repo]).status,1);
  assert.ok(!JSON.parse(fs.readFileSync(f.registry,'utf8')).projects['unbound-new']);
  const cleanHome=path.join(f.root,'fresh-client');fs.mkdirSync(cleanHome);
  const cleanConfig=path.join(cleanHome,'remote.json');
  must(f.cli(['remote-bind','--id','new-project','--root',f.repo,'--binding-file',bindFile],{env:{...f.env,DASHBOARD_HOME:cleanHome,DASHBOARD_REMOTE_CONFIG:cleanConfig}}));
  assert.ok(fs.existsSync(cleanConfig));assert.ok(!fs.existsSync(path.join(f.repo,'.dashboard','board.json')));
});
test('cleanup retains local Git dry-run and explicit execution without writing either board',t=>{
  const f=fixture(t);init(f);git(f,['remote','add','origin',f.repo]);git(f,['fetch','origin','main']);
  const wt=path.join(f.root,'cleanup-wt');git(f,['worktree','add','-b','feat/cleanup',wt]);
  const old=fs.readFileSync(f.old,'utf8'),cloud=fs.readFileSync(f.board,'utf8');
  const args=['cleanup','--project','p','--repo',f.repo,'--worktree',wt,'--branch','feat/cleanup'];
  must(f.cli(args));assert.ok(fs.existsSync(wt));
  must(f.cli([...args,'--yes']));assert.ok(!fs.existsSync(wt));
  assert.equal(fs.readFileSync(f.old,'utf8'),old);assert.equal(fs.readFileSync(f.board,'utf8'),cloud);
});
