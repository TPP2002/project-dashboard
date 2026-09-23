'use strict';

const isTerminal = state => ['passed', 'failed', 'cancelled', 'voided'].includes(state);

function checkedCores(raw) {
  if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) {
    throw new Error('调度授予核数无效，拒绝开跑');
  }
  return Number(raw);
}

/** 客户端负责许可、心跳和进程树；此处只编排生命周期。回执不确定仍按确定性单号撤单。 */
async function runScheduled({ client, share, root, key, job, command, args,
  signals = process, log = console.error }) {
  const id = client.deriveTicketId('dashboard', key);
  let submitted = false, completed = false, interrupted = false, cancellation;
  const cancel = () => cancellation ??= client.cancel(id, { share, reason: '看板任务中断或未能开跑' })
    .then(result => {
      if (result.exitCode) throw new Error(result.reason || `撤单退出码 ${result.exitCode}`);
    }).catch(async error => {
      // 外部撤单或完成可先于本次 cancel 回执；只有读到真实终态才免除误报警。
      try {
        if (isTerminal((await client.status(id, { share })).state)) return;
      } catch (readError) {
        error = new Error(`${error.message}；终态核对失败：${readError.message}`);
      }
      log(`撤单未确认：${error.message}；请执行 sched.cjs cancel ${id} --share ${share}`);
    });
  const onSignal = () => { interrupted = true; if (submitted) void cancel(); };
  signals.on('SIGINT', onSignal); signals.on('SIGTERM', onSignal);
  try {
    const receipt = await client.submit({ share, root, project: 'dashboard', key,
      category: job.category, cores: job.cores, title: job.title, workType: job.workType,
      targets: job.targets, codeRef: 'content:auto', engine: 'codex' });
    submitted = true;
    log(`调度单 ${id}；撤单：node <共享盘>/sched/bin/sched.cjs cancel ${id} --share <共享盘>`);
    if (receipt.exitCode) return receipt.exitCode;
    if (interrupted) return 130;
    const granted = await client.waitFor(id, { share, until: 'granted' });
    if (isTerminal(granted.ticket?.state)) completed = true;
    if (interrupted) return 130;
    if (completed) return granted.exitCode;
    if (granted.exitCode) return granted.exitCode;
    const result = await client.run(id, { share, root, command, args });
    completed = true;
    return interrupted ? 130 : result.exitCode;
  } finally {
    if (!completed) await cancel();
    if (cancellation) await cancellation;
    signals.removeListener('SIGINT', onSignal); signals.removeListener('SIGTERM', onSignal);
  }
}

module.exports = { runScheduled, checkedCores };
