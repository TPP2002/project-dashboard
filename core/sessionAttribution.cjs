'use strict';

const ATTRIBUTION_API_VERSION = 1;
const TRUNK_BRANCHES = Object.freeze(['main', 'master', 'HEAD']);
const BINDINGS_FILE = 'session-bindings.jsonl';
const CLAIM_RE = /\bclaim\s+([A-Z0-9]+(?:-[A-Z0-9]+)+)/g;
const BRANCH_FLAG_RE = /--branch\s+([^\s"']+)/g;

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function signalTextsOfRow(row) {
  if (!row || typeof row !== 'object' || !['user', 'assistant'].includes(row.type)) return [];
  const content = row.message && row.message.content;
  if (typeof content === 'string') return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  const texts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) texts.push(block.text);
    if (row.type === 'assistant' && block.type === 'tool_use'
      && block.input && typeof block.input.command === 'string' && block.input.command.trim()) {
      texts.push(block.input.command);
    }
  }
  return texts;
}

function extractCommandSignals(texts) {
  const claimIds = [];
  const branchFlags = [];
  for (const text of Array.isArray(texts) ? texts : []) {
    if (typeof text !== 'string') continue;
    for (const match of text.matchAll(CLAIM_RE)) claimIds.push(match[1]);
    for (const match of text.matchAll(BRANCH_FLAG_RE)) branchFlags.push(match[1]);
  }
  return { claimIds: sortedUnique(claimIds), branchFlags: sortedUnique(branchFlags) };
}

function parseBindings(text) {
  const bindings = Object.create(null);
  if (typeof text !== 'string') return bindings;
  for (const line of text.split(/\r?\n/)) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || typeof record.sessionId !== 'string' || !record.sessionId.trim()
      || typeof record.taskId !== 'string' || !record.taskId.trim()) continue;
    (bindings[record.sessionId] ||= []).push(record.taskId);
  }
  for (const sessionId of Object.keys(bindings)) bindings[sessionId] = sortedUnique(bindings[sessionId]);
  return bindings;
}

function attributeSession(session, cards, bindings, opts = {}) {
  const sessionId = session.sessionId;
  const allCards = Array.isArray(cards) ? cards : [];
  const cardIds = new Set(allCards.map((card) => card && card.id).filter((id) => typeof id === 'string'));
  const trunk = new Set(opts.trunkBranches === undefined ? TRUNK_BRANCHES : opts.trunkBranches);
  const unknown = new Set();
  const result = (status, level, ids, evidence) => ({
    sessionId, status, level,
    cardIds: status === 'ambiguous' ? [] : sortedUnique(ids),
    candidates: sortedUnique(ids), unknownCards: sortedUnique(unknown),
    evidence: `${evidence}${unknown.size ? `；提到的卡号 ${sortedUnique(unknown).join('、')} 不在看板上` : ''}`,
  });

  const bound = [];
  const boundIds = bindings && bindings[sessionId];
  for (const id of Array.isArray(boundIds) ? boundIds : []) {
    if (cardIds.has(id)) bound.push(id);
    else unknown.add(id);
  }
  const bindingHits = sortedUnique(bound);
  if (bindingHits.length) return result(bindingHits.length === 1 ? 'attributed' : 'multi', 'binding', bindingHits, '开工时 claim/done 记下的绑定');

  const branchHits = new Set();
  const sharedBranches = [];
  const matchedBranches = [];
  for (const branch of sortedUnique((session.branches || []).filter((b) => typeof b === 'string' && !trunk.has(b)))) {
    const hits = sortedUnique(allCards.filter((card) => card && Array.isArray(card.gitBranch)
      && card.gitBranch.includes(branch) && cardIds.has(card.id)).map((card) => card.id));
    if (hits.length) matchedBranches.push(branch);
    if (hits.length > 1) sharedBranches.push(branch);
    for (const id of hits) branchHits.add(id);
  }
  if (branchHits.size) {
    const hits = sortedUnique(branchHits);
    if (hits.length === 1) return result('attributed', 'branch', hits, `分支 ${matchedBranches.join('、')} 命中`);
    if (sharedBranches.length) return result('ambiguous', 'branch', hits, `分支 ${sharedBranches.join('、')} 同时挂在多张卡上`);
    return result('multi', 'branch', hits, `在 ${matchedBranches.length} 个分支上各属一张卡`);
  }

  const commandHits = new Set();
  for (const id of session.claimIds || []) {
    if (cardIds.has(id)) commandHits.add(id);
    else unknown.add(id);
  }
  for (const branch of session.branchFlags || []) {
    if (trunk.has(branch)) continue;
    for (const card of allCards) {
      if (card && cardIds.has(card.id) && Array.isArray(card.gitBranch) && card.gitBranch.includes(branch)) commandHits.add(card.id);
    }
  }
  if (commandHits.size) {
    const hits = sortedUnique(commandHits);
    return result(hits.length === 1 ? 'attributed' : 'ambiguous', 'command', hits, '会话文字里的 claim / --branch 命中');
  }
  return result('unattributed', 'none', [], '分支（已排除主干）、命令文字都没命中任何卡');
}

module.exports = { ATTRIBUTION_API_VERSION, TRUNK_BRANCHES, BINDINGS_FILE,
  signalTextsOfRow, extractCommandSignals, parseBindings, attributeSession };
