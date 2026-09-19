'use strict';
/**
 * readerImport.cjs —— 审阅台「本机导入」的纯函数与存储层(READER-IMPORT-BUTTON T1)。
 *
 * 干什么:接住浏览器端(T2)已经转好的 markdown,连同可选的原件二进制,落到本机数据目录
 *        <数据根>/data/reader/<项目>/imports/<key>/;按 key 列出/读取/删除;
 *        并把导入清单拼成 manifest 里的「本机导入」虚拟批次(server 端只负责把它接进回包)。
 *
 * 边界(与整体设计对齐,不许越界):
 *   · 不依赖 HTTP、不 require 任何 npm 包(与 readerApi 同为零依赖);只落本机数据目录,不写仓库文件。
 *   · key = IMP-<YYYYMMDD>-<md 内容 sha1 前 6 位>:同内容同天再导入 = 同 key,不覆盖不重复存。
 *   · 不做格式转换、不解析 pdf/docx、不生成边注、不登记拍板项(那些分别归 T2 与后续单)。
 *
 * 写盘纪律:一律先写临时文件再改名(复用 core/atomicWrite),同一 key 的导入/删除用文件锁串行
 * (复用 core/lock,与批注账本同规矩)。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteFileSync, atomicWriteJsonSync } = require('../core/atomicWrite.cjs');
const { withLock } = require('../core/lock.cjs');

// ---------- 常量(与接口契约逐条对齐) ----------
/** 支持的导入格式;md 之外的都是 T2 在浏览器端转成 md 再发上来,server 不解析原件 */
const FORMATS = new Set(['md', 'txt', 'html', 'docx', 'pdf']);
const MD_MAX_BYTES = 3 * 1024 * 1024;        // md 正文上限(超了回 413)
const ORIGINAL_MAX_BYTES = 30 * 1024 * 1024; // 原件解码后上限(超了回 413)
const TITLE_MAX_CHARS = 120;                 // 标题最长 120 字
const KEY_PREFIX = 'IMP-';
/** 导入 key 的完整形状:IMP-<YYYYMMDD>-<6 位十六进制>。所有按 key 的盘上操作先过这道,防路径注入 */
const KEY_RE = /^IMP-\d{8}-[0-9a-f]{6}$/;
/** 「本机导入」虚拟批次(只在至少有一份导入时由调用方追加进 manifest) */
const BATCH_ID = 'local-import';
const BATCH_NAME = '本机导入';
const BATCH_BASELINE = '本机导入,未经回流对账';
/** 落盘原件名的全集:original.<小写字母数字 ≤5 位>(meta 里存展示名,盘上不用它拼路径) */
const ORIGINAL_FILE_RE = /^original\.[a-z0-9]{1,5}$/;

// ---------- 纯函数 ----------
/**
 * 生成导入 key:IMP-<YYYYMMDD>-<md 内容 sha1 前 6 位>(同内容同天 = 同 key)。
 * 日期取本地日历日(与使用者感知一致);now 可注入,方便测试与"同 seed 必须同结果"。
 */
function makeImportKey(md, now) {
  const d = now instanceof Date ? now : new Date();
  const ymd = String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  return KEY_PREFIX + ymd + '-' + crypto.createHash('sha1').update(md, 'utf8').digest('hex').slice(0, 6);
}

/** 展示名清洗:只取最后一段并清掉路径分隔符与「..」。结果只进 meta 当展示,不参与拼任何盘上路径 */
function sanitizeName(s) {
  return String(s || '').split(/[\\/]+/).pop().replace(/\.\./g, '').replace(/[\\/]/g, '').trim();
}

/** 从清洗后的展示名推标题:去最后一个扩展名(「.md」这类点开头的不算扩展名) */
function deriveTitle(cleanedName) {
  const dot = cleanedName.lastIndexOf('.');
  return dot > 0 ? cleanedName.slice(0, dot) : cleanedName;
}

/** 落盘原件的扩展名:只认小写字母数字且 ≤5 位,否则一律 bin(不让怪后缀进文件系统) */
function extFromName(cleanedName) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(cleanedName);
  return m ? m[1].toLowerCase() : 'bin';
}

/**
 * 校验并归一化导入请求体(纯函数;「项目必须已注册」要查 registry,归 API 层管)。
 * 通过 → { ok:true, value:{ title, fileName, format, md, warnings, original } };
 * 不通过 → { ok:false, status, message },status 直接当 HTTP 状态码用。
 * 校验顺序按契约原文:md 去空白为空 400 → md 超 3MB 413 → 原件解码超 30MB 413 → format 不在名单 400。
 */
function validateImportBody(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const md = typeof b.md === 'string' ? b.md : '';
  if (!md.trim()) return { ok: false, status: 400, message: 'md 正文为空' };
  if (Buffer.byteLength(md, 'utf8') > MD_MAX_BYTES) return { ok: false, status: 413, message: 'md 正文超过 3MB 上限' };
  // 原件可选;给了就必须带合法 base64(不带 data: 前缀,契约只约定位流)
  let original = null;
  if (b.original !== undefined && b.original !== null) {
    const raw = b.original;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, status: 400, message: 'original 必须是 {name, mime, base64}' };
    const b64 = typeof raw.base64 === 'string' ? raw.base64 : '';
    if (!b64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) return { ok: false, status: 400, message: 'original.base64 缺失或不是合法的 base64' };
    const buffer = Buffer.from(b64, 'base64');
    if (buffer.length > ORIGINAL_MAX_BYTES) return { ok: false, status: 413, message: '原件超过 30MB 上限' };
    const name = sanitizeName(raw.name);
    original = { name, ext: extFromName(name), buffer, mime: typeof raw.mime === 'string' ? raw.mime : '' };
  }
  const format = typeof b.format === 'string' ? b.format.trim().toLowerCase() : '';
  if (!FORMATS.has(format)) return { ok: false, status: 400, message: 'format 只认 md / txt / html / docx / pdf' };
  // 标题:空则取 fileName 去扩展名,截 120 字;两者都推不出来 → 400(没法起名的导入没法在清单里认)
  const fileName = sanitizeName(b.fileName);
  let title = typeof b.title === 'string' ? b.title.trim() : '';
  if (!title) title = deriveTitle(fileName);
  title = title.slice(0, TITLE_MAX_CHARS);
  if (!title) return { ok: false, status: 400, message: '缺 title,且 fileName 推不出标题' };
  // 警示(如「第 2 页是扫描件」):只收字符串项,别的不认识的丢掉,不让脏数据进 meta
  const warnings = Array.isArray(b.warnings) ? b.warnings.filter((w) => typeof w === 'string') : [];
  return { ok: true, value: { title, fileName, format, md, warnings, original } };
}

/**
 * 一份导入在清单里的报告元数据(与接口契约逐字段对齐)。
 * md 恒为 null(正文不进清单,读的时候按 key 去 imports 目录取)。
 */
function buildImportReportMeta(projectId, meta, hasOriginal) {
  return {
    key: meta.key,
    title: meta.title,
    version: String(meta.format || '').toUpperCase() + ' · ' + String(meta.importedAt || '').slice(0, 10),
    md: null,
    project: projectId,
    status: '未对账',
    why: '本机导入的文件:' + meta.fileName + '。没有经过回流对账,没有边注,也没有登记拍板项。',
    imported: true,
    importedAt: meta.importedAt,
    format: meta.format,
    fileName: meta.fileName,
    warnings: meta.warnings,
    hasOriginal: !!hasOriginal,
  };
}

/**
 * 把若干份导入拼成「本机导入」虚拟批次,报告按导入时间倒序(同刻再按 key 倒序,保证稳定)。
 * 没有导入时调用方必须整体跳过 —— 那种情况下 manifest 回包要和没有这段代码时逐字节一致。
 */
function buildLocalImportBatch(projectId, metas, dataDir) {
  const sorted = [...metas].sort((a, b) =>
    String(b.importedAt || '').localeCompare(String(a.importedAt || '')) || String(b.key || '').localeCompare(String(a.key || '')));
  return {
    id: BATCH_ID,
    name: BATCH_NAME,
    baseline: BATCH_BASELINE,
    noteLayers: [],
    reports: sorted.map((meta) => buildImportReportMeta(projectId, meta, hasOriginal(dataDir, projectId, meta.key))),
  };
}

// ---------- 存储层(全部落本机数据目录,不进仓库) ----------
/** imports 根:<数据根>/data/reader/<项目>/imports/ */
function importsRoot(dataDir, projectId) { return path.join(dataDir, projectId, 'imports'); }
function importDir(dataDir, projectId, key) { return path.join(importsRoot(dataDir, projectId), key); }

/** 读一份 meta.json;key 非法/目录缺失/文件坏了 → null(坏的宁可少显示,不能把清单打挂) */
function readMeta(dataDir, projectId, key) {
  if (!KEY_RE.test(key)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(importDir(dataDir, projectId, key), 'meta.json'), 'utf8')); }
  catch (_) { return null; }
}

/** 列出某项目的全部导入(只认形状合法的 key;meta 坏了的跳过) */
function listImports(dataDir, projectId) {
  let entries;
  try { entries = fs.readdirSync(importsRoot(dataDir, projectId)); } catch (_) { return []; }
  const metas = [];
  for (const name of entries) {
    const meta = readMeta(dataDir, projectId, name);
    if (meta && meta.key === name) metas.push(meta);
  }
  return metas;
}

/** 该导入有没有原件(目录里有形状合法的 original.<ext> 文件) */
function hasOriginal(dataDir, projectId, key) {
  let entries;
  try { entries = fs.readdirSync(importDir(dataDir, projectId, key)); } catch (_) { return false; }
  return entries.some((f) => ORIGINAL_FILE_RE.test(f));
}

/** 读一份导入(meta + md 正文);没有或读不了 → null */
function readImport(dataDir, projectId, key) {
  const meta = readMeta(dataDir, projectId, key);
  if (!meta) return null;
  try { return { meta, md: fs.readFileSync(path.join(importDir(dataDir, projectId, key), 'report.md'), 'utf8') }; }
  catch (_) { return null; }
}

/** 找导入的原件;没有 → null。回 { file, ext },Content-Type 由 API 层按 ext 定 */
function readImportOriginal(dataDir, projectId, key) {
  if (!KEY_RE.test(key)) return null;
  let entries;
  try { entries = fs.readdirSync(importDir(dataDir, projectId, key)); } catch (_) { return null; }
  const file = entries.find((f) => ORIGINAL_FILE_RE.test(f));
  return file ? { file: path.join(importDir(dataDir, projectId, key), file), ext: file.slice('original.'.length) } : null;
}

/**
 * 落盘一份导入。同 key(同内容同天)已有完好导入 → 不覆盖不重复存,回 duplicate:true 并沿用原 meta;
 * 目录在但 meta 缺/坏(写盘中途崩溃的半截状态) → 视同未导入,补齐落盘。
 * 文件一律原子写;同一 key 的导入/删除经文件锁串行(与批注账本同纪律)。
 */
function saveImport(dataDir, projectId, value, now) {
  const key = makeImportKey(value.md, now);
  const root = importsRoot(dataDir, projectId);
  fs.mkdirSync(root, { recursive: true });
  return withLock(path.join(root, key + '.lock'), () => {
    const existing = readMeta(dataDir, projectId, key);
    if (existing) return { key, duplicate: true, meta: existing };
    const meta = {
      key,
      title: value.title,
      fileName: value.fileName,
      format: value.format,
      importedAt: (now instanceof Date ? now : new Date()).toISOString(),
      warnings: value.warnings,
      originalName: value.original ? value.original.name : '',
      originalBytes: value.original ? value.original.buffer.length : 0,
    };
    const dir = importDir(dataDir, projectId, key);
    fs.mkdirSync(dir, { recursive: true }); // 原子写的临时文件落在目标目录里,目录得先在
    atomicWriteFileSync(path.join(dir, 'report.md'), value.md);
    if (value.original) atomicWriteFileSync(path.join(dir, 'original.' + value.original.ext), value.original.buffer);
    atomicWriteJsonSync(path.join(dir, 'meta.json'), meta);
    return { key, duplicate: false, meta };
  });
}

/** 删一份导入(整个目录);不存在 → false。批注账本不归这里管,由 API 层一并清 */
function deleteImport(dataDir, projectId, key) {
  if (!KEY_RE.test(key)) return false;
  const root = importsRoot(dataDir, projectId);
  fs.mkdirSync(root, { recursive: true });
  return withLock(path.join(root, key + '.lock'), () => {
    const dir = importDir(dataDir, projectId, key);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true;
  });
}

module.exports = {
  FORMATS, MD_MAX_BYTES, ORIGINAL_MAX_BYTES, TITLE_MAX_CHARS, BATCH_ID, BATCH_NAME, BATCH_BASELINE,
  makeImportKey, sanitizeName, deriveTitle, extFromName, validateImportBody,
  buildImportReportMeta, buildLocalImportBatch,
  importsRoot, importDir, listImports, readMeta, readImport, readImportOriginal, hasOriginal, saveImport, deleteImport,
};
