import { computeFloorPlanFingerprint } from '@/services/dashboard/floorPlan/floorPlanFingerprint'
import type { PlanArea, PlanElement, PlanTable } from '@/services/dashboard/floorPlan/floorPlan.types'

const area: PlanArea = { id: 'a1', name: 'Salón', floorShape: 'WIDE', sortOrder: 0, externalId: null }
const t1: PlanTable = {
  id: 't1',
  number: '1',
  capacity: 4,
  shape: 'SQUARE',
  rotation: 0,
  positionX: 0.25,
  positionY: 0.5,
  areaId: 'a1',
  hasOpenOrder: false,
}
const t2: PlanTable = { ...t1, id: 't2', number: '2', positionX: 0.75 }
const wall: PlanElement = {
  id: 'e1',
  type: 'WALL',
  areaId: 'a1',
  positionX: 0,
  positionY: 0,
  width: null,
  height: null,
  rotation: 0,
  endX: 1,
  endY: 0,
  label: null,
  color: null,
}
const plan = { areas: [area], tables: [t1, t2], elements: [wall] }

describe('computeFloorPlanFingerprint', () => {
  it('mide 16 caracteres hexadecimales', () => {
    expect(computeFloorPlanFingerprint(plan)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('no depende del orden en que llegan las filas', () => {
    expect(computeFloorPlanFingerprint({ ...plan, tables: [t2, t1] })).toBe(computeFloorPlanFingerprint(plan))
  })

  it('cambia si una mesa se mueve, cambia de número o de área', () => {
    const base = computeFloorPlanFingerprint(plan)
    expect(computeFloorPlanFingerprint({ ...plan, tables: [{ ...t1, positionX: 0.3 }, t2] })).not.toBe(base)
    expect(computeFloorPlanFingerprint({ ...plan, tables: [{ ...t1, number: '9' }, t2] })).not.toBe(base)
    expect(computeFloorPlanFingerprint({ ...plan, tables: [{ ...t1, areaId: null }, t2] })).not.toBe(base)
  })

  it('cambia si un área cambia de forma o de nombre', () => {
    const base = computeFloorPlanFingerprint(plan)
    expect(computeFloorPlanFingerprint({ ...plan, areas: [{ ...area, floorShape: 'TALL' }] })).not.toBe(base)
    expect(computeFloorPlanFingerprint({ ...plan, areas: [{ ...area, name: 'Terraza' }] })).not.toBe(base)
  })

  it('ignora el estado operativo: abrir una cuenta no es cambiar el plano', () => {
    expect(computeFloorPlanFingerprint({ ...plan, tables: [{ ...t1, hasOpenOrder: true }, t2] })).toBe(computeFloorPlanFingerprint(plan))
  })

  it('tolera el ruido de punto flotante de la base', () => {
    expect(computeFloorPlanFingerprint({ ...plan, tables: [{ ...t1, positionX: 0.2500000001 }, t2] })).toBe(
      computeFloorPlanFingerprint(plan),
    )
  })
})
