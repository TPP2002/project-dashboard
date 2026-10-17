'use strict';
const fs = require('node:fs');
const path = require('node:path');
const p = require('../core/boardCommand.cjs');
const taskRules = require('../core/boardCommandTasks.cjs');
function importBatch(proj, payload, author) {
  if (!payload || Object.keys(payload).some(k => !['tasks','sourceHash','index','total'].includes(k)) || !/^[a-f0-9]{64}$/.test(payload.sourceHash) || !Number.isSafeInteger(payload.index) || !Number.isSafeInteger(payload.total) || payload.index < 0 || payload.total <= payload.index) throw new Error('非法导入语义批次');
  taskRules.importTasks(payload.tasks);
  let added = 0;
  require('./store.cjs').mutate(proj,b => {
    for (const t of payload.tasks) {
      const old = b.tasks.find(x => x.id === t.id);
      if (old) {
        if (p.inputHash(old) !== p.inputHash(t)) throw new Error('导入与当前卡冲突，禁止覆盖: ' + t.id);
      } else { b.tasks.push(t); added++; }
    }
    require('../core/boardSchema.cjs').assertValid(b);
  },() => added ? {ts:new Date().toISOString(),author:author || 'import',type:'note',taskId:null,text:`import 语义批次 ${payload.index+1}/${payload.total}：新增 ${added} 张；来源 ${payload.sourceHash}`} : null);
  return {ok:true,added,index:payload.index,total:payload.total};
}
function importLocal(proj,flags,tasks,sourceHash,revoked) {
  const client = require('./remoteClient.cjs');
  // Prove authority availability before persisting a local plan. Never read the old board.
  require('./projectBoard.cjs').readProjectBoard(proj);
  const planPath = require('./projectBoard.cjs').artifact(proj,undefined,'imports',sourceHash + '.json');
  let plan;
  try { plan = JSON.parse(fs.readFileSync(planPath,'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!plan) {
    const groups = []; let group = [];
    for (const task of tasks) {
      taskRules.importTasks([task]);
      const candidate = [...group,task];
      if (group.length && (candidate.length > 50 || Buffer.byteLength(JSON.stringify(candidate)) > 400 * 1024)) { groups.push(group); group = []; }
      group.push(task);
    }
    if (group.length) groups.push(group);
    plan = {sourceHash,requests:groups.map((rows,index) => client.createRequest('import-batch',proj.id,{_:[],payload:{tasks:rows,sourceHash,index,total:groups.length}})),confirmed:0};
    fs.mkdirSync(path.dirname(planPath),{recursive:true,mode:0o700});
    require('./remoteConfig.cjs').initialize(planPath,plan);
  }
  if (plan.sourceHash !== sourceHash || !Array.isArray(plan.requests)) throw new Error('导入恢复清单损坏');
  let confirmed = 0;
  for (const request of plan.requests) {
    try {
      if (request.projectId !== proj.id || request.command !== 'import-batch' || request.args.payload.sourceHash !== sourceHash) throw new Error('导入恢复请求身份不匹配');
      const binding = require('./remoteConfig.cjs').binding(proj.id);
      if (binding.authorityId !== request.authorityId || binding.authorityEpoch !== request.authorityEpoch) throw new Error('导入属于旧权威，禁止重放');
      let ack;
      try { ack = require('./remoteOutbox.cjs').read(request.requestId); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (ack && p.inputHash(ack.request) !== p.inputHash(request)) throw new Error('导入待送请求已被改写');
      if (!ack || ack.state !== 'confirmed') client.performRequest(request);
      confirmed++;
      require('../core/atomicWrite.cjs').atomicWriteJsonSync(planPath,{...plan,confirmed});
    } catch (e) {
      throw new Error(`import 部分确认 ${confirmed}/${plan.requests.length} 批；恢复清单 ${planPath}；用相同输入续接，不得改写请求。${e.message}`);
    }
  }
  return {ok:true,count:tasks.length,revoked,confirmed,total:plan.requests.length,planPath,text:`✔ import 已确认 ${confirmed}/${plan.requests.length} 批，共 ${tasks.length} 张卡；既有卡与历史未覆盖`};
}
module.exports = { importBatch, importLocal };
