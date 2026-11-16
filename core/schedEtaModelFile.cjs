'use strict';
/**
 * 共享盘估时模型的只读入口(AD-20261116-SCHED-ETA-LEARN)。
 * 模型文件由派单员写到 <share>/sched/_stats/eta-model.json;看板只读、不写。
 * 文件不存在、读坏、不是合法模型都只降级成 { loaded:false, reason },永不抛:
 * 模型没生成时调度台照常工作,继续用旧的同类中位耗时口径。
 */
const fs = require('node:fs');
const path = require('node:path');
const c = require('./schedContract.cjs');
const { parseModel, accuracySummary } = require('./schedEtaModel.cjs');

/** 每个共享盘单独缓存上次解析结果:同一文件(mtime+大小都没变)返回同一个对象。 */
const cache = new Map();

function failure(reason) {
  return { loaded: false, reason };
}

function readEtaModelFile(share, options = {}) {
  try {
    const reader = options.fs === undefined ? fs : options.fs;
    const stat = options.stat === undefined ? (reader.statSync === undefined ? fs.statSync : reader.statSync.bind(reader)) : options.stat;
    const file = path.join(c.schedPaths(share).root, '_stats', 'eta-model.json');
    let info;
    try {
      info = stat(file);
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return failure('估时模型文件还没生成');
      return failure('估时模型文件读不了:' + (error && error.message ? error.message : String(error)));
    }
    const key = String(share);
    const cached = cache.get(key);
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.result;
    let text;
    try { text = reader.readFileSync(file, 'utf8'); }
    catch (error) { return failure('估时模型文件读不了:' + (error && error.message ? error.message : String(error))); }
    const parsed = parseModel(text);
    if (!parsed.ok) return failure('估时模型文件读不了:' + parsed.reason);
    const result = { loaded: true, model: parsed.model, updatedAt: parsed.model.updatedAt,
      buckets: Object.keys(parsed.model.buckets).length, accuracy: accuracySummary(parsed.model) };
    cache.set(key, { mtimeMs: info.mtimeMs, size: info.size, result });
    return result;
  } catch (error) {
    return failure('估时模型文件读不了:' + (error && error.message ? error.message : String(error)));
  }
}

module.exports = { readEtaModelFile };
