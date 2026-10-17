'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn,fork}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {PassThrough}=require('node:stream');
const {pathToFileURL}=require('node:url');
const C=require('../core/ownerNodeContract.cjs');
const {peer,framed}=require('../core/ownerNodeTransport.cjs');
const {Journal,exclusive,atomic}=require('../core/ownerNodeStore.cjs');
const scheduler=require('../scripts/codex/codex-scheduler.cjs');
const fixture=path.resolve(__dirname,'../packages/owner-node/test-worker.cjs');
function root(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owner-transport-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function worker(t,dir,mode){const child=spawn(process.execPath,[fixture,dir,mode||'normal'],{stdio:['pipe','pipe','pipe'],windowsHide:true});child.stderr.resume();const p=peer(child.stdout,child.stdin,{initiate:true,timeoutMs:15000});t.after(()=>{p.close();child.kill();});return {child,p};}
function write(){const args={projectId:'alpha',slug:'sample-job',message:'line one\n"literal" & line two'},operation='jobs.say';return {operation,args,identity:{operationId:randomUUID(),hash:C.digest({operation,args})}};}
test('real stdio subprocess: literal message and replay launch exactly once',async t=>{
  const dir=root(t),{p}=worker(t,dir),w=write();
  const first=await p.call(w.operation,w.args,w.identity),second=await p.call(w.operation,w.args,w.identity);
  assert.deepEqual(first,second);assert.equal(first.reply,w.args.message);
  assert.equal(fs.readFileSync(path.join(dir,'launches.txt'),'utf8'),'launch\n');
  assert.throws(()=>p.call(w.operation,{...w.args,message:'changed'},w.identity));
  await p.call(w.operation,w.args,{...w.identity,operationId:randomUUID()});
  assert.equal(fs.readFileSync(path.join(dir,'launches.txt'),'utf8'),'launch\nlaunch\n','a new explicit operation with identical text executes');
});
test('lost response / crash after spawn: restart leaves unknown, never relaunches',async t=>{
  const dir=root(t),w=write(),first=worker(t,dir,'crash-after-spawn');
  await assert.rejects(first.p.call(w.operation,w.args,w.identity));
  if(first.child.exitCode===null)await new Promise(resolve=>first.child.once('exit',resolve));
  const second=worker(t,dir);
  await assert.rejects(second.p.call(w.operation,w.args,w.identity));
  assert.deepEqual(await second.p.call('jobs.list',{projectId:'alpha'}),{operation:'jobs.list',args:{projectId:'alpha'}},'service actually restarts while launch intent stays blocked');
  assert.equal(fs.readFileSync(path.join(dir,'launches.txt'),'utf8'),'launch\n');
});
test('durable completed receipt survives process restart',async t=>{
  const dir=root(t),w=write(),a=worker(t,dir);const result=await a.p.call(w.operation,w.args,w.identity);const exited=new Promise(resolve=>a.child.once('exit',resolve));a.child.kill('SIGKILL');await exited;
  const b=worker(t,dir);assert.deepEqual(await b.p.call(w.operation,w.args,w.identity),result);
  assert.equal(fs.readFileSync(path.join(dir,'launches.txt'),'utf8'),'launch\n');
});
test('generation, nonce and response sequence mismatch close connection',async()=>{
  for(const field of ['generation','nonce','sequence']){
    const input=new PassThrough(),output=new PassThrough();let hello;
    const rogue=framed(output,input,m=>{
      if(m.direction==='hello'){hello=m;return;}
      const r={version:C.VERSION,direction:'reply',generation:hello.generation,sequence:m.sequence,nonce:m.nonce,ok:true,result:{}};
      r[field]=field==='sequence'?m.sequence+1:randomUUID();rogue.send(r);
    });
    const p=peer(input,output,{initiate:true,timeoutMs:1000});
    await assert.rejects(p.call('jobs.list',{projectId:'alpha'}));p.close();
  }
});
test('strict semantic fields, directions and frame allocation bound',()=>{
  assert.throws(()=>C.validateOperation('jobs.list',{projectId:'alpha',role:'owner'}));
  assert.throws(()=>C.validateOperation('shell',{argv:['echo']}));
  assert.throws(()=>C.validateOperation('project.doc.get',{projectId:'alpha',relativePath:'../secret'}));
  const input=new PassThrough(),output=new PassThrough();let closed=false,received=false;
  framed(input,output,()=>{received=true;},()=>{closed=true;});const header=Buffer.alloc(4);header.writeUInt32BE(C.MAX_FRAME+1);input.write(header);
  assert.equal(closed,true);assert.equal(received,false);
});
test('real gateway subprocess and local socket: entry identity binds configured project',async t=>{
  const dir=root(t),suffix=randomUUID(),socket=name=>process.platform==='win32'?'\\\\.\\pipe\\owner-'+suffix+'-'+name:path.join(dir,name+'.sock');
  const node={nodeId:'node-one',nodeSocket:socket('node'),clientSocket:socket('client'),projects:['alpha']};
  fs.writeFileSync(path.join(dir,'gateway.json'),JSON.stringify({nodes:[node]}));
  const child=fork(fixture,[dir,'gateway'],{silent:true,windowsHide:true});child.stdout.resume();child.stderr.resume();
  t.after(()=>child.kill());await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Gateway startup timeout')),5000);child.once('error',reject);child.once('message',()=>{clearTimeout(timer);resolve();});});
  const ns=net.connect(node.nodeSocket),np=peer(ns,ns,{handler:r=>({project:r.args.projectId})});await np.ready;t.after(()=>np.close());
  const cs=net.connect(node.clientSocket),cp=peer(cs,cs);await cp.ready;t.after(()=>cp.close());
  assert.deepEqual(await cp.call('jobs.list',{projectId:'alpha'}),{project:'alpha'});
  await assert.rejects(cp.call('jobs.list',{projectId:'another'}));
  np.close();await assert.rejects(cp.call('jobs.list',{projectId:'alpha'}));
});
test('registration refusal and permission refusal never invoke the launch adapter',t=>{
  const dir=root(t);let launches=0,cancels=0;
  const spec={file:path.join(dir,'op.json'),cwd:dir,title:'synthetic',targets:['fixture'],executable:process.execPath,argv:['ignored'],options:{}};
  assert.throws(()=>scheduler.registeredRun(spec,{scheduler:{register(){throw new Error('reject');}},launch(){launches++;}}));
  assert.equal(launches,0);
  assert.throws(()=>scheduler.registeredRun({...spec,file:path.join(dir,'other.json')},{scheduler:{register:()=> 'tk-'+ 'a'.repeat(20),permit(){throw new Error('no grant');},cancel(){cancels++;}},launch(){launches++;}}));
  assert.equal(launches,0);assert.equal(cancels,1);
});

test('writer crash recovery is serialized: Linux kernel lock / Windows birth identity generations',async t=>{
  const dir=root(t);
  const start=()=>new Promise((resolve,reject)=>{const child=fork(fixture,[dir,'writer'],{silent:true,windowsHide:true});child.stdout.resume();child.stderr.resume();t.after(()=>child.kill());child.once('error',reject);child.once('message',()=>resolve(child));child.once('exit',code=>reject(new Error('Writer exited '+code)));});
  const first=await start();assert.throws(()=>exclusive(dir),/active|unconfirmed/);
  const exited=new Promise(resolve=>first.once('exit',resolve));first.kill('SIGKILL');await exited;
  const contenders=await Promise.allSettled([start(),start()]);
  assert.equal(contenders.filter(r=>r.status==='fulfilled').length,1,'only one recovering writer wins');
  const second=contenders.find(r=>r.status==='fulfilled').value;assert.throws(()=>exclusive(dir),/active|unconfirmed/);
  const stopped=new Promise(resolve=>second.once('exit',resolve));second.send('close');await stopped;
  const release=exclusive(dir);assert.throws(()=>exclusive(dir),/active|unconfirmed/);release();release();
});

test('Linux real flock helper exits but parent FD retains the permanent inode lock', {skip:process.platform!=='linux',timeout:15000},async t=>{
  const dir=root(t),file=path.join(dir,'writer.flock');
  const first=fork(fixture,[dir,'writer'],{silent:true});first.stdout.resume();first.stderr.resume();
  t.after(()=>first.kill());
  await new Promise((resolve,reject)=>{first.once('message',resolve);first.once('error',reject);first.once('exit',code=>reject(new Error('Writer startup failed '+code)));});
  // The fixture cannot report ready until exclusive()'s real spawnSync flock
  // subprocess has exited. A new open description must still conflict now.
  const inode=fs.statSync(file,{bigint:true});
  assert.throws(()=>exclusive(dir),/active \(flock conflict\)/);
  const exited=new Promise(resolve=>first.once('exit',resolve));first.kill('SIGKILL');await exited;
  assert.equal(fs.statSync(file,{bigint:true}).ino,inode.ino,'crash leaves the fixed file');
  const release=exclusive(dir);
  assert.throws(()=>exclusive(dir),/active \(flock conflict\)/);
  release();release();
  const again=exclusive(dir);again();
  const after=fs.statSync(file,{bigint:true});assert.equal(after.dev,inode.dev);assert.equal(after.ino,inode.ino,'release and recovery never replace the inode');
});

test('Linux flock migration refuses unknown legacy writers and seals released generations', {skip:process.platform!=='linux'},t=>{
  const {ownIdentity}=require('../core/ownerNodeLock.cjs');
  const unknown=root(t);fs.writeFileSync(path.join(unknown,'writer.lock'),JSON.stringify({pid:process.pid}));
  assert.throws(()=>exclusive(unknown),/Legacy.*reconciliation/);
  const live=root(t),old={token:randomUUID(),identity:ownIdentity()};
  fs.writeFileSync(path.join(live,'writer.lock'),JSON.stringify(old));
  assert.throws(()=>exclusive(live),/Legacy writer active/);
  const foreign=root(t);
  fs.writeFileSync(path.join(foreign,'writer.lock'),JSON.stringify({...old,identity:{...old.identity,scope:'0'}}));
  assert.throws(()=>exclusive(foreign),/Legacy writer active|unconfirmed/,'another namespace is not evidence of death');
  fs.writeFileSync(path.join(live,'writer-generations',old.token+'.released'),JSON.stringify(old));
  const release=exclusive(live);release();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(live,'writer.lock'))),old,'original evidence retained');
  const marker=JSON.parse(fs.readFileSync(path.join(live,'writer-generations',old.token+'.next')));
  assert.equal(marker.protocol,'linux-flock-v1');assert.equal(marker.identity,undefined,'old generation executables cannot prove this sentinel dead');
  assert.equal(fs.existsSync(path.join(live,'writer-generations',marker.token+'.released')),false);
  exclusive(live)();
});

test('Linux fixed flock inode rejects symlinks, extra links and non-files', {skip:process.platform!=='linux'},t=>{
  const linked=root(t),target=path.join(linked,'target');fs.writeFileSync(target,'evidence');
  fs.symlinkSync(target,path.join(linked,'writer.flock'));
  assert.throws(()=>exclusive(linked));assert.equal(fs.readFileSync(target,'utf8'),'evidence');
  const multiple=root(t),original=path.join(multiple,'original');fs.writeFileSync(original,'evidence');
  fs.linkSync(original,path.join(multiple,'writer.flock'));assert.throws(()=>exclusive(multiple),/fixed protected regular file/);
  const directory=root(t);fs.mkdirSync(path.join(directory,'writer.flock'));assert.throws(()=>exclusive(directory));
});

test('Linux never probes a Windows worker PID or treats an unknown identity as dead',()=>{
  const processIdentity=require('../core/ownerNodeProcess.cjs');let probes=0;
  assert.equal(processIdentity.identity(12345,{platform:'linux',run(){probes++;}}),null);
  assert.equal(probes,0);assert.equal(processIdentity.matches({pid:12345,birth:'old',command:'worker'},null),false);
  assert.equal(require('../core/ownerNodeLock.cjs').absent({platform:process.platform==='linux'?'win32':'linux',pid:12345,birth:'old'}),false);
});

test('bridge shutdown drains writes before releasing writer ownership and rejects new calls',async t=>{
  const dir=root(t),{Bridge}=require('../server/ownerNodeBridge.cjs'),bridge=new Bridge({stateRoot:dir,nodes:[]},{autoSync:false});
  let resume;const gate=new Promise(resolve=>{resume=resolve;});
  const write=bridge.work(async()=>{await gate;atomic(path.join(dir,'late.json'),{written:true});});
  await Promise.resolve();const closing=bridge.close();assert.equal(bridge.close(),closing);
  assert.throws(()=>exclusive(dir),/active|unconfirmed/);
  await assert.rejects(bridge.call({},'jobs.list',{projectId:'alpha'}),/shutting down/);
  resume();await write;await closing;
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'late.json'))).written,true);exclusive(dir)();
});
test('permission precedes process, finish follows exit; unknown retries cannot start',t=>{
  const dir=root(t),events=[],spec={file:path.join(dir,'op.json'),cwd:dir,title:'synthetic',targets:['fixture'],executable:process.execPath,argv:[],options:{}};
  const sched={register(){events.push('register');return 'tk-'+ 'b'.repeat(20);},permit(){events.push('permit');},finish(){events.push('finish');},cancel(){events.push('cancel');}};
  scheduler.registeredRun(spec,{scheduler:sched,launch(){events.push('spawn');return {status:0};}});
  assert.deepEqual(events,['register','permit','spawn','finish']);
  events.length=0;
  scheduler.registeredRun({...spec,file:path.join(dir,'unknown.json')},{scheduler:sched,launch(){events.push('spawn');return {status:null,error:new Error('lost')};}});
  assert.deepEqual(events,['register','permit','spawn','cancel']);
  assert.throws(()=>scheduler.registeredRun({...spec,file:path.join(dir,'unknown.json')},{scheduler:sched,launch(){throw new Error('MUST NOT SPAWN');}}),/unknown/);
});
test('public dispatch/supervise/say use registered holds; acceptance alone uses exec',async t=>{
  const dir=root(t),source=path.resolve(__dirname,'..');
  fs.mkdirSync(path.join(dir,'scripts'),{recursive:true});fs.cpSync(path.join(source,'scripts','codex'),path.join(dir,'scripts','codex'),{recursive:true});
  fs.mkdirSync(path.join(dir,'core'));
  for(const name of ['ownerNodeStore.cjs','ownerNodeContract.cjs','ownerNodeProcess.cjs','ownerNodeLock.cjs'])fs.copyFileSync(path.join(source,'core',name),path.join(dir,'core',name));
  fs.symlinkSync(fs.realpathSync(path.join(source,'node_modules')),path.join(dir,'node_modules'),process.platform==='win32'?'junction':'dir');
  fs.writeFileSync(path.join(dir,'exec'),`const fs=require('node:fs');fs.appendFileSync('model-calls.jsonl',JSON.stringify(process.argv.slice(2))+'\\n');console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}));setTimeout(()=>process.exit(0),200);`);
  const schedFile=path.join(dir,'scheduler.json'),log=path.join(dir,'scheduler.jsonl');fs.writeFileSync(schedFile,JSON.stringify({cli:path.join(source,'packages','owner-node','test-scheduler.cjs'),share:dir,project:'synthetic'}));
  const task={schemaVersion:1,taskId:'SYNTHETIC',slug:'synthetic-job',title:'无害派单',goal:'只运行本地合成进程',allowedPaths:['exec'],forbiddenPaths:[],nonGoals:[],acceptance:[{id:'MANUAL',kind:'manual',required:true}],expectArtifacts:[],worktree:false,timeoutSec:30};
  const taskFile=path.join(dir,'task.json');fs.writeFileSync(taskFile,JSON.stringify(task));
  const env={...process.env,CODEX_BIN:process.execPath,DASHBOARD_WORKER_SCHED_CONFIG:schedFile,SYNTHETIC_SCHED_LOG:log};
  const cli=path.join(dir,'scripts','codex','codex-dispatch.ts');
  async function command(args,extra={}){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--import',pathToFileURL(require.resolve('tsx',{paths:[source]})).href,cli,...args],{cwd:dir,env:{...env,...extra},stdio:['ignore','pipe','pipe'],windowsHide:true});let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});child.once('error',reject);child.once('close',code=>resolve({code,output}));});}
  const denied=await command(['dispatch','--task',taskFile],{SYNTHETIC_SCHED_DENY:'submit'});assert.notEqual(denied.code,0);assert.equal(fs.existsSync(path.join(dir,'model-calls.jsonl')),false);
  task.slug='permitted-job';fs.writeFileSync(taskFile,JSON.stringify(task));
  const dispatched=await command(['dispatch','--task',taskFile]);assert.equal(dispatched.code,0,dispatched.output);
  const stateFile=path.join(dir,'.codex','jobs',task.slug,'state.json');let state;
  for(let i=0;i<150;i++){state=JSON.parse(fs.readFileSync(stateFile,'utf8'));if(state.schedulerFinish==='confirmed')break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(state.schedulerFinish,'confirmed');assert.equal(state.exitCode,0);
  assert.equal(fs.readFileSync(path.join(dir,'model-calls.jsonl'),'utf8').trim().split('\n').length,1,'detached child survives dispatcher exit');
  const replay=await command(['_supervise',task.slug]);assert.notEqual(replay.code,0);assert.equal(fs.readFileSync(path.join(dir,'model-calls.jsonl'),'utf8').trim().split('\n').length,1);
  const said=await command(['say',task.slug,'literal\n"quotes" & no shell']);assert.equal(said.code,0,said.output);
  const calls=fs.readFileSync(path.join(dir,'model-calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.ok(calls[1].includes('literal\n"quotes" & no shell'));
  let events=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.equal(events.some(e=>e.command==='exec'),false,'background dispatch and say never use outer exec');assert.ok(events.some(e=>e.command==='finish'));
  fs.mkdirSync(path.join(dir,'test'));fs.writeFileSync(path.join(dir,'test','tiny.cjs'),`require('node:test').test('synthetic',()=>{});`);
  const driver=path.join(dir,'acceptance.mts');fs.writeFileSync(driver,`import {runAcceptance} from './scripts/codex/codex-runner';import {readFileSync,mkdirSync} from 'node:fs';const task=JSON.parse(readFileSync('task.json','utf8'));task.acceptance=[{id:'CHECK',kind:'test:targeted',target:'test/tiny.cjs',required:true}];mkdirSync('results');const r=runAcceptance(task,process.cwd(),'results');if(!r[0].passed)process.exitCode=1;`);
  const accepted=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--import',pathToFileURL(require.resolve('tsx',{paths:[source]})).href,driver],{cwd:dir,env,stdio:'ignore',windowsHide:true});child.once('error',reject);child.once('close',resolve);});assert.equal(accepted,0);
  events=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.equal(events.filter(e=>e.command==='exec').length,1);assert.ok(events.at(-1).args.includes('--test-concurrency=1'));
});
