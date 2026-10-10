import prisma from '../../utils/prismaClient'
import { FLOOR_PLAN_LIMITS, type FloorShapeCode, type PlanElement } from '../dashboard/floorPlan/floorPlan.types'
import { computeTablesVersions } from './tablesVersion.service'

/** Plano para el POS (spec 2026-10-09 §3.2): áreas + elementos ACTIVOS. Las mesas viajan en `/tables`. */
export interface MobileFloorPlanArea {
  id: string
  name: string
  floorShape: FloorShapeCode | null
  sortOrder: number
}

export interface MobileFloorPlanDto {
  floorPlanVersion: string
  areas: MobileFloorPlanArea[]
  elements: PlanElement[]
  /** El venue tiene más de lo que el plano permite: se manda truncado con orden estable, y se dice. */
  overLimit: boolean
}

export async function getMobileFloorPlan(venueId: string): Promise<MobileFloorPlanDto> {
  // 🔴 La versión ANTES de leer: si algo cambia entre las dos lecturas, viaja la versión vieja y la consulta de 10 s
  // vuelve a bajar el plano (una consulta de más, nunca un plano viejo con versión nueva).
  const { floorPlanVersion } = await computeTablesVersions(venueId)
  const [areas, elements] = await Promise.all([
    prisma.area.findMany({
      where: { venueId },
      select: { id: true, name: true, floorShape: true, sortOrder: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      take: FLOOR_PLAN_LIMITS.areas + 1,
    }),
    prisma.floorElement.findMany({
      where: { venueId, active: true },
      select: {
        id: true,
        type: true,
        areaId: true,
        positionX: true,
        positionY: true,
        width: true,
        height: true,
        rotation: true,
        endX: true,
        endY: true,
        label: true,
        color: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: FLOOR_PLAN_LIMITS.elements + 1,
    }),
  ])
  return {
    floorPlanVersion,
    areas: areas.slice(0, FLOOR_PLAN_LIMITS.areas),
    elements: elements.slice(0, FLOOR_PLAN_LIMITS.elements),
    overLimit: areas.length > FLOOR_PLAN_LIMITS.areas || elements.length > FLOOR_PLAN_LIMITS.elements,
  }
}
