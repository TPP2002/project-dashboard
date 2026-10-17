'use strict';
const path = require('node:path');
const config = require('./remoteConfig.cjs');
const { readRegistry, detectProjectIds, REGISTRY_PATH } = require('../core/resolveProject.cjs');
const p = require('../core/boardCommand.cjs');
const LOCAL = new Set(['protocol','release','hooks-install','hooks-global','hooks-trunk-guard']);
function route(command, flags) {
  const all = config.load().projects;
  const client = require('./remoteClient.cjs');
  const registryPath = flags.registry ? path.resolve(flags.registry) : REGISTRY_PATH;
  if (['register','enroll'].includes(command) && all[flags.id]) throw new Error('已绑定远程项目，禁止本机重新注册/导入: ' + flags.id);
  if (command === 'remote-retry') return {handled:true,result:client.retry(flags._[0],registryPath)};
  if (LOCAL.has(command)) return {handled:false};
  if (command === 'claim-check' && Object.keys(all).length) {
    const branch = flags.branch || client.localBranch(flags.repo || process.cwd());
    const hits = []; const scanned = [];
    // Preserve cross-project claims: every registered authority must answer; offline is never "no claim".
    const registry = readRegistry(registryPath);
    for (const id of new Set([...Object.keys(registry.projects || {}), ...Object.keys(all)])) {
      scanned.push(id);
      if (all[id]) hits.push(...client.perform('claim-check',id,{_:[],branch}).hits);
      else {
        const {resolveProject} = require('../core/resolveProject.cjs');
        let b;
        try { b = require('./store.cjs').readBoard(resolveProject(id,{registryPath}).board); }
        catch (e) { process.stderr.write('⚠ claim-check 本机项目不可读: ' + id + '\n'); continue; }
        for (const t of b.tasks || []) if (['施工中','待收单'].includes(t.status) && (t.gitBranch || []).includes(branch)) hits.push({project:id,taskId:t.id});
      }
    }
    if (!hits.length && !['main','master','HEAD',''].includes(branch)) throw new Error('当前权威账本无施工中/待收单认领: ' + branch);
    return {handled:true,result:{ok:true,hits,scanned,text:`✔ claim-check ${branch} (${hits.length})`}};
  }
  if (command === 'sync-progress' && Object.keys(all).length) {
    const ids = flags.project ? [flags.project] : detectProjectIds({registryPath});
    if (!ids.some(id => all[id])) return {handled:false};
    const branch = client.localBranch(); // hook facts always come from this local worktree
    const matches = [];
    for (const id of ids) {
      if (all[id]) {
        const result = client.perform('claim-check',id,{_:[],branch});
        if (result.hits.some(h => h.status === '施工中')) matches.push(id);
      } else {
        const proj = require('../core/resolveProject.cjs').resolveProject(id,{registryPath});
        const board = require('./store.cjs').readBoard(proj.board);
        if ((board.tasks || []).some(t => t.status === '施工中' && (t.gitBranch || []).includes(branch))) matches.push(id);
      }
    }
    if (matches.length !== 1) return {handled:true,result:{ok:true,silent:true,skipped:'无唯一项目认领'}};
    if (!all[matches[0]]) return {handled:true,result:require('./commands.cjs').syncProgress({...flags,project:matches[0],branch})};
    return {handled:true,result:client.perform('sync-progress',matches[0],{_:[],branch,percent:Number(flags.percent)})};
  }
  if (!all[flags.project]) {
    if (Object.keys(all).length && !flags.project && !['register','enroll'].includes(command)) throw new Error('远程模式需明确 --project（拒绝读取旧板）');
    return {handled:false};
  }
  if (command === 'sync-from-git') {
    const facts = require('./gitFacts.cjs').capture(flags,all[flags.project]);
    return {handled:true,result:client.perform('git-facts',flags.project,{_:[],facts})};
  }
  if (!Object.hasOwn(p.FIELDS,command) || ['git-facts'].includes(command)) throw new Error('远程模式未适配命令，拒绝本机回退: ' + command);
  const args = client.typedArgs(command,flags);
  const result = client.perform(command,flags.project,args,{registry:registryPath});
  if (result.text && ['brief','inbox','claim'].includes(command)) {
    // Cloud rendering must instruct the client to use its own formal CLI prefix.
    result.text = result.text.replace(/^.*(?:board\.cmd|index\.cjs)(?= (?:progress|pending|done|claim|brief|inbox|mark-landed)\b)/gm, 'node "' + path.join(__dirname,'index.cjs').replace(/\\/g,'/') + '"');
  }
  return {handled:true,result};
}
module.exports = { route };
