'use strict';
// A fixed, supervised child of the node. Input is supplied by the semantic handler,
// never a user-specified program/argv. No HTTP server or network listener.
const path=require('node:path');
const fs=require('node:fs');
const {loadConfig}=require('../../core/ownerNodeConfig.cjs');
const scheduler=require('../../scripts/codex/codex-scheduler.cjs');
const {findCodexExecutable,buildSessionResumeArgs}=require('../../server/codexProcess.cjs');
async function main() {
  const config=loadConfig(process.argv[2],'node');let raw='';
  process.stdin.setEncoding('utf8');
  for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>256*1024)throw new Error('Input limit');}
  const request=JSON.parse(raw),C=require('../../core/ownerNodeContract.cjs');C.request(request);
  const a=request.args,p=config.projects[a.projectId];if(!p)throw new Error('Unknown project');
  if(!['dispatch.launch','sessions.resume'].includes(request.operation))throw new Error('Invalid launch operation');
  if(!config.schedulerConfig)throw new Error('Scheduler configuration required');
  process.env.DASHBOARD_WORKER_SCHED_CONFIG=config.schedulerConfig;
  if(!config.dashboardRemoteConfig)throw new Error('Cloud authority binding required');
  process.env.DASHBOARD_REMOTE_CONFIG=config.dashboardRemoteConfig;
  if(!require('../../cli/remoteConfig.cjs').binding(a.projectId))throw new Error('Project authority binding missing');
  const resume=request.operation==='sessions.resume';
  const executable=resume?findCodexExecutable():config.launcher;
  if(!executable)throw new Error('Configured executable unavailable');
  const detail=resume?require('../../server/codexSessions.cjs').getSessionDetail(a.sessionId,{sessionsRoot:config.sessionsRoot,projects:config.projects,tail:1}):null;
  if(resume&&!detail)throw new Error('Session unavailable');
  const cwd=resume&&detail.cwd&&fs.existsSync(detail.cwd)?detail.cwd:p.codeRepo;
  const cli='node "'+path.resolve(__dirname,'../../cli/index.cjs').replace(/\\/g,'/')+'"';
  const text=resume?'':a.text.split('{{OWNER_NODE_CLI}}').join(cli);
  const argv=resume?buildSessionResumeArgs(a.sessionId,a.message,a.sandboxMode):[text];
  const r=await scheduler.registeredWorker({file:path.join(config.stateRoot,'launches',request.operationId+'.json'),cwd,title:resume?'会话续聊':'看板派单',targets:['.'],executable,argv,onStarted:identity=>process.send?.({started:true,...identity}),options:{encoding:'utf8',maxBuffer:1024*1024,timeout:10*60*1000}});
  if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);
  process.exitCode=r.error||r.status===null?1:r.status;
  process.disconnect?.();
}
if(require.main===module)main().catch(()=>{process.stderr.write('Launch failed or unconfirmed; inspect node recovery state\n');process.exitCode=1;});
