/**
 * @typedef {object} MachineCapacityInput
 * @property {boolean} [online]
 * @property {number} [availableCores]
 * @property {number} [quotaCores]
 * @property {number} [grantedCores]
 * @property {number} [externalLoadCores]
 * @property {string} [ci]
 * @property {{ requestedCores?: number } | null} [reservation]
 */

function unavailable(kind, label, detail) {
  return { kind, label, detail, tone: 'muted', barPercent: null, barLabel: `${label}；没有有效的可派配额比例` };
}

/**
 * 只呈现派单员已经给出的可用核，不用配额减占用重算；条形表示不可再派的配额，包含预留和波动余量。
 * stale 由调用方沿用既有心跳/负载时效判据传入；不读系统时间、不修改输入。
 * @param {MachineCapacityInput | null | undefined} machine
 * @param {boolean} stale
 */
export function machineCapacity(machine, stale = true) {
  if (!machine || typeof machine.online !== 'boolean') {
    return unavailable('unknown', '状态暂不可读', '尚未读到机器状态，暂不能判断是否可派。');
  }
  if (!machine.online) return unavailable('offline', '离线', '这台机器不参与派单；下方数字为上次收到的记录。');
  if (stale) return unavailable('stale', '数据过期', '心跳或负载采样已过期，暂不能判断是否可派；下方数字为旧快照。');

  const available = machine.availableCores, quota = machine.quotaCores;
  if (typeof available !== 'number' || !Number.isFinite(available) || available < 0) {
    return unavailable('unknown', '可用核未知', '缺少有效的可用核数，暂不能判断是否可派；不能用配额减占用来代替。');
  }
  const full = available === 0;
  const quotaLabel = typeof quota === 'number' && Number.isFinite(quota) && quota >= 0 ? `配额 ${quota} 核` : '配额未知';
  const barPercent = full ? 100 : typeof quota === 'number' && Number.isFinite(quota) && quota > 0
    ? Math.max(0, Math.min(100, (1 - available / quota) * 100)) : null;
  const occupants = [];
  if (machine.grantedCores > 0) occupants.push('已派任务');
  if (machine.externalLoadCores > 0) occupants.push('未接入调度的占用');
  if (machine.reservation?.requestedCores > 0) occupants.push('负责人预留');
  const occupiedBy = occupants.length ? `当前配额中有${occupants.join('、')}。` : '';
  const idleHint = machine.ci === 'idle' ? 'CI 空闲不代表机器可派。' : '';
  return {
    kind: full ? 'full' : 'available', tone: full ? 'warn' : 'ok',
    label: full ? '已被占满' : `空闲 ${available} 核可派`,
    detail: full
      ? `配额已用尽；可用核为 0，不能再派。${occupiedBy}配额还要计入预留与波动余量，相减的差额不等于空闲。${idleHint}`
      : `能否再派看可用核；这 ${available} 核是派单员扣除占用、预留与波动余量后给出的可派空间。`,
    barPercent,
    barLabel: barPercent === null ? '配额暂不可读，不能计算条形比例'
      : `不可再派的配额占比 ${Math.round(barPercent)}%（含占用、预留与波动余量）；可用 ${available} 核 / ${quotaLabel}，不代表实测利用率`,
  };
}
