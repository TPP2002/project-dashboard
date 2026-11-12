'use strict';

const path = require('node:path');

function createCostSources({ demoDir, real }) {
  const emptyLedger = () => ({ requests: [], lastCheck: null, updatedAt: null });
  return {
    getUsage: (...args) => demoDir
      ? real.getUsage({ ...args[0], projectsRoot: path.join(demoDir, 'claude-projects'), cachePath: path.join(demoDir, 'costUsageCache.json') })
      : real.getUsage(...args),
    sessionsRoot: (root) => demoDir ? path.join(demoDir, 'codex-sessions') : root,
    jobsRoot: (root) => demoDir ? path.join(demoDir, 'demo-jobs') : root,
    costRoots: (roots) => demoDir ? [] : roots,
    collectJobRows: (...args) => real.collectJobRows(...args),
    getDeepseekUsage: (...args) => demoDir ? real.summarizeDeepseekJobs([], { ...args[0], projectRepo: demoDir }) : real.getDeepseekUsage(...args),
    scanAllDeepseekJobs: (...args) => demoDir ? [] : real.scanAllDeepseekJobs(...args),
    summarizeDeepseekJobs: (...args) => demoDir ? real.summarizeDeepseekJobs([], { ...args[1], projectRepo: demoDir }) : real.summarizeDeepseekJobs(...args),
    getGlmUsage: (...args) => demoDir ? real.summarizeGlmJobs([], args[0]) : real.getGlmUsage(...args),
    scanGlmJobs: (...args) => demoDir ? [] : real.scanGlmJobs(...args),
    summarizeGlmJobs: (...args) => demoDir ? real.summarizeGlmJobs([], { ...args[1], projectRepo: null }) : real.summarizeGlmJobs(...args),
    getWorkbuddyUsage: (...args) => demoDir ? real.summarizeWorkbuddyRequests(emptyLedger(), args[0]) : real.getWorkbuddyUsage(...args),
    scanWorkbuddyLedgers: (...args) => demoDir ? emptyLedger() : real.scanWorkbuddyLedgers(...args),
    summarizeWorkbuddyRequests: (...args) => demoDir ? real.summarizeWorkbuddyRequests(emptyLedger(), { ...args[1], projectRepo: null }) : real.summarizeWorkbuddyRequests(...args),
    getDeepseekBalance: (...args) => demoDir
      ? Promise.resolve({ available: false, reason: '演示实例不查询余额', balance: null, sampledAt: new Date().toISOString() })
      : real.getDeepseekBalance(...args),
  };
}

module.exports = { createCostSources };
