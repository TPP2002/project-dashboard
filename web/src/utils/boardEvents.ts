export type BoardEventKind = 'claim' | 'progress' | 'pending' | 'decide' | 'done' | 'park' | 'block' | 'note'

export interface BoardEvent {
  kind: BoardEventKind
  projectId: string
  taskId: string
  ts: string
}

const subscribers = new Set<(event: BoardEvent) => void>()
const cardElements = new Map<string, HTMLElement>()

/** 同步通知；退订可重复调用，不补发订阅前的活动。 */
export function onBoardEvent(fn: (event: BoardEvent) => void): () => void {
  subscribers.add(fn)
  return () => { subscribers.delete(fn) }
}

/** 保留原始活动类型；单个订阅者失败不能打断看板刷新和其它订阅者。 */
export function emitBoardEvent(event: BoardEvent): void {
  for (const fn of subscribers) {
    try { fn(event) }
    catch (error) { console.error('看板事件订阅者执行失败', error) }
  }
}

/** key 为 projectId:taskId；同键以最后挂载的卡片为准。 */
export function registerCardElement(key: string, el: HTMLElement): void {
  cardElements.set(key, el)
}

/** 旧卡卸载不得误删同键新卡的登记。 */
export function unregisterCardElement(key: string, el: HTMLElement): void {
  if (cardElements.get(key) === el) cardElements.delete(key)
}

export function findCardElement(key: string): HTMLElement | null {
  return cardElements.get(key) ?? null
}
