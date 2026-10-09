import type { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { computeFloorPlanFingerprint } from './floorPlanFingerprint'
import { FLOOR_PLAN_LIMITS, type FloorPlanDto, type PlanArea, type PlanElement, type PlanTable } from './floorPlan.types'

type Db = Prisma.TransactionClient | typeof prisma

/**
 * Cuenta ABIERTA = viva y sin pagar. Es el mismo criterio con que `assignTable` (table.tpv.service) decide si una mesa
 * ya tiene cuenta, y el de la vista de mesas del POS (COMPLETED / CANCELLED / DELETED ya no están en la mesa). Una
 * cuenta cancelada o borrada con el puntero colgado NO frena quitar la mesa.
 */
export function isOpenOrder(order: { status: string; paymentStatus: string }): boolean {
  return !['COMPLETED', 'CANCELLED', 'DELETED'].includes(order.status) && order.paymentStatus !== 'PAID'
}

export interface FloorPlanState {
  areas: PlanArea[]
  tables: PlanTable[]
  elements: PlanElement[]
  /** El venue tiene más de lo que el editor permite: se muestra sin editar (nunca se trunca en silencio). */
  overLimit: boolean
}

/** Lee el plano ACTIVO de un venue. Acotado: toma `límite + 1` para saber si se pasó. */
export async function loadFloorPlanState(db: Db, venueId: string): Promise<FloorPlanState> {
  const areas = await db.area.findMany({
    where: { venueId },
    select: { id: true, name: true, floorShape: true, sortOrder: true, externalId: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    take: FLOOR_PLAN_LIMITS.areas + 1,
  })
  const tables = await db.table.findMany({
    where: { venueId, active: true },
    select: {
      id: true,
      number: true,
      capacity: true,
      shape: true,
      rotation: true,
      positionX: true,
      positionY: true,
      areaId: true,
      currentOrderId: true,
      currentOrder: { select: { status: true, paymentStatus: true } },
    },
    orderBy: [{ number: 'asc' }, { id: 'asc' }],
    take: FLOOR_PLAN_LIMITS.tables + 1,
  })
  const elements = await db.floorElement.findMany({
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
  })
  const overLimit =
    areas.length > FLOOR_PLAN_LIMITS.areas || tables.length > FLOOR_PLAN_LIMITS.tables || elements.length > FLOOR_PLAN_LIMITS.elements
  return {
    areas: areas.slice(0, FLOOR_PLAN_LIMITS.areas),
    tables: tables.slice(0, FLOOR_PLAN_LIMITS.tables).map(t => ({
      id: t.id,
      number: t.number,
      capacity: t.capacity,
      shape: t.shape,
      rotation: t.rotation,
      positionX: t.positionX,
      positionY: t.positionY,
      areaId: t.areaId,
      // Puntero a una cuenta que no se encuentra: ante la duda, abierta (igual que el servidor al publicar).
      hasOpenOrder: !!t.currentOrderId && (!t.currentOrder || isOpenOrder(t.currentOrder)),
    })),
    elements: elements.slice(0, FLOOR_PLAN_LIMITS.elements),
    overLimit,
  }
}

export async function getFloorPlan(venueId: string): Promise<FloorPlanDto> {
  const state = await loadFloorPlanState(prisma, venueId)
  return { fingerprint: computeFloorPlanFingerprint(state), ...state, limits: FLOOR_PLAN_LIMITS }
}
