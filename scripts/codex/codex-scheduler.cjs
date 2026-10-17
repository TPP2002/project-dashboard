'use strict';
// Public dispatcher adapter. No private repository, implicit shared drive, or outer exec.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { randomUUID } = require('node:crypto');
const { atomic, read } = require('../../core/ownerNodeStore.cjs');
function config(env = process.env) {
  const file = env.DASHBOARD_WORKER_SCHED_CONFIG;
  if (!file || !path.isAbsolute(file)) throw new Error('DASHBOARD_WORKER_SCHED_CONFIG must name protected scheduler configuration');
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || (process.platform !== 'win32' && (st.mode & 0o022))) throw new Error('Unsafe scheduler configuration');
  const c = JSON.parse(fs.readFileSync(file,'utf8'));
  if (Object.keys(c).some(k => !['cli','project','share','clientConfig'].includes(k)) || !path.isAbsolute(c.cli || '') || !/^[A-Za-z0-9_.-]+$/.test(c.project || '') || Boolean(c.share) === Boolean(c.clientConfig)) throw new Error('Invalid scheduler configuration');
  if (!path.isAbsolute(c.share || c.clientConfig)) throw new Error('Scheduler endpoint must be explicitly configured');
  return c;
}
function client(c, run = spawnSync) {
  const env = { ...process.env, ...(c.clientConfig ? { SCHED_CONFIG:c.clientConfig } : {}) };
  const call = (args,cwd,timeout=40000) => run(process.execPath,[c.cli,...(c.share ? ['--share',c.share] : []),...args],{cwd,env,encoding:'utf8',windowsHide:true,shell:false,timeout,maxBuffer:1024*1024});
  function json(args,cwd) {
    const r=call(args,cwd);
    if (r.error || r.status !== 0) throw new Error('Scheduler rejected/unavailable; no worker launched');
    let body;
    for (const line of String(r.stdout).trim().split(/\r?\n/).reverse()) { try { body=JSON.parse(line); break; } catch {} }
    if (!body) throw new Error('Scheduler receipt missing');
    return body;
  }
  return {
    register({key,title,cwd,codeRef,targets}) {
      const r=json(['submit','--project',c.project,'--submitter','codex-dispatch','--key',key,'--category','codex-build','--cores','0','--title',title,'--work-type','build','--targets',targets.join(','),'--code-ref',codeRef,'--engine','codex','--receipt-timeout','30'],cwd);
      if (r.status !== 'accepted' || !/^tk-[a-f0-9]{20}$/.test(r.ticketId || '')) throw new Error('Worker registration not accepted');
      return r.ticketId;
    },
    permit(ticket,cwd) {
      const r=json(['status',ticket],cwd);
      if (r.ticketId !== ticket || r.cancelRequested || r.state !== 'running') throw new Error('Worker permission not confirmed');
      return r;
    },
    finish(ticket,cwd,passed) { const r=json(['finish',ticket,'--result',passed?'passed':'failed','--reason','worker exited','--receipt-timeout','5'],cwd); if(r.status!=='executed') throw new Error('Worker finish unconfirmed'); },
    cancel(ticket,cwd) { const r=json(['cancel',ticket,'--reason','worker cancelled or startup failed','--receipt-timeout','5'],cwd); if(r.status!=='executed') throw new Error('Worker cancellation unconfirmed'); },
    exec({cwd,title,target,argv,category='other',workType='build'}) {
      return call(['exec','--project',c.project,'--cores','1','--title',title,'--category',category,'--work-type',workType,'--targets',target,'--',...argv],cwd,30*60*1000);
    },
  };
}
const keyFor = value => 'owner-' + createHash('sha256').update(value).digest('hex').slice(0,40);
function registeredRun({ file, cwd, title, targets, executable, argv, options }, deps = {}) {
  if(!deps.scheduler&&!deps.launch){
    // Preserve the public synchronous say API while a separate supervisor observes
    // permissions, identity and exit. The worker is never wrapped in sched exec.
    const run=spawnSync(process.execPath,[__filename,'registered-worker'],{input:JSON.stringify({file,cwd,title,targets,executable,argv,options}),encoding:'utf8',shell:false,windowsHide:true,maxBuffer:(options?.maxBuffer||1024*1024)*3,env:process.env});
    if(run.error||run.status!==0)return {status:null,error:run.error||new Error('Registered supervisor outcome unconfirmed'),stdout:'',stderr:''};
    const result=JSON.parse(run.stdout);if(result.error)result.error=new Error(result.error);return result;
  }
  const sched = deps.scheduler || client(config());
  const launch = deps.launch || spawnSync;
  const previous = read(file, null);
  if (previous && previous.phase !== 'done') throw new Error('Previous launch outcome unknown; reconcile before retry');
  const key = keyFor(randomUUID());
  const row = { key, phase:'registering' }; atomic(file,row);
  const ticket = sched.register({ key,title,cwd,codeRef:'content:auto',targets });
  row.ticket = ticket; row.phase='intent'; atomic(file,row);
  try { sched.permit(ticket,cwd); } catch (error) { sched.cancel(ticket,cwd); throw error; }
  row.phase='launch-unknown'; atomic(file,row);
  let result;
  try { result=launch(executable,argv,{...options,cwd,shell:false,windowsHide:true}); }
  catch (error) { try { sched.cancel(ticket,cwd); } catch {} throw error; }
  if (result.error || result.status === null) { try { sched.cancel(ticket,cwd); } catch {} return result; }
  row.phase='exited'; row.exitCode=result.status; atomic(file,row);
  sched.finish(ticket,cwd,result.status === 0);
  row.phase='done'; atomic(file,row); return result;
}
async function registeredWorker(spec, deps = {}) {
  const sched=deps.scheduler||client(config()),launch=deps.launch||spawn;
  const previous=read(spec.file,null);
  if(previous&&previous.phase!=='done')throw new Error('Previous worker outcome unknown; reconcile before retry');
  const row={key:keyFor(randomUUID()),phase:'registering'};atomic(spec.file,row);
  const ticket=sched.register({key:row.key,title:spec.title,cwd:spec.cwd,codeRef:'content:auto',targets:spec.targets});
  row.ticket=ticket;row.phase='intent';atomic(spec.file,row);
  try{sched.permit(ticket,spec.cwd);}catch(error){sched.cancel(ticket,spec.cwd);throw error;}
  row.phase='launch-unknown';atomic(spec.file,row);
  let child;
  try{child=launch(spec.executable,spec.argv,{cwd:spec.cwd,env:spec.options?.env||process.env,stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true});}
  catch(error){try{sched.cancel(ticket,spec.cwd);}catch{}throw error;}
  const processProbe=require('../../core/ownerNodeProcess.cjs');
  let stdout='',stderr='',uncertain=false,observed;
  const limit=spec.options?.maxBuffer||1024*1024;
  const stop=()=>{
    uncertain=true;
    try{sched.cancel(ticket,spec.cwd);}catch{}
    if(child.exitCode!==null)return;
    if(process.platform==='win32'){
      if(processProbe.matches(observed,processProbe.identity(child.pid)))spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:10000,stdio:'ignore'});
    }else child.kill('SIGTERM');
  };
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{if(Buffer.byteLength(stdout)+Buffer.byteLength(chunk)>limit)stop();else stdout+=chunk;});
  child.stderr.on('data',chunk=>{if(Buffer.byteLength(stderr)+Buffer.byteLength(chunk)>limit)stop();else stderr+=chunk;});
  child.once('spawn',()=>{
    observed=processProbe.identity(child.pid);row.pid=child.pid;row.identity=observed;row.phase='started';atomic(spec.file,row);spec.onStarted?.({pid:child.pid,ticket});
  });
  const timer=setTimeout(stop,spec.options?.timeout||10*60*1000);
  const poll=setInterval(()=>{try{sched.permit(ticket,spec.cwd);}catch{stop();}},10000);
  const result=await new Promise(resolve=>{
    child.once('error',error=>resolve({status:null,error,stdout,stderr}));
    child.once('close',status=>resolve({status,stdout,stderr}));
  });clearTimeout(timer);clearInterval(poll);
  row.exitCode=result.status;row.phase=uncertain||result.status===null?'unknown':'exited';atomic(spec.file,row);
  if(uncertain||result.status===null){try{sched.cancel(ticket,spec.cwd);}catch{}return {...result,error:result.error||new Error('Worker tree/outcome unconfirmed')};}
  sched.finish(ticket,spec.cwd,result.status===0);row.phase='done';atomic(spec.file,row);return result;
}
module.exports = { config,client,keyFor,registeredRun,registeredWorker };
if(require.main===module){
  process.stdin.setEncoding('utf8');
  (async()=>{if(process.argv[2]!=='registered-worker')throw new Error('Invalid fixed supervisor mode');let input='';for await(const b of process.stdin){input+=b;if(Buffer.byteLength(input)>512*1024)throw new Error('Supervisor input limit');}const result=await registeredWorker(JSON.parse(input));process.stdout.write(JSON.stringify({...result,error:result.error?.message}));})().catch(()=>{process.stderr.write('Registered supervisor failed; reconcile launch state\n');process.exitCode=1;});
}
