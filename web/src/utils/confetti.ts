import { reducedMotion } from '@/utils/iconMotion'

/** 在视口坐标 rect 内播放 1200ms；覆盖层独立于原卡片，结束后自行移除。 */
export function burstConfettiAt(rect: DOMRect, opts: { count: number; colors: string[] }): void {
  if (reducedMotion.value || typeof document === 'undefined') return
  if (rect.width <= 0 || rect.height <= 0 || opts.count <= 0 || !opts.colors.length) return

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = window.devicePixelRatio || 1
  const { width, height } = rect
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  Object.assign(canvas.style, {
    position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`,
    width: `${width}px`, height: `${height}px`, pointerEvents: 'none', zIndex: '90',
  })
  canvas.setAttribute('aria-hidden', 'true')
  ctx.scale(dpr, dpr)
  document.body.appendChild(canvas)

  // 随机只用于纸屑外观，不参与完工记录或连击统计；参数沿用已拍板的第 03 节。
  const bits = Array.from({ length: opts.count }, () => ({
    x: width * (.3 + Math.random() * .4),
    y: height * .55,
    vx: (Math.random() - .5) * 7,
    vy: -3.2 - Math.random() * 5.2,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - .5) * .38,
    w: 4 + Math.random() * 5,
    h: 2.5 + Math.random() * 4,
    color: opts.colors[Math.floor(Math.random() * opts.colors.length)],
  }))

  const duration = 1200
  const startedAt = performance.now()
  const frame = (now: number) => {
    const elapsed = now - startedAt
    // 系统偏好在播放途中改变也立即停下，不留下冻结的纸屑覆盖层。
    if (elapsed >= duration || reducedMotion.value) { canvas.remove(); return }
    ctx.clearRect(0, 0, width, height)
    ctx.globalAlpha = elapsed > duration * .65
      ? 1 - (elapsed - duration * .65) / (duration * .35) : 1
    for (const bit of bits) {
      bit.x += bit.vx
      bit.y += bit.vy
      bit.vy += .34
      bit.vx *= .992
      bit.rot += bit.vr
      ctx.save()
      ctx.translate(bit.x, bit.y)
      ctx.rotate(bit.rot)
      ctx.fillStyle = bit.color
      ctx.fillRect(-bit.w / 2, -bit.h / 2, bit.w, bit.h)
      ctx.restore()
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}
