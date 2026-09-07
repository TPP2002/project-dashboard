import type { SceneFactory, WorldId } from '../types'

export const registry: Record<WorldId, () => Promise<{ createScene: SceneFactory }>> = {
  launch: () => import('./launch'),
  mech: () => import('./mech'),
}
