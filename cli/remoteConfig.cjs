'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
function configPath() {
  return process.env.DASHBOARD_REMOTE_CONFIG || path.join(process.env.DASHBOARD_HOME || path.join(os.homedir(), '.claude','dashboard'), 'remote.json');
}
function load() {
  const file = configPath();
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT' && !process.env.DASHBOARD_REMOTE_CONFIG) return { projects: Object.create(null) }; throw new Error('远程配置不可读/不存在（拒绝本机回退）'); }
  return validateConfig(config);
}
function validateConfig(config) {
  if (!config || config.version !== 1 || !config.projects || typeof config.projects !== 'object' || Array.isArray(config.projects)) throw new Error('远程配置格式错误');
  for (const [id, binding] of Object.entries(config.projects)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id) || ['__proto__','constructor','prototype'].includes(id)
      || !binding || typeof binding !== 'object' || Array.isArray(binding)
      || typeof binding.authorityId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(binding.authorityId)
      || !Number.isSafeInteger(binding.authorityEpoch) || binding.authorityEpoch < 1
      || !binding.transport || typeof binding.transport !== 'object' || Array.isArray(binding.transport)) {
      throw new Error('远程项目绑定无效（拒绝本机回退）: ' + id);
    }
  }
  return { ...config, projects: Object.assign(Object.create(null), config.projects) };
}
function binding(id) { const projects = load().projects; return Object.hasOwn(projects,id) ? projects[id] : null; }
function initialize(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
module.exports = { load, binding, initialize, configPath, validateConfig };
