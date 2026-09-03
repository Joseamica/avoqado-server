import { TableStatus, TableShape, Order, PaymentStatus } from '@prisma/client'
import logger from '../../config/logger'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import socketManager from '../../communication/sockets'
import { SocketEventType } from '../../communication/sockets/types'
import { assertVenueSalesEnabled } from '../venueSalesGuard'
import { logAction } from '../dashboard/activity-log.service'
import { turnoAbiertoDelNegocio } from '../shared/turnoDeCaja'

interface TableStatusResponse {
  id: string
  number: string
  capacity: number
  positionX: number | null
  positionY: number | null
  shape: string
  rotation: number
  status: TableStatus
  areaId: string | null
  areaName: string | null
  currentOrder: {
    id: string
    orderNumber: string
    covers: number | null
    total: number
    itemCount: number
    /** Order.version for optimistic concurrency on add-round (additive). */
    version: number
    items: Array<{
      id: string
      productName: string
      quantity: number
      unitPrice: number
      total: number
      course: string | null
      isCortesia: boolean
      cortesiaReason: string | null
    }>
    waiter: {
      id: string
      name: string
    } | null
    createdAt: Date
  } | null
  /** Multi-cheque: TODAS las cuentas abiertas de la mesa (resumen ligero).
   *  Opcional: create/updateTable devuelven la mesa sin este campo. */
  openOrders?: Array<{
    id: string
    orderNumber: string
    covers: number | null
    total: number
    itemCount: number
    version: number
    name: string | null
    /** Additive: dueño de la cuenta — los POS lo comparan contra su staffId
     *  para pintar read-only cuando enforceTableOwnership está encendido. */
    waiterId: string | null
    waiterName: string | null
    createdAt: Date
  }>
}

/**
 * Get all tables with their current status and active orders for floor plan display
 * Returns table layout data with real-time order information
 */
export async function getTablesWithStatus(venueId: string): Promise<TableStatusResponse[]> {
  logger.info(`📋 [TABLE SERVICE] Getting tables with status for venue ${venueId}`)

  // Multi-cheque (Square's separate checks): every OPEN order per table, not
  // just the denormalized currentOrder pointer. Lightweight summaries only.
  const openOrders = await prisma.order.findMany({
    where: {
      venueId,
      tableId: { not: null },
      status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] },
    },
    select: {
      id: true,
      tableId: true,
      orderNumber: true,
      covers: true,
      total: true,
      version: true,
      customerName: true,
      createdAt: true,
      _count: { select: { items: true } },
      servedById: true,
      servedBy: { select: { firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'asc' },
  })
  const openByTable = new Map<string, typeof openOrders>()
  for (const o of openOrders) {
    const list = openByTable.get(o.tableId!) ?? []
    list.push(o)
    openByTable.set(o.tableId!, list)
  }

  const tables = await prisma.table.findMany({
    // Only active tables — soft-deleted ones (active: false) must not resurface
    // on the floor plan. Mirrors getFloorElements, which already filters active.
    where: { venueId, active: true },
    include: {
      area: {
        select: { id: true, name: true },
      },
      currentOrder: {
        include: {
          items: {
            include: {
              product: {
                select: { id: true, name: true },
              },
            },
          },
          servedBy: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      },
    },
    orderBy: { number: 'asc' },
  })

  const response: TableStatusResponse[] = tables.map(table => ({
    id: table.id,
    number: table.number,
    capacity: table.capacity,
    positionX: table.positionX,
    positionY: table.positionY,
    shape: table.shape,
    rotation: table.rotation,
    status: table.status,
    areaId: table.areaId,
    areaName: table.area?.name || null,
    // 🔴 Sólo se manda el puntero si la orden SIGUE ABIERTA. Al cobrar una
    // cuenta dividida, `Table.currentOrderId` se queda apuntando a la que se
    // acaba de pagar; mandarla hacía que el POS mostrara "Pagar $310.50" de
    // algo ya cobrado y el mesero no pudiera llegar a la cuenta viva.
    // (Medido en una D3 sobre la mesa M2, 2026-07-28. El cliente además se
    // defiende solo vía DiningTable.primaryCheck.)
    currentOrder:
      table.currentOrder && !['COMPLETED', 'CANCELLED', 'DELETED'].includes(String(table.currentOrder.status))
        ? {
            id: table.currentOrder.id,
            orderNumber: table.currentOrder.orderNumber,
            covers: table.currentOrder.covers,
            total: Number(table.currentOrder.total),
            itemCount: table.currentOrder.items.length,
            version: table.currentOrder.version,
            items: table.currentOrder.items.map(item => ({
              id: item.id,
              productName: item.product?.name || item.productName || 'Unknown',
              quantity: item.quantity,
              unitPrice: Number(item.unitPrice),
              total: Number(item.total),
              course: item.course ?? null,
              isCortesia: item.isCortesia,
              cortesiaReason: item.cortesiaReason,
            })),
            waiter: table.currentOrder.servedBy
              ? {
                  id: table.currentOrder.servedBy.id,
                  name: `${table.currentOrder.servedBy.firstName} ${table.currentOrder.servedBy.lastName}`,
                }
              : null,
            createdAt: table.currentOrder.createdAt,
          }
        : null,
    // Multi-cheque: TODAS las cuentas abiertas de la mesa (resumen ligero).
    // Additive — clients that only read currentOrder are untouched.
    openOrders: (openByTable.get(table.id) ?? []).map(o => ({
      id: o.id,
      orderNumber: o.orderNumber,
      covers: o.covers,
      total: Number(o.total),
      itemCount: o._count.items,
      version: o.version,
      name: o.customerName ?? null,
      // waiterId additive: los POS lo comparan contra su staffId para pintar
      // read-only cuando enforceTableOwnership está encendido.
      waiterId: o.servedById ?? null,
      waiterName: o.servedBy ? `${o.servedBy.firstName} ${o.servedBy.lastName}`.trim() : null,
      createdAt: o.createdAt,
    })),
  }))

  logger.info(`✅ [TABLE SERVICE] Retrieved ${response.length} tables (${response.filter(t => t.status === 'OCCUPIED').length} occupied)`)

  return response
}

/**
 * Assign a table to start a new order or return existing order if table is occupied
 * If table has existing order, returns that order (for adding more items)
 * If table is free, creates new order and marks table as OCCUPIED
 */
export async function assignTable(
  venueId: string,
  tableId: string,
  staffId: string,
  covers: number,
  terminalId?: string | null, // Terminal that created this order (for sales attribution)
): Promise<{ order: Order; isNewOrder: boolean }> {
  logger.info(`🪑 [TABLE SERVICE] Assigning table ${tableId} with ${covers} covers (staff: ${staffId}, terminal: ${terminalId || 'none'})`)

  // Verify table exists and belongs to venue
  const table = await prisma.table.findFirst({
    where: { id: tableId, venueId },
    include: {
      currentOrder: {
        include: {
          items: {
            include: {
              product: {
                select: { id: true, name: true },
              },
            },
          },
        },
      },
    },
  })

  if (!table) {
    throw new NotFoundError(`Table not found or does not belong to this venue`)
  }

  // Verify staff exists and belongs to venue
  const staffVenue = await prisma.staffVenue.findFirst({
    where: { staffId, venueId },
    include: { staff: true },
  })

  if (!staffVenue) {
    throw new BadRequestError(`Staff member not found or not assigned to this venue`)
  }

  // Reserved tables can only be opened through reservation check-in flow
  if (table.status === TableStatus.RESERVED) {
    throw new BadRequestError('Mesa reservada para una reservacion proxima')
  }

  // If table already has an active order, return it
  if (table.currentOrder && table.status === 'OCCUPIED') {
    logger.info(`✅ [TABLE SERVICE] Table ${table.number} already has order ${table.currentOrder.orderNumber}`)

    return {
      order: table.currentOrder,
      isNewOrder: false,
    }
  }

  await assertVenueSalesEnabled(venueId)

  // Multi-cheque invariant: "open orders bound to this tableId" must mean
  // "checks of the CURRENT seating". Opening a table from AVAILABLE detaches
  // any zombie open orders left bound to it by older flows/abandoned data,
  // otherwise they would block clearTable and hijack the sibling repoint.
  // The orders themselves survive (reports); they just leave the table.
  await prisma.order.updateMany({
    where: {
      venueId,
      tableId: table.id,
      status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] },
    },
    data: { tableId: null },
  })

  // Create new order
  const orderNumber = `ORD-${Date.now()}`

  // 🔴 Abrir mesa ocurre EN el mostrador, dentro del turno de caja abierto ahora
  // (`../shared/turnoDeCaja.ts`). Desde la fase 1, `getActiveShifts` cuenta las órdenes del
  // turno agrupando por `Order.shiftId`: sin esto, un restaurante entero salía con «0 órdenes».
  // Opcional a propósito — un negocio que no abrió caja sigue atendiendo mesas.
  const currentShift = await turnoAbiertoDelNegocio(prisma, venueId)

  const newOrder = await prisma.order.create({
    data: {
      venueId,
      shiftId: currentShift?.id ?? null,
      tableId: table.id,
      covers,
      orderNumber,
      servedById: staffId,
      terminalId: terminalId || null, // Track which terminal created this order
      status: 'PENDING',
      paymentStatus: PaymentStatus.PENDING,
      kitchenStatus: 'PENDING',
      subtotal: 0,
      discountAmount: 0,
      taxAmount: 0,
      total: 0,
      version: 1,
    },
    include: {
      items: {
        include: {
          product: {
            select: { id: true, name: true },
          },
        },
      },
    },
  })

  // Update table status and link to order
  await prisma.table.update({
    where: { id: tableId },
    data: {
      status: 'OCCUPIED',
      currentOrderId: newOrder.id,
    },
  })

  logger.info(`✅ [TABLE SERVICE] Created order ${orderNumber} for table ${table.number}`)

  // Emit Socket.IO event for real-time table status update
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.TABLE_STATUS_CHANGE, {
      tableId: table.id,
      tableNumber: table.number,
      status: 'OCCUPIED',
      orderId: newOrder.id,
      orderNumber: newOrder.orderNumber,
      covers,
      waiter: {
        id: staffVenue.staffId,
        name: `${staffVenue.staff.firstName} ${staffVenue.staff.lastName}`,
      },
    })
  }

  return {
    order: newOrder,
    isNewOrder: true,
  }
}

/**
 * Clear table after payment is completed
 * Marks table as AVAILABLE and removes currentOrderId link
 *
 * `performedBy` (optional, additive) is the actor's `authContext.userId` —
 * threaded through by callers that have a request context (the online `/tpv`
 * controller). Callers without one (the offline sync reducer replaying
 * CLEAR_TABLE, and the frozen `/mobile` controller) still get an audited row,
 * just with `staffId: null` — visibility beats total blindness; "liberar
 * mesa" was previously NOT audited from any path at all (found 2026-07-27
 * while closing out Plan B Task 6 — comp/discount/cancel already logged via
 * their own services, this one didn't).
 */
export async function clearTable(venueId: string, tableId: string, performedBy?: string): Promise<void> {
  logger.info(`🧹 [TABLE SERVICE] Clearing table ${tableId}`)

  const table = await prisma.table.findFirst({
    where: { id: tableId, venueId },
    select: { id: true, number: true, currentOrderId: true },
  })

  if (!table) {
    throw new NotFoundError(`Table not found or does not belong to this venue`)
  }

  // Multi-cheque: the table frees only when EVERY open check on it is PAID
  // (not just the denormalized currentOrder).
  const openOnTable = await prisma.order.findMany({
    where: { venueId, tableId, status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] } },
    select: { id: true, orderNumber: true, paymentStatus: true },
  })
  const unpaid = openOnTable.filter(o => o.paymentStatus !== PaymentStatus.PAID)
  if (unpaid.length > 0) {
    throw new BadRequestError(`Cannot clear table with unpaid order ${unpaid[0].orderNumber}`)
  }

  // Clear table
  await prisma.table.update({
    where: { id: tableId },
    data: {
      status: 'AVAILABLE',
      currentOrderId: null,
    },
  })

  logger.info(`✅ [TABLE SERVICE] Table ${table.number} cleared and marked as AVAILABLE`)

  void logAction({
    action: 'TABLE_CLEARED',
    entity: 'Table',
    entityId: table.id,
    staffId: performedBy ?? null,
    venueId,
    data: { number: table.number, ordersCleared: openOnTable.map(o => o.orderNumber) },
  })

  // Emit Socket.IO event
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.TABLE_STATUS_CHANGE, {
      tableId: table.id,
      tableNumber: table.number,
      status: 'AVAILABLE',
      orderId: null,
      orderNumber: null,
      covers: null,
      waiter: null,
    })
  }
}

/**
 * TABLE_SERVICE — libera la mesa cuando su ÚLTIMA cuenta abierta queda saldada.
 *
 * 🔴 Por qué existe (mesa M9, 2026-08-03): liberar la mesa después de cobrar era
 * responsabilidad del CLIENTE — `TablesViewModel.finishTableAfterPayment()` en
 * Android (y su espejo en iOS) llamaba `clearTable` por HTTP directo, NO como
 * intent. Si esa llamada no ocurría, `Table.status` se quedaba en `OCCUPIED`
 * para siempre mientras la orden pasaba a COMPLETED. Resultado: una mesa que el
 * plano pinta ocupada, sin cuenta viva, que **no se puede abrir ni anular ni
 * liberar** — porque la única salida ("liberar mesa") vive detrás de un tap que
 * muere en `primaryCheck ?: return`. Se pierde una mesa del salón, permanente.
 *
 * Formas de perder esa llamada, todas reales:
 *  - Sin red: `repository.clearTable` es HTTP crudo, no va por el outbox. El
 *    `PAY_CASH` replayado por el reducer NO libera la mesa (sólo `CLEAR_TABLE`).
 *  - App matada / sesión de mesa perdida entre el cobro y la liberación.
 *  - Se cobró desde OTRO dispositivo (TPV, otra tablet) que no tenía la sesión.
 *
 * La corrección de fondo es que la liberación NO puede depender de que un
 * cliente siga vivo en el momento correcto: el server la hace al saldarse la
 * última cuenta. Idempotente y NO transaccional a propósito — esto es
 * bookkeeping del plano, jamás debe tumbar un cobro ya aprobado.
 *
 * Devuelve `true` sólo si esta llamada fue la que liberó la mesa.
 */
export async function releaseTableIfSettled(venueId: string, tableId: string): Promise<boolean> {
  // ¿Queda ALGUNA cuenta viva? Multi-cheque: no basta con la que se acaba de
  // pagar — una mesa con la cuenta B abierta sigue ocupada aunque la A se pague.
  const stillOpen = await prisma.order.count({
    where: { venueId, tableId, status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] } },
  })
  if (stillOpen > 0) return false

  const table = await prisma.table.findFirst({
    where: { id: tableId, venueId },
    select: { id: true, number: true, status: true, currentOrderId: true },
  })
  if (!table) return false

  // Ya está libre — nada que hacer (idempotencia: el cliente puede haber
  // ganado la carrera con su propio clearTable, y está bien).
  if (table.status === 'AVAILABLE' && table.currentOrderId === null) return false

  // Una mesa RESERVED sin cuenta abierta NO es una fuga: es una reserva viva.
  // Pisarla borraría la reservación del plano.
  if (table.status === 'RESERVED') return false

  await prisma.table.update({
    where: { id: tableId },
    data: { status: 'AVAILABLE', currentOrderId: null },
  })

  logger.info(`✅ [TABLE SERVICE] Table ${table.number} auto-released — última cuenta saldada`)

  void logAction({
    action: 'TABLE_AUTO_RELEASED',
    entity: 'Table',
    entityId: table.id,
    staffId: null,
    venueId,
    data: { number: table.number, previousStatus: table.status },
  })

  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.TABLE_STATUS_CHANGE, {
      tableId: table.id,
      tableNumber: table.number,
      status: 'AVAILABLE',
      orderId: null,
      orderNumber: null,
      covers: null,
      waiter: null,
    })
  }

  return true
}

/**
 * TABLE_SERVICE — move an OPEN check to another table (Square's "Mover").
 * The order keeps everything (items, courses, payments in flight are blocked
 * anyway); only the table binding changes. Source table is released, target
 * becomes OCCUPIED. Both sides broadcast TABLE_STATUS_CHANGE.
 */
export async function moveOrderToTable(venueId: string, orderId: string, targetTableId: string): Promise<void> {
  logger.info(`🔀 [TABLE SERVICE] Moving order ${orderId} to table ${targetTableId}`)

  const order = await prisma.order.findFirst({
    where: { id: orderId, venueId },
    select: {
      id: true,
      orderNumber: true,
      tableId: true,
      status: true,
      paymentStatus: true,
      covers: true,
      servedBy: { select: { id: true, firstName: true, lastName: true } },
    },
  })
  if (!order) {
    throw new NotFoundError('Order not found or does not belong to this venue')
  }
  if (['COMPLETED', 'CANCELLED', 'DELETED'].includes(order.status)) {
    throw new BadRequestError('La cuenta ya está cerrada — no se puede mover')
  }
  if (order.paymentStatus === PaymentStatus.PAID) {
    throw new BadRequestError('La cuenta ya está pagada — no se puede mover')
  }
  if (order.tableId === targetTableId) {
    throw new BadRequestError('La cuenta ya está en esa mesa')
  }

  const target = await prisma.table.findFirst({
    where: { id: targetTableId, venueId },
    select: { id: true, number: true, status: true, currentOrderId: true },
  })
  if (!target) {
    throw new NotFoundError('Target table not found or does not belong to this venue')
  }
  if (target.currentOrderId || target.status === 'OCCUPIED') {
    throw new BadRequestError(`La mesa ${target.number} ya tiene una cuenta abierta`)
  }
  if (target.status === TableStatus.RESERVED) {
    throw new BadRequestError(`La mesa ${target.number} está reservada`)
  }

  const sourceTableId = order.tableId
  // Order matters: currentOrderId is UNIQUE, so the source must release the
  // order BEFORE the target can hold it. Release is conditional (updateMany)
  // in case another check landed there between reads.
  await prisma.$transaction([
    ...(sourceTableId
      ? [
          prisma.table.updateMany({
            where: { id: sourceTableId, venueId, currentOrderId: order.id },
            data: { status: 'AVAILABLE', currentOrderId: null },
          }),
        ]
      : []),
    prisma.order.update({ where: { id: order.id }, data: { tableId: target.id } }),
    prisma.table.update({
      where: { id: target.id },
      data: { status: 'OCCUPIED', currentOrderId: order.id },
    }),
  ])

  // Multi-cheque: si la mesa origen aún tiene otra cuenta abierta, re-apuntar
  // currentOrderId al hermano y mantenerla OCUPADA (el release de arriba solo
  // aplicó si apuntaba a la cuenta movida).
  if (sourceTableId) {
    const sibling = await prisma.order.findFirst({
      where: { venueId, tableId: sourceTableId, status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    })
    if (sibling) {
      await prisma.table.update({
        where: { id: sourceTableId },
        data: { status: 'OCCUPIED', currentOrderId: sibling.id },
      })
    }
  }

  logger.info(`✅ [TABLE SERVICE] Order ${order.orderNumber} moved to table ${target.number}`)

  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    const waiter = order.servedBy ? { id: order.servedBy.id, name: `${order.servedBy.firstName} ${order.servedBy.lastName}` } : null
    if (sourceTableId) {
      const source = await prisma.table.findUnique({ where: { id: sourceTableId }, select: { id: true, number: true, status: true } })
      if (source) {
        broadcastingService.broadcastToVenue(venueId, SocketEventType.TABLE_STATUS_CHANGE, {
          tableId: source.id,
          tableNumber: source.number,
          status: source.status,
          orderId: null,
          orderNumber: null,
          covers: null,
          waiter: null,
        })
      }
    }
    broadcastingService.broadcastToVenue(venueId, SocketEventType.TABLE_STATUS_CHANGE, {
      tableId: target.id,
      tableNumber: target.number,
      status: 'OCCUPIED',
      orderId: order.id,
      orderNumber: order.orderNumber,
      covers: order.covers,
      waiter,
    })
  }
}

/**
 * TABLE_SERVICE — reconcile a table's occupancy after one of its bound orders
 * is removed by a path OTHER than moveOrderToTable (Fix 1, "zombie table",
 * 2026-08-07 — `/tpv` layer only, see
 * .superpowers/sdd/2026-07-24-tpv-plan-b-superficie-tpv-server/zombie-table-and-staff-picker.md).
 *
 * 🔴 Root cause this closes: `mergeOrders`' own table-release step
 * (`src/services/mobile/order.mobile.service.ts` — FROZEN, iOS/Android build
 * against it in parallel sessions) only frees/repoints a table when
 * `Table.currentOrderId === source.id`. A child order created by
 * SPLIT_ORDER/SPLIT_BY_SEAT never gets `Table.currentOrderId` pointed at it
 * (see splitOrderItems' own comment on that), so when that child is later the
 * table's LAST open order and gets merged away, the lookup misses, the
 * release silently no-ops, and the table stays OCCUPIED with openOrders: []
 * forever — reproduced twice on hardware, endpoint even returns `tableFreed:
 * false`.
 *
 * Since `/mobile` cannot be touched, this reconciles from the `/tpv` layer
 * instead — called by order-table.tpv.controller.ts's `mergeOrders` AFTER the
 * shared service succeeds. Mirrors `moveOrderToTable`'s sibling-reconciliation
 * above: looks up the removed order's OWN `tableId` (the FK, always correct —
 * unlike the denormalized `currentOrderId` pointer that caused the bug) and
 * sets the table to whatever the remaining LIVE siblings on that table imply.
 * Idempotent — safe to call even when the shared service already released the
 * table correctly (no sibling found twice → same no-op write).
 */
export async function reconcileTableAfterOrderRemoved(venueId: string, removedOrderId: string): Promise<{ tableFreed: boolean }> {
  const removedOrder = await prisma.order.findFirst({
    where: { id: removedOrderId, venueId },
    select: { tableId: true },
  })
  const tableId = removedOrder?.tableId
  if (!tableId) return { tableFreed: false }

  // Tenant isolation: re-verify the table belongs to THIS venue before writing
  // to it — never trust a bare tableId, even one read off an order already
  // scoped to venueId.
  const table = await prisma.table.findFirst({
    where: { id: tableId, venueId },
    select: { id: true, number: true },
  })
  if (!table) return { tableFreed: false }

  const sibling = await prisma.order.findFirst({
    where: { venueId, tableId: table.id, id: { not: removedOrderId }, status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })

  await prisma.table.update({
    where: { id: table.id },
    data: sibling ? { status: 'OCCUPIED', currentOrderId: sibling.id } : { status: 'AVAILABLE', currentOrderId: null },
  })

  logger.info(
    sibling
      ? `✅ [TABLE SERVICE] Table ${table.number} repointed to sibling check after /tpv reconciliation`
      : `✅ [TABLE SERVICE] Table ${table.number} released after /tpv reconciliation`,
  )

  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService) {
    broadcastingService.broadcastToVenue(venueId, SocketEventType.TABLE_STATUS_CHANGE, {
      tableId: table.id,
      tableNumber: table.number,
      status: sibling ? 'OCCUPIED' : 'AVAILABLE',
      orderId: sibling?.id ?? null,
      orderNumber: null,
      covers: null,
      waiter: null,
    })
  }

  return { tableFreed: !sibling }
}

/**
 * TABLE_SERVICE — reassign an OPEN check to another waiter (Square's
 * "Asignar"). Sales attribution (tips, corte) follows servedById.
 */
export async function assignOrderWaiter(venueId: string, orderId: string, staffId: string): Promise<{ staffName: string }> {
  logger.info(`👤 [TABLE SERVICE] Assigning order ${orderId} to staff ${staffId}`)

  const order = await prisma.order.findFirst({
    where: { id: orderId, venueId },
    select: { id: true, orderNumber: true, status: true, paymentStatus: true, tableId: true, covers: true },
  })
  if (!order) {
    throw new NotFoundError('Order not found or does not belong to this venue')
  }
  if (['COMPLETED', 'CANCELLED', 'DELETED'].includes(order.status)) {
    throw new BadRequestError('La cuenta ya está cerrada — no se puede reasignar')
  }

  const staffVenue = await prisma.staffVenue.findFirst({
    where: { staffId, venueId },
    include: { staff: { select: { id: true, firstName: true, lastName: true } } },
  })
  if (!staffVenue) {
    throw new BadRequestError('Staff member not found or not assigned to this venue')
  }

  await prisma.order.update({ where: { id: order.id }, data: { servedById: staffId } })

  const staffName = `${staffVenue.staff.firstName} ${staffVenue.staff.lastName}`.trim()
  logger.info(`✅ [TABLE SERVICE] Order ${order.orderNumber} assigned to ${staffName}`)

  // Floor payloads poll the waiter, but broadcast so open floor plans refresh.
  const broadcastingService = socketManager.getBroadcastingService()
  if (broadcastingService && order.tableId) {
    const table = await prisma.table.findUnique({ where: { id: order.tableId }, select: { id: true, number: true } })
    if (table) {
      broadcastingService.broadcastToVenue(venueId, SocketEventType.TABLE_STATUS_CHANGE, {
        tableId: table.id,
        tableNumber: table.number,
        status: 'OCCUPIED',
        orderId: order.id,
        orderNumber: order.orderNumber,
        covers: order.covers,
        waiter: { id: staffVenue.staff.id, name: staffName },
      })
    }
  }

  return { staffName }
}

/**
 * Create a new table
 */
export async function createTable(
  venueId: string,
  data: {
    number: string
    capacity: number
    shape: string
    rotation?: number
    positionX?: number
    positionY?: number
    areaId?: string | null
  },
): Promise<TableStatusResponse> {
  logger.info(`➕ [TABLE SERVICE] Creating table - Number: ${data.number}, Capacity: ${data.capacity}`)

  // Validate venue exists
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
  })

  if (!venue) {
    throw new NotFoundError(`Venue not found: ${venueId}`)
  }

  // Validate number is unique
  const existingTable = await prisma.table.findFirst({
    where: {
      venueId,
      number: data.number,
    },
  })

  if (existingTable) {
    throw new BadRequestError(`Table number ${data.number} already exists`)
  }

  // Validate area exists if provided
  if (data.areaId) {
    const area = await prisma.area.findFirst({
      where: { id: data.areaId, venueId },
    })

    if (!area) {
      throw new NotFoundError(`Area not found in venue ${venueId}`)
    }
  }

  // Validate capacity is positive
  if (data.capacity < 1) {
    throw new BadRequestError(`Capacity must be at least 1`)
  }

  // Validate shape is valid
  if (!['ROUND', 'SQUARE', 'RECTANGLE'].includes(data.shape)) {
    throw new BadRequestError(`Invalid shape: ${data.shape}`)
  }

  // Validate coordinates if provided (0-1 range)
  if (data.positionX !== undefined && (data.positionX < 0 || data.positionX > 1)) {
    throw new BadRequestError(`Invalid positionX: ${data.positionX}. Must be between 0 and 1`)
  }
  if (data.positionY !== undefined && (data.positionY < 0 || data.positionY > 1)) {
    throw new BadRequestError(`Invalid positionY: ${data.positionY}. Must be between 0 and 1`)
  }

  // Create table
  const newTable = await prisma.table.create({
    data: {
      venueId,
      number: data.number,
      capacity: data.capacity,
      shape: data.shape as TableShape,
      rotation: data.rotation ?? 0,
      positionX: data.positionX ?? 0.5, // Default to center
      positionY: data.positionY ?? 0.5,
      areaId: data.areaId ?? undefined, // Convert null to undefined for Prisma
      qrCode: `table-${venueId}-${data.number}-${Date.now()}`, // Generate unique QR code
      status: 'AVAILABLE',
    },
    include: {
      area: {
        select: { id: true, name: true },
      },
    },
  })

  logger.info(`✅ [TABLE SERVICE] Table ${newTable.number} created successfully`)

  // Return formatted response
  return {
    id: newTable.id,
    number: newTable.number,
    capacity: newTable.capacity,
    positionX: newTable.positionX,
    positionY: newTable.positionY,
    shape: newTable.shape,
    rotation: newTable.rotation,
    status: newTable.status,
    areaId: newTable.areaId,
    areaName: newTable.area?.name || null,
    currentOrder: null, // New tables don't have orders
  }
}

/**
 * Update table position on floor plan
 * Coordinates are normalized 0-1 values (relative to venue canvas)
 */
export async function updateTablePosition(
  venueId: string,
  tableId: string,
  positionX: number,
  positionY: number,
): Promise<{ id: string; number: string; positionX: number; positionY: number }> {
  logger.info(`📍 [TABLE SERVICE] Updating table position - Table: ${tableId}, X: ${positionX}, Y: ${positionY}`)

  // Validate table exists and belongs to venue
  const table = await prisma.table.findFirst({
    where: { id: tableId, venueId },
  })

  if (!table) {
    throw new NotFoundError(`Table not found in venue ${venueId}`)
  }

  // Validate coordinates are in valid range (0-1)
  if (positionX < 0 || positionX > 1 || positionY < 0 || positionY > 1) {
    throw new BadRequestError(`Invalid coordinates. Position values must be between 0 and 1 (X: ${positionX}, Y: ${positionY})`)
  }

  // Update table position
  const updatedTable = await prisma.table.update({
    where: { id: tableId },
    data: {
      positionX,
      positionY,
    },
    select: {
      id: true,
      number: true,
      positionX: true,
      positionY: true,
    },
  })

  logger.info(`✅ [TABLE SERVICE] Table ${table.number} position updated to (${positionX}, ${positionY})`)

  // Return with non-null assertion since we just set these values
  return {
    id: updatedTable.id,
    number: updatedTable.number,
    positionX: updatedTable.positionX!,
    positionY: updatedTable.positionY!,
  }
}

/**
 * Update table properties (number, capacity, shape, rotation, areaId)
 */
export async function updateTable(
  venueId: string,
  tableId: string,
  data: {
    number?: string
    capacity?: number
    shape?: string
    rotation?: number
    areaId?: string | null
  },
): Promise<TableStatusResponse> {
  logger.info(`🔧 [TABLE SERVICE] Updating table - Table: ${tableId}, Data: ${JSON.stringify(data)}`)

  // Validate table exists and belongs to venue
  const table = await prisma.table.findFirst({
    where: { id: tableId, venueId },
  })

  if (!table) {
    throw new NotFoundError(`Table not found in venue ${venueId}`)
  }

  // Validate area exists if provided
  if (data.areaId) {
    const area = await prisma.area.findFirst({
      where: { id: data.areaId, venueId },
    })

    if (!area) {
      throw new NotFoundError(`Area not found in venue ${venueId}`)
    }
  }

  // Validate number is unique if being changed
  if (data.number && data.number !== table.number) {
    const existingTable = await prisma.table.findFirst({
      where: {
        venueId,
        number: data.number,
        id: { not: tableId },
      },
    })

    if (existingTable) {
      throw new BadRequestError(`Table number ${data.number} already exists`)
    }
  }

  // Validate capacity is positive
  if (data.capacity !== undefined && data.capacity < 1) {
    throw new BadRequestError(`Capacity must be at least 1`)
  }

  // Validate shape is valid
  if (data.shape && !['ROUND', 'SQUARE', 'RECTANGLE'].includes(data.shape)) {
    throw new BadRequestError(`Invalid shape: ${data.shape}`)
  }

  // Update table
  const updatedTable = await prisma.table.update({
    where: { id: tableId },
    data: {
      ...(data.number !== undefined && { number: data.number }),
      ...(data.capacity !== undefined && { capacity: data.capacity }),
      ...(data.shape !== undefined && { shape: data.shape as TableShape }),
      ...(data.rotation !== undefined && { rotation: data.rotation }),
      ...(data.areaId !== undefined && { areaId: data.areaId ?? undefined }),
    },
    include: {
      area: {
        select: { id: true, name: true },
      },
      currentOrder: {
        include: {
          items: {
            include: {
              product: {
                select: { id: true, name: true },
              },
            },
          },
          servedBy: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      },
    },
  })

  logger.info(`✅ [TABLE SERVICE] Table ${updatedTable.number} updated successfully`)

  // Return formatted response
  return {
    id: updatedTable.id,
    number: updatedTable.number,
    capacity: updatedTable.capacity,
    positionX: updatedTable.positionX,
    positionY: updatedTable.positionY,
    shape: updatedTable.shape,
    rotation: updatedTable.rotation,
    status: updatedTable.status,
    areaId: updatedTable.areaId,
    areaName: updatedTable.area?.name || null,
    currentOrder: updatedTable.currentOrder
      ? {
          id: updatedTable.currentOrder.id,
          orderNumber: updatedTable.currentOrder.orderNumber,
          covers: updatedTable.currentOrder.covers,
          total: Number(updatedTable.currentOrder.total),
          itemCount: updatedTable.currentOrder.items.length,
          version: updatedTable.currentOrder.version,
          items: updatedTable.currentOrder.items.map(item => ({
            id: item.id,
            productName: item.product?.name || item.productName || 'Unknown',
            quantity: item.quantity,
            unitPrice: Number(item.unitPrice),
            total: Number(item.total),
            course: item.course ?? null,
            isCortesia: item.isCortesia,
            cortesiaReason: item.cortesiaReason,
          })),
          waiter: updatedTable.currentOrder.servedBy
            ? {
                id: updatedTable.currentOrder.servedBy.id,
                name: `${updatedTable.currentOrder.servedBy.firstName} ${updatedTable.currentOrder.servedBy.lastName}`,
              }
            : null,
          createdAt: updatedTable.currentOrder.createdAt,
        }
      : null,
  }
}

/**
 * Delete a table (soft delete by setting active = false)
 */
export async function deleteTable(venueId: string, tableId: string): Promise<void> {
  logger.info(`🗑️ [TABLE SERVICE] Deleting table - Table: ${tableId}`)

  // Validate table exists and belongs to venue
  const table = await prisma.table.findFirst({
    where: { id: tableId, venueId },
  })

  if (!table) {
    throw new NotFoundError(`Table not found in venue ${venueId}`)
  }

  // Check if table has active order
  if (table.currentOrderId) {
    const order = await prisma.order.findUnique({
      where: { id: table.currentOrderId },
      select: { paymentStatus: true, orderNumber: true },
    })

    if (order && order.paymentStatus !== PaymentStatus.PAID) {
      throw new BadRequestError(`Cannot delete table with active unpaid order ${order.orderNumber}`)
    }
  }

  // Soft delete table by setting active = false
  await prisma.table.update({
    where: { id: tableId },
    data: {
      active: false,
    },
  })

  logger.info(`✅ [TABLE SERVICE] Table ${table.number} deleted (soft delete)`)
}
