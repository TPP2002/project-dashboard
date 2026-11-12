import { beijingClock, beijingDateTime } from './resourcesFormat'
import type { PerksState, PerksToday, PerksPlatform } from '@/api/perks'

export function statusTone(status: string | null): 'ok' | 'warn' | 'n' {
  if (['claimed', 'already', 'visited'].includes(status || '')) return 'ok'
  if (['need-login', 'captcha', 'not-found', 'unconfirmed', 'error'].includes(status || '')) return 'warn'
  return 'n'
}
export function todayView(today: PerksToday | null) {
  if (!today) return { text: '今天还没跑', tone: 'n', time: '', detail: '' }
  const tone = statusTone(today.status)
  return { text: today.statusName, tone, time: today.time || '', detail: tone === 'warn' ? today.detail || '' : '' }
}
export function weekCells(last7: PerksPlatform['last7']) {
  return last7.map(day => ({ tone: day.status === null ? 'none' : statusTone(day.status), label: `${day.date.slice(5)} ${day.status === null ? '没跑' : day.statusName}` }))
}
export function autoLabel(runTimes: string[]) { return `每天 ${runTimes.join('、')} 自动领` }
export function clock(iso: string, todayDate: string) {
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)) return ''
  const date = new Date(parsed + 8 * 3600_000).toISOString().slice(0, 10)
  return (date === todayDate ? beijingClock(iso) : beijingDateTime(iso)) || ''
}
export interface PerksLine { kind: string; text: string; canStop: boolean; canRetry: boolean; progress: number | null }
export function statusLine(state: PerksState, nowMs: number, note: string): PerksLine {
  const result = (kind: string, text: string, canStop = false, canRetry = false, progress: number | null = null): PerksLine => ({ kind, text, canStop, canRetry, progress })
  const { activity, job, lastRun } = state
  if (activity?.stopping) return result('stopping', '正在停止…')
  if (activity?.kind === 'run') {
    const started = Date.parse(activity.startedAt)
    const seconds = Number.isFinite(started) ? Math.max(0, Math.floor((nowMs - started) / 1000)) : 0
    if (activity.phase === 'queued') return result('queued', `在排队，轮到就开始。已等 ${seconds} 秒。`, true)
    if (activity.progress) {
      const p = activity.progress
      return result('running', `正在领取：${p.accountName} · ${p.platformName}（第 ${p.index} 家，共 ${p.total} 家），已用 ${seconds} 秒。`, true, false, p.total > 0 ? Math.max(0, Math.min(1, p.index / p.total)) : 0)
    }
    return result('running', `正在领取，已用 ${seconds} 秒。`, true)
  }
  if (activity?.kind === 'login') {
    const text = !activity.own ? '登录窗口开着。登完关掉那个 Chrome 窗口，或点「停止」。' : job?.label === '登录各家' ? '登录窗口已经打开。逐个标签页登录，全部登完关掉那个 Chrome 窗口。' : `${job?.label || ''}的登录页已经打开，登完关掉那个 Chrome 窗口。`
    return result('login', text, true)
  }
  if (activity?.kind === 'probe') return result('busy', '正在处理…')
  if (note) return result('note', note)
  if (job && job.finishedAt !== null) {
    if (job.stopped) return result('stopped', job.kind === 'run' && lastRun?.outcome === 'stopped' ? `已停止。跑了 ${lastRun.ran} 家，剩下 ${lastRun.total - lastRun.ran} 家没跑。` : '已停止。')
    if (job.exitCode !== 0) return result('failed', `没办成：${job.reason}`, false, true)
    if (job.kind === 'run') return result('done', `跑完了：今天已领 ${state.summary.done} 家，要你处理 ${state.summary.action} 家，还没校准 ${state.summary.unverified} 家。`)
    if (job.kind === 'login') return result('done', '登录窗口已关。点「现在领一次」试试能不能领到。')
    return result('done', job.kind === 'schedule-on' ? '已打开自动领。' : '已关掉自动领。')
  }
  if (job) return result('busy', '正在处理…')
  if (lastRun) {
    const time = clock(lastRun.finishedAt, state.date)
    if (lastRun.outcome === 'done') return result('idle', `上次 ${time} 跑完。`)
    if (lastRun.outcome === 'stopped') return result('idle', `上次 ${time} 被停止，跑了 ${lastRun.ran} 家，剩下 ${lastRun.total - lastRun.ran} 家没跑。`)
    return result('idle', `上次 ${time} 出错：${lastRun.error}`)
  }
  return result('idle', '')
}
export function validateAccountName(name: string): string | null {
  const trimmed = name.trim()
  return !trimmed ? '名字不能空着' : [...trimmed].length > 20 ? '名字最多 20 个字' : null
}
