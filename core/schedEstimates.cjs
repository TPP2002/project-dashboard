'use strict';
const { durationSamples, sampleKey } = require('./schedLedger.cjs');

const REASONS = Object.freeze({
  ci: 'CI 在跑', reservation: '预留未兑现', capacity: '需求超过容量', history: '没有历史样本',
  unavailable: '允许的机器离线、数据过期或暂不可派', start: '尚未收到开跑回报',
  paused: '执行已暂停或处于低速，恢复时刻未知', load: '现有占用的释放时刻未知',
  overdue: '在跑执行已超出平均耗时', missingMachine: '执行所在机器已不在快照中',
  head: '队首单子的开跑时刻未知',
  snapshot: '调度快照不可读、已过期或尚未同步', ledger: '调度台账不可读',
});
const unknown = (code, extra = {}) => ({ kind: 'unavailable', code, reason: REASONS[code], ...extra });
const currentAttempt = ticket => ticket.attempts.find(attempt => attempt.attemptId === ticket.currentAttemptId);

function machineBlock(machine, nowMs) {
  if (machine.ci === 'active') return 'ci';
  if (machine.reservation?.requestedCores > 0 && machine.reservation.fulfilledCores < machine.reservation.requestedCores) return 'reservation';
  const stale = [machine.heartbeatAt, machine.loadSampledAt].some(at => !at || nowMs - Date.parse(at) > 30000);
  if (!machine.online || !machine.fresh || stale || machine.ci !== 'idle' || machine.ownerHold) return 'unavailable';
  return null;
}

function runningEstimate(ticket, machines, samples, nowMs) {
  const attempt = currentAttempt(ticket), machine = machines.find(item => item.name === (attempt?.permit?.machine ?? attempt?.intent?.machine));
  if (!machine && !ticket.registerOnly) return unknown('missingMachine');
  const block = machine && machineBlock(machine, nowMs);
  if (block) return unknown(block);
  if (ticket.pauseReasons.includes('ci')) return unknown('ci');
  const sample = samples.get(sampleKey(ticket.request));
  if (!sample) return unknown('history');
  if (!attempt?.startedAt) return unknown('start');
  if (['paused', 'slow'].includes(ticket.state)) return unknown('paused');
  const finishMs = Date.parse(attempt.startedAt) + sample.medianMs;
  return { kind: 'completion', ...sample, finishAt: new Date(finishMs).toISOString(), remainingMs: Math.max(0, finishMs - nowMs), overdue: nowMs > finishMs };
}

/** 在已预约区间里找最早可容纳整段执行的位置，不让后单挤掉前单的未来核数。 */
function earliestSlot(machine, cores, durationMs, nowMs, ticketId) {
  const from = machine.protectedBy === ticketId ? nowMs : Math.max(nowMs, machine.protectedUntil);
  if (!Number.isFinite(from)) return null;
  const changes = new Map();
  // 超额时先偿还当前超出的核数，释放一个核不一定立刻得到一个可派核。
  let free = machine.availableCores - (machine.overCommitted ? Math.max(0,
    machine.grantedCores + machine.externalLoadCores + (machine.reservation?.requestedCores || 0) - machine.quotaCores) : 0);
  for (const change of machine.changes) {
    if (change.at <= from) free += change.cores;
    else changes.set(change.at, (changes.get(change.at) || 0) + change.cores);
  }
  let start = free >= cores ? from : null;
  for (const [at, delta] of [...changes].sort((a, b) => a[0] - b[0])) {
    if (start !== null && start + durationMs <= at) return start;
    free += delta;
    if (free < cores) start = null;
    else if (start === null) start = at;
  }
  return start;
}

function queueEstimate(entry, ticket, machines, samples, nowMs) {
  const allowed = machines.filter(machine => entry.allowedMachines.includes(machine.name));
  if (entry.state === 'unsatisfiable' || (allowed.length === entry.allowedMachines.length && allowed.every(machine => machine.quotaCores < entry.requestedCores))) return unknown('capacity');
  const qualified = allowed.filter(machine => machine.quotaCores >= entry.requestedCores);
  const ready = qualified.filter(machine => !machine.block);
  if (!ready.length) return unknown(qualified.find(machine => machine.block === 'ci') ? 'ci'
    : qualified.find(machine => machine.block === 'reservation') ? 'reservation' : 'unavailable');
  if (!ticket || ticket.state !== entry.state) {
    for (const machine of ready) machine.uncertain = 'snapshot';
    return unknown('snapshot');
  }
  const sample = ticket && samples.get(sampleKey(ticket.request));
  if (!sample) {
    // 队首缺耗时，无法确认它何时释放；只阻止它能去的机器上的后续预测。
    for (const machine of ready) machine.uncertain = 'history';
    return unknown('history');
  }
  const candidates = ready.filter(machine => !machine.uncertain).map(machine => ({ machine,
    at: earliestSlot(machine, entry.requestedCores, sample.medianMs, nowMs, entry.ticketId) })).filter(slot => slot.at !== null)
    .sort((a, b) => a.at - b.at || a.machine.preference - b.machine.preference || (a.machine.name < b.machine.name ? -1 : 1));
  const chosen = candidates[0];
  if (!chosen) return unknown(ready.find(machine => machine.uncertain)?.uncertain
    || (ready.some(machine => !Number.isFinite(machine.protectedUntil) && machine.protectedBy !== entry.ticketId) ? 'head' : 'load'));
  chosen.machine.changes.push({ at: chosen.at, cores: -entry.requestedCores }, { at: chosen.at + sample.medianMs, cores: entry.requestedCores });
  for (const machine of machines) if (machine.protectedBy === entry.ticketId) machine.protectedUntil = chosen.at;
  return { kind: 'wait', ...sample, machine: chosen.machine.name, startAt: new Date(chosen.at).toISOString(), waitMs: chosen.at - nowMs };
}

/** 纯投影：输入完整快照、台账读取结果和显式 nowMs；不写输入、不读盘、不读取系统时钟。 */
function estimateTickets(snapshot, history) {
  const { nowMs } = snapshot;
  const tickets = snapshot.tickets ?? [], queue = snapshot.queue ?? [], machines = snapshot.machines ?? [];
  const ids = [...new Set([...queue.map(entry => entry.ticketId), ...tickets.filter(ticket => ['granted', 'running', 'paused', 'slow'].includes(ticket.state)).map(ticket => ticket.ticketId)])];
  const heartbeatMs = Date.parse(snapshot.heartbeatAt);
  const stale = !Number.isFinite(nowMs) || !snapshot.readable || !Number.isFinite(heartbeatMs) || nowMs - heartbeatMs > 60000
    || tickets.some(ticket => ticket.lastSeq > snapshot.cursorSeq);
  if (stale || !history?.readable) return Object.fromEntries(ids.map(id => [id, unknown(stale ? 'snapshot' : 'ledger')]));
  const events = history.events.filter(event => event.seq <= snapshot.cursorSeq);
  const samples = durationSamples(tickets, events, nowMs), result = {};
  const simulated = machines.map(machine => {
    const protectedBy = snapshot.locks?.find(lock => lock.machine === machine.name && queue.some(entry => entry.ticketId === lock.byTicketId && entry.state === 'queued'))?.byTicketId;
    return { ...machine, block: machineBlock(machine, nowMs), changes: [], uncertain: null, releaseBudget: machine.grantedCores,
      protectedBy, protectedUntil: protectedBy ? Infinity : nowMs };
  });
  for (const ticket of tickets.filter(item => ['granted', 'running', 'paused', 'slow'].includes(item.state))) {
    const estimate = runningEstimate(ticket, machines, samples, nowMs);
    result[ticket.ticketId] = estimate;
    const attempt = currentAttempt(ticket), machine = simulated.find(item => item.name === (attempt?.permit?.machine ?? attempt?.intent?.machine));
    if (!machine || ticket.registerOnly || !attempt?.grantedCores) continue;
    const releasing = Math.min(attempt.grantedCores, machine.releaseBudget);
    machine.releaseBudget -= releasing;
    if (estimate.kind === 'completion' && !estimate.overdue) machine.changes.push({ at: nowMs + estimate.remainingMs, cores: releasing });
    // 超时或未知执行保持占用；已有空闲核仍可用，只有需要释放这些核时才报告原因。
    else machine.releaseUnknown = estimate.overdue ? 'overdue' : estimate.code;
  }
  const byId = new Map(tickets.map(ticket => [ticket.ticketId, ticket]));
  for (const entry of [...queue].sort((a, b) => a.position - b.position)) {
    const estimate = queueEstimate(entry, byId.get(entry.ticketId), simulated, samples, nowMs);
    if (estimate.kind === 'unavailable' && estimate.code === 'load') {
      const code = simulated.find(machine => entry.allowedMachines.includes(machine.name) && machine.releaseUnknown)?.releaseUnknown;
      result[entry.ticketId] = code ? unknown(code) : estimate;
    } else result[entry.ticketId] = estimate;
  }
  return result;
}

module.exports = { estimateTickets, REASONS };
