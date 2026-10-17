'use strict';
const fs = require('node:fs');
const path = require('node:path');
const protocol = require('../core/boardCommand.cjs');
const store = require('./store.cjs');
const audit = require('./branchAudit.cjs');
function stateHash(board) { return protocol.inputHash(protocol.publicResult(board)); }
function claimEvidence(proj) {
  const activity = (store.readBoard(proj.board).activity || []).filter(a => a.type === 'claim');
  for (const name of fs.readdirSync(path.dirname(proj.board)).filter(n => /^activity-\d{6}\.json$/.test(n)).sort()) {
    const items = JSON.parse(fs.readFileSync(path.join(path.dirname(proj.board),name),'utf8'));
    if (!Array.isArray(items)) throw new Error('归档流水格式错误');
    activity.push(...items.filter(a => a.type === 'claim'));
  }
  return {ok:true, activity};
}
function cleanup(proj, payload) {
  if (!payload || Array.isArray(payload) || Object.keys(payload).some(k => !['expected','entries','tier','trunk'].includes(k)) || !/^[a-f0-9]{64}$/.test(payload.expected) || !Array.isArray(payload.entries) || !['owned','suspect','claimed-elsewhere','broadcast'].includes(payload.tier) || (payload.trunk !== null && typeof payload.trunk !== 'string')) throw new Error('分支清理语义非法');
  for (const e of payload.entries) {
    if (!e || Object.keys(e).some(k => !['taskId','branch','otherIds','verdict','evidence'].includes(k)) || !/^[A-Z0-9][A-Z0-9-]*$/.test(e.taskId) || typeof e.branch !== 'string' || !e.branch || !Array.isArray(e.otherIds) || e.otherIds.some(id => typeof id !== 'string') || e.verdict !== 'suspect' || !['commits','name','claim','spread'].includes(e.evidence)) throw new Error('分支清理条目非法');
  }
  let removed = 0, plan;
  store.mutate(proj,b => {
    if (stateHash(b) !== payload.expected) throw new Error('账本已并发变化，请重新读取并体检；原请求不得改写');
    const claims = audit.claimIndex(claimEvidence(proj).activity);
    const entries = payload.entries.filter(e => !claims.get(e.taskId)?.has(e.branch));
    plan = audit.planBranchCleanup(b.tasks || [],entries,{tier:payload.tier,trunkNames:[payload.trunk]});
    // Re-evaluate current dependencies, branch holders, claims and expected board under this lock.
    removed = audit.applyBranchCleanup(b,plan.removals);
  },() => removed ? {ts:new Date().toISOString(),author:'doctor',type:'note',taskId:null,text:`doctor --branches --fix：摘掉 ${removed} 条误扣分支（${payload.tier}）`} : null);
  return {ok:true,removed,skipped:plan.skipped};
}
module.exports = { stateHash, claimEvidence, cleanup };
