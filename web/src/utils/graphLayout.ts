import type { Task } from '../types'

export interface DependencyEdge {
  source: string
  target: string
  kind: 'dependsOn' | 'blockedBy' | 'related'
}
export type GraphNode = Task & { highlighted?: boolean }

function edgesOf(tasks: readonly Task[]): DependencyEdge[] {
  const ids = new Set(tasks.map(task => task.id))
  const edges: DependencyEdge[] = []
  const seen = new Set<string>()
  const add = (source: string, target: string, kind: DependencyEdge['kind']) => {
    if (!ids.has(source) || !ids.has(target)) return
    const pair = kind === 'related' ? [source, target].sort() : [source, target]
    const key = JSON.stringify([kind, ...pair])
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ source, target, kind })
  }
  for (const task of tasks) {
    for (const source of task.deps?.dependsOn ?? []) add(source, task.id, 'dependsOn')
    for (const source of task.deps?.blockedBy ?? []) add(source, task.id, 'blockedBy')
    for (const target of task.deps?.relatedTasks ?? []) add(task.id, target, 'related')
  }
  return edges
}

/** 图上的活跃卡指未结案的卡；暂缓仍可解释依赖，阻塞计数另用 task-signal 的判据。 */
function isOpen(task: Task): boolean {
  return task.status !== '已完工' && task.status !== '已作废'
}

function oneHop(roots: ReadonlySet<string>, edges: readonly DependencyEdge[]): Set<string> {
  const selected = new Set(roots)
  // 始终查原始 roots，不能在遍历中把刚加入的邻居继续扩成第二跳。
  for (const edge of edges) {
    if (roots.has(edge.source) || roots.has(edge.target)) {
      selected.add(edge.source)
      selected.add(edge.target)
    }
  }
  return selected
}

/** 默认保留有依赖的未结案卡及一跳邻居；showAll 展开独立卡和历史卡。不会改动任务或依赖数组。 */
export function dependencySubgraph(tasks: readonly Task[], options: { showAll: boolean; focusId?: string }): {
  nodes: GraphNode[]; edges: DependencyEdge[]
} {
  const edges = edgesOf(tasks)
  const active = new Set(tasks.filter(isOpen).map(task => task.id))
  const roots = new Set(tasks.filter(task => isOpen(task)
    && ((task.deps?.dependsOn?.length ?? 0) > 0 || (task.deps?.blockedBy?.length ?? 0) > 0)).map(task => task.id))
  for (const edge of edges) {
    if (edge.kind !== 'related' && active.has(edge.target) && active.has(edge.source)) roots.add(edge.source)
  }
  let selected = options.showAll ? new Set(tasks.map(task => task.id)) : oneHop(roots, edges)
  if (options.focusId) {
    const neighbors = selected.has(options.focusId) ? oneHop(new Set([options.focusId]), edges) : new Set<string>()
    selected = new Set([...selected].filter(id => neighbors.has(id)))
  }
  return {
    nodes: tasks.filter(task => selected.has(task.id)).map(task => options.focusId ? { ...task, highlighted: true } : task),
    edges: edges.filter(edge => selected.has(edge.source) && selected.has(edge.target)),
  }
}

/** 非零波次优先；全零时取依赖最长路径。环的回边按输入发现顺序忽略，关联边不影响先后。 */
export function layerOf(nodes: readonly Task[], edges: readonly DependencyEdge[]): Map<string, number> {
  const waveOf = (task: Task) => typeof task.wave === 'number' && Number.isFinite(task.wave) ? task.wave : 0
  if (nodes.some(task => waveOf(task) !== 0)) return new Map(nodes.map(task => [task.id, waveOf(task)]))
  const parents = new Map(nodes.map(task => [task.id, [] as string[]]))
  for (const edge of edges) {
    if (edge.kind !== 'related' && parents.has(edge.source)) parents.get(edge.target)?.push(edge.source)
  }
  const layers = new Map<string, number>()
  const visiting = new Set<string>()
  function depth(id: string): number {
    if (layers.has(id)) return layers.get(id)!
    visiting.add(id)
    let layer = 0
    for (const parent of parents.get(id) ?? []) {
      if (!visiting.has(parent)) layer = Math.max(layer, depth(parent) + 1)
    }
    visiting.delete(id)
    layers.set(id, layer)
    return layer
  }
  for (const node of nodes) depth(node.id)
  return layers
}

/** 坐标单位为像素；层间及同层节点等距，边缘各留一份间距，单节点位于画布中心。 */
export function layeredLayout(nodes: readonly Task[], edges: readonly DependencyEdge[], size: { width: number; height: number }): Map<string, { x: number; y: number }> {
  const layers = layerOf(nodes, edges)
  const groups = new Map<number, Task[]>()
  for (const node of nodes) {
    const layer = layers.get(node.id)!
    if (!groups.has(layer)) groups.set(layer, [])
    groups.get(layer)!.push(node)
  }
  const ordered = [...groups.keys()].sort((a, b) => a - b)
  const width = Number.isFinite(size.width) ? Math.max(0, size.width) : 0
  const height = Number.isFinite(size.height) ? Math.max(0, size.height) : 0
  const positions = new Map<string, { x: number; y: number }>()
  ordered.forEach((layer, column) => {
    const group = groups.get(layer)!.sort((a, b) => a.id.localeCompare(b.id))
    group.forEach((node, row) => positions.set(node.id, {
      x: width * (column + 1) / (ordered.length + 1), y: height * (row + 1) / (group.length + 1),
    }))
  })
  return positions
}
