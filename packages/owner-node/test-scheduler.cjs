'use strict';
// Synthetic CLI for formal-dispatch tests. It never loads or calls a scheduler.
const fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2),command=args.find(v=>['submit','status','finish','cancel','exec'].includes(v));
fs.appendFileSync(process.env.SYNTHETIC_SCHED_LOG,JSON.stringify({command,args})+'\n');
if(process.env.SYNTHETIC_SCHED_DENY===command){process.stdout.write(JSON.stringify({status:'rejected'})+'\n');process.exit(2);}
const ticketId='tk-'+'a'.repeat(20);
if(command==='submit')console.log(JSON.stringify({status:'accepted',ticketId}));
else if(command==='status')console.log(JSON.stringify({ticketId,state:'running',cancelRequested:false}));
else if(command==='finish'||command==='cancel')console.log(JSON.stringify({status:'executed',ticketId}));
else if(command==='exec'){
  const i=args.indexOf('--'),child=spawnSync(args[i+1],args.slice(i+2),{cwd:process.cwd(),stdio:'inherit',shell:false,windowsHide:true});process.exitCode=child.status??1;
}else process.exitCode=2;
