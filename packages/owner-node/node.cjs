'use strict';
const {spawn}=require('node:child_process');
const {peer}=require('../../core/ownerNodeTransport.cjs');
const {loadConfig}=require('../../core/ownerNodeConfig.cjs');
const {exclusive}=require('../../core/ownerNodeStore.cjs');
const {collector}=require('../../core/ownerNodeUsage.cjs');
const {handlers}=require('../../server/ownerNodeHandlers.cjs');
function attach(config,input,output,deps={}) {const service=deps.service||handlers(config,deps);return peer(input,output,{handler:service.handle,timeoutMs:11*60*1000});}
async function main(file,stdio=false) {
  const config=loadConfig(file,'node'); config.configFile=file;
  const release=exclusive(config.stateRoot);
  if(config.schedulerConfig)process.env.DASHBOARD_WORKER_SCHED_CONFIG=config.schedulerConfig;
  if(config.dashboardRemoteConfig)process.env.DASHBOARD_REMOTE_CONFIG=config.dashboardRemoteConfig;
  const usage=collector(config),service=handlers(config,{usage});let sampling=null;
  function sample(){if(sampling)return sampling;sampling=(async()=>{try{await usage.scan();if(config.balance==='windows-key'&&process.platform==='win32')usage.balance=await require('../../core/deepseekBalance.cjs').fetchDeepseekBalance();}catch{process.stderr.write('Owner cost collection unavailable; retaining prior facts\n');}})().finally(()=>{sampling=null;});return sampling;}
  await sample();const timer=setInterval(sample,60000);timer.unref();
  let current,ssh,stopping=false,retry;
  function connect(){
    const s=config.ssh;if(!s)throw new Error('Protected SSH configuration required');
    ssh=spawn(s.executable,['-T','-o','BatchMode=yes','-o','ForwardAgent=no','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+s.knownHosts,'-o','IdentitiesOnly=yes','-o','ClearAllForwardings=yes','-i',s.identityFile,s.host],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
    ssh.stderr.on('data',()=>{}); // SSH diagnostics may contain private host/key paths.
    current=attach(config,ssh.stdout,ssh.stdin,{usage,service});
    ssh.once('error',()=>{process.stderr.write('Owner SSH connection unavailable\n');});
    ssh.once('close',()=>{current.close();if(!stopping)retry=setTimeout(connect,5000);});
  }
  if(stdio)current=attach(config,process.stdin,process.stdout,{usage,service});else connect();
  let closing;
  const close=()=>closing||(closing=(async()=>{stopping=true;clearTimeout(retry);clearInterval(timer);current?.close();ssh?.kill();let timeout;try{await Promise.race([Promise.allSettled([sampling,service.close()]),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Node drain unknown; retain writer generation')),5000);})]);release();}finally{clearTimeout(timeout);}})());
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{close().then(()=>process.exit(0),()=>process.exit(1));});
  if(stdio)process.stdin.once('end',()=>{close().catch(()=>{process.exitCode=1;});});
  return {close};
}
if(require.main===module)main(process.argv[2],process.argv[3]==='--stdio').catch(()=>{process.stderr.write('Owner node startup failed; check protected configuration\n');process.exitCode=1;});
module.exports={main,attach};
