/**
 * @typedef {object} MachineCapacityInput
 * @property {boolean} [online]
 * @property {number} [availableCores]
 * @property {number} [quotaCores]
 * @property {number} [grantedCores]
 * @property {number} [externalLoadCores]
 * @property {string} [ci]
 * @property {{ requestedCores?: number } | null} [reservation]
 * @property {{ capacity: number, occupied: number } | null} [agentSlots]
 */

/**
 * 核数只用于显示，派单用的原值不改。默认四舍五入到一位小数并去掉多余的 .0；
 * floor 用于“可派”口径，向下取整到一位，免得 3.96 显示成 4 核而实际接不了 4 核的单。
 * 大于 0 但不足 0.1 的值统一显示“<0.1”，既不抹成 0，也不露出浮点尾巴。
 */
export function formatCores(value, { floor = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value ?? '');
  if (value > 0 && value < 0.1) return '<0.1';
  const tenths = floor ? Math.floor(value * 10 + 1e-9) : Math.round(value * 10);
  return String(tenths / 10);
}

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
  const quotaLabel = typeof quota === 'number' && Number.isFinite(quota) && quota >= 0 ? `配额 ${formatCores(quota)} 核` : '配额未知';
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
    label: full ? '已被占满' : `空闲 ${formatCores(available, { floor: true })} 核可派`,
    detail: full
      ? `配额已用尽；可用核为 0，不能再派。${occupiedBy}配额还要计入预留与波动余量，相减的差额不等于空闲。${idleHint}`
      : `能否再派看可用核；这 ${formatCores(available, { floor: true })} 核是派单员扣除占用、预留与波动余量后给出的可派空间。`,
    barPercent,
    barLabel: barPercent === null ? '配额暂不可读，不能计算条形比例'
      : `不可再派的配额占比 ${Math.round(barPercent)}%（含占用、预留与波动余量）；可用 ${formatCores(available, { floor: true })} 核 / ${quotaLabel}，不代表实测利用率`,
  };
}

/**
 * 执行端作业槽读数（派单员转发的实测值）：capacity 正安全整数、occupied 非负安全整数。
 * @typedef {object} AgentSlotsReading
 * @property {number} capacity
 * @property {number} occupied
 */

/**
 * 只呈现派单员转发的作业槽实测值：缺键或 null 是未知，不拿准入回退值假装实测，也不把未知说成空闲；
 * 超占保留实况。作业槽与可用核是两个口径，分别说明；槽满只说明执行端槽满
 * （等在跑作业让出槽位会自行改善），本机命令不经执行端作业槽，仍可能照常派。
 * outdated 表示机器离线或读数过期，数字需注明是旧快照。不读系统时间、不修改输入。
 * @param {AgentSlotsReading | null | undefined} value
 * @param {boolean} [outdated]
 */
export function agentSlotsDisplay(value, outdated = false) {
  const known = !!value && typeof value === 'object'
    && Number.isSafeInteger(value.capacity) && value.capacity >= 1
    && Number.isSafeInteger(value.occupied) && value.occupied >= 0;
  const snapshot = outdated ? '数字为上次收到的旧快照。' : '';
  if (!known) {
    return { known: false, full: false, tone: 'muted', numbers: '未知',
      detail: `执行端未上报作业槽占用，槽满与否未知；有空闲核也不代表有空闲作业槽。${snapshot}` };
  }
  const full = value.occupied >= value.capacity;
  const scale = `占用 ${value.occupied}、容量 ${value.capacity}${value.occupied > value.capacity ? '（超占）' : ''}`;
  return {
    known: true, full, tone: full ? 'warn' : 'ok', numbers: `${value.occupied} / ${value.capacity}`,
    detail: full
      ? `执行端作业槽已满：${scale}；等在跑的作业让出槽位后会自行改善，本机命令不经执行端作业槽，仍可能照常派。${snapshot}`
      : `执行端作业槽${scale}；作业槽与可用核分开看，有空闲核也可能在等作业槽。${snapshot}`,
  };
}
