'use strict';
// A fresh parser context for a finite changed-file batch. Existing parser caches
// key by size; replacing a source with equal-length bytes must not reuse them.
const {Worker,isMainThread,parentPort,workerData}=require('node:worker_threads');
if(!isMainThread){
  (async()=>{
    const sessions=require('../server/codexSessions.cjs'),result={};
    for(const item of workerData.files){
      const summary=sessions.getJobSessionSummary(item.sessionId,workerData.options);
      if(!summary)throw new Error('Changed session unavailable');
      const {cwd,...safe}=summary;
      result[item.sessionId]={kind:'codex',summary:{...safe,...await sessions.scanTokenTotalsByDay(item.file)}};
    }
    parentPort.postMessage({result,...(workerData.options.includeQuota?{quota:sessions.getLatestQuota(workerData.options)}:{})});
  })().catch(()=>{throw new Error('Changed session parsing failed');});
}
function parse(files,options){return new Promise((resolve,reject)=>{
  const worker=new Worker(__filename,{workerData:{files,options}});
  const timer=setTimeout(()=>{worker.terminate();reject(new Error('Changed session scan timed out'));},30000);
  worker.once('message',value=>{clearTimeout(timer);resolve(value);});
  worker.once('error',error=>{clearTimeout(timer);reject(error);});
  worker.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(new Error('Changed session parser exited'));});
});}
module.exports={parse};
