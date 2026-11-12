'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ASK_PATTERNS = [
  /先(?:去)?(?:问|请示|报|找)(?:一下)?负责人/,
  /(?:问|请示|报给?|请)负责人(?:拍板|定|确认|同意|点头|放行|批)/,
  /等(?:待)?(?:负责人)?(?:拍板|放行|点头|批准|确认)(?:后|再|之后|才)?/,
  /停下(?:来)?(?:并)?(?:报告|汇报|问负责人|等(?:负责人|拍板|指令|放行|确认|我|人拍))/,
  /等我(?:说)?(?:开工|放行|确认|点头|拍板)/,
  /负责人(?:确认|同意|拍板|点头|放行)(?:后|之后|以后)(?:再|才)/,
];
const SIX_KINDS = [
  { name: '改目标', re: /改目标|加范围|砍功能|降(?:低)?(?:完成)?标准|换方向|推翻/ },
  { name: '花钱超线', re: /花钱|超线|预算/ },
  { name: '收不回的事', re: /收不回|对外发布|动生产|真数据|删数据/ },
  { name: '只有他知道或只有他能做的事', re: /只有他(?:知道|能做)|只有负责人(?:知道|能)|登录|扫码|付款/ },
  { name: '口味题', re: /口味|授权页点名/ },
  { name: '改规矩', re: /改规矩/ },
];
const NEG = /(?:不用|不必|无需|不需要|不许|不要|别|禁止|不再|不得|勿|不准|严禁|不是|而非|取消|作废|废止|删掉|拦下|拦截|扫描|检测|命中)[^。；;\n]{0,12}$/;
const META = /夹带|这类句子|类句子|的句子|句式|词表/;
const OWNER_QUOTE = /负责人[^。\n]{0,30}(?:20\d\d-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2}|\d{1,2}月\d{1,2}日|\b\d{4}\b)|(?:20\d\d-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2})[^。\n]{0,20}负责人|原话/;
const RISK = /发版|发新版|部署到(?:线上|生产|服务器|VPS|云)|上线到生产|动生产|(?:删|清)(?:除|空)?(?:生产|线上|真实?|用户|玩家)?(?:数据库|数据|存档)|删库|充值|(?:花钱|付费)(?:买|购买|订阅|开通|升级)|续费|购买(?:额度|套餐|会员|服务)/;

function splitSentences(text) {
  return String(text).split(/(?<=[。！？!?；;])|\n+/).map((s) => s.trim()).filter(Boolean);
}

function inQuotes(sentence, index) {
  const before = sentence.slice(0, index);
  for (const [open, close] of [['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’']]) {
    if (before.lastIndexOf(open) > before.lastIndexOf(close)) return true;
  }
  for (const quote of ['`', '"', "'"]) {
    if (before.split(quote).length % 2 === 0) return true;
  }
  return false;
}

function scanAsk(text) {
  const hits = [];
  for (const sentence of splitSentences(text)) {
    const match = ASK_PATTERNS.map((re) => re.exec(sentence)).find(Boolean);
    if (!match || inQuotes(sentence, match.index) || NEG.test(sentence.slice(0, match.index)) ||
        SIX_KINDS.some(({ re }) => re.test(sentence)) || META.test(sentence)) continue;
    hits.push({ rule: 'ask', sentence, match: match[0] });
  }
  return hits;
}

function scanRisk(text) {
  if (OWNER_QUOTE.test(String(text))) return [];
  const hits = [];
  for (const sentence of splitSentences(text)) {
    const match = RISK.exec(sentence);
    if (!match || inQuotes(sentence, match.index)) continue;
    const before = sentence.slice(0, match.index);
    if (NEG.test(before) || /(?:不|没|未|别|禁|勿|非)\S{0,2}$/.test(before)) continue;
    hits.push({ rule: 'risk', sentence, match: match[0] });
  }
  return hits;
}

function scanBrief(text, { kind = 'brief' } = {}) {
  if (!['card', 'brief', 'job'].includes(kind)) throw new Error('无效的 kind');
  const hits = scanAsk(text).concat(kind === 'card' ? scanRisk(text) : []);
  return { ok: hits.length === 0, hits };
}

function textOfCard(card) {
  return [card.title, card.plainTitle, card.desc, card.description].filter((s) => typeof s === 'string').join('\n');
}

function textOfTask(task) {
  const fields = [task.title, task.goal, task.background];
  for (const key of ['nonGoals', 'steps']) if (Array.isArray(task[key])) fields.push(...task[key]);
  if (Array.isArray(task.acceptance)) fields.push(...task.acceptance.map((item) => item && item.note));
  return fields.filter((s) => typeof s === 'string').join('\n');
}

function formatRejection(hits, { where = '这段文字' } = {}) {
  const lines = [`拦下:${where} 里有 ${hits.length} 句不合代理决策规矩`];
  for (const hit of hits) {
    const sentence = hit.sentence.length > 120 ? hit.sentence.slice(0, 120) + '…' : hit.sentence;
    lines.push(hit.rule === 'ask'
      ? `  · 「${sentence}」——要负责人拍板或停下等他,但同一句没写明属于六类里的哪一类`
      : `  · 「${sentence}」——写了${hit.match},但全文没引负责人的原话和日期`);
  }
  if (hits.some((hit) => hit.rule === 'ask')) {
    lines.push('改法:范围以内的事删掉这句,接单的对话自己定;确属六类之一的,在同一句写明是哪一类(改目标 / 花钱超线 / 收不回的事 / 只有他知道或只有他能做的事 / 口味题 / 改规矩)。');
    lines.push('引用或举例放进「」里不算。');
  }
  if (hits.some((hit) => hit.rule === 'risk')) lines.push('改法:引负责人的原话并带日期(例如 负责人 2026-11-11 原话「……」),或指到他在看板上答的那条决定;不需要他授权的就删掉这句。');
  return lines.join('\n');
}

function projectAdopted(repoRoot) {
  try {
    return typeof repoRoot === 'string' && repoRoot.length > 0 && fs.existsSync(path.join(repoRoot, 'docs', '授权页.md'));
  } catch (_) {
    return false;
  }
}

function main(argv) {
  const options = {};
  const usage = '用法: (--file <路径> | --text <文本>) [--kind card|brief|job] [--repo <仓根>] [--where <名字>] [--json]';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (['--file', '--text', '--kind', '--repo', '--where'].includes(arg) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) options[arg.slice(2)] = argv[++i];
    else { console.error(usage); return 2; }
  }
  if ((options.file === undefined) === (options.text === undefined) || (options.kind !== undefined && !['card', 'brief', 'job'].includes(options.kind))) {
    console.error(usage);
    return 2;
  }
  if (options.repo !== undefined && !projectAdopted(options.repo)) {
    console.log(options.json ? JSON.stringify({ ok: true, adopted: false, hits: [] }) : '未接代理决策(仓里没有 docs/授权页.md),不扫');
    return 0;
  }
  let text = options.text;
  if (options.file !== undefined) {
    try {
      text = fs.readFileSync(options.file, 'utf8');
      if (options.file.endsWith('.json') && options.kind === 'job') text = textOfTask(JSON.parse(text.replace(/^\uFEFF/, '')));
    } catch (err) {
      console.error(err.message);
      return 2;
    }
  }
  const result = scanBrief(text, { kind: options.kind });
  if (result.ok) {
    if (options.json) console.log(JSON.stringify({ ok: true, adopted: true, hits: [] }));
    return 0;
  }
  const message = formatRejection(result.hits, { where: options.where || (options.file && path.basename(options.file)) || '这段文字' });
  if (options.json) console.log(JSON.stringify({ ok: false, adopted: true, hits: result.hits, message }));
  else console.error(message);
  return 3;
}

module.exports = { splitSentences, scanAsk, scanRisk, scanBrief, textOfTask, textOfCard, formatRejection, projectAdopted, ASK_PATTERNS, SIX_KINDS };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
