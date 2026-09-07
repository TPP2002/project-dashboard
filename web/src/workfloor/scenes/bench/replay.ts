import type { SceneFactory, SceneHandle, SceneOptions, SceneState, WorldId } from '../../types'
import { registry } from '../registry'
import { attributes, svg } from '../../fx/svg'

/** 只向真实场景送合成快照；复用测试台的 SVG 与 tick，不连接看板或增加帧循环。 */
export function createReplay(host: SVGSVGElement, bench: SVGGElement, initial: SceneOptions) {
  const controls = svg(host, 'foreignObject', { x: 24, y: 8, width: 630, height: 48, 'data-bench-replay': '' })
  const row = host.ownerDocument.createElementNS('http://www.w3.org/1999/xhtml', 'div')
  row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:4px;background:var(--surface);border-radius:var(--r-md)'
  controls.appendChild(row)
  let options = { ...initial }, scene: SceneHandle | null = null, factory: SceneFactory | null = null
  let generation = 0, serial = 0, elapsed = 0, disposed = false
  const listeners: (() => void)[] = []
  function button(label: string, action: () => void) {
    const node = host.ownerDocument.createElementNS('http://www.w3.org/1999/xhtml', 'button') as HTMLButtonElement
    node.type = 'button'; node.className = 'btn btn-sm'; node.textContent = label
    node.addEventListener('click', action); listeners.push(() => node.removeEventListener('click', action))
    row.appendChild(node)
    return node
  }
  const fixture = (): SceneState => ({ projectId: 'bench-replay', projectName: '动画刷新复现',
    queued: [], pending: [], blocked: [], done: [], total: 2, percent: 0, complete: false,
    active: [{ id: 'BENCH-A', title: '首个完工', percent: 96, status: '施工中', order: 0 },
      { id: 'BENCH-B', title: '同秒完工', percent: 30, status: '施工中', order: 1 }],
  })
  function mount() {
    if (!factory) return
    scene?.destroy(); elapsed = 0
    scene = factory(host, { ...options, state: fixture() })
    bench.style.display = 'none'
    host.appendChild(controls)
  }
  const launch = button('发射场', () => { void select('launch') })
  const mech = button('机甲', () => { void select('mech') })
  const replay = button('连发 done + update', () => {
    mount()
    if (!scene) return
    const state = fixture(), [first, second] = state.active
    const ts = new Date(Date.UTC(2026, 8, 8, 0, 0, ++serial)).toISOString()
    const event = { kind: 'done' as const, projectId: state.projectId, taskId: first.id, ts }
    scene.handleEvent(event, !options.reducedMotion)
    scene.setState(state)
    scene.setState({ ...state, active: [second], done: [{ ...first, status: '已完工' }], percent: 50 })
    scene.handleEvent({ ...event, taskId: second.id }, false)
    scene.setState({ ...state, active: [], done: state.active.map(task => ({ ...task, status: '已完工' })), percent: 100, complete: true })
    scene.handleEvent({ ...event, kind: 'complete', taskId: '' }, !options.reducedMotion)
  })
  replay.disabled = true
  button('返回特效', () => {
    generation++; scene?.destroy(); scene = null; factory = null; replay.disabled = true
    bench.style.display = ''; setHeight(options.height)
  })
  async function select(world: WorldId) {
    const version = ++generation
    replay.disabled = true
    try {
      const module = await registry[world]()
      if (disposed || version !== generation) return
      factory = module.createScene; mount(); replay.disabled = false; replay.textContent = '连发 done + update'
      launch.setAttribute('aria-pressed', String(world === 'launch'))
      mech.setAttribute('aria-pressed', String(world === 'mech'))
    } catch (error) {
      if (disposed || version !== generation) return
      replay.textContent = '场景加载失败'; console.error('施工现场测试台加载失败', error)
    }
  }
  function setHeight(value: SceneOptions['height']) {
    options.height = value
    attributes(controls, { y: value === 'compact' ? 98 : 8 })
    if (scene) scene.setHeight(value)
    else attributes(host, { viewBox: value === 'compact' ? '0 80 1400 360' : '0 0 1400 520' })
  }
  setHeight(options.height)
  return {
    get active() { return scene !== null },
    tick(dt: number) { elapsed += dt; scene?.tick(dt, elapsed) },
    setHeight,
    setDayNight(value: SceneOptions['dayNight']) { options.dayNight = value; scene?.setDayNight(value) },
    setDetail(value: SceneOptions['detail']) { options.detail = value; scene?.setDetail(value) },
    setReducedMotion(value: boolean) { options.reducedMotion = value; scene?.setReducedMotion(value) },
    setSound(value: SceneOptions['sound']) { options.sound = value; scene?.setSound(value) },
    destroy() { disposed = true; generation++; scene?.destroy(); listeners.forEach(remove => remove()); controls.remove() },
  }
}
