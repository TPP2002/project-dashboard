'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { subjectRefs, buildMatcher } = require('./commitRefs.cjs');
const { mutate, unionBy, unionShas } = require('./store.cjs');
function git(repo,args) { return execFileSync('git',['-C',repo,...args],{encoding:'utf8',windowsHide:true,timeout:15000,stdio:['ignore','pipe','pipe'],maxBuffer:1024*1024}).trim(); }
function common(repo) { const dir = git(repo,['rev-parse','--git-common-dir']); return require('../core/safePath.cjs').normalizeReal(path.resolve(repo,dir)); }
function capture(flags,binding) {
  const {resolveProject} = require('../core/resolveProject.cjs');
  const proj = resolveProject(flags.project,{registryPath:flags.registry});
  const repo = process.cwd();
  if (common(repo) !== common(proj.codeRepo)) throw new Error('当前 Git 工位不属于项目本机绑定');
  if (typeof binding.repoBindingId !== 'string' || !binding.repoBindingId) throw new Error('缺少 repoBindingId');
  const exact = typeof flags.commit === 'string' && !!flags.commit;
  if (exact && !/^[0-9a-f]{7,40}$/i.test(flags.commit)) throw new Error('非法 Git commit');
  const n = flags.n === undefined ? 300 : Number(flags.n);
  if (!Number.isInteger(n) || n < 1 || n > 2000) throw new Error('Git 窗口需 1–2000');
  const raw = git(repo,exact ? ['log','-1','--pretty=format:%H%x1f%s',flags.commit] : ['log','-n',String(n),'--pretty=format:%H%x1f%s']);
  // Only an explicit post-commit branch is authoritative. Post-merge/window never broadcasts HEAD.
  const branch = exact && typeof flags.branch === 'string' ? flags.branch : '';
  return {repoBindingId:binding.repoBindingId,mode:exact?'exact':'window',branch,commit:exact ? git(repo,['rev-parse',flags.commit]) : '',commits:raw ? raw.split('\n').map(line => { const at=line.indexOf('\x1f'); return {sha:line.slice(0,at),subject:line.slice(at+1)}; }) : []};
}
function validateFacts(f, project, subject) {
  if (!f || typeof f !== 'object' || Array.isArray(f) || Object.keys(f).some(k => !['repoBindingId','mode','branch','commit','commits'].includes(k))) throw new Error('Git 事实字段非法');
  const bound = project && project.repoBindings && project.repoBindings[f.repoBindingId];
  if (!bound || !Array.isArray(bound.ownerIds) || !bound.ownerIds.includes(subject.id)) throw new Error('Git 绑定不属于项目/受信 owner 设备');
  if (!['exact','window'].includes(f.mode) || typeof f.branch !== 'string' || f.branch.length > 1024 || typeof f.commit !== 'string' || !Array.isArray(f.commits) || f.commits.length > 2000) throw new Error('Git 事实类型非法');
  for (const c of f.commits) if (!c || Object.keys(c).some(k => !['sha','subject'].includes(k)) || !/^[a-f0-9]{40}$/.test(c.sha) || typeof c.subject !== 'string' || c.subject.length > 8192 || /[\r\n\x00]/.test(c.subject)) throw new Error('Git 提交事实非法');
  if (f.mode === 'exact' && (f.commits.length !== 1 || f.commit !== f.commits[0].sha)) throw new Error('exact Git 事实必须与指定提交一致');
  if (f.mode === 'window' && (f.branch || f.commit)) throw new Error('window 不得携带当前分支/指定提交');
}
function merge(proj,facts,project,subject) {
  validateFacts(facts,project,subject);
  let changed = 0;
  mutate(proj,b => {
    const matcher = buildMatcher((b.tasks || []).map(t => t.id));
    const commits = facts.commits.map(c => ({ c, refs: subjectRefs(c.subject,matcher) }));
    for (const t of b.tasks || []) {
      const before = JSON.stringify([t.commitShas,t.prNumbers,t.gitBranch]);
      for (const {c,refs} of commits) {
        const structural = refs.structural.includes(t.id);
        const branch = facts.mode === 'exact' && facts.branch !== 'HEAD' ? facts.branch : '';
        const claimedProse = branch && refs.prose.includes(t.id) && (t.gitBranch || []).includes(branch);
        if (!structural && !claimedProse) continue;
        t.commitShas = unionShas([...(t.commitShas || []),c.sha.slice(0,12)]);
        if (refs.prs.length) t.prNumbers = unionBy([...(t.prNumbers || []),...refs.prs],String);
        if (structural && branch) t.gitBranch = unionBy([...(t.gitBranch || []),branch],String);
      }
      if (JSON.stringify([t.commitShas,t.prNumbers,t.gitBranch]) !== before) changed++;
    }
  }, () => changed ? {ts:new Date().toISOString(),author:'git-hook',type:'note',text:`sync-from-git：${changed} 个任务的 git 字段已更新`,taskId:null} : null);
  return {ok:true,changed,scanned:facts.commits.length};
}
function progress(proj,branch,percent) {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100 || !branch || branch === 'HEAD') throw new Error('自动进度事实非法');
  let taskId = null;
  mutate(proj,b => {
    // Re-find status and ownership under the transaction lock; no delayed target replay.
    const t = (b.tasks || []).find(t => t.status === '施工中' && (t.gitBranch || []).includes(branch));
    if (!t) return;
    taskId = t.id;
    const target = Math.max(t.percent || 0,Math.min(95,percent));
    if (target > (t.percent || 0)) { t.percent=target; t.lastProgressAt=new Date().toISOString(); }
  });
  return {ok:true,taskId};
}
module.exports = { capture, merge, progress, validateFacts };
