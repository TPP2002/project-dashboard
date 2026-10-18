'use strict';
const usage=require('../core/ownerNodeUsage.cjs');
const cost=require('../core/costUsage.cjs');
const {summarizeGlmJobs}=require('../core/glmCostUsage.cjs');
function deepseek(jobs,days) {
  const date=new Date();date.setDate(date.getDate()-(days-1));const cutoff=date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');
  const empty=()=>({tokens:0,costRmb:0,input:0,output:0,cacheRead:0,cacheWrite:0,cacheHitRate:0});
  const totals={...empty(),jobs:0},byModel={},daily={};
  const today=require('./codexMetrics.cjs').localDate(Date.now());
  for(const job of jobs){const day=require('./codexMetrics.cjs').localDate(job.dispatchedAt);if(day<cutoff||day>today)continue;
    const u=job.usage,input=Number(u.input_tokens)||0,output=Number(u.output_tokens)||0,cacheRead=Number(u.cache_read_input_tokens)||0,ttl=(Number(u.cache_creation?.ephemeral_5m_input_tokens)||0)+(Number(u.cache_creation?.ephemeral_1h_input_tokens)||0),cacheWrite=ttl||Number(u.cache_creation_input_tokens)||0;
    for(const row of [totals,byModel[job.model]||=(empty()),daily[day]||=({date:day,...empty()})])for(const[k,v]of Object.entries({input,output,cacheRead,cacheWrite,tokens:input+output+cacheRead+cacheWrite,costRmb:job.costRmb}))row[k]+=v;
    totals.jobs++;
  }
  for(const row of [totals,...Object.values(byModel),...Object.values(daily)]){const d=row.input+row.cacheRead+row.cacheWrite;row.cacheHitRate=d?row.cacheRead/d:0;}
  return {totals,byModel,byDay:Object.values(daily).sort((a,b)=>a.date.localeCompare(b.date))};
}
function view(rows,id,name,days,{cards=[],bindings=null,balance=null}={}) {
  const claude=usage.claude(rows,id,days,cards,bindings),codex=usage.codex(rows,days,name);
  const jobs=rows.find(r=>r.kind==='jobs')||{glm:[],deepseek:{}};
  const projectRepo=jobs.projects?.[id];
  const glm=summarizeGlmJobs(jobs.glm,{projectRepo,days});
  const ds=deepseek(jobs.deepseek[id]||[],days),claudeTokens=cost.totalClaudeTokens(claude),codexTokens=codex.selected.tokens;
  return {ok:true,costRoots:rows.find(r=>r.kind==='projects')?.roots[id]||[],sharedDirs:claude.sharedDirs,usage:claude,codex,deepseek:ds,glm,deepseekBalance:balance||{available:false,reason:'节点余额快照不可用',balance:null,sampledAt:null},quota:rows.find(r=>r.kind==='quota')?.value,combined:{claudeTokens,codexTokens,totalTokens:claudeTokens+codexTokens,savingsEstimateUsd:cost.estimateCodexSavings(codexTokens,claude)},nodeSampledAt:rows.find(r=>r.kind==='sample')?.at};
}
module.exports={view,deepseek};
