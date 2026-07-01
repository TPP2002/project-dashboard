'use strict';
/**
 * importCmd.cjs —— 从 INDEX.md 半自动生成 board 骨架（治本 R3）。
 * 先剥 ~~删除线~~（作废勘误），只抽【可靠字段】(id/title/status/branch/PR/commit/date/doc)，
 * 语义字段(decisions/deps/wave/bot/tests/禁区)一律留空、交 backfill 人工补。默认 --dry-run 不落盘。
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

/** 从"核实结论"文字判定 status 枚举 */
function statusFromText(t) {
  if (/暂缓|被卡/.test(t)) return '暂缓';
  if (/压轴|殿后|排在所有.*之后/.test(t)) return '压轴';
  if (/施工中/.test(t)) return '施工中';
  if (/可复工/.test(t)) return '可复工';
  if (/待拍板/.test(t)) return '待拍板';
  if (/立项完成|立项·待施工|待施工/.test(t)) return '待开工';
  if (/已完工|合入\s*main|全案完工/.test(t)) return '已完工';
  if (/待开工|从未开工|未开工/.test(t)) return '待开工';
  return '未开工';
}

/** 解析 INDEX §一 总表 → tasks[]。返回 {tasks, revoked} */
function parseIndexTable(md) {
  const revoked = [];
  const lines = md.split(/\r?\n/).map((l) => {
    const stripped = stripRevoked(l);
    if (stripped !== l) revoked.push(l.trim());
    return stripped;
  });
  // 定位 §一 表格：从 '## 一' 到下一个 '## '
  let start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s*一[、.]/.test(lines[i])) start = i;
    else if (start >= 0 && /^##\s/.test(lines[i]) && i > start) { end = i; break; }
  }
  const idRe = /^\|\s*(P\d+|HOTFIX[-\w]*|QT-\d+)\s*\|/;
  const tasks = [];
  for (let i = (start >= 0 ? start : 0); i < end; i++) {
    const raw = lines[i];
    if (!idRe.test(raw)) continue;
    const cols = raw.split('|').map((s) => s.trim()); // ['', id, 方案链接, 核实结论, 一句话现状, '']
    const id = cols[1];
    const linkM = (cols[2] || '').match(/\[([^\]]+)\]\(([^)]+)\)/);
    const title = linkM ? linkM[1] : (cols[2] || id);
    const docFile = linkM ? linkM[2] : null;
    const verdict = cols[3] || '';
    const desc = cols.slice(4, -1).join('|').trim() || (cols[4] || ''); // 防 desc 内含 |
    const status = statusFromText(verdict);
    const blob = verdict + ' ' + desc;
    const date = (blob.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
    const branches = [...new Set([...blob.matchAll(/stock-r\d+-\d+/g)].map((m) => m[0]))];
    const prs = [...new Set([...blob.matchAll(/PR\s?#?(\d+)|#(\d+)/g)].map((m) => Number(m[1] || m[2])).filter(Boolean))];
    const commits = [...new Set([...blob.matchAll(/\b([0-9a-f]{7,40})\b/g)].map((m) => m[1]).filter((s) => /[a-f]/.test(s)))];
    tasks.push({
      id, title, description: desc, status,
      percent: status === '已完工' ? 100 : 0, wave: 0,
      dates: { design: null, start: null, done: status === '已完工' ? date : null },
      gitBranch: branches, worktree: [], prNumbers: prs, commitShas: commits,
      decisions: [], deps: { dependsOn: [], blockedBy: [], relatedTasks: [] },
      docs: docFile ? ['docs/plans/股市清零工程/' + docFile] : [],
    });
  }
  return { tasks, revoked };
}

function importCmd(flags) {
  const proj = resolveProj(flags);
  const from = flags.from ? path.resolve(flags.from) : path.join(proj.docsRoot, 'INDEX.md');
  const md = fs.readFileSync(from, 'utf8');
  const { tasks, revoked } = parseIndexTable(md);
  if (!tasks.length) throw new Error(`未从 ${from} 的 §一 总表解析出任务（检查表格格式）`);

  const board = emptyBoard({ id: proj.id, name: proj.name, mainRepo: proj.mainRepo });
  board.tasks = tasks;
  board.activity = [{
    ts: new Date().toISOString(), author: 'import', type: 'note',
    text: `import 从 ${path.basename(from)} 抽 ${tasks.length} 个任务；语义字段(decisions/deps/wave/bot/tests/禁区)待 backfill 人工补；剥离作废(删除线)条目 ${revoked.length} 处`,
    taskId: null,
  }];
  assertValid(board); // 骨架也必须过校验

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
