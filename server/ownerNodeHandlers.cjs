'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const C=require('../core/ownerNodeContract.cjs');
const {Journal,Objects,read}=require('../core/ownerNodeStore.cjs');
const sources=require('../core/ownerNodeSources.cjs');
const {invoke}=require('./ownerNodeInvoke.cjs');
const {createCodexApi}=require('./codexApi.cjs');
const {createAuditionApi}=require('./auditionApi.cjs');
const {hookInstalledFor}=require('../core/hookProbe.cjs');
const {identity,matches}=require('../core/ownerNodeProcess.cjs');
const {createCiJobsMonitor}=require('../core/schedCiJobs.cjs');
function handlers(config,{usage,launch=spawn}={}) {
  const journal=new Journal(config.stateRoot),objects=new Objects(config.stateRoot,config.nodeId),ci=new Map(),activeDispatches=new Set();
  const project=id=>{if(!Object.hasOwn(config.projects,id))C.fail('Unknown node project',404);return config.projects[id];};
  const health=(repo,jobs)=>jobs.map(job=>{
    if(!job.running)return {...job,confirmedDead:false,nodeId:config.nodeId};
    const state=read(path.join(repo,'.codex','jobs',job.slug,'state.json'),null);
    const live=state?.processIdentity&&matches(state.processIdentity,identity(state.pid));
    return {...job,confirmedDead:false,...(!live&&job.running?{liveness:'stalled',stalledReason:'本机进程身份或整树退出尚未确认'}:{}),nodeId:config.nodeId};
  });
  function launchChild(request) {
    const child=launch(process.execPath,[path.resolve(__dirname,'../packages/owner-node/launch.cjs'),config.configFile],{stdio:['pipe','pipe','pipe','ipc'],detached:request.operation==='dispatch.launch',windowsHide:true,shell:false});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request));return child;
  }
  const json=value=>({status:200,headers:{'content-type':'application/json; charset=utf-8'},body:Buffer.from(JSON.stringify(value))});
  async function execute(request) {
    const a=request.args,op=request.operation;
    if(op==='object.read') {project(a.object.projectId);return objects.chunk(a);}
    if(op==='object.write') {project(a.object.projectId);return objects.write(a);}
    let result;
    if(op==='usage.changes')result=json(usage.facts.changes(a));
    else {
      const p=project(a.projectId);
      if(op.startsWith('jobs.')||op.startsWith('sessions.')) {
        const actions={'jobs.list':'jobs','jobs.get':'job','jobs.task':'task','jobs.dispatch':'dispatch','jobs.say':'say','jobs.collect':'collect','sessions.list':'sessions','sessions.get':'session','sessions.resume':'say-session','sessions.quota':'quota','sessions.report':'report'};
        const query={project:a.projectId,...a,...(a.sessionId?{id:a.sessionId}:{}),...(typeof a.tail==='boolean'?{tail:a.tail?'1':'0'}:{})};
        if(op==='jobs.dispatch') {
          const previous=read(path.join(p.codeRepo,'.codex','jobs',a.slug,'state.json'),null);
          if(previous&&previous.treeExited!==true)C.fail('Process tree exit unconfirmed',409);
        }
        const spawnJob=(repo,args,options)=>{
          if(!config.dashboardRemoteConfig||process.env.DASHBOARD_REMOTE_CONFIG!==config.dashboardRemoteConfig||!require('../cli/remoteConfig.cjs').binding(a.projectId))throw new Error('Cloud authority binding required');
          return require('./codexProcess.cjs').spawnDispatchCli(repo,args,options);
        };
        result=await invoke(deps=>createCodexApi({...deps,activeDispatches,confirmDispatch:true,spawnJob,resolveRepo:id=>project(id).codeRepo,readRegistry:()=>({projects:Object.fromEntries(Object.entries(config.projects).map(([id,p])=>[id,{...p,mainRepo:p.codeRepo}]))}),dashboardRoot:path.resolve(__dirname,'..'),sessionsRoot:config.sessionsRoot,registryPath:usage.registryPath,jobHealth:jobs=>health(p.codeRepo,jobs),spawnResume:()=>launchChild(request)}),actions[op],C.writes.has(op)?'POST':'GET',query,a);
        if(C.writes.has(op)&&result.status>=400)throw Object.assign(new Error('Launch result unconfirmed'),{status:409});
      } else if(op==='dispatch.launch') {
        const child=launchChild(request);
        result=await new Promise((resolve,reject)=>{
          child.stdout.resume();child.stderr.resume();
          child.once('message',message=>{if(message?.started===true&&Number.isSafeInteger(message.pid)&&typeof message.ticket==='string')resolve(json({ok:true,pid:message.pid,ticket:message.ticket}));});
          child.once('error',reject);child.once('close',()=>reject(new Error('Launch outcome unconfirmed')));
        });
      } else if(op==='project.doc.get')result={status:200,headers:{'content-type':'text/plain; charset=utf-8'},body:sources.bytes(p.docsRoot,a.relativePath)};
      else if(op==='reader.sources.get')result=json(sources.reader(p.docsRoot,a));
      else if(op==='audition.sources.get') {
        result=await invoke(deps=>createAuditionApi({...deps,resolveProjectSafe:()=>p,dataRoot:config.stateRoot}),a.kind,'GET',{project:a.projectId,key:a.key,path:a.relativePath},null);
        if(a.kind==='index'&&result.status===200) {const data=JSON.parse(result.body);result=json({files:{[sources.INDEX]:JSON.stringify(data.index)}});}
      } else if(op.endsWith('.annotations.export')) {
        if(a.object.projectId!==a.projectId||a.object.kind!==op.split('.')[0]+'-export'||a.object.hash!==a.contentVersion)C.fail('Export binding mismatch',403);
        result=json(sources.exportAnnotations(p.docsRoot,op.split('.')[0],{...a,content:objects.content(a.object).toString('utf8')}));
      }
      else if(op==='project.facts')result=json({hookInstalled:hookInstalledFor(p.codeRepo,a.projectId),repositoryConfigured:!!p.githubRepo});
      else if(op==='ci.snapshot') {
        const repositories=[...new Set(Object.values(config.projects).map(p=>p.githubRepo).filter(Boolean))];
        if(!repositories.length)C.fail('GitHub repository not configured',503);
        let monitor=ci.get('all');
        if(!monitor){monitor=createCiJobsMonitor({now:Date.now,readBoards:async()=>[],readRunnerMachines:async()=>new Map(),runnerOverrides:'{}',repositoryOverrides:repositories.join(',')});ci.set('all',monitor);}
        if(!monitor.ownerSampleAt||Date.now()-monitor.ownerSampleAt>=60000){monitor.ownerSampleAt=Date.now();await monitor.refresh();}result=json(monitor.snapshot());
      } else if(op==='usage.balance')result=json(usage.balance || {available:false,reason:'节点余额快照尚未采集',balance:null,sampledAt:null});
      else if(op==='usage.details') {
        const detail=a.kind==='jobs'?require('../core/costJobDetail.cjs'):require('../core/costSessionDetail.cjs');
        const filters={fromDate:a.fromDate||'',toDate:a.toDate||'',model:a.model||'',card:a.card||'',engine:a.engine||''};
        if(a.kind==='jobs') {
          const all=await detail.collectJobRows(path.join(p.codeRepo,'.codex','jobs')),rows=detail.filterJobRows(all,filters);
          result=json({ok:true,rows:rows.map(row=>({...row,costRmb:detail.jobCostRmb(row)})),totals:detail.summarizeJobRows(rows),options:detail.jobFilterOptions(all),filters});
        } else {
          const all=require('../core/ownerNodeUsage.cjs').claude(Object.values(usage.facts.state.rows).map(r=>r.data),a.projectId,a.days||30).sessionRows;
          const rows=detail.filterSessions(all,filters);result=json({ok:true,rows,totals:detail.summarizeSessionRows(rows),options:detail.sessionFilterOptions(all),filters});
        }
      } else throw new Error('Fixed operation handler missing');
    }
    const headers={};
    for(const key of ['content-type','content-security-policy','accept-ranges','content-disposition'])if(result.headers[key])headers[key]=result.headers[key];
    return {status:result.status,headers,object:objects.put(a.projectId||Object.keys(config.projects)[0],op.replace(/\./g,'-'),result.body)};
  }
  const pending=new Set();let closing=false;
  return {handle:request=>{
    if(closing)return Promise.reject(new Error('Node is shutting down'));
    const result=journal.run(request,()=>execute(request));pending.add(result);result.then(()=>pending.delete(result),()=>pending.delete(result));return result;
  },close:async()=>{closing=true;await Promise.allSettled([...pending]);},journal,objects};
}
module.exports={handlers};
