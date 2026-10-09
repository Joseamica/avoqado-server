import { createHash } from 'node:crypto'
import type { PlanArea, PlanElement, PlanTable } from './floorPlan.types'

export interface FingerprintInput {
  areas: Array<Pick<PlanArea, 'id' | 'name' | 'floorShape' | 'sortOrder'>>
  tables: Array<Pick<PlanTable, 'id' | 'number' | 'capacity' | 'shape' | 'rotation' | 'positionX' | 'positionY' | 'areaId'>>
  elements: PlanElement[]
}

const round = (n: number | null) => (n === null ? null : Math.round(n * 1e6) / 1e6)
const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/**
 * Huella del PLANO (no del servicio): cambia si cambia algo que se dibuja, nunca si sólo se abre o cierra
 * una cuenta. El editor la manda de vuelta al guardar; si ya no coincide, alguien más (otro gerente o la
 * pantalla vieja de la PAX) cambió el plano mientras tanto.
 */
export function computeFloorPlanFingerprint(plan: FingerprintInput): string {
  const canonical = {
    a: byId(plan.areas).map(a => [a.id, a.name, a.floorShape, a.sortOrder]),
    t: byId(plan.tables).map(t => [t.id, t.number, t.capacity, t.shape, t.rotation, round(t.positionX), round(t.positionY), t.areaId]),
    e: byId(plan.elements).map(e => [
      e.id,
      e.type,
      e.areaId,
      round(e.positionX),
      round(e.positionY),
      round(e.width),
      round(e.height),
      e.rotation,
      round(e.endX),
      round(e.endY),
      e.label,
      e.color,
    ]),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16)
}
