'use strict';
// Synthetic transport fixture only. Never imported by either production CLI.
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {peer}=require('../../core/ownerNodeTransport.cjs');
const {Journal,exclusive}=require('../../core/ownerNodeStore.cjs');
const root=process.argv[2],mode=process.argv[3];
if(mode==='dashboard'){
  const dashboard=require('../../server/server.cjs');dashboard.main();
  process.on('message',message=>{if(message==='shutdown')Promise.all([dashboard.shutdown(),dashboard.shutdown()]).then(()=>process.exit(0));});
}else if(mode==='writer'){
  const release=exclusive(root);process.send({ready:true});
  process.on('message',message=>{if(message==='close'){release();process.exit(0);}});
}else if(mode==='gateway'){
  const {serve}=require('./gateway.cjs');
  serve(JSON.parse(fs.readFileSync(path.join(root,'gateway.json'),'utf8'))).then(service=>{
    process.send({ready:true});process.on('message',m=>{if(m==='close')service.close().then(()=>process.exit(0));});
  }).catch(()=>process.exit(2));
}else{
  const release=exclusive(root);
  const journal=new Journal(root);
  const handle=request=>journal.run(request,async()=>{
    if(request.operation==='jobs.say'){
      const child=spawn(process.execPath,['-e','require("node:fs").appendFileSync(process.argv[1],"launch\\n")',path.join(root,'launches.txt')],{stdio:'ignore',windowsHide:true});
      await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error('Synthetic child failed')));});
      if(mode==='crash-after-spawn')process.exit(19);
      await new Promise(resolve=>setTimeout(resolve,80));
      return {reply:request.args.message};
    }
    return {operation:request.operation,args:request.args};
  });
  const connection=peer(process.stdin,process.stdout,{handler:handle});
  process.stdin.on('end',()=>{connection.close();Promise.allSettled([...journal.active.values()]).then(release);});
}
