'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const C=require('../core/ownerNodeContract.cjs');
const {Facts,Replica,collector,claude}=require('../core/ownerNodeUsage.cjs');
const {Objects,Journal}=require('../core/ownerNodeStore.cjs');
const sources=require('../core/ownerNodeSources.cjs');
const {invoke}=require('../server/ownerNodeInvoke.cjs');
const {createAuditionApi}=require('../server/auditionApi.cjs');
const {Bridge}=require('../server/ownerNodeBridge.cjs');
function root(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owner-data-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('source replacement, replay, tombstones and paged reconciliation persist over restart',t=>{
  const dir=root(t),source=path.join(dir,'source.json'),target=path.join(dir,'replica.json');
  let f=new Facts(source,'n1'),r=new Replica(target);
  f.replace('group','v1',{tokens:3});r.apply('n1',f.changes({cursor:0}));
  const cursor=r.state.nodes.n1.cursor;
  f.replace('group','v2',{tokens:9});const page=f.changes({cursor});r.apply('n1',page);r.apply('n1',page);
  assert.deepEqual(r.rows('n1'),[{tokens:9}]);
  f=new Facts(source,'n1');r=new Replica(target);assert.deepEqual(r.rows('n1'),[{tokens:9}]);
  f.replace('group','v3',null);r.apply('n1',f.changes({cursor:r.state.nodes.n1.cursor}));assert.equal(Object.keys(r.state.nodes.n1.rows).length,0);
  for(let i=0;i<3;i++)f.replace('g'+i,'a'+i,{tokens:i});
  const first=f.changes({cursor:0,limit:1});r.apply('n1',first);assert.equal(Object.keys(r.state.nodes.n1.rows).length,0,'partial batch must not replace published facts');
  let offset=first.nextOffset;while(offset!==null){const next=f.changes({cursor:0,batch:first.batch,offset,limit:1});r.apply('n1',next);offset=next.nextOffset;}
  assert.equal(r.rows('n1').length,3);
  assert.throws(()=>r.apply('other',first),/source mismatch/);
});
test('real parent/child parser: replay dedup, new/deleted children change group version',async t=>{
  const dir=root(t),repo=path.join(dir,'repo'),logs=path.join(dir,'claude'),sessions=path.join(dir,'sessions');
  for(const p of [repo,logs,sessions])fs.mkdirSync(p);
  const prefix=require('../core/costUsage.cjs').mapRepoToPrefix(repo),bucket=path.join(logs,prefix);fs.mkdirSync(bucket);
  const now=new Date().toISOString(),event=(id,output)=>JSON.stringify({type:'assistant',sessionId:'parent',timestamp:now,cwd:repo,message:{id,model:'claude-sonnet-4-5',usage:{input_tokens:1,output_tokens:output}}})+'\n';
  fs.writeFileSync(path.join(bucket,'parent.jsonl'),event('shared',2));
  const config={nodeId:'n1',stateRoot:path.join(dir,'node'),claudeProjectsRoot:logs,sessionsRoot:sessions,projects:{alpha:{name:'Alpha',codeRepo:repo,docsRoot:repo,costRoots:[repo]}}};
  let c=collector(config);await c.scan();const id=Object.keys(c.facts.state.rows).find(k=>k.startsWith('claude-')),v1=c.facts.state.rows[id].sourceVersion;
  const subs=path.join(bucket,'parent','subagents');fs.mkdirSync(subs,{recursive:true});fs.writeFileSync(path.join(subs,'child.jsonl'),event('shared',2)+event('new',5));
  await c.scan();assert.notEqual(c.facts.state.rows[id].sourceVersion,v1);
  const rows=()=>Object.values(c.facts.state.rows).map(r=>r.data);
  assert.equal(claude(rows(),'alpha',30).totals.output,7);
  c=collector(config);await c.scan();assert.equal(claude(rows(),'alpha',30).totals.output,7);
  fs.unlinkSync(path.join(subs,'child.jsonl'));await c.scan();assert.equal(claude(rows(),'alpha',30).totals.output,2);
  const serialized=JSON.stringify(rows());assert.doesNotMatch(serialized,/"message"|"content"|"prompt"/);
});
test('sources reject traversal, absolute/UNC and symlink escape; fixed export has content identity',t=>{
  const dir=root(t),repo=path.join(dir,'repo');fs.mkdirSync(repo);fs.writeFileSync(path.join(repo,'safe.md'),'source');
  for(const rel of ['../secret','a/../safe.md','/absolute','C:/path/to/secret','\\\\host\\share','a\\b'])assert.throws(()=>sources.bytes(repo,rel));
  const outside=path.join(dir,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'secret.md'),'private');
  fs.symlinkSync(outside,path.join(repo,'linked'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>sources.bytes(repo,'linked/secret.md'));
  const content=JSON.stringify({schemaVersion:2,project:'alpha',key:'REPORT',annos:[]}),args={projectId:'alpha',key:'REPORT',content,contentVersion:C.digest(content)};
  const result=sources.exportAnnotations(repo,'reader',args);assert.equal(result.path,sources.EXPORTS.reader+'/REPORT.json');
  assert.deepEqual(sources.exportAnnotations(repo,'reader',args),result);assert.equal(fs.readFileSync(path.join(repo,'safe.md'),'utf8'),'source');
  assert.throws(()=>sources.exportAnnotations(repo,'reader',{...args,contentVersion:'0'.repeat(64)}));
});
test('bound object upload/read and hash verification across chunked export',t=>{
  const dir=root(t),store=new Objects(dir,'n1'),bytes=Buffer.alloc(C.MAX_CHUNK+17,65),object={nodeId:'n1',projectId:'alpha',kind:'reader-export',hash:C.digest(bytes),size:bytes.length};
  assert.equal(store.write({object,offset:0,data:bytes.subarray(0,C.MAX_CHUNK).toString('base64')}).complete,false);
  assert.equal(store.write({object,offset:C.MAX_CHUNK,data:bytes.subarray(C.MAX_CHUNK).toString('base64')}).complete,true);
  assert.deepEqual(store.content(object),bytes);
  assert.throws(()=>store.chunk({object:{...object,nodeId:'other'},offset:0,length:1}));
  assert.throws(()=>store.chunk({object:{...object,projectId:'other'},offset:0,length:1}));
  assert.throws(()=>store.write({object,offset:0,data:Buffer.alloc(C.MAX_CHUNK+1).toString('base64')}));
});
test('existing audition Range/MIME/HTML/SVG and size boundaries remain usable',async t=>{
  const dir=root(t),proj={docsRoot:dir};fs.writeFileSync(path.join(dir,'sound.wav'),Buffer.from('0123456789'));fs.writeFileSync(path.join(dir,'screen.html'),'<p>screen</p>');fs.writeFileSync(path.join(dir,'icon.svg'),'<svg/>');
  const build=d=>createAuditionApi({...d,resolveProjectSafe:()=>proj,dataRoot:path.join(dir,'data')});
  const ranged=await invoke(build,'file','GET',{project:'alpha',path:'sound.wav'},null,{range:'bytes=2-5'});assert.equal(ranged.status,206);assert.equal(ranged.body.toString(),'2345');assert.equal(ranged.headers['content-type'],'audio/wav');
  assert.equal((await invoke(build,'file','GET',{project:'alpha',path:'sound.wav'},null,{range:'bytes=50-'})).status,416);
  const html=await invoke(build,'file','GET',{project:'alpha',path:'screen.html'});assert.match(html.headers['content-security-policy'],/connect-src 'none'/);
  const svg=await invoke(build,'file','GET',{project:'alpha',path:'icon.svg'});assert.match(svg.headers['content-security-policy'],/sandbox/);
  const fd=fs.openSync(path.join(dir,'large.wav'),'w');fs.ftruncateSync(fd,30*1024*1024+1);fs.closeSync(fd);
  assert.equal((await invoke(build,'file','GET',{project:'alpha',path:'large.wav'})).status,413);
});
test('cloud refuses wrong source identity and offline costs are not fabricated',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owner-data-')),node={nodeId:'n1',projects:['alpha']};
  const bridge=new Bridge({stateRoot:path.join(dir,'cloud'),nodes:[]},{autoSync:false});
  t.after(async()=>{await bridge.close();fs.rmSync(dir,{recursive:true,force:true});});
  bridge.connection=async()=>({call:async()=>({status:200,headers:{},object:{nodeId:'intruder',projectId:'alpha',kind:'doc',hash:'0'.repeat(64),size:0}})});
  await assert.rejects(bridge.call(node,'project.doc.get',{projectId:'alpha',relativePath:'file.md'}),/source mismatch/);
  assert.throws(()=>bridge.replica.rows('n1'),/unavailable/);
  bridge.replica.state.nodes.n1={cursor:1,rows:{sample:{data:{kind:'sample',at:'2000-01-01T00:00:00.000Z'}}}};
  assert.throws(()=>bridge.costRows('n1'),/陈旧/);
});
