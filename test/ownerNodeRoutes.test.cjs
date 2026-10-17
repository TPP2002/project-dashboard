'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {fork}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {createAuth}=require('../core/collaborationAuth.cjs');
const {emptyBoard}=require('../core/boardSchema.cjs');
const {serve}=require('../packages/owner-node/gateway.cjs');
const {peer}=require('../core/ownerNodeTransport.cjs');
const {handlers}=require('../server/ownerNodeHandlers.cjs');
const {collector}=require('../core/ownerNodeUsage.cjs');
const sources=require('../core/ownerNodeSources.cjs');
const ORIGIN='http://127.0.0.1:48129',PASSWORD='Synthetic-password-12345';
const SESSION='11111111-1111-4111-8111-111111111111';
const routes=[
  ['/api/codex/jobs?project=alpha'],['/api/codex/job?project=alpha&slug=missing-job'],['/api/codex/task?project=alpha&slug=missing-job'],
  ['/api/codex/dispatch?project=alpha',{slug:'missing-job'}],['/api/codex/say?project=alpha',{slug:'missing-job',message:'literal\nmessage'}],['/api/codex/collect?project=alpha',{slug:'missing-job'}],
  ['/api/codex/sessions?project=alpha'],['/api/codex/session?project=alpha&id='+SESSION],['/api/codex/say-session?project=alpha',{sessionId:SESSION,message:'hello'}],['/api/codex/quota?project=alpha'],['/api/codex/report?project=alpha'],
  ['/api/cost?project=alpha'],['/api/cost/session-detail?project=alpha'],['/api/cost/job-detail?project=alpha'],['/api/doc?projectId=alpha&path=sample.md'],
  ['/api/reader/manifest?project=alpha'],['/api/reader/report?project=alpha&key=REPORT'],['/api/reader/export-review?project=alpha&key=REPORT'],['/api/reader/annos?project=alpha&key=REPORT'],
  ['/api/reader/annos',{project:'alpha',key:'REPORT',anno:{text:'note'}}],['/api/reader/marks',{project:'alpha',key:'REPORT',mark:{blockId:'b1',start:0,end:2}}],['/api/reader/review',{project:'alpha',key:'REPORT',state:'已审阅'}],['/api/reader/export',{project:'alpha',key:'REPORT'}],
  ['/api/reader/import',{project:'alpha'}],['/api/reader/import-original?project=alpha&key=IMP-none'],['/api/reader/import-delete',{project:'alpha',key:'IMP-none'}],
  ['/api/audition/index?project=alpha'],['/api/audition/batch?project=alpha&key=AUDIO'],['/api/audition/file?project=alpha&path=sound.wav'],['/api/audition/state?project=alpha&key=AUDIO'],
  ...['note','note/update','note/delete','mark','verdict','review','export'].map(action=>['/api/audition/'+action,{project:'alpha',key:'AUDIO',id:'missing',text:'note',group:'g',scene:'s',value:null,state:'已审阅'}]),
  ['/api/dispatch',{pid:'alpha',tid:'MISSING',did:'d1'}],['/api/dispatch-project',{pid:'alpha',preview:true}],['/api/dispatch-task',{pid:'alpha',tid:'ONE',preview:true}],['/api/sched/ci-jobs'],
];
async function start(home,registry,bridge){
  const child=fork(path.resolve(__dirname,'../packages/owner-node/test-worker.cjs'),[home,'dashboard'],{silent:true,windowsHide:true,env:{...process.env,DASHBOARD_HOME:home,DASHBOARD_REGISTRY:registry,DASHBOARD_MODULES:'codex,cost,cpu,reader,audition',DASHBOARD_MODE:'collaboration',DASHBOARD_PUBLIC_ORIGIN:ORIGIN,DASHBOARD_HOST:'127.0.0.1',DASHBOARD_PORT:'0',DASHBOARD_NO_OPEN:'1',DASHBOARD_EVENT_WEBHOOK:'',DASHBOARD_OWNER_NODE_CONFIG:bridge||'',DASHBOARD_CODEX_SESSIONS:path.join(home,'sessions'),DASHBOARD_SCHED_SHARE:path.join(home,'synthetic-share'),SCHED_SHARE:path.join(home,'synthetic-share')}});
  let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('Server startup timeout: '+output));},15000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code+': '+output));});child.on('message',m=>{if(m.type==='dashboard-ready'){clearTimeout(timer);resolve({child,base:'http://127.0.0.1:'+m.port});}});});
}
async function stop(server){if(server&&server.child.exitCode===null&&server.child.signalCode===null)await new Promise(resolve=>{server.child.once('exit',resolve);server.child.send('shutdown');});}
test('real HTTP owner routes, anonymous/member isolation, revocation and local baseline',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-routes-'));let cloud,baseline,gateway,nodePeer;
  t.after(async()=>{await stop(cloud);await stop(baseline);nodePeer?.close();await gateway?.close();fs.rmSync(root,{recursive:true,force:true});});
  const repo=path.join(root,'repo'),home=path.join(root,'cloud'),nodeRoot=path.join(root,'node'),sessions=path.join(root,'sessions'),claudeRoot=path.join(root,'claude');
  for(const dir of [repo,home,nodeRoot,sessions,claudeRoot,path.join(home,'sessions')])fs.mkdirSync(dir,{recursive:true});
  const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
  write(path.join(repo,'sample.md'),'# synthetic document');write(path.join(repo,'sound.wav'),'0123456789');write(path.join(repo,'screen.html'),'<p>screen</p>');
  write(path.join(repo,sources.MANIFEST),{batches:[{id:'batch',name:'Batch',reports:[{key:'REPORT',title:'Report',md:'sample.md'}]}]});
  write(path.join(repo,sources.INDEX),{schemaVersion:1,batches:[{key:'AUDIO',title:'Audio',path:'batch.json'}]});
  write(path.join(repo,'batch.json'),{schemaVersion:1,title:'Audio',groups:[{id:'g',name:'Group'}],scenes:[{id:'s',name:'Scene',level:1}],screens:[{id:'screen',path:'screen.html'}],defaultScreen:'screen',clips:[{group:'g',scene:'s',files:['sound.wav'],sources:[{license:'CC0',url:'https://example.invalid/synthetic'}]}]});
  const board=emptyBoard({id:'alpha',name:'Alpha',mainRepo:repo});board.tasks=[{id:'ONE',title:'Synthetic',status:'施工中',decisions:[{id:'d1',question:'Continue?',answer:'yes',landed:false}]}];
  write(path.join(home,'alpha.json'),board);const registry=path.join(home,'registry.json');write(registry,{projects:{alpha:{name:'Alpha',mainRepo:repo,codeRepo:repo,docsRoot:repo,board:path.join(home,'alpha.json')}}});
  const auth=createAuth({home,registryPath:registry});await auth.bootstrap('owner',PASSWORD);const owner=await auth.login('owner',PASSWORD,'synthetic');const invitation=auth.createInvite(owner.token,{projectIds:['alpha'],expiresInHours:1,maxUses:1});const member=await auth.register({inviteToken:invitation.token,username:'member',password:PASSWORD},'synthetic-member');
  const suffix=randomUUID(),socket=name=>process.platform==='win32'?'\\\\.\\pipe\\owner-'+suffix+'-'+name:path.join(root,name+'.sock');
  const node={nodeId:'n1',nodeSocket:socket('node'),clientSocket:socket('client'),projects:['alpha']};
  const config={version:'owner-node.v1',stateRoot:path.join(home,'bridge'),nodes:[node]},configPath=path.join(root,'bridge.json');write(configPath,config);if(process.platform!=='win32')fs.chmodSync(configPath,0o600);
  gateway=await serve(config);
  const nodeConfig={nodeId:'n1',stateRoot:nodeRoot,sessionsRoot:sessions,claudeProjectsRoot:claudeRoot,projects:{alpha:{name:'Alpha',codeRepo:repo,docsRoot:repo,costRoots:[repo]}}};
  const usage=collector(nodeConfig);await usage.scan();usage.balance={available:false,reason:'synthetic',balance:null,sampledAt:new Date().toISOString()};
  let calls=0;const chunks=[];const service=handlers(nodeConfig,{usage,launch(){throw new Error('Tests must never launch a model');}}),ns=net.connect(node.nodeSocket);nodePeer=peer(ns,ns,{handler:r=>{calls++;if(r.operation==='object.read')chunks.push(r.args);return service.handle(r);}});await nodePeer.ready;
  cloud=await start(home,registry,configPath);
  async function request(server,route,session,data,extra={}){const response=await fetch(server.base+route,{method:data===undefined?'GET':'POST',headers:{...(session?{Cookie:'dashboard_session='+session.token}:{}),...(data===undefined?{}:{Origin:ORIGIN,'Content-Type':'application/json','X-Dashboard-Request':'1','X-Dashboard-CSRF':session?.csrfToken||'','X-Owner-Operation-Id':randomUUID()}),...extra},body:data===undefined?undefined:JSON.stringify(data)});return {status:response.status,body:await response.text(),headers:response.headers};}
  await t.test('every owner endpoint rejects anonymous and member before node access',async()=>{
    // Initial background cost sync is separate from request authorization.
    await new Promise(resolve=>setTimeout(resolve,100));const before=calls;
    for(const [route,data]of routes){assert.equal((await request(cloud,route,null,data)).status,401,route);assert.equal((await request(cloud,route,member,data)).status,403,route);}
    assert.equal(calls,before);
    const health=await request(cloud,'/api/health',member);assert.deepEqual(JSON.parse(health.body),{ok:true,mode:'collaboration'});
  });
  await t.test('owner reads sources through original URLs; private cache and Range survive',async()=>{
    assert.equal((await request(cloud,'/api/doc?projectId=alpha&path=sample.md',owner)).body,'# synthetic document');
    const report=await request(cloud,'/api/reader/report?project=alpha&key=REPORT',owner);assert.equal(report.status,200);assert.equal(JSON.parse(report.body).md,'# synthetic document');assert.equal(report.headers.get('cache-control'),'private, no-store');
    const before=chunks.length;
    const audio=await request(cloud,'/api/audition/file?project=alpha&path=sound.wav',owner,undefined,{Range:'bytes=2-5'});assert.equal(audio.status,206);assert.equal(audio.body,'2345');
    assert.deepEqual(chunks.slice(before).map(c=>[c.offset,c.length]),[[2,4]],'Range transfers exactly requested bytes, not a full remote object');
    const posted=await request(cloud,'/api/reader/annos',owner,{project:'alpha',key:'REPORT',anno:{text:'stored only in cloud'}});assert.equal(posted.status,200);
    assert.equal(fs.existsSync(path.join(home,'data','reader','alpha','REPORT.json')),true);assert.equal(fs.existsSync(path.join(nodeRoot,'data','reader','alpha','REPORT.json')),false);
    const exported=await request(cloud,'/api/reader/export',owner,{project:'alpha',key:'REPORT'});assert.equal(exported.status,200);assert.equal(JSON.parse(fs.readFileSync(path.join(repo,sources.EXPORTS.reader,'REPORT.json'),'utf8')).annos[0].text,'stored only in cloud');
    const id=randomUUID(),body={project:'alpha',key:'REPORT',anno:{text:'same explicit text'}},headers={'X-Owner-Operation-Id':id};
    const once=await request(cloud,'/api/reader/annos',owner,body,headers),retry=await request(cloud,'/api/reader/annos',owner,body,headers);
    assert.equal(once.status,200);assert.equal(retry.body,once.body);
    const fresh=await request(cloud,'/api/reader/annos',owner,body);assert.notEqual(JSON.parse(fresh.body).anno.id,JSON.parse(once.body).anno.id);
    assert.equal((await request(cloud,'/api/reader/annos',owner,body,{'X-Owner-Operation-Id':''})).status,400);
  });
  await t.test('exported shutdown is repeatable and permits restart with the same state volume',async()=>{
    await stop(cloud);cloud=await start(home,registry,configPath);
    assert.equal((await request(cloud,'/api/doc?projectId=alpha&path=sample.md',owner)).status,200);
  });
  await t.test('write CSRF/origin and revoked session cannot cross bridge',async()=>{
    const before=calls;assert.equal((await request(cloud,'/api/codex/say?project=alpha',owner,{slug:'missing-job',message:'no'},{Origin:'https://elsewhere.invalid'})).status,403);assert.equal(calls,before);
    auth.logout(owner.token);assert.equal((await request(cloud,'/api/codex/jobs?project=alpha',owner)).status,401);
  });
  await t.test('all owner routes reach their fixed bridge handlers without launching a model',async()=>{
    const fresh=await auth.login('owner',PASSWORD,'owner-all');
    for(const [route,data]of routes){const response=await request(cloud,route,fresh,data);assert.ok([200,400,404,409,503].includes(response.status),route+': '+response.status+' '+response.body);assert.equal(response.headers.get('cache-control'),'private, no-store');}
  });
  await t.test('no bridge configuration retains local source baseline',async()=>{
    const fresh=await auth.login('owner',PASSWORD,'baseline');baseline=await start(home,registry,null);
    assert.equal((await request(baseline,'/api/doc?projectId=alpha&path=sample.md',fresh)).body,'# synthetic document');
    const local=await request(baseline,'/api/reader/report?project=alpha&key=REPORT',fresh);assert.equal(local.status,200);assert.equal(JSON.parse(local.body).md,'# synthetic document');
    const audio=await request(baseline,'/api/audition/file?project=alpha&path=sound.wav',fresh,undefined,{Range:'bytes=2-5'});assert.equal(audio.body,'2345');assert.equal(audio.status,206);
    // Missing jobs/sessions fail before any launch; no paid or external tools.
    for(const [route,data]of routes.filter(([r])=>!r.startsWith('/api/cost')&&!r.startsWith('/api/sched/'))){const response=await request(baseline,route,fresh,data);assert.ok([200,400,404].includes(response.status),route+': '+response.status);}
    for(const suffix of ['', '/session-detail','/job-detail'])assert.equal((await request(baseline,'/api/cost'+suffix+'?project=not-registered',fresh)).status,404);
  });
});
