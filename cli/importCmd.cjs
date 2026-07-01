'use strict';
/**
 * importCmd.cjs —— 从任务台账(INDEX.md / BOARD.md 等)半自动生成 board 骨架（治本 R3）。
 * 通用解析：扫全文任意 markdown 表格，凡第一列是任务号(P01 / M0 / W1 / HOTFIX / QT 等)的行即一条任务；
 * 状态从整行判、标题取第二列(去链接)、文档路径按项目自适应。只抽可靠字段，语义字段留 backfill。默认 --dry-run。
 */
const fs = require('node:fs');
const path = require('node:path');
const { resolveProject, REGISTRY_PATH } = require('../core/resolveProject.cjs');
const { emptyBoard, assertValid } = require('../core/boardSchema.cjs');
const { atomicWriteJsonSync } = require('../core/atomicWrite.cjs');
const { withLock } = require('../core/lock.cjs');

function resolveProj(flags) {
  return resolveProject(flags.project, { registryPath: flags.registry ? path.resolve(flags.registry) : REGISTRY_PATH });
}

/** 剥删除线/作废标记（不静默丢，调用方可收集） */
function stripRevoked(line) {
  return line.replace(/~~[^~]*~~/g, '').replace(/<del>[\s\S]*?<\/del>/gi, '');
}

/** 从状态文字判定 status 枚举（兼容 A 股"已完工/待开工/被卡"与 Questline"就位/已入main/🟡进行中/未认领"） */
function statusFromText(t) {
  if (/暂缓|被卡/.test(t)) return '暂缓';
  if (/压轴|殿后|排在所有.*之后/.test(t)) return '压轴';
  if (/待拍板/.test(t)) return '待拍板';
  if (/可复工/.test(t)) return '可复工';
  if (/施工中|🔨/.test(t)) return '施工中';
  if (/立项完成|立项·待施工|待施工/.test(t)) return '待开工';
  if (/已完工|合入\s*main|全案完工|已入\s*main|基本就位|就位|✅\s*完成|\b完成\b/.test(t)) return '已完工';
  if (/🟡|进行中|契约.*冻结|未认领|待建/.test(t)) return '施工中';
  if (/待开工|从未开工|未开工/.test(t)) return '待开工';
  return '未开工';
}

/**
 * 解析任务台账 → tasks[]。扫全文表格，第一列匹配任务号的行即一条任务。
 * @param {string} md 台账全文
 * @param {string} [docPrefix] 文档链接前缀（=台账文件相对 docsRoot 的目录），A 股为 docs/plans/股市清零工程、根级台账为空
 */
function parseIndexTable(md, docPrefix = '') {
  const revoked = [];
  const lines = md.split(/\r?\n/).map((l) => {
    const stripped = stripRevoked(l);
    if (stripped !== l) revoked.push(l.trim());
    return stripped;
  });
  const idRe = /^(P\d+|M\d+|W\d+|HOTFIX[-\w]*|QT-?\d+)$/i; // 任务号：A 股 P/HOTFIX/QT + Questline M/W
  const tasks = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw[0] !== '|') continue; // 只看表格行
    const cols = raw.split('|').map((s) => s.trim()); // ['', id, ..., '']
    const id = cols[1];
    if (!id || !idRe.test(id) || seen.has(id)) continue; // 第一列非任务号(表头/分支表)→跳过；去重取先出现
    seen.add(id);
    const c2 = cols[2] || '';
    const linkM = c2.match(/\[([^\]]+)\]\(([^)]+)\)/);
    const title = linkM ? linkM[1] : (c2 || id);
    const docFile = linkM ? linkM[2] : null;
    const desc = (cols[cols.length - 2] || '').trim(); // 最后一个数据列 = 现状一句话
    const statusBlob = cols.slice(2, Math.max(3, cols.length - 2)).join(' '); // 前面各列(排除末尾长 desc)判状态
    const status = statusFromText(statusBlob);
    const blob = cols.slice(2).join(' ');
    const date = (blob.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
    const branches = [...new Set([...blob.matchAll(/stock-r\d+-\d+|claude\/[\w-]+/g)].map((m) => m[0]))];
    const prs = [...new Set([...blob.matchAll(/PR\s?#?(\d+)|#(\d+)/g)].map((m) => Number(m[1] || m[2])).filter(Boolean))];
    const commits = [...new Set([...blob.matchAll(/\b([0-9a-f]{7,40})\b/g)].map((m) => m[1]).filter((s) => /[a-f]/.test(s)))];
    tasks.push({
      id, title, description: desc, status,
      percent: status === '已完工' ? 100 : 0, wave: 0,
      dates: { design: null, start: null, done: status === '已完工' ? date : null },
      gitBranch: branches, worktree: [], prNumbers: prs, commitShas: commits,
      decisions: [], deps: { dependsOn: [], blockedBy: [], relatedTasks: [] },
      docs: docFile ? [docPrefix ? docPrefix + '/' + docFile : docFile] : [],
    });
  }
  return { tasks, revoked };
}

function importCmd(flags) {
  const proj = resolveProj(flags);
  // 默认台账文件：docsRoot 下的 INDEX.md 或 BOARD.md（谁在用谁）
  let from = flags.from ? path.resolve(flags.from) : path.join(proj.docsRoot, 'INDEX.md');
  if (!flags.from && !fs.existsSync(from)) {
    const alt = path.join(proj.docsRoot, 'BOARD.md');
    if (fs.existsSync(alt)) from = alt;
  }
  const md = fs.readFileSync(from, 'utf8');
  const docPrefix = path.relative(proj.docsRoot, path.dirname(from)).replace(/\\/g, '/');
  const { tasks, revoked } = parseIndexTable(md, docPrefix);
  if (!tasks.length) throw new Error(`未从 ${from} 解析出任务表格（需有"第一列是任务号 P01/M0/HOTFIX… 的 markdown 表格"）`);

  const board = emptyBoard({ id: proj.id, name: proj.name, mainRepo: proj.mainRepo });
  board.tasks = tasks;
  board.activity = [{
    ts: new Date().toISOString(), author: 'import', type: 'note',
    text: `import 从 ${path.basename(from)} 抽 ${tasks.length} 个任务；语义字段(decisions/deps/wave/bot/tests/禁区)待 backfill 补；剥离作废(删除线)条目 ${revoked.length} 处`,
    taskId: null,
  }];
  assertValid(board);

  const summary = tasks.map((t) => `  ${String(t.id).padEnd(8)} ${String(t.status).padEnd(5)} ${t.gitBranch.join(',') || '-'}  PR${t.prNumbers.join(',') || '-'}  ${t.title}`).join('\n');
  if (flags['dry-run']) {
    return { ok: true, dryRun: true, count: tasks.length, revoked: revoked.length,
      text: `[dry-run] 将抽 ${tasks.length} 个任务（未落盘）· 剥离作废 ${revoked.length} 处\n可靠字段(id/title/status/branch/PR/commit/date/doc)已填；语义字段留待 backfill：\n${summary}` };
  }
  fs.mkdirSync(path.dirname(proj.board), { recursive: true });
  withLock(proj.lock, () => { atomicWriteJsonSync(proj.board, board); });
  return { ok: true, count: tasks.length, text: `✔ import 完成：${tasks.length} 个任务写入 ${proj.board}\n语义字段待 backfill 补齐（decisions/deps/wave/bot/tests/禁区）。` };
}

module.exports = { importCmd, parseIndexTable, statusFromText, stripRevoked };
