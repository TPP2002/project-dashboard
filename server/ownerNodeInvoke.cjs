'use strict';
const { EventEmitter } = require('node:events');
// Adapts fixed handlers, never an HTTP route supplied over the wire.
function invoke(build, action, method, query, body, headers={}) {
  return new Promise((resolve,reject)=>{
    let finished=false;
    const response=new EventEmitter(); response.headers={}; response.statusCode=200;
    response.setHeader=(k,v)=>{response.headers[k.toLowerCase()]=v;};
    response.getHeader=k=>response.headers[k.toLowerCase()];
    response.writeHead=(status,h={})=>{response.statusCode=status;for(const[k,v]of Object.entries(h))response.setHeader(k,v);};
    response.end=data=>{if(finished)return;finished=true;resolve({status:response.statusCode,headers:response.headers,body:Buffer.isBuffer(data)?data:Buffer.from(data||'')});};
    const sendJson=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    const sendText=(res,status,value,mime)=>{res.writeHead(status,{'content-type':mime});res.end(value);};
    const readBody=(_req,max,callback)=>{const raw=JSON.stringify(body||{});callback(Buffer.byteLength(raw)>max?new Error('Body limit'):null,raw);};
    const req={method,headers};
    try { const api=build({sendJson,sendText,readBody,bodyMax:256*1024}); if(!api.route(action,req,response,query))reject(new Error('Fixed handler missing')); } catch(error){reject(error);}
  });
}
module.exports={invoke};
