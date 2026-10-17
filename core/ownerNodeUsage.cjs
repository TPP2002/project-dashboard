'use strict';
const fs = require('node:fs');
const path = require('node:path');
const C = require('./ownerNodeContract.cjs');
const { atomic,read } = require('./ownerNodeStore.cjs');
const usage = require('./costUsage.cjs');
const sessions = require('../server/codexSessions.cjs');
const { parseSessionIdFromFilename } = require('../server/codexSessionData.cjs');
const { aggregateCodexUsage } = require('../server/codexMetrics.cjs');
const glm = require('./glmCostUsage.cjs');
const deepseek = require('./deepseekCostUsage.cjs');
class Facts {
  constructor(file,nodeId) { this.file=file; this.nodeId=nodeId; this.state=read(file,{cursor:0,rows:{},log:[]}); }
  replace(id,sourceVersion,data) {
    if(this.state.rows[id]?.sourceVersion===sourceVersion) return;
    const fact={nodeId:this.nodeId,id,sourceVersion,data,cursor:++this.state.cursor};
    if(data===null) delete this.state.rows[id]; else this.state.rows[id]=fact;
    this.state.log.push(fact); this.state.log=this.state.log.slice(-2000); atomic(this.file,this.state);
  }
  changes({cursor,limit=40,batch,offset=0}) {
    limit=Math.max(1,Math.min(100,limit));
    if(batch) {
      const snapshot=read(this.file+'.batch',null);
      if(!snapshot || snapshot.batch!==batch) C.fail('Reconciliation batch expired',409);
      return {...snapshot,rows:snapshot.rows.slice(offset,offset+limit),nextOffset:offset+limit<snapshot.rows.length?offset+limit:null};
    }
    if(cursor>this.state.cursor || cursor===0 || cursor<(this.state.log[0]?.cursor||1)-1) {
      const snapshot={batch:C.digest({node:this.nodeId,cursor:this.state.cursor}),cursor:this.state.cursor,full:true,rows:Object.values(this.state.rows)};
      atomic(this.file+'.batch',snapshot);
      return {...snapshot,rows:snapshot.rows.slice(0,limit),nextOffset:limit<snapshot.rows.length?limit:null};
    }
    const rows=this.state.log.filter(r=>r.cursor>cursor).slice(0,limit);
    return {full:false,rows,cursor:rows.at(-1)?.cursor||cursor,more:(rows.at(-1)?.cursor||cursor)<this.state.cursor};
  }
}
function files(dir) { try{return fs.readdirSync(dir,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return [];throw error;} }
function stat(file) {const s=fs.statSync(file);return {path:file,size:s.size,mtimeMs:s.mtimeMs};}
function numericFields(value,keys){return Object.fromEntries(keys.filter(k=>typeof value?.[k]==='number').map(k=>[k,value[k]]));}
function safeGlm(job){const cost=job.cost;return {...job,cost:{usage:numericFields(cost.usage,['input','output','cacheRead','cacheWrite']),resumeUsage:numericFields(cost.resumeUsage,['input','output','cacheRead','cacheWrite']),resumeRounds:typeof cost.resumeRounds==='number'?cost.resumeRounds:0,glmQuota:numericFields(cost.glmQuota,['weeklyDelta']),attribution:{attributable:cost.attribution?.attributable===true}}};}
function safeDeepseek(job){return {...job,usage:{...numericFields(job.usage,['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens']),cache_creation:numericFields(job.usage.cache_creation,['ephemeral_5m_input_tokens','ephemeral_1h_input_tokens'])}};}
function collector(config) {
  const facts=new Facts(path.join(config.stateRoot,'usage-facts.json'),config.nodeId);
  const indexFile=path.join(config.stateRoot,'usage-index.json'); let index=read(indexFile,{}),running=null;
  const registryPath=path.join(config.stateRoot,'node-projects.json');
  // Private node-only derived registry. Never change the dashboard's cloud registry.
  atomic(registryPath,{projects:Object.fromEntries(Object.entries(config.projects).map(([id,p])=>[id,{...p,mainRepo:p.codeRepo,board:path.join(config.stateRoot,'boards',id,'board.json')}]))});
  async function scan() {
    const next={},seen=new Set(); const projects=Object.fromEntries(Object.entries(config.projects).map(([id,p])=>[id,{...p,mainRepo:p.codeRepo}]));
    async function changed(id,entries,load) {
      seen.add(id);const version=C.digest(entries);next[id]=version;
      if(index[id]!==version) facts.replace(id,version,await load());
    }
    const root=config.claudeProjectsRoot;
    if(root) for(const dir of files(root).filter(e=>e.isDirectory())) {
      const owners=Object.entries(projects).filter(([id,p])=>usage.selectProjectDirs([dir.name],{prefixes:p.costRoots.map(usage.mapRepoToPrefix),otherPrefixes:Object.entries(projects).filter(([other])=>other!==id).flatMap(([,other])=>other.costRoots.map(usage.mapRepoToPrefix))}).dirs.length).map(([id])=>id);
      if(!owners.length) continue;
      for(const f of files(path.join(root,dir.name)).filter(e=>e.isFile()&&e.name.endsWith('.jsonl'))) {
        const full=path.join(root,dir.name,f.name), entries=usage.groupStatEntries(full);
        if(!entries) throw new Error('Cost source unavailable');
        await changed('claude-'+C.digest(full),{entries,owners},async()=>({kind:'claude',owners,dir:dir.name,group:await usage.scanGroup(entries)}));
      }
    }
    const changedSessions=[];
    if(config.sessionsRoot) for(const file of sessions.listSessionFiles(config.sessionsRoot,{days:366})) {
      const sessionId=parseSessionIdFromFilename(path.basename(file)); if(!sessionId)continue;
      const id='codex-'+sessionId,version=C.digest(stat(file));seen.add(id);next[id]=version;
      if(index[id]!==version)changedSessions.push({file,sessionId,id,version});
    }
    let quota=facts.state.rows.quota?.data.value;
    const quotaInputs=C.digest(Object.entries(next).filter(([id])=>id.startsWith('codex-')));next['quota-inputs']=quotaInputs;seen.add('quota-inputs');
    if(changedSessions.length||quota===undefined||index['quota-inputs']!==quotaInputs){
      // Bound each worker lifetime; do not transfer transcripts to the cloud.
      for(let offset=0;offset<Math.max(1,changedSessions.length);offset+=64){
        const batch=changedSessions.slice(offset,offset+64),parsed=await require('./ownerNodeSessionParser.cjs').parse(batch,{sessionsRoot:config.sessionsRoot,projects,dashboardRoot:path.resolve(__dirname,'..'),includeQuota:offset===0});
        for(const item of batch)facts.replace(item.id,item.version,parsed.result[item.sessionId]);if(parsed.quota!==undefined)quota=parsed.quota;
      }
    }
    // GLM/DeepSeek parsers are reused; a job-group fingerprint prevents re-reading
    // their transcripts when none of task/meta/cost/exec/resume inputs changed.
    const entries=[];
    for(const repo of new Set(Object.values(projects).map(p=>p.codeRepo))) {
      const jobs=path.join(repo,'.codex','jobs');
      for(const dir of files(jobs).filter(e=>e.isDirectory())) for(const f of files(path.join(jobs,dir.name)).filter(e=>e.isFile()&&/\.(json|jsonl)$/.test(e.name))) entries.push(stat(path.join(jobs,dir.name,f.name)));
    }
    await changed('job-costs',{entries,projects},async()=>({kind:'jobs',projects:Object.fromEntries(Object.entries(projects).map(([id,p])=>[id,fs.realpathSync.native(p.codeRepo)])),glm:glm.scanGlmJobs({registryPath}).map(safeGlm),deepseek:Object.fromEntries(await Promise.all(Object.entries(projects).map(async([id,p])=>[id,(await deepseek.scanDeepseekJobs({registryPath,currentCodeRepo:p.codeRepo})).map(safeDeepseek)])))}));
    for(const id of Object.keys(index)) if(!seen.has(id)) facts.replace(id,C.digest('deleted:'+index[id]),null);
    index=next;atomic(indexFile,index);
    facts.replace('quota',C.digest(quota),{kind:'quota',value:quota});
    facts.replace('projects',C.digest(projects),{kind:'projects',roots:Object.fromEntries(Object.entries(projects).map(([id,p])=>[id,p.costRoots]))});
    facts.replace('sample',C.digest(String(Date.now())),{kind:'sample',at:new Date().toISOString()});
  }
  return {facts,registryPath,scan:()=>running||(running=scan().finally(()=>{running=null;}))};
}
class Replica {
  constructor(file) {this.file=file;this.state=read(file,{nodes:{}});}
  apply(nodeId,page) {
    const node=this.state.nodes[nodeId]||{cursor:0,rows:{}};
    if(page.full) {
      if(!node.stage||node.stage.batch!==page.batch)node.stage={batch:page.batch,rows:{}};
      for(const row of page.rows) {if(row.nodeId!==nodeId)throw new Error('Fact source mismatch');node.stage.rows[row.id]=row;}
      node.stage.nextOffset=page.nextOffset;
      if(page.nextOffset===null) {node.rows=node.stage.rows;node.cursor=page.cursor;delete node.stage;}
    } else {
      for(const row of page.rows) {
        if(row.nodeId!==nodeId)throw new Error('Fact source mismatch');
        if(row.cursor<=node.cursor)continue;
        if(row.data===null)delete node.rows[row.id];else node.rows[row.id]=row;
      }
      node.cursor=Math.max(node.cursor,page.cursor);
    }
    this.state.nodes[nodeId]=node;atomic(this.file,this.state);
  }
  rows(nodeId) {const n=this.state.nodes[nodeId];if(!n||!Object.keys(n.rows).length)C.fail('Cost snapshot unavailable',503);return Object.values(n.rows).map(r=>r.data);}
}
function claude(rows,projectId,days,cards=[],bindings=null) {
  const totalDays={},sessionAcc=new Map(),dirs=new Set(),sharedDirs=[];let count=0;
  for(const row of rows) if(row.kind==='claude'&&(!projectId||row.owners.includes(projectId))) {
    usage.mergeDays(totalDays,row.group.days);usage.mergeSessionFiles(sessionAcc,row.group.sessionDays);count+=row.group.sessions;dirs.add(row.dir);
    if(row.owners.length>1)sharedDirs.push(row.dir);
  }
  return usage.summarizeGroups({totalDays,sessionAcc,days,cards,bindings,dirNames:[...dirs],sharedDirs,sessions:count});
}
function codex(rows,days,name) {return aggregateCodexUsage(rows.filter(r=>r.kind==='codex').map(r=>r.summary),{days,nowMs:Date.now(),projectName:name});}
module.exports={Facts,Replica,collector,claude,codex};
