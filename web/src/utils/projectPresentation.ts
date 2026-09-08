import { useBoardStore } from '@/stores/board'
import { appearance, PROJECT_COLORS, PROJECT_ICONS, type ProjectIconId } from './appearance'
import { isHexColor, pickProjectColor, resolveVarColor } from './projectColor'

const paletteIds = PROJECT_COLORS.map(color => color.id)

export function projectColorCss(projectId: string): string | null {
  if (!appearance.projectColor) return null
  const project = useBoardStore().projects.find(project => project.id === projectId)
  return pickProjectColor({
    projectId, override: appearance.projectColors[projectId], registry: project?.color, paletteIds,
  }).value
}

/** SVG 明暗色站需要真 hex；没有页面或变量未解析时不启用项目环。 */
export function projectHex(projectId: string): string | null {
  if (typeof document === 'undefined') return null
  const value = projectColorCss(projectId)
  if (!value) return null
  const hex = resolveVarColor(value, name => getComputedStyle(document.documentElement).getPropertyValue(name))
  return isHexColor(hex) ? hex : null
}

export function projectIconName(projectId: string): ProjectIconId {
  const override = appearance.projectIcons[projectId]
  if (override) return override
  const project = useBoardStore().projects.find(project => project.id === projectId)
  return PROJECT_ICONS.find(icon => icon.id === project?.icon)?.id ?? 'kanban'
}

export function projectLetter(projectId: string): string {
  const project = useBoardStore().projects.find(project => project.id === projectId)
  return Array.from(project?.name || projectId)[0] ?? ''
}
