'use strict';

const isTerminal = state => ['passed', 'failed', 'cancelled', 'voided'].includes(state);

function checkedCores(raw) {
  if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) {
    throw new Error('调度授予核数无效，拒绝开跑');
  }
  return Number(raw);
}

/** 客户端 exec 一步完成挂号、排队、授予、执行与进程树回报（许可、心跳、信号下的进程树处置
 *  都由它负责）；此处只编排撤单与退出码。回执不确定仍按确定性单号幂等撤单；exec 明确完成
 *  （含它自行回报的终态，如外部撤单、排队被回收、中断收账）不再重复撤单。 */
async function runScheduled({ client, share, root, key, job, command, args,
  signals = process, log = console.error }) {
  const id = client.deriveTicketId('dashboard', key);
  let completed = false, interrupted = false, cancellation;
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
  // 进程树的中断处置由客户端 run 负责；这里登记中断并立刻按确定性单号撤单，
  // 保证排队/授予间隙收到的信号也「授予后也不开跑」；撤单幂等去重，不与客户端抢生命周期。
  const onSignal = () => { interrupted = true; if (!completed) void cancel(); };
  signals.on('SIGINT', onSignal); signals.on('SIGTERM', onSignal);
  log(`调度单 ${id}；撤单：node <共享盘>/sched/bin/sched.cjs cancel ${id} --share <共享盘>`);
  try {
    // targets 显式收窄内容指纹范围；codeRef 刻意不传：由 exec 自行在干净仓 commit 快照与
    // 脏仓内容指纹之间选择（客户端 autoCodeRef 口径），也不被客户端当成「--code-ref 钉本机」
    // 的口实——未来项目菜单/开关开放时，这个入口不被人写死在本机。
    const result = await client.exec({ share, root, project: 'dashboard', key,
      category: job.category, cores: job.cores, title: job.title, workType: job.workType,
      targets: job.targets, engine: 'codex', command, args });
    completed = true;
    return interrupted ? 130 : result.exitCode;
  } catch (error) {
    // 排队期中断在现行客户端以异常落地（旧版等到的是终态回执）：中断统一收敛为退出码 130，
    // 错误原文照旧打出来，不吞异常。
    if (interrupted) { log(error && error.message ? error.message : String(error)); return 130; }
    throw error;
  } finally {
    if (!completed) await cancel();
    if (cancellation) await cancellation;
    signals.removeListener('SIGINT', onSignal); signals.removeListener('SIGTERM', onSignal);
  }
}

module.exports = { runScheduled, checkedCores };
