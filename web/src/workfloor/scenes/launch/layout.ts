/** v10 cabinet 投影与接驳几何；单位均为 1400 × 520 画布像素。 */
export const PAD_X = 902, MOUNT_TOP = 412, BODY_R = 13, NOZZLE_Y = 190
export const ROCKET_Y = MOUNT_TOP - NOZZLE_Y - 4, TOWER_X = PAD_X - 78, TOWER_Y = 154
export const ARM1_Y = ROCKET_Y + 82.5, ARM2_Y = ROCKET_Y + 28
export const ARM_ROOT = TOWER_X + 16, ARM_END = PAD_X - BODY_R, ARM_LENGTH = ARM_END - ARM_ROOT
export const CRAWLER_PATH = 'M283 382v24a14 14 0 0 0 14 14H902'
export const TRUCK_PATH = 'M550 409C598 401 638 408 677 408S767 403 816 415'
export const SEA_SHAPE = 'M1000 330H1400V520H1180L1138 476 1107 447 1075 414 1040 376Z'
export const LAND_SHAPE = 'M0 330H1000L1040 376 1075 414 1107 447 1138 476 1180 520H0Z'
export const SHORE = 'M1000 330L1040 376 1075 414 1107 447 1138 476 1180 520'
export const MASTS = [[783, 246], [982, 236], [857, 302], [999, 312]] as const
export const ROLLOUT_MS = 4000, DOCK_MS = 1900, FLIGHT_MS = 3400, SMOKE_MS = FLIGHT_MS + 4000
export const STANDARD_VIEWBOX = '0 0 1400 520'
// 厂房顶 y=104，台基/导流槽底 y=445；两者均落在紧凑裁切内。
export const COMPACT_VIEWBOX = '0 94 1400 360'
export type Vertex = readonly [number, number]
export function cabinetFaces(x: number, y: number, w: number, h: number) {
  const dx = -w * .45 * Math.cos(Math.PI / 6), dy = -w * .45 * .5
  return {
    front: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] as Vertex[],
    left: [[x + dx, y + dy], [x, y], [x, y + h], [x + dx, y + h + dy]] as Vertex[],
    top: [[x + dx, y + dy], [x + w + dx, y + dy], [x + w, y], [x, y]] as Vertex[],
  }
}
