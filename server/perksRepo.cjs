'use strict';
/**
 * 找「每日福利」代码目录：三步走，前一步找到就不看后一步。
 * 每日福利仓靠「有没有那三个标记文件」认，不靠目录名或包名认。
 */
const fs = require('node:fs');
const path = require('node:path');

const PERKS_REPO_MARKERS = ['src/cli.ts', 'src/control.ts', 'src/panel/launch.ts'];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createPerksRepoFinder(deps) {
  deps = deps || {};
  const { codexRepo, readRegistry } = deps;
  const env = deps.env || process.env;
  const fileExists = deps.fileExists || fs.existsSync;
  const now = deps.now || Date.now;
  const cacheMs = deps.cacheMs ?? 60000;
  let cache = null; // { time, value }；只缓存第三步扫描的结果（找到或 null）

  function collectCandidates(proj) {
    const out = [];
    if (!isRecord(proj)) return out;
    out.push(proj.mainRepo);
    out.push(proj.codeRepo);
    if (Array.isArray(proj.costRoots)) {
      for (const root of proj.costRoots) out.push(root);
    }
    return out.filter((s) => typeof s === 'string' && s.length > 0 && path.isAbsolute(s));
  }

  function hasAllMarkers(dir) {
    for (const marker of PERKS_REPO_MARKERS) {
      let found;
      try { found = fileExists(path.join(dir, marker)); }
      catch (_) { return false; }
      if (!found) return false;
    }
    return true;
  }

  function scan() {
    let registry;
    try { registry = readRegistry(); }
    catch (_) { return null; }
    const projects = registry && registry.projects;
    if (!isRecord(projects)) return null;
    const fold = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
    const seen = new Set();
    for (const key of Object.keys(projects)) {
      for (const raw of collectCandidates(projects[key])) {
        const dir = path.resolve(raw);
        const dedup = fold(dir);
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        if (hasAllMarkers(dir)) return dir;
      }
    }
    return null;
  }

  function resolve() {
    try {
      // 甲：环境变量是非空绝对路径就直接用它，不查注册表、不查文件。
      const override = String(env.DASHBOARD_PERKS_REPO || '').trim();
      if (override && path.isAbsolute(override)) return override;
      // 乙：注册表里 id 为 perks 的项目给的代码目录（现有行为）；抛异常当作没找到。
      try {
        const fromCodex = codexRepo('perks');
        if (typeof fromCodex === 'string' && fromCodex.length > 0) return fromCodex;
      } catch (_) { /* 当作没找到，继续往下走 */ }
      // 丙：在注册表各项目登记过的目录里认标记文件；结果缓存 cacheMs 毫秒。
      const t = now();
      if (cache && t - cache.time < cacheMs) return cache.value;
      const value = scan();
      cache = { time: t, value };
      return value;
    } catch (_) {
      return null;
    }
  }

  return { resolve };
}

module.exports = { createPerksRepoFinder, PERKS_REPO_MARKERS };
