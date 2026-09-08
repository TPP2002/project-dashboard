'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DASHBOARD_HOME } = require('./resolveProject.cjs');
const { atomicWriteJsonSync } = require('./atomicWrite.cjs');

const SETTINGS_PATH = path.join(DASHBOARD_HOME, 'settings.json');

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

module.exports = { SETTINGS_PATH, readSettings, writeSettings, normalizeWebhookEvents };
