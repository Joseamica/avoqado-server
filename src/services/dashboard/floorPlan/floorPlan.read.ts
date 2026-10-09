import type { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { CUENTA_VIVA_SIN_PAGAR, esCuentaVivaSinPagar } from '../../shared/cuentaEnLaMesa'
import { computeFloorPlanFingerprint } from './floorPlanFingerprint'
import { FLOOR_PLAN_LIMITS, type FloorPlanDto, type PlanArea, type PlanElement, type PlanTable } from './floorPlan.types'

type Db = Prisma.TransactionClient | typeof prisma

/**
 * El puntero `Table.currentOrderId` apunta a una cuenta viva y sin pagar (`shared/cuentaEnLaMesa`). Un puntero a una
 * cuenta que no se encuentra cuenta como abierta: ante la duda, no se deja quitar la mesa.
 */
export function pointerIsOpen(order: { status: string; paymentStatus: string } | null | undefined): boolean {
  return !order || esCuentaVivaSinPagar(order)
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
  const shown = tables.slice(0, FLOOR_PLAN_LIMITS.tables)
  // Cuentas vivas y sin pagar ligadas a la mesa por `Order.tableId`, aunque la mesa no las apunte (cuenta dividida,
  // orden dada de alta en el POS). UNA consulta para todas las mesas, acotada por ellas (índice venueId+tableId+paymentStatus).
  const withLiveOrder = new Set(
    shown.length
      ? (
          await db.order.groupBy({
            by: ['tableId'],
            where: { venueId, tableId: { in: shown.map(t => t.id) }, ...CUENTA_VIVA_SIN_PAGAR },
          })
        ).map(g => g.tableId)
      : [],
  )
  return {
    areas: areas.slice(0, FLOOR_PLAN_LIMITS.areas),
    tables: shown.map(t => ({
      id: t.id,
      number: t.number,
      capacity: t.capacity,
      shape: t.shape,
      rotation: t.rotation,
      positionX: t.positionX,
      positionY: t.positionY,
      areaId: t.areaId,
      // Abierta = su puntero apunta a una cuenta abierta, o tiene una cuenta viva sin pagar ligada por tableId (igual
      // que el servidor al publicar).
      hasOpenOrder: (!!t.currentOrderId && pointerIsOpen(t.currentOrder)) || withLiveOrder.has(t.id),
    })),
    elements: elements.slice(0, FLOOR_PLAN_LIMITS.elements),
    overLimit,
  }
}

export async function getFloorPlan(venueId: string): Promise<FloorPlanDto> {
  const state = await loadFloorPlanState(prisma, venueId)
  return { fingerprint: computeFloorPlanFingerprint(state), ...state, limits: FLOOR_PLAN_LIMITS }
}
