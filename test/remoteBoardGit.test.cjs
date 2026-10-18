'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {fixture,must,addArgs,GATEWAY}=require('./remoteBoardFixtures.test.cjs');
function git(f,args,cwd=f.repo,env=f.env) { return spawnSync('git',args,{cwd,env,encoding:'utf8',windowsHide:true}); }
function init(f) {
  must(git(f,['init','-b','main'])); must(git(f,['config','user.name','Test Owner']));must(git(f,['config','user.email','owner@example.invalid']));
  fs.writeFileSync(path.join(f.repo,'initial.txt'),'initial');must(git(f,['add','initial.txt']));must(git(f,['commit','-m','initial']));
}
function claim(f,id,branch,cwd=f.repo) { return f.cli(['claim',id,'--project','p','--branch',branch,'--builder','派单器'],{cwd}); }
test('formal CLI and generated hooks bridge local Git to cloud without repository',t=>{
  const f=fixture(t);init(f);must(git(f,['checkout','-b','feat/a']));
  must(f.cli(addArgs('A')));must(claim(f,'A','feat/a'));
  must(f.cli(['claim-check','--registry',f.registry]));
  must(f.cli(['hooks-install','--project','p','--registry',f.registry]));
  const hook=fs.readFileSync(path.join(f.repo,'.git','hooks','pre-commit'),'utf8');assert.match(hook,/claim-check/);
  fs.writeFileSync(path.join(f.repo,'work.txt'),'first');must(git(f,['add','work.txt']));
  must(git(f,['commit','-m','feat(A): 实现共同记录 (#12)']));
  const sha=must(git(f,['rev-parse','HEAD'])).stdout.trim();
  must(f.cli(['sync-from-git','--project','p','--commit',sha,'--branch','feat/a']));
  const show=must(f.cli(['show','A','--project','p','--full']));assert.match(show.stdout,new RegExp(sha.slice(0,12)));
  assert.deepEqual(f.read().tasks[0].prNumbers,[12]);
  assert.ok(!fs.existsSync(path.join(f.cloud,'.git')));
  const old=fs.readFileSync(f.old,'utf8');
  f.remote.projects.p.transport.args=['-e','process.exit(1)'];f.write(f.remoteFile,f.remote);
  fs.writeFileSync(path.join(f.repo,'work.txt'),'second');must(git(f,['add','work.txt']));
  const blocked=git(f,['commit','-m','feat(A): should block']);assert.notEqual(blocked.status,0);assert.match(blocked.stderr,/结果待确认/);
  assert.equal(must(git(f,['rev-parse','HEAD'])).stdout.trim(),sha);
  // pre-commit remains strict; explicit emergency bypass lets post-commit demonstrate durable pending facts.
  const committed=must(git(f,['commit','-m','feat(A): offline postcommit'],f.repo,{...f.env,DASHBOARD_SKIP_CLAIM_CHECK:'1'}));
  assert.match(committed.stderr,/结果待确认 requestId=/);
  const postsha=must(git(f,['rev-parse','HEAD'])).stdout.trim();assert.notEqual(postsha,sha);
  const outbox=path.join(f.local,'remote-outbox');
  const pending=fs.readdirSync(outbox).map(n=>JSON.parse(fs.readFileSync(path.join(outbox,n),'utf8'))).filter(x=>x.state==='unconfirmed'&&x.request.command==='git-facts');
  assert.equal(pending.length,1);assert.equal(pending[0].request.args.facts.commit,postsha);
  f.remote.projects.p.transport.args=[GATEWAY,'--authority',f.authorityFile];f.write(f.remoteFile,f.remote);
  must(f.cli(['remote-retry',pending[0].request.requestId]));must(f.cli(['remote-retry',pending[0].request.requestId]));
  assert.equal(f.read().tasks[0].commitShas.filter(s=>s===postsha.slice(0,12)).length,1);
  assert.equal(fs.readFileSync(f.old,'utf8'),old);
});
test('two worktrees, structural vs prose references, historical windows and postmerge',t=>{
  const f=fixture(t);init(f);
  const wt1=path.join(f.root,'wt1'),wt2=path.join(f.root,'wt2');
  must(git(f,['worktree','add','-b','feat/one',wt1]));must(git(f,['worktree','add','-b','feat/two',wt2]));
  for(const id of ['A','B','C']) must(f.cli(addArgs(id)));
  must(claim(f,'A','feat/one',wt1));must(claim(f,'B','feat/two',wt2));
  const commit=(cwd,text,file)=>{fs.writeFileSync(path.join(cwd,file),text);must(git(f,['add',file],cwd));must(git(f,['commit','-m',text],cwd));return must(git(f,['rev-parse','HEAD'],cwd)).stdout.trim();};
  const prose=commit(wt1,'fix: mention A B C in prose','one.txt');
  must(f.cli(['sync-from-git','--project','p','--commit',prose,'--branch','feat/one'],{cwd:wt1}));
  let tasks=f.read().tasks;
  assert.equal(tasks[0].commitShas.length,1);assert.equal(tasks[1].commitShas.length,0);assert.equal(tasks[2].commitShas.length,0);
  const structural=commit(wt2,'feat(C): add feature, mention A','two.txt');
  must(f.cli(['sync-from-git','--project','p','--commit',structural,'--branch','feat/two'],{cwd:wt2}));
  tasks=f.read().tasks;assert.deepEqual(tasks[2].gitBranch,['feat/two']);assert.equal(tasks[0].commitShas.length,1);
  // A historical scan may merge structured commit/PR facts, never the caller's current branch or prose.
  must(f.cli(['sync-from-git','--project','p','--branch','feat/SHOULD-NOT-SPREAD','--n','300'],{cwd:wt2}));
  assert.ok(f.read().tasks.every(t=>!t.gitBranch.includes('feat/SHOULD-NOT-SPREAD')));
  const noBranch=commit(wt1,'feat(C): merged history (#9)','three.txt');
  must(f.cli(['sync-from-git','--project','p','--commit',noBranch],{cwd:wt1}));
  assert.deepEqual(f.read().tasks[2].gitBranch,['feat/two']);
  assert.deepEqual(f.read().tasks[2].prNumbers,[9]);
  // Git facts cannot touch semantic fields and unknown/cross-project devices cannot submit patches.
  const c=f.read().tasks[2];assert.equal(c.status,'未开工');assert.deepEqual(c.decisions,[]);assert.deepEqual(c.deps,{dependsOn:[],blockedBy:[],relatedTasks:[]});
  const bad=f.request('git-facts',{facts:{repoBindingId:'other-project',mode:'window',branch:'',commit:'',commits:[]}});
  assert.equal(f.gateway(bad).status,1);
});
test('shared-repo multi-project claim check and lock-time monotone progress with no stale ownership',async t=>{
  const f=fixture(t);init(f);must(git(f,['checkout','-b','feat/shared']));
  const cloudRegistry=JSON.parse(fs.readFileSync(f.authority.registryPath,'utf8'));
  const qboard=path.join(f.cloud,'q-board.json');
  f.write(qboard,require('../core/boardSchema.cjs').emptyBoard({id:'q',name:'第二项目',mainRepo:f.cloud}));
  cloudRegistry.projects.q={mainRepo:f.cloud,board:qboard};f.write(f.authority.registryPath,cloudRegistry);
  const localReg=JSON.parse(fs.readFileSync(f.registry,'utf8'));localReg.projects.q={mainRepo:f.repo,board:path.join(f.local,'q-old.json')};f.write(f.registry,localReg);
  f.authority.projects.q={repoBindings:{'repo-q':{ownerIds:['owner-device']}}};f.write(f.authorityFile,f.authority);
  f.remote.projects.q={...f.remote.projects.p,repoBindingId:'repo-q'};f.write(f.remoteFile,f.remote);
  must(f.cli(addArgs('A').map(x=>x==='p'?'q':x)));
  must(f.cli(['claim','A','--project','q','--branch','feat/shared','--builder','派单器']));
  const claimResult=must(f.cli(['claim-check','--json']));assert.ok(JSON.parse(claimResult.stdout).hits.some(h=>h.project==='q'));
  await Promise.all([90,20,80,95,5,70].map(percent=>f.concurrent(['sync-progress','--project','q','--percent',String(percent)]).then(must)));
  let qb=JSON.parse(fs.readFileSync(qboard,'utf8'));assert.equal(qb.tasks[0].percent,95);
  must(f.cli(['unclaim','A','--project','q','--reason','交回']));
  must(f.cli(['sync-progress','--project','q','--percent','99']));
  qb=JSON.parse(fs.readFileSync(qboard,'utf8'));assert.equal(qb.tasks[0].percent,95);assert.equal(qb.tasks[0].status,'待开工');assert.deepEqual(qb.tasks[0].gitBranch,[]);
  must(f.cli(['cost','A','--project','q','--agents','test:1','--unknown','测试无额度']));
  must(f.cli(['done','A','--project','q']));must(f.cli(['sync-progress','--project','q','--percent','0']));
  assert.equal(JSON.parse(fs.readFileSync(qboard,'utf8')).tasks[0].percent,100);
  const n=fs.readdirSync(path.join(f.local,'remote-outbox')).map(name=>JSON.parse(fs.readFileSync(path.join(f.local,'remote-outbox',name),'utf8')));
  assert.ok(n.every(x=>x.request.command!=='sync-progress'));
});
