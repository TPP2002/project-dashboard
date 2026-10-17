'use strict';
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {randomUUID}=require('node:crypto');
const C=require('../core/ownerNodeContract.cjs');
const {peer}=require('../core/ownerNodeTransport.cjs');
const {loadConfig}=require('../core/ownerNodeConfig.cjs');
const {read,atomic,exclusive}=require('../core/ownerNodeStore.cjs');
const {Replica}=require('../core/ownerNodeUsage.cjs');
const sources=require('../core/ownerNodeSources.cjs');
const {invoke}=require('./ownerNodeInvoke.cjs');
const {createReaderApi}=require('./readerApi.cjs');
const {createAuditionApi,byteRange}=require('./auditionApi.cjs');
const {view}=require('./ownerNodeCostViews.cjs');
class Bridge {
  constructor(config,{autoSync=true}={}) {
    if(!config.stateRoot)throw new Error('Cloud bridge stateRoot required');
    this.config=config;this.release=exclusive(config.stateRoot);this.connections=new Map();
    this.pending=new Set();this.closing=false;
    this.writeFile=path.join(config.stateRoot,'cloud-writes.json');this.writes=read(this.writeFile,{});this.activeWrites=new Map();
    this.replica=new Replica(path.join(config.stateRoot,'usage-replica.json'));this.syncing=false;
    if(autoSync){this.timer=setInterval(()=>this.sync().catch(()=>{}),60000);this.timer.unref();this.sync().catch(()=>{});}
  }
  node(projectId) {const n=this.config.nodes.find(n=>n.projects.includes(projectId));if(!n)C.fail('Project has no owner node',503);return n;}
  costRows(nodeId){const rows=this.replica.rows(nodeId),at=Date.parse(rows.find(row=>row.kind==='sample')?.at||'');if(!Number.isFinite(at)||Date.now()-at>180000)C.fail('节点成本缓存已陈旧，请等待采集恢复',503);return rows;}
  async connection(node) {
    let p=this.connections.get(node.nodeId);if(p){await p.ready;return p;}
    const socket=net.connect(node.clientSocket);
    p=peer(socket,socket,{timeoutMs:11*60*1000,onClose:()=>{if(this.connections.get(node.nodeId)===p)this.connections.delete(node.nodeId);}});
    this.connections.set(node.nodeId,p);await p.ready;return p;
  }
  async call(node,operation,args,options={}) {
    return this.work(()=>this.performCall(node,operation,args,options));
  }
  work(action){
    if(this.closing)return Promise.reject(Object.assign(new Error('Owner bridge shutting down'),{status:503}));
    const promise=Promise.resolve().then(()=>{if(this.closing)C.fail('Owner bridge shutting down',503);return action();});this.pending.add(promise);
    promise.then(()=>this.pending.delete(promise),()=>this.pending.delete(promise));return promise;
  }
  async performCall(node,operation,args,{operationId,guard,metadataOnly=false}={}) {
    C.validateOperation(operation,args);const p=await this.connection(node);let identity={};
    if(C.writes.has(operation)) {
      const hash=C.digest({operation,args});
      if(!C.uuid(operationId))C.fail('X-Owner-Operation-Id required');
      identity={operationId,hash};
    }
    const send=()=>p.call(operation,args,identity);
    const result=await(guard?guard(send):send());
    if(operation==='object.read'||operation==='object.write')return result;
    C.fields(result,{status:v=>Number.isInteger(v)&&v>=100&&v<=599,headers:v=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.entries(v).every(([key,value])=>['content-type','content-security-policy','accept-ranges','content-disposition'].includes(key)&&typeof value==='string'&&value.length<=4096),object:v=>{C.descriptor(v);return true;}});
    C.descriptor(result.object);
    if(result.object.nodeId!==node.nodeId||!node.projects.includes(result.object.projectId)||(args.projectId&&result.object.projectId!==args.projectId))throw new Error('Object source mismatch');
    if(metadataOnly)return result;
    const chunks=[];let offset=0;
    while(offset<result.object.size){const chunk=await p.call('object.read',{object:result.object,offset,length:Math.min(C.MAX_CHUNK,result.object.size-offset)});
      if(C.canonical(chunk.object)!==C.canonical(result.object)||chunk.offset!==offset||typeof chunk.data!=='string')throw new Error('Object chunk mismatch');
      const bytes=Buffer.from(chunk.data,'base64');if(!bytes.length||bytes.length>Math.min(C.MAX_CHUNK,result.object.size-offset)||chunk.hash!==C.digest(bytes))throw new Error('Object chunk limit/integrity');chunks.push(bytes);offset+=bytes.length;
    }
    const body=Buffer.concat(chunks);if(body.length!==result.object.size||C.digest(body)!==result.object.hash)throw new Error('Object hash mismatch');
    return {...result,body};
  }
  async json(node,operation,args,options){const r=await this.call(node,operation,args,options);if(r.status>=400)C.fail('Node source unavailable',r.status);return JSON.parse(r.body.toString('utf8'));}
  async sync(){return this.work(()=>this.performSync());}
  async performSync(){
    if(this.syncing)return;this.syncing=true;
    try{for(const node of this.config.nodes){
      const saved=this.replica.state.nodes[node.nodeId];
      let args=saved?.stage?{cursor:0,batch:saved.stage.batch,offset:saved.stage.nextOffset}:{cursor:saved?.cursor||0},pages=0;
      do{let page;try{page=await this.json(node,'usage.changes',args);}catch(error){
        if(error.status===409&&args.batch){delete this.replica.state.nodes[node.nodeId].stage;atomic(this.replica.file,this.replica.state);args={cursor:0};continue;}
        break;
      }this.replica.apply(node.nodeId,page);
        args=page.full&&page.nextOffset!==null?{cursor:0,batch:page.batch,offset:page.nextOffset}:page.more?{cursor:page.cursor}:null;
      }while(args&&++pages<100);
    }}finally{this.syncing=false;}
  }
  close(){
    if(this.closePromise)return this.closePromise;
    this.closing=true;clearInterval(this.timer);
    for(const p of this.connections.values())p.close();
    this.closePromise=(async()=>{
      let timer;
      try{await Promise.race([Promise.allSettled([...this.pending]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owner bridge drain timed out; writer remains held')),5000);})]);}
      finally{clearTimeout(timer);}
      this.release();
    })();return this.closePromise;
  }
  respond(res,r){res.writeHead(r.status,{...r.headers,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-length':r.body.length});res.end(r.body);}
  async cloudWrite(id,identity,action){
    const hash=C.digest(identity),old=this.writes[id];
    if(old){if(old.hash!==hash)C.fail('Operation ID reused with different content',409);if(old.phase==='done')return {...old.result,body:Buffer.from(old.result.body,'base64')};if(this.activeWrites.has(id))return this.activeWrites.get(id);C.fail('Cloud write outcome unknown; reconciliation required',409);}
    this.writes[id]={hash,phase:'intent'};atomic(this.writeFile,this.writes);
    const pending=Promise.resolve().then(action).then(result=>{this.writes[id]={hash,phase:'done',result:{...result,body:result.body.toString('base64')}};atomic(this.writeFile,this.writes);return result;}).finally(()=>this.activeWrites.delete(id));
    this.activeWrites.set(id,pending);return pending;
  }
  async streamObject(node,result,req,res){
    const object=result.object,headers={...result.headers,'cache-control':'private, no-store','x-content-type-options':'nosniff'};
    let start=0,end=object.size-1,status=result.status;
    if(status===200&&headers['accept-ranges']==='bytes'&&req.headers.range!==undefined){
      const range=byteRange(req.headers.range,object.size);
      if(!range){res.writeHead(416,{...headers,'content-range':`bytes */${object.size}`,'content-length':0});res.end();return;}
      [start,end]=range;status=206;headers['content-range']=`bytes ${start}-${end}/${object.size}`;
    }
    headers['content-length']=Math.max(0,end-start+1);
    try{
      // One bounded chunk is retained, including for a full-file response.
      for(let offset=start;offset<=end;){
        if(res.destroyed||this.closing)throw new Error('Source transfer interrupted');
        const length=Math.min(C.MAX_CHUNK,end-offset+1),chunk=await this.call(node,'object.read',{object,offset,length});
        const bytes=Buffer.from(chunk.data,'base64');
        if(C.canonical(chunk.object)!==C.canonical(object)||chunk.offset!==offset||bytes.length!==length||chunk.hash!==C.digest(bytes))throw new Error('Source chunk mismatch');
        if(!res.headersSent)res.writeHead(status,headers);
        if(!res.write(bytes))await new Promise((resolve,reject)=>{const done=()=>{cleanup();resolve();},closed=()=>{cleanup();reject(new Error('Client disconnected'));},cleanup=()=>{res.off('drain',done);res.off('close',closed);};res.once('drain',done);res.once('close',closed);});
        offset+=length;
      }
      if(!res.headersSent)res.writeHead(status,headers);res.end();
    }catch(error){if(res.headersSent)res.destroy(error);else throw error;}
  }
  cacheRoot(projectId){const root=path.join(this.config.stateRoot,'source-cache',projectId);fs.mkdirSync(root,{recursive:true});return root;}
  saveFiles(projectId,files,missing=[]){const root=this.cacheRoot(projectId);for(const rel of missing){const dest=sources.inside(root,rel,true);try{fs.unlinkSync(dest);}catch(error){if(error.code!=='ENOENT')throw error;}}for(const[rel,text]of Object.entries(files)){
    const dest=sources.inside(root,rel,true);fs.mkdirSync(path.dirname(dest),{recursive:true});sources.inside(root,rel,true);
    // Only a bridge-owned cache root, never a cloud project/source checkout.
    const temp=dest+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,text);fs.renameSync(temp,dest);
  }return root;}
  async route(req,res,pathname,query,deps){
    return this.work(()=>this.performRoute(req,res,pathname,query,deps));
  }
  async performRoute(req,res,pathname,query,deps){
    const match=/^\/api\/(codex|reader|audition)(?:\/(.*))?$/.exec(pathname);
    if(!match&&pathname!=='/api/doc'&&pathname!=='/api/cost'&&!pathname.startsWith('/api/cost/')&&pathname!=='/api/sched/ci-jobs')return false;
    const group=match?.[1],action=match?.[2];let body={};
    if(req.method==='POST')body=await new Promise((resolve,reject)=>{
      const aborted=()=>reject(new Error('Owner request aborted'));req.once('aborted',aborted);
      deps.readBody(req,group==='reader'&&action==='import'?45*1024*1024:256*1024,(error,raw)=>{req.off('aborted',aborted);if(error)return reject(error);try{resolve(JSON.parse(raw||'{}'));}catch(e){reject(e);}});
      res.once('close',()=>{req.off('aborted',aborted);reject(new Error('Owner request closed'));});
    });
    if(req.method==='POST'&&!C.uuid(req.headers['x-owner-operation-id']))C.fail('X-Owner-Operation-Id required');
    const projectId=String(query.project||query.projectId||body.project||'');
    if(projectId==='all'&&pathname==='/api/cost'){await this.portfolio(res,query,deps);return true;}
    if(pathname==='/api/sched/ci-jobs'&&!projectId){
      const snapshots=await Promise.all(this.config.nodes.map(n=>this.json(n,'ci.snapshot',{projectId:n.projects[0]})));
      if(snapshots.some(s=>s.unavailable)){deps.sendJson(res,200,{unavailable:snapshots.find(s=>s.unavailable).unavailable});return true;}
      const machines=new Map(),queued=[],repositories=[];
      for(const s of snapshots){for(const m of s.machines){const jobs=machines.get(m.machine)||[];jobs.push(...m.jobs);machines.set(m.machine,jobs);}queued.push(...s.queued);repositories.push(...(s.repositories||[]));}
      deps.sendJson(res,200,{machines:[...machines].map(([machine,jobs])=>({machine,jobs})),queued,repositories,updatedAt:snapshots.map(s=>s.updatedAt).filter(Boolean).sort()[0]||null,staleSince:snapshots.map(s=>s.staleSince).find(Boolean)||null,...(snapshots.some(s=>s.error)?{error:'暂时读不到检查作业'}:{})});return true;
    }
    const node=this.node(projectId),p=deps.resolveProjectSafe(projectId);if(!p)C.fail('Unknown project',404);
    const options={operationId:req.headers['x-owner-operation-id'],...(req.method==='POST'?{guard:fn=>new Promise((resolve,reject)=>{deps.guard(req,()=>{try{resolve(fn());}catch(e){reject(e);}});if(res.headersSent)reject(new Error('Owner authorization revoked'));})}:{})};
    if(pathname==='/api/doc'){this.respond(res,await this.call(node,'project.doc.get',{projectId,relativePath:query.path}));return true;}
    if(pathname==='/api/sched/ci-jobs'){this.respond(res,await this.call(node,'ci.snapshot',{projectId}));return true;}
    if(pathname.startsWith('/api/cost')){
      if(pathname!=='/api/cost') {
        if(pathname==='/api/cost/session-detail'){
          await this.json(node,'usage.balance',{projectId});
          const detail=require('../core/costSessionDetail.cjs'),filters={};
          for(const k of ['fromDate','toDate','model','card','engine'])filters[k]=typeof query[k]==='string'?query[k]:'';
          const all=require('../core/ownerNodeUsage.cjs').claude(this.costRows(node.nodeId),projectId,bounded(query.days,365,30),deps.costCards(p),deps.costBindings(p)).sessionRows;
          const rows=detail.filterSessions(all,filters);deps.sendJson(res,200,{ok:true,rows,totals:detail.summarizeSessionRows(rows),options:detail.sessionFilterOptions(all),filters});return true;
        }
        const args={projectId,kind:pathname.endsWith('job-detail')?'jobs':'sessions'};
        for(const k of ['fromDate','toDate','model','card','engine'])if(query[k])args[k]=query[k];if(query.days)args.days=bounded(query.days,365,30);
        this.respond(res,await this.call(node,'usage.details',args));
      }else{
        const rows=this.costRows(node.nodeId),balance=await this.json(node,'usage.balance',{projectId});
        const value=view(rows,projectId,p.name||projectId,bounded(query.days,365,30),{cards:deps.costCards(p),bindings:deps.costBindings(p),balance});
        deps.sendJson(res,200,value);
      }return true;
    }
    if(group==='codex'){
      const names={jobs:'jobs.list',job:'jobs.get',task:'jobs.task',dispatch:'jobs.dispatch',say:'jobs.say',collect:'jobs.collect',sessions:'sessions.list',session:'sessions.get','say-session':'sessions.resume',quota:'sessions.quota',report:'sessions.report'};
      const operation=names[action];if(!operation)C.fail('Unknown owner operation',404);
      if(C.writes.has(operation)!==(req.method==='POST'))C.fail('Invalid method',405);
      const a={projectId};for(const k of ['slug','taskText','message','sessionId','sandboxMode'])if(body[k]!==undefined)a[k]=body[k];
      if(query.slug)a.slug=query.slug;if(query.id)a.sessionId=query.id;
      if(action==='job')a.tail=query.tail!=='0';
      if(action==='session')a.tail=bounded(query.tail,1000,200);
      if(action==='sessions'){a.limit=bounded(query.limit,500,50);a.days=bounded(query.days,365,30);}
      if(action==='report')a.days=Number(query.days)===7?7:1;
      this.respond(res,await this.call(node,operation,a,options));return true;
    }
    const key=String(query.key||body.key||'');
    if(action==='export'&&req.method==='POST'){
      const exported=await this.cloudWrite(options.operationId,{pathname,query,body},async()=>{
      if(!/^[A-Za-z0-9_-]{1,40}$/.test(key))C.fail('Invalid key');
      if(group==='audition')await this.json(node,'audition.sources.get',{projectId,kind:'batch',key});
      const file=path.join(deps.dataRoot,'data',group,projectId,key+'.json');
      const content=fs.readFileSync(file),object=C.descriptor({nodeId:node.nodeId,projectId,kind:group+'-export',hash:C.digest(content),size:content.length});
      for(let offset=0;offset<content.length;offset+=C.MAX_CHUNK){
        const digest=C.digest({id:options.operationId,object,offset});
        const chunkId=digest.slice(0,8)+'-'+digest.slice(8,12)+'-'+digest.slice(12,16)+'-'+digest.slice(16,20)+'-'+digest.slice(20,32);
        await this.call(node,'object.write',{object,offset,data:content.subarray(offset,offset+C.MAX_CHUNK).toString('base64')},{operationId:chunkId,guard:options.guard});
      }
      return this.call(node,group+'.annotations.export',{projectId,key,object,contentVersion:object.hash},options);
      });this.respond(res,exported);return true;
    }
    let root=this.cacheRoot(projectId),batch;
    if(group==='reader'&&!['import','import-original','import-delete','marks','review','annos'].includes(action)) {
      if(!key.startsWith('IMP-')){const remote=await this.json(node,'reader.sources.get',{projectId,kind:['report','export-review'].includes(action)?'report':'manifest',...(key?{key}:{})});root=this.saveFiles(projectId,remote.files,remote.missing);}
    }
    if(group==='reader'&&action==='annos'&&req.method==='POST'&&!key.startsWith('IMP-'))root=this.saveFiles(projectId,(await this.json(node,'reader.sources.get',{projectId,kind:'manifest'})).files);
    if(group==='audition'){
      if(action==='file'){
        const r=await this.call(node,'audition.sources.get',{projectId,kind:'file',relativePath:query.path},{metadataOnly:true});
        await this.streamObject(node,r,req,res);return true;
      }else if(action==='index')root=this.saveFiles(projectId,(await this.json(node,'audition.sources.get',{projectId,kind:'index'})).files);
      else if(action!=='state')batch=await this.json(node,'audition.sources.get',{projectId,kind:'batch',key});
    }
    const build=d=>(group==='reader'?createReaderApi:createAuditionApi)({...deps,...d,resolveProjectSafe:id=>id===projectId?{...p,docsRoot:root}:null,sourceBatch:batch?{key,value:batch}:null});
    const run=()=>invoke(build,action,req.method,query,body,req.headers);
    const r=req.method==='POST'?await this.cloudWrite(options.operationId,{pathname,query,body},()=>options.guard(run)):await run();this.respond(res,r);return true;
  }
  async portfolio(res,query,deps){
    const days=bounded(query.days,365,30),rows=[],all=[],seen=new Set(),names=new Set();
    for(const node of this.config.nodes){await this.json(node,'usage.balance',{projectId:node.projects[0]});const facts=this.costRows(node.nodeId);all.push(...facts);
      for(const id of node.projects){const p=deps.resolveProjectSafe(id);if(!p)continue;const v=view(facts,id,p.name||id,days),jobs=facts.find(r=>r.kind==='jobs'),repo=jobs?.projects?.[id],sharedCodeRepo=seen.has(repo);seen.add(repo);
        const duplicateName=names.has(p.name||id);names.add(p.name||id);
        rows.push({id,name:p.name||id,claudeTokens:v.combined.claudeTokens,claudeUsd:v.usage.usd.actual,claudeOutput:v.usage.claudeTotals.output,unpricedModels:v.usage.unpricedModels,sharedDirs:v.sharedDirs,codexTokens:duplicateName?0:v.codex.selected.tokens,codexBuckets:duplicateName?null:v.codex.selected.buckets,deepseekRmb:sharedCodeRepo?0:v.deepseek.totals.costRmb,deepseekJobs:sharedCodeRepo?0:v.deepseek.totals.jobs,glm:sharedCodeRepo?null:v.glm.totals,sharedCodeRepo,duplicateName});
      }
    }
    const u=require('../core/ownerNodeUsage.cjs'),claude=u.claude(all,null,days),codex=u.codex(all,days,'');
    deps.sendJson(res,200,{ok:true,scope:'all',days,rows,totals:{claudeTokens:require('../core/costUsage.cjs').totalClaudeTokens(claude),claudeUsd:claude.usd.actual,claudeOutput:claude.claudeTotals.output,unpricedModels:claude.unpricedModels,codexTokens:codex.totals.tokens,codexBuckets:codex.totals.buckets,codexBucketedTokens:codex.totals.bucketedTokens,deepseekRmb:rows.reduce((n,r)=>n+r.deepseekRmb,0),glmCredits:rows.reduce((n,r)=>n+(r.glm?.credits||0),0),glmCreditJobs:rows.reduce((n,r)=>n+(r.glm?.creditJobs||0),0),glmUncertainCredits:rows.reduce((n,r)=>n+(r.glm?.uncertainCredits||0),0),glmTokens:rows.reduce((n,r)=>n+(r.glm?.tokens||0),0)},unassignedCodexTokens:codex.byProject.filter(r=>!rows.some(p=>p.name===r.project)).reduce((n,r)=>n+r.tokens,0)});
  }
}
function bounded(value,max,fallback){return Math.max(1,Math.min(max,parseInt(value,10)||fallback));}
function fromEnvironment({collaboration}){const file=process.env.DASHBOARD_OWNER_NODE_CONFIG;if(!file)return null;if(!collaboration)throw new Error('Owner bridge requires collaboration authentication');return new Bridge(loadConfig(file,'cloud'));}
module.exports={Bridge,fromEnvironment};
