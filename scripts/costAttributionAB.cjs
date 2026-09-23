'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

function argsOf(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith('--') || argv[i + 1] === undefined) throw new Error(`参数不完整：${key}`);
    args[key.slice(2)] = argv[i + 1];
  }
  for (const key of ['old', 'new', 'prefix', 'board']) if (!args[key]) throw new Error(`缺 --${key}`);
  for (const key of ['days', 'sample']) {
    if (args[key] !== undefined && (!Number.isInteger(Number(args[key])) || Number(args[key]) < 1)) {
      throw new Error(`--${key} 必须是正整数`);
    }
  }
  return args;
}

function evenlySample(rows, count) {
  if (rows.length <= count) return rows;
  if (count === 1) return [rows[0]];
  return Array.from({ length: count }, (_, i) => rows[Math.floor(i * (rows.length - 1) / (count - 1))]);
}

async function inspectSession(projectsRoot, prefix, sessionId, signals) {
  let first = null;
  const claims = new Set();
  const dirs = fs.readdirSync(projectsRoot).filter((name) => name.startsWith(prefix)).sort();
  for (const dir of dirs) {
    const file = path.join(projectsRoot, dir, `${sessionId}.jsonl`);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const texts = signals.signalTextsOfRow(row);
      for (const id of signals.extractCommandSignals(texts).claimIds) claims.add(id);
      if (row && row.type === 'user' && texts.length) {
        const at = typeof row.timestamp === 'string' ? row.timestamp : '';
        if (!first || (at && (!first.at || at < first.at))) first = { at, text: texts[0] };
      }
    }
  }
  return { firstUser: first ? first.text.replace(/\s+/g, ' ').slice(0, 80) : '—', claims: [...claims].sort() };
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  const oldRoot = path.resolve(args.old);
  const newRoot = path.resolve(args.new);
  const projectsRoot = path.resolve(args['projects-root'] || path.join(os.homedir(), '.claude', 'projects'));
  const boardPath = path.resolve(args.board);
  const days = Number(args.days || 7);
  const sample = Number(args.sample || 10);
  const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
  const cards = (board.tasks || []).filter((card) => card && typeof card.id === 'string')
    .map((card) => ({ id: card.id, gitBranch: Array.isArray(card.gitBranch)
      ? card.gitBranch.filter((branch) => typeof branch === 'string') : [] }));
  const cardIds = cards.map((card) => card.id);
  const bindings = require(path.join(newRoot, 'core', 'sessionBindings.cjs')).readBindings(boardPath);
  const signals = require(path.join(newRoot, 'core', 'sessionAttribution.cjs'));
  const oldUsage = require(path.join(oldRoot, 'core', 'costUsage.cjs'));
  const newUsage = require(path.join(newRoot, 'core', 'costUsage.cjs'));
  const oldTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-ab-old-'));
  const newTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-ab-new-'));
  let oldResult, newResult;
  try {
    const common = { prefixes: [args.prefix], days, projectsRoot, cardIds, cards, bindings };
    oldResult = await oldUsage.getUsage({ ...common, cachePath: path.join(oldTmp, 'cache.json') });
    newResult = await newUsage.getUsage({ ...common, cachePath: path.join(newTmp, 'cache.json') });
  } finally {
    fs.rmSync(oldTmp, { recursive: true, force: true });
    fs.rmSync(newTmp, { recursive: true, force: true });
  }
  const oldRows = oldResult.sessionRows;
  const newRows = newResult.sessionRows;
  if (oldRows.length !== newRows.length) {
    throw new Error(`新旧会话总数不等：旧 ${oldRows.length}，新 ${newRows.length}`);
  }
  const total = newRows.length;
  const pct = (n) => `${total ? (100 * n / total).toFixed(1) : '0.0'}%`;
  const oldHit = oldRows.filter((row) => row.card).length;
  const counts = { attributed: 0, multi: 0, ambiguous: 0, unattributed: 0 };
  for (const row of newRows) counts[row.attribution.status]++;
  const newHit = counts.attributed + counts.multi;
  process.stdout.write(`会话总数：${total}\n旧版判出卡：${oldHit}（${pct(oldHit)}）\n`);
  process.stdout.write(`新版：一张卡 ${counts.attributed}、多卡 ${counts.multi}、歧义 ${counts.ambiguous}、未归因 ${counts.unattributed}\n`);
  process.stdout.write(`新版判出卡：${newHit}（${pct(newHit)}）\n`);
  const eligible = newRows.filter((row) => ['attributed', 'multi'].includes(row.attribution.status))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  for (const row of evenlySample(eligible, sample)) {
    const inspected = await inspectSession(projectsRoot, args.prefix, row.sessionId, signals);
    process.stdout.write(`${row.sessionId} | ${row.attribution.status} ${row.attribution.cardIds.join('、')} | ${row.attribution.evidence}`
      + ` | 首条用户文字：${inspected.firstUser} | claim：${inspected.claims.join('、') || '—'}\n`);
  }
}

main().catch((error) => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
