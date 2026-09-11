'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DASHBOARD_HOME } = require('./resolveProject.cjs');
const { atomicWriteJsonSync } = require('./atomicWrite.cjs');

const SETTINGS_PATH = path.join(DASHBOARD_HOME, 'settings.json');
const MODULE_IDS = ['codex', 'cost', 'cpu', 'reader', 'audition'];

/** 设置缺失、损坏或不是对象时回落空设置，不影响服务启动。 */
function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (_) { return {}; }
}

/** 浅合并并原子落盘；写失败由调用方报告，不能冒充已保存。 */
function writeSettings(patch) {
  const settings = { ...readSettings(), ...patch };
  fs.mkdirSync(DASHBOARD_HOME, { recursive: true });
  atomicWriteJsonSync(SETTINGS_PATH, settings);
  return settings;
}

/** 只收三个布尔字段；缺失或脏字段默认选中，是否发出仍由服务端地址控制。 */
function normalizeWebhookEvents(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    done: typeof value.done === 'boolean' ? value.done : true,
    pending: typeof value.pending === 'boolean' ? value.pending : true,
    block: typeof value.block === 'boolean' ? value.block : true,
  };
}

/** 仅布尔 true 开启模块；缺失、脏字段和未知字段均不授予开关。 */
function normalizeModules(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries(MODULE_IDS.map((id) => [id, value[id] === true]));
}

/** 环境变量存在即覆盖文件（空字符串表示全关）；每次读取，保存后立即生效。 */
function resolveModules() {
  if (process.env.DASHBOARD_MODULES !== undefined) {
    const enabled = new Set(process.env.DASHBOARD_MODULES.split(',').map((id) => id.trim()));
    return Object.fromEntries(MODULE_IDS.map((id) => [id, enabled.has('all') || enabled.has(id)]));
  }
  return normalizeModules(readSettings().modules);
}

module.exports = { SETTINGS_PATH, MODULE_IDS, readSettings, writeSettings, normalizeWebhookEvents, normalizeModules, resolveModules };
