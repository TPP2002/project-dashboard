'use strict';
/**
 * docsAudit.cjs —— 文档新鲜度巡检(DOCS-LIFECYCLE-GOVERNANCE,0901 负责人拍板)。
 *
 * 【定位】探雷器,不是判官:只做硬数据比对(状态行 × 看板卡状态 × 日期),
 * **永远不判文档内容、不改任何文档**;产出疑似过期清单,判断交给人/agent。
 * 配合每月一张巡检卡(--create-card),把「全库 442 篇」缩圈到「本月十几篇」,
 * 判断额度从此可忽略。状态行规矩正本 = 项目 docs/开工须知.md §5.7。
 *
 * 【信号】(全部机械可验,零启发式猜测)
 *   A 疑似该转历史:状态行含 正本/草案/待拍,但关联卡在看板已完工超 --stale-days(默认30)天
 *   B 核对过期:状态行「最后核对」日期超 --recheck-days(默认90)天
 *   C 无标签:design/plans 域下头部无状态行(回填战役清完后此桶应趋零,新增文档冒头即被抓)
 *   D 已归档态(已被…取代/评估件)→ 跳过,不算问题
 *
 * 用法:node cli/index.cjs docs-audit --project <id> [--create-card] [--stale-days 30] [--recheck-days 90]
 *   报告写到 <board 同目录>/docs-audit-<YYYYMM>.txt;--create-card 时在看板建
 *   DOCS-AUDIT-<YYYYMM> 卡(已存在则跳过,幂等,desc 带统计摘要与报告路径)。
 */
const fs = require('node:fs');
const path = require('node:path');
const { resolveProject, REGISTRY_PATH } = require('../core/resolveProject.cjs');
const { readBoardOrNull } = require('./store.cjs');
const cmds = require('./commands.cjs');

const AUDIT_DIRS = ['design', 'plans']; // 状态行规矩的适用域(§5.7)
const CARD_RE = /关联卡\s+([A-Z0-9][A-Z0-9-]*)/;
const RECHECK_RE = /最后核对\s+(\d{4}-\d{2}-\d{2})/;

function listMd(root) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** 读头部标签:{ line, legacy } —— 标准 §5.7 状态行,或 0830 前的旧式定稿标注(粗体「✅定稿」等) */
function readStatusLine(file) {
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    head = buf.toString('utf8', 0, n);
  } catch (_) { return null; }
  const lines = head.split('\n').slice(0, 12).map((l) => l.trim());
  for (const line of lines) {
    if (/^>.*状态\s*[::]/.test(line)) return { line, legacy: false };
  }
  // 旧式:头部前 12 行里的定稿/废弃/取代/评估件标注(只认强词,防误配正文)
  for (const line of lines) {
    if (/定稿|已废弃|已被.+取代|评估件/.test(line)) return { line, legacy: true };
  }
  return null;
}

function daysSince(dateStr) {
  const t = new Date(dateStr).getTime();
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
}

function docsAudit(flags) {
  const pid = flags.project;
  if (!pid || pid === true) throw new Error('缺参数。用法: docs-audit --project <id> [--create-card] [--monthly-tick] [--stale-days 30] [--recheck-days 90]');
  const proj = resolveProject(pid, { registryPath: flags.registry ? path.resolve(flags.registry) : REGISTRY_PATH });

  // --monthly-tick:月度节拍器(给计划任务用,幂等可反复触发)。
  // 距上次成功巡检不足 30 天 → 秒退零成本;到期才真跑,成功后写 lastSuccessAt ⇒ 下次自动从成功日顺延 30 天。
  // 配合计划任务「每日多个触发点 + 错过开机补跑」= 负责人要的「没开机就下次试、失败当日重试、成功即顺延」。
  const statePath = path.join(path.dirname(proj.board), 'docs-audit-state.json');
  if (flags['monthly-tick']) {
    let st = null;
    try { st = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) { /* 无状态 = 从未成功跑过 → 到期 */ }
    if (st && st.lastSuccessAt) {
      const days = (Date.now() - new Date(st.lastSuccessAt).getTime()) / 86400000;
      if (days < 30) {
        return { ok: true, text: `月度巡检未到期(上次成功 ${st.lastSuccessAt.slice(0, 10)},${Math.floor(days)} 天前;满 30 天后触发)` };
      }
    }
  }
  const staleDays = parseInt(flags['stale-days'], 10) || 30;
  const recheckDays = parseInt(flags['recheck-days'], 10) || 90;
  const docsRoot = path.join(proj.mainRepo, 'docs');
  const board = readBoardOrNull(proj.board) || { tasks: [] };
  const taskById = new Map((board.tasks || []).map((t) => [t.id, t]));

  const files = [];
  for (const d of AUDIT_DIRS) {
    const dir = path.join(docsRoot, d);
    if (fs.existsSync(dir)) files.push(...listMd(dir));
  }

  const stale = [], recheck = [], untagged = [], legacy = [];
  let archived = 0, tagged = 0;
  for (const f of files) {
    const rel = path.relative(proj.mainRepo, f).replace(/\\/g, '/');
    const st = readStatusLine(f);
    if (!st) { untagged.push(rel); continue; }
    if (st.legacy) { legacy.push(rel); continue; } // 旧式定稿标注:不算裸奔,升级 §5.7 格式归回填战役顺手做
    const sl = st.line;
    tagged++;
    if (/已被.*取代|评估件/.test(sl)) { archived++; continue; }
    if (/正本|草案|待拍/.test(sl)) {
      const m = sl.match(CARD_RE);
      if (m) {
        const t = taskById.get(m[1]);
        if (t && t.status === '已完工' && t.dates && t.dates.done) {
          const d = daysSince(t.dates.done);
          if (d !== null && d > staleDays) stale.push(`${rel} —— 标「${(sl.match(/状态\s*[::]\s*([^·]+)/) || [, '?'])[1].trim()}」但关联卡 ${m[1]} 已完工 ${d} 天`);
        }
      }
    }
    const r = sl.match(RECHECK_RE);
    if (r) {
      const d = daysSince(r[1]);
      if (d !== null && d > recheckDays) recheck.push(`${rel} —— 最后核对 ${r[1]}(${d} 天前)`);
    }
  }

  const ym = (() => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`; })();
  const L = [];
  L.push(`═══ 文档新鲜度巡检 · 项目 ${pid} · ${ym} ═══`);
  L.push(`扫描域:docs/{${AUDIT_DIRS.join(',')}} 共 ${files.length} 篇;标准状态行 ${tagged}(其中已归档态 ${archived});旧式定稿标注 ${legacy.length};无标签 ${untagged.length}`);
  L.push('');
  L.push(`【A 疑似该转历史】${stale.length} 篇(标着现行,关联卡却完工超 ${staleDays} 天——请逐篇确认是否改标「已被 X 取代/评估件」)`);
  for (const s of stale) L.push(`  · ${s}`);
  L.push('', `【B 核对过期】${recheck.length} 篇(最后核对超 ${recheckDays} 天——请确认内容仍与事实相符后刷新日期)`);
  for (const s of recheck) L.push(`  · ${s}`);
  L.push('', `【C 无标签】${untagged.length} 篇(头部无状态行;存量回填战役范围,战役后此桶应趋零)`);
  for (const s of untagged.slice(0, 15)) L.push(`  · ${s}`);
  if (untagged.length > 15) L.push(`  · …… 另 ${untagged.length - 15} 篇(全量见报告文件)`);
  L.push('', '处置口径:本清单只是疑似名单,改标签前先看内容;拿不准的登记待拍板,别硬改。状态行规矩 = docs/开工须知.md §5.7。');

  // 报告落盘(board 同目录,本机不入库)
  const reportPath = path.join(path.dirname(proj.board), `docs-audit-${ym}.txt`);
  const full = L.join('\n') + (untagged.length > 15 ? '\n\n【C 全量清单】\n' + untagged.map((s) => '  · ' + s).join('\n') : '');
  fs.writeFileSync(reportPath, full, 'utf8');
  L.push('', `报告已写:${reportPath}`);

  // 建巡检卡(幂等)
  if (flags['create-card']) {
    const cardId = `DOCS-AUDIT-${ym}`;
    if (taskById.has(cardId)) {
      L.push(`巡检卡 ${cardId} 已存在,跳过建卡(幂等)`);
    } else if (stale.length + recheck.length + untagged.length === 0) {
      L.push('三桶全空,本月无需巡检卡 ✔');
    } else {
      cmds.add({
        _: [cardId], project: pid, registry: flags.registry,
        title: `月度文档巡检 ${ym}:疑似过期 ${stale.length} + 核对过期 ${recheck.length} + 无标签 ${untagged.length}`,
        desc: `docs-audit 探雷清单(机械比对,未判内容):A 疑似该转历史 ${stale.length} 篇 / B 核对过期 ${recheck.length} 篇 / C 无标签 ${untagged.length} 篇。完整清单:${reportPath}。施工=低档对话过清单逐篇确认改标签(§5.7 口径),拿不准的登记待拍板;完毕后重跑 docs-audit 验三桶归零并销卡。`,
        author: 'docs-audit',
        model: 'sonnet·低', // 巡检=过清单改标签的机械活,自动建卡天生带档位徽章(ADD-MODEL-GATE 配套)
      });
      L.push(`已建巡检卡 ${cardId}(未开工,待派发)`);
    }
  }

  // monthly-tick 走到这里 = 本次巡检真跑成功 → 记账,下个节拍从今天顺延 30 天
  if (flags['monthly-tick']) {
    try {
      fs.writeFileSync(statePath, JSON.stringify({ lastSuccessAt: new Date().toISOString() }), 'utf8');
      L.push(`节拍已记账:下次月度巡检自 ${new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)} 起触发`);
    } catch (e) {
      L.push(`⚠ 节拍状态写入失败(${e.message})——下次触发会再跑一遍,不丢巡检只多跑`);
    }
  }
  return { ok: true, text: L.join('\n') };
}

module.exports = { docsAudit };
