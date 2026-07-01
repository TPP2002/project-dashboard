// 实时通道（R7）：EventSource 优先；彻底断线降级 3s 轮询 + 定时重连回 SSE。
// 服务端用注释行 `: ping` 心跳保活；客户端只需在 CLOSED 时降级，onopen 时回升。
export type ConnState = 'connecting' | 'sse' | 'polling' | 'offline'

export interface BoardStreamOptions {
  /** 收到 board:changed；'*' = 触发全量重拉（轮询降级时用） */
  onChanged: (projectId: string) => void
  onState?: (s: ConnState) => void
  url?: string
  pollMs?: number
  reconnectMs?: number
}

export class BoardStream {
  private es: EventSource | null = null
  private pollTimer: number | null = null
  private reconnectTimer: number | null = null
  private closed = false
  private readonly onChanged: (projectId: string) => void
  private readonly onState: (s: ConnState) => void
  private readonly url: string
  private readonly pollMs: number
  private readonly reconnectMs: number

  constructor(opts: BoardStreamOptions) {
    this.onChanged = opts.onChanged
    this.onState = opts.onState ?? (() => {})
    this.url = opts.url ?? '/api/stream'
    this.pollMs = opts.pollMs ?? 3000
    this.reconnectMs = opts.reconnectMs ?? 10000
  }

  start(): void {
    this.closed = false
    this.openSse()
  }

  stop(): void {
    this.closed = true
    this.closeSse()
    this.stopPolling()
    this.stopReconnect()
    this.onState('offline')
  }

  private openSse(): void {
    this.closeSse()
    this.onState('connecting')
    try {
      const es = new EventSource(this.url)
      this.es = es
      es.onopen = () => {
        this.stopPolling()
        this.stopReconnect()
        this.onState('sse')
      }
      // hello:server 启动/重启时的握手,内含 pid。
      // 记住第一次拿到的 pid,后续任何一次 pid 不同 = server 被重启过 → 强制 reload 拉最新前端。
      // 治用户实测的"我改了代码你刷新没反应"——server 重启后前端自动跟上,不再需要用户手动 F5。
      es.addEventListener('hello', (e: MessageEvent) => {
        try {
          const d = JSON.parse(e.data)
          const pid = String(d?.pid ?? '')
          if (pid) {
            const KEY = '__dashboardServerPid'
            const prev = sessionStorage.getItem(KEY)
            if (prev && prev !== pid) {
              // server 换新进程了 → 前端一定过期 → 硬 reload
              sessionStorage.setItem(KEY, pid)
              window.location.reload()
              return
            }
            if (!prev) sessionStorage.setItem(KEY, pid)
          }
        } catch { /* 忽略 hello 解析错 */ }
      })
      es.addEventListener('board:changed', (e: MessageEvent) => {
        let pid = '*'
        try {
          const d = JSON.parse(e.data)
          if (d && typeof d.projectId === 'string') pid = d.projectId
        } catch {
          /* 无 payload 时全量重拉 */
        }
        this.onChanged(pid)
      })
      es.onerror = () => {
        // EventSource 自身会重试连接中态；仅在 CLOSED（彻底断）时主动降级
        if (es.readyState === EventSource.CLOSED) this.degrade()
      }
    } catch {
      this.degrade()
    }
  }

  private degrade(): void {
    if (this.closed) return
    this.closeSse()
    this.startPolling()
    this.startReconnect()
  }

  private startPolling(): void {
    if (this.pollTimer != null) return
    this.onState('polling')
    this.onChanged('*') // 降级瞬间先拉一次
    this.pollTimer = window.setInterval(() => this.onChanged('*'), this.pollMs)
  }

  private stopPolling(): void {
    if (this.pollTimer != null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private startReconnect(): void {
    if (this.reconnectTimer != null) return
    this.reconnectTimer = window.setInterval(() => {
      if (!this.closed) this.openSse()
    }, this.reconnectMs)
  }

  private stopReconnect(): void {
    if (this.reconnectTimer != null) {
      clearInterval(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private closeSse(): void {
    if (this.es) {
      this.es.onopen = null
      this.es.onerror = null
      this.es.close()
      this.es = null
    }
  }
}
