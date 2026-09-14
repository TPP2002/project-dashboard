'use strict';
const { durationSamples, sampleKey } = require('./schedLedger.cjs');

// CI 期间低优先级执行的耗时系数，待实测校准；可经 estimateTickets 的选项覆盖。
const CI_AWARE_SLOWDOWN = 1.5;
const REASONS = Object.freeze({
  ci: '被 CI 冻住，恢复时刻未知', reservation: '预留的核数还没腾出来',
  capacity: '这项任务要的核数超过了允许机器的容量', history: '还没有同类任务的历史耗时',
  unavailable: '允许使用的机器离线、读数过期，或暂时不能接活', start: '还没收到任务开跑的消息',
  paused: '任务已暂停或降速，何时恢复还不知道', load: '正在占用的核数何时能腾出来还不知道',
  overdue: '任务已超过预计耗时，何时结束还不知道', missingMachine: '找不到这项任务所在机器的最新信息',
  head: '还不知道前面的任务何时开跑',
  snapshot: '还没读到最新的调度信息', ledger: '读不到历史执行记录',
});
const unknown = (code, extra = {}) => ({ kind: 'unavailable', code, reason: REASONS[code], ...extra });
const currentAttempt = ticket => ticket.attempts.find(attempt => attempt.attemptId === ticket.currentAttemptId);
const headroom = machine => machine?.ciReserveCores === undefined ? {} : { ciHeadroom: machine.ciReserveCores };

function machineBlock(machine, nowMs) {
  if (machine.reservation?.requestedCores > 0 && machine.reservation.fulfilledCores < machine.reservation.requestedCores) return 'reservation';
  const stale = [machine.heartbeatAt, machine.loadSampledAt].some(at => !at || nowMs - Date.parse(at) > 30000);
  if (!machine.online || !machine.fresh || stale || machine.ci === 'unknown' || machine.ownerHold) return 'unavailable';
  return null;
}

function runningEstimate(ticket, machines, samples, nowMs, ciAwareSlowdown) {
  const attempt = currentAttempt(ticket), machine = machines.find(item => item.name === (attempt?.permit?.machine ?? attempt?.intent?.machine));
  if (!machine && !ticket.registerOnly) return unknown('missingMachine');
  const block = machine && machineBlock(machine, nowMs);
  if (block) return unknown(block);
  const ciAware = attempt?.permit?.ciAware === true;
  if (ticket.pauseReasons.includes('ci') && !ciAware) return unknown('ci');
  const sample = samples.get(sampleKey(ticket.request));
  if (!sample) return unknown('history');
  if (!attempt?.startedAt) return unknown('start');
  // ciAware 只解释 CI 下的低优先级，不能把真正的暂停或其他原因的降速当作继续执行。
  if (ticket.state === 'paused' || (ticket.state === 'slow' && (!ciAware || ticket.pauseReasons.some(reason => reason !== 'ci')))) return unknown('paused');
  const finishMs = Date.parse(attempt.startedAt) + sample.medianMs * (ciAware ? ciAwareSlowdown : 1);
  return { kind: 'completion', ...sample, ...(ciAware ? { slowdown: ciAwareSlowdown } : {}),
    finishAt: new Date(finishMs).toISOString(), remainingMs: Math.max(0, finishMs - nowMs), overdue: nowMs > finishMs };
}

/** 在已预约区间里找最早可容纳整段执行的位置，不让后单挤掉前单的未来核数。 */
function earliestSlot(machine, cores, durationMs, nowMs, ticketId) {
  const from = machine.protectedBy === ticketId ? nowMs : Math.max(nowMs, machine.protectedUntil);
  if (!Number.isFinite(from)) return null;
  const changes = new Map();
  // availableCores 已扣 CI 余量，不重复扣 ciReserveCores；超额时先偿还当前超出的核数。
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
  const unavailable = code => unknown(code, allowed.length === 1 ? headroom(allowed[0]) : {});
  if (entry.state === 'unsatisfiable' || (allowed.length === entry.allowedMachines.length && allowed.every(machine => machine.quotaCores < entry.requestedCores))) return unavailable('capacity');
  const qualified = allowed.filter(machine => machine.quotaCores >= entry.requestedCores);
  const ready = qualified.filter(machine => !machine.block);
  if (!ready.length) return unavailable(qualified.find(machine => machine.block === 'reservation') ? 'reservation' : 'unavailable');
  if (!ticket || ticket.state !== entry.state) {
    for (const machine of ready) machine.uncertain = 'snapshot';
    return unavailable('snapshot');
  }
  const sample = ticket && samples.get(sampleKey(ticket.request));
  if (!sample) {
    // 队首缺耗时，无法确认它何时释放；只阻止它能去的机器上的后续预测。
    for (const machine of ready) machine.uncertain = 'history';
    return unavailable('history');
  }
  const candidates = ready.filter(machine => !machine.uncertain).map(machine => ({ machine,
    at: earliestSlot(machine, entry.requestedCores, sample.medianMs, nowMs, entry.ticketId) })).filter(slot => slot.at !== null)
    .sort((a, b) => a.at - b.at || a.machine.preference - b.machine.preference || (a.machine.name < b.machine.name ? -1 : 1));
  const chosen = candidates[0];
  if (!chosen) return unavailable(ready.find(machine => machine.uncertain)?.uncertain
    || (ready.some(machine => !Number.isFinite(machine.protectedUntil) && machine.protectedBy !== entry.ticketId) ? 'head' : 'load'));
  chosen.machine.changes.push({ at: chosen.at, cores: -entry.requestedCores }, { at: chosen.at + sample.medianMs, cores: entry.requestedCores });
  for (const machine of machines) if (machine.protectedBy === entry.ticketId) machine.protectedUntil = chosen.at;
  return { kind: 'wait', ...sample, ...headroom(chosen.machine), machine: chosen.machine.name,
    startAt: new Date(chosen.at).toISOString(), waitMs: chosen.at - nowMs };
}

/** 纯投影：显式 nowMs，不写输入、不读盘/系统时钟；校准系数须为有限数且不小于 1，否则抛 RangeError。 */
function estimateTickets(snapshot, history, { ciAwareSlowdown = CI_AWARE_SLOWDOWN } = {}) {
  if (!Number.isFinite(ciAwareSlowdown) || ciAwareSlowdown < 1) throw new RangeError('CI 低优先级耗时系数必须是大于等于 1 的有限数');
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
    const estimate = runningEstimate(ticket, machines, samples, nowMs, ciAwareSlowdown);
    const attempt = currentAttempt(ticket), machine = simulated.find(item => item.name === (attempt?.permit?.machine ?? attempt?.intent?.machine));
    result[ticket.ticketId] = { ...estimate, ...headroom(machine) };
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
      result[entry.ticketId] = code ? { ...estimate, ...unknown(code) } : estimate;
    } else result[entry.ticketId] = estimate;
  }
  return result;
}

module.exports = { estimateTickets, REASONS, CI_AWARE_SLOWDOWN };
