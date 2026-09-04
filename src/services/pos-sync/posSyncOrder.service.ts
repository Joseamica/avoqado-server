import prisma from '../../utils/prismaClient'
import { NotFoundError } from '../../errors/AppError'
import { Order, OrderSource, OrderStatus, OriginSystem, Prisma, SplitType, SyncStatus } from '@prisma/client'
import logger from '../../config/logger'
import { posSyncStaffService } from './posSyncStaff.service'
import { getOrCreatePosTable } from './posSyncTable.service'
import { getOrCreatePosShift } from './posSyncShift.service'
import { RichPosPayload, PosPaymentMethod } from '@/types/pos.types'
import { PaymentMethod } from '@prisma/client'
import { socketManager } from '../../communication/sockets/managers/socketManager'
import { SocketEventType } from '../../communication/sockets/types'
import {
  lockExistingOrderForPayment,
  recordPendingPaymentShiftReconciliation,
  resolvePaymentShiftReconciliationEnabled,
  type CapturedPaymentShiftClaim,
} from '../shared/paymentShiftClaim'

// Cache to track recent payment commands to prevent double deduction
interface RecentPayment {
  orderId: string
  timestamp: number
  amount: number
}

const recentPayments = new Map<string, RecentPayment>()
const PAYMENT_CACHE_TTL = 30000 // 30 seconds

// Clean up expired entries - only in production/development, not in tests
let cleanupInterval: NodeJS.Timeout | null = null

if (process.env.NODE_ENV !== 'test') {
  cleanupInterval = setInterval(() => {
    const now = Date.now()
    for (const [key, payment] of recentPayments.entries()) {
      if (now - payment.timestamp > PAYMENT_CACHE_TTL) {
        recentPayments.delete(key)
      }
    }
  }, 60000) // Clean every minute
}

/**
 * Cleanup function to clear the interval and prevent memory leaks
 * Should be called when shutting down or in test teardown
 */
export function cleanupPaymentCache(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval)
    cleanupInterval = null
  }
  recentPayments.clear()
}

/**
 * Track a payment command that was sent to POS to prevent double deduction
 */
export function trackRecentPaymentCommand(orderExternalId: string, amount: number): void {
  recentPayments.set(orderExternalId, {
    orderId: orderExternalId,
    timestamp: Date.now(),
    amount,
  })
  logger.info(`[💳 PaymentTracker] Tracked payment command for order ${orderExternalId}, amount: ${amount}`)
}

/**
 * Check if an order has a recent payment command that should prevent total updates
 */
function shouldIgnoreTotalUpdates(orderExternalId: string): boolean {
  const recentPayment = recentPayments.get(orderExternalId)
  if (!recentPayment) return false

  const isRecent = Date.now() - recentPayment.timestamp < PAYMENT_CACHE_TTL
  if (isRecent) {
    logger.info(`[💳 PaymentTracker] Ignoring total updates for order ${orderExternalId} due to recent payment command`)
    return true
  }

  return false
}

/**
 * Encuentra una orden existente usando lógica de resolución inteligente.
 * Maneja el caso donde SoftRestaurant crea órdenes con idturno=0 inicialmente,
 * luego las actualiza al idturno real durante el pago.
 * @param externalId - El Entity ID actual de la orden
 * @param venueId - ID del venue
 * @param folio - Número de folio de la orden
 * @returns La orden existente o null si no existe
 */
async function findExistingOrderWithSmartResolution(
  db: Pick<Prisma.TransactionClient, 'order'>,
  externalId: string,
  venueId: string,
  _folio: string,
): Promise<Order | null> {
  // Paso 1: Buscar por el externalId exacto
  const exactMatch = await db.order.findUnique({
    where: {
      venueId_externalId: {
        venueId: venueId,
        externalId: externalId,
      },
    },
  })

  if (exactMatch) {
    return exactMatch
  }

  // Paso 2: Si no encontramos coincidencia exacta, implementar lógica de resolución
  // para el caso SoftRestaurant idturno=0 → idturno real
  const entityParts = externalId.split(':')
  if (entityParts.length === 3) {
    const [instanceId, currentIdTurno, orderFolio] = entityParts

    // Si el idturno actual no es 0, buscar si existe una orden con idturno=0
    if (currentIdTurno !== '0') {
      const zeroTurnoExternalId = `${instanceId}:0:${orderFolio}`

      logger.info(`[🔍 SmartResolution] Buscando orden huérfana con idturno=0: ${zeroTurnoExternalId}`)

      const orphanOrder = await db.order.findUnique({
        where: {
          venueId_externalId: {
            venueId: venueId,
            externalId: zeroTurnoExternalId,
          },
        },
      })

      if (orphanOrder) {
        // Sólo resolver aquí. La escritura ocurre dentro de la transacción DESPUÉS de intentar
        // el lock OPEN del turno; hacerlo en esta lectura dejaba una Order modificada fuera del
        // protocolo financiero aunque luego el cierre ganara.
        logger.info(`[🎯 SmartResolution] ¡Orden huérfana encontrada! Se actualizará ${zeroTurnoExternalId} a ${externalId} en transacción`)
        return orphanOrder
      }
    }
  }

  return null
}

async function lockPosOrderNaturalKey(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  input: { venueId: string; externalId: string },
): Promise<void> {
  // Una Order aún inexistente no ofrece fila para FOR UPDATE. Este advisory
  // xact lock serializa la clasificación/creación de la llave única natural;
  // se libera automáticamente al commit/rollback.
  const parts = input.externalId.split(':')
  // SoftRestaurant cambia idturno 0 por el real durante el cobro, pero ambas
  // formas nombran la misma comanda. Para su formato válido de tres partes la
  // identidad excluye idturno; formatos ajenos/malformados conservan el ID
  // completo y nunca se colapsan accidentalmente.
  const canonicalExternalIdentity =
    parts.length === 3 && parts[0] && /^\d+$/.test(parts[1]) && parts[2] ? `${parts[0]}:*:${parts[2]}` : input.externalId
  const key = `pos-order:${input.venueId}:${canonicalExternalIdentity}`
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
}

/**
 * Procesa un evento de creación/actualización de una Orden desde el POS.
 * Incluye lógica de resolución inteligente para manejar el caso SoftRestaurant
 * donde las órdenes se crean con idturno=0 y luego se actualizan al idturno real.
 * @param payload - Los datos mapeados de la orden desde el producer.
 */
export async function processPosOrderEvent(payload: RichPosPayload): Promise<Order> {
  const { venueId, orderData, staffData, tableData, shiftData, payments, paymentMethodsCatalog } = payload
  const { externalId } = orderData
  logger.info(`[🥾 PosSyncOrder] Procesando orden ${externalId} para Venue ${venueId}`)
  // logger.info(JSON.stringify(payload))

  const venue = await prisma.venue.findUnique({ where: { id: venueId } })
  if (!venue) {
    throw new NotFoundError(`Venue con ID ${venueId} no encontrado.`)
  }

  // 1. Sincronizar entidades relacionadas para obtener sus IDs de Prisma
  const staffId = await posSyncStaffService.syncPosStaff(staffData, venue.id, venue.organizationId)
  const tableId = await getOrCreatePosTable(tableData, venue.id) // Pasamos areaData

  const shiftId = await getOrCreatePosShift(shiftData, venue.id, staffId)

  const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venue.id)

  // Se fija dentro de la transacción después de serializar la llave natural.
  // Sólo se usa al emitir el socket post-commit.
  let isNewOrder = false

  // 3. Ejecutar el upsert final de la Orden
  const order = await prisma.$transaction(async tx => {
    await lockPosOrderNaturalKey(tx, { venueId: venue.id, externalId })
    // La clasificación exterior era TOCTOU: un request podía observar null,
    // otro crear la fila, y el primero tomar Shift antes de actualizar esa
    // Order ya existente. Esta relectura bajo advisory es la autoritativa.
    const existingOrder = await findExistingOrderWithSmartResolution(tx, externalId, venue.id, orderData.orderNumber)
    isNewOrder = !existingOrder
    if (existingOrder) {
      await lockExistingOrderForPayment(tx, { venueId: venue.id, orderId: existingOrder.id })
    }
    // El id resuelto arriba es sólo CANDIDATO. Este update condicionado es también el lock de
    // fila que serializa Order + Payments contra OPEN → CLOSING durante toda la transacción.
    // Perderlo NO falla la venta: lo nuevo queda sin turno y una Order existente conserva su liga.
    let shiftClaim: CapturedPaymentShiftClaim = {
      shiftId: null,
      candidateShiftId: null,
      observedStatus: null,
      pendingReason: 'NO_SHIFT',
    }
    if (shiftId) {
      const locked = await tx.shift.updateMany({
        where: { id: shiftId, venueId: venue.id, status: 'OPEN', endTime: null },
        data: { updatedAt: new Date() },
      })
      if (locked.count === 1) {
        shiftClaim = {
          shiftId,
          candidateShiftId: shiftId,
          observedStatus: 'OPEN',
          pendingReason: null,
        }
      } else {
        const observed = await tx.shift.findFirst({
          where: { id: shiftId, venueId: venue.id },
          select: { id: true, status: true },
        })
        shiftClaim = {
          shiftId: null,
          candidateShiftId: shiftId,
          observedStatus: observed?.status ?? null,
          pendingReason: observed && observed.status !== 'OPEN' ? 'SHIFT_NOT_OPEN' : 'CLAIM_LOST',
        }
      }
    }
    // Task 5t: capture the reviewed POS claim as immutable primitives before
    // crossing the payment-helper boundary. The helper reconstructs the exact
    // auditor payload inline, so no mutable claim object escapes.
    const writableShiftId = shiftClaim.shiftId
    const paymentCandidateShiftId = shiftClaim.candidateShiftId
    const paymentObservedShiftStatus = shiftClaim.observedStatus
    const paymentShiftPendingReason = shiftClaim.pendingReason

    // Si encontramos una orden existente con resolución inteligente, actualizarla
    if (existingOrder && existingOrder.externalId !== externalId) {
      // La orden existe pero con un externalId diferente (caso idturno=0 → idturno real)
      const ignoreFinancialUpdates = shouldIgnoreTotalUpdates(externalId)

      // Prepare update data conditionally
      const updateData: any = {
        externalId: externalId, // Actualizar al nuevo externalId
        status: orderData.status,
        paymentStatus: orderData.paymentStatus,
        completedAt: orderData.completedAt ? new Date(orderData.completedAt) : null,
        posRawData: orderData.posRawData as Prisma.InputJsonValue,
        syncedAt: new Date(),
        syncStatus: SyncStatus.SYNCED,
      }
      if (writableShiftId && !existingOrder.shiftId) {
        updateData.shift = { connect: { id: writableShiftId } }
      }

      // Only update financial fields if not from recent payment command
      if (!ignoreFinancialUpdates) {
        updateData.subtotal = orderData.subtotal
        updateData.taxAmount = orderData.taxAmount
        updateData.discountAmount = orderData.discountAmount
        updateData.tipAmount = orderData.tipAmount
        updateData.total = orderData.total
      } else {
        logger.info(`[💳 PaymentTracker] Skipping financial field updates for existing order ${externalId}`)
      }

      const order = await tx.order.update({
        where: { id: existingOrder.id },
        data: updateData,
      })

      logger.info(
        `[🥾 PosSyncOrder] Orden ${order.id} actualizada con nuevo externalId: ${externalId} (antes: ${existingOrder.externalId})`,
      )

      // Procesar pagos si la orden está pagada
      if (order.paymentStatus === 'PAID' && payments && payments.length > 0) {
        await processPaymentsForOrder(
          tx,
          order,
          payments,
          paymentMethodsCatalog,
          venue,
          writableShiftId,
          paymentCandidateShiftId,
          paymentObservedShiftStatus,
          paymentShiftPendingReason,
          staffId,
          reconciliationEnabled,
        )
      }

      return order
    }

    // Si no hay orden existente o el externalId coincide, hacer upsert normal
    const ignoreFinancialUpdates = shouldIgnoreTotalUpdates(externalId)

    // Prepare update data conditionally
    const updateData: any = {
      status: orderData.status,
      paymentStatus: orderData.paymentStatus,
      completedAt: orderData.completedAt ? new Date(orderData.completedAt) : null,
      posRawData: orderData.posRawData as Prisma.InputJsonValue,
      syncedAt: new Date(),
      syncStatus: SyncStatus.SYNCED,
    }
    // Una Order ya ligada conserva su asociación durable. Sólo adoptamos el turno cuando la
    // fila observada era huérfana y este mismo tx ganó el lock OPEN que también cubre Payments.
    if (existingOrder && !existingOrder.shiftId && writableShiftId) {
      updateData.shift = { connect: { id: writableShiftId } }
    }

    // Only update financial fields if not from recent payment command
    if (!ignoreFinancialUpdates) {
      updateData.subtotal = orderData.subtotal
      updateData.taxAmount = orderData.taxAmount
      updateData.discountAmount = orderData.discountAmount
      updateData.tipAmount = orderData.tipAmount
      updateData.total = orderData.total
    } else {
      logger.info(`[💳 PaymentTracker] Skipping financial field updates for order ${externalId}`)
    }

    const order = await tx.order.upsert({
      where: {
        venueId_externalId: {
          venueId: venue.id,
          externalId: externalId,
        },
      },
      update: updateData,
      create: {
        externalId: externalId,
        orderNumber: orderData.orderNumber,
        source: OrderSource.POS,
        originSystem: OriginSystem.POS_SOFTRESTAURANT,
        createdAt: new Date(orderData.createdAt),
        syncedAt: new Date(),
        status: orderData.status,
        paymentStatus: orderData.paymentStatus,
        subtotal: orderData.subtotal,
        taxAmount: orderData.taxAmount,
        discountAmount: orderData.discountAmount,
        tipAmount: orderData.tipAmount,
        total: orderData.total,
        posRawData: orderData.posRawData as Prisma.InputJsonValue,
        kitchenStatus: 'PENDING',
        type: 'DINE_IN',
        venue: { connect: { id: venue.id } },
        ...(staffId && { servedBy: { connect: { id: staffId } }, createdBy: { connect: { id: staffId } } }),
        ...(tableId && { table: { connect: { id: tableId } } }),
        ...(writableShiftId && { shift: { connect: { id: writableShiftId } } }),
        syncStatus: SyncStatus.SYNCED,
      },
    })

    logger.info(`[🥾 PosSyncOrder] Orden ${order.id} (externalId: ${order.externalId}) guardada/actualizada.`)

    // 2b. LÓGICA DE PAGOS MEJORADA
    if (order.paymentStatus === 'PAID' && payments && payments.length > 0) {
      await processPaymentsForOrder(
        tx,
        order,
        payments,
        paymentMethodsCatalog,
        venue,
        writableShiftId,
        paymentCandidateShiftId,
        paymentObservedShiftStatus,
        paymentShiftPendingReason,
        staffId,
        reconciliationEnabled,
      )
    }

    return order
  })

  // Emit socket event for real-time updates to POS devices (AFTER transaction commits)
  try {
    const socketEvent = isNewOrder ? SocketEventType.ORDER_CREATED : SocketEventType.ORDER_UPDATED
    const eventType = isNewOrder ? 'created' : 'updated'

    socketManager.broadcastToVenue(venue.id, socketEvent, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      venueId: venue.id,
      status: order.status,
      paymentStatus: order.paymentStatus,
      source: order.source,
      externalId: order.externalId,
      eventType: eventType, // For Android compatibility
      timestamp: new Date().toISOString(),
    })

    logger.info(`[🔔 PosSyncOrder] Socket event ${isNewOrder ? 'ORDER_CREATED' : 'ORDER_UPDATED'} emitted`, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      venueId: venue.id,
    })
  } catch (error) {
    logger.error('[❌ PosSyncOrder] Failed to emit socket event', { orderId: order.id, error })
    // Don't fail the order sync if socket emission fails
  }

  return order
}

/**
 * Procesa los pagos para una orden.
 *
 * ⚠️ PREGUNTA ABIERTA (3-sep-2026), NO una decisión tomada: este camino cierra la orden
 * como pagada **sin crear el vale de inventario** (`createSalePostingInTx`) y sin deducir
 * stock. Todos los demás caminos de cobro sí lo hacen; cripto/b4bit era la otra excepción y
 * se cerró como defecto ese mismo día.
 *
 * Aquí NO se cerró igual porque no es evidente que sea un defecto: SoftRestaurant es el
 * sistema de registro de estas ventas —`status`, `paymentStatus`, `completedAt` y los totales
 * llegan del payload, esto es un espejo, no un origen— y es defendible que su inventario lo
 * lleve él. Pero **nadie lo escribió nunca**: se buscó en `.claude/rules/`, en `docs/` y en el
 * historial de este archivo y no hay decisión, ni a favor ni en contra. Mientras no la haya,
 * esto no se toca y **tampoco se silencia**: la 7ª invariante del vigilante de dinero
 * (`jobs/money-integrity-watchdog.job.ts`) lo vigila a propósito, y su propio comentario
 * prohíbe ensanchar el criterio para que deje de sonar.
 *
 * Exposición medida el 3-sep-2026, que es lo que hace que esto no urja: los productos que
 * este servicio crea son placeholders (`getOrCreatePosProduct`, en `posSyncOrderItem`) y
 * `Product.trackInventory` nace en `false`, así que no descuentan nada. Sólo muerde cuando el
 * `externalId` del POS empata con un producto que alguien configuró en Avoqado CON receta o
 * método de inventario. En la base local, 0 órdenes de origen `POS_SOFTRESTAURANT` cumplen ese
 * predicado; en producción `Payment.source = 'POS'` no registra un cobro desde el 12-ago-2026.
 *
 * 🔴 Quien resuelva la pregunta: si la respuesta es "SoftRestaurant es dueño del inventario",
 * escríbelo aquí Y en la 7ª invariante con su motivo; si es "Avoqado también descuenta",
 * es el mismo arreglo que se le hizo a b4bit y hay que hacerlo antes de reactivar el puente.
 */
async function processPaymentsForOrder(
  tx: any,
  order: Order,
  payments: any[],
  paymentMethodsCatalog: PosPaymentMethod[],
  venue: any,
  shiftId: CapturedPaymentShiftClaim['shiftId'],
  candidateShiftId: CapturedPaymentShiftClaim['candidateShiftId'],
  observedStatus: CapturedPaymentShiftClaim['observedStatus'],
  pendingReason: CapturedPaymentShiftClaim['pendingReason'],
  staffId: string | null,
  reconciliationEnabled: boolean,
) {
  logger.info(`[🥾 PosSyncOrder] La orden ${order.id} está pagada. Procesando ${payments.length} pago(s)...`)

  // Verificación de idempotencia
  const existingPayments = await tx.payment.count({ where: { orderId: order.id } })
  if (existingPayments > 0) {
    logger.warn(`[🥾 PosSyncOrder] Ya existen ${existingPayments} pagos para la orden ${order.id}. Saltando creación.`)
    return
  }

  // Asegurarnos de que el catálogo de pagos vino en el payload
  if (!paymentMethodsCatalog || paymentMethodsCatalog.length === 0) {
    throw new Error('No se proporcionó el catálogo de métodos de pago para procesar los pagos.')
  }

  for (const posPayment of payments) {
    const feePercentage = venue.feeValue
    const feeAmount = posPayment.amount * parseFloat(feePercentage.toString())
    const netAmount = posPayment.amount - feeAmount

    // Crear el registro de Pago (Payment)
    const newPayment = await tx.payment.create({
      data: {
        amount: posPayment.amount,
        tipAmount: posPayment.tipAmount,
        method: mapPaymentMethodFromCatalog(posPayment.methodExternalId, paymentMethodsCatalog),
        splitType: SplitType.FULLPAYMENT,
        status: 'COMPLETED',
        feePercentage,
        feeAmount,
        netAmount,
        originSystem: OriginSystem.POS_SOFTRESTAURANT,
        posRawData: posPayment.posRawData as Prisma.InputJsonValue,
        externalId: `${order.externalId}-${posPayment.methodExternalId}`,
        venue: { connect: { id: venue.id } },
        order: { connect: { id: order.id } },
        shift: shiftId ? { connect: { id: shiftId } } : undefined,
        processedBy: staffId ? { connect: { id: staffId } } : undefined,
      },
    })

    await recordPendingPaymentShiftReconciliation(tx, {
      reconciliationEnabled,
      claim: { shiftId, candidateShiftId, observedStatus, pendingReason },
      venueId: venue.id,
      paymentId: newPayment.id,
      orderId: order.id,
      staffId,
      channel: 'posSyncOrder',
      amountPesos: new Prisma.Decimal(posPayment.amount),
      tipPesos: new Prisma.Decimal(posPayment.tipAmount ?? 0),
    })

    logger.info(`[🥾 PosSyncOrder] Pago ${newPayment.id} creado para la orden ${order.id}.`)

    // Crear la asignación del pago
    await tx.paymentAllocation.create({
      data: {
        amount: newPayment.amount,
        payment: { connect: { id: newPayment.id } },
        order: { connect: { id: order.id } },
      },
    })
    logger.info(`[🥾 PosSyncOrder] Asignación de pago creada para el pago ${newPayment.id}.`)
  }
}

/**
 * Procesa un evento de eliminación de una Orden desde el POS.
 * En lugar de borrar, actualiza el estado a DELETED.
 * Incluye lógica de resolución inteligente para encontrar la orden correcta.
 * @param payload - Los datos mapeados de la orden desde el producer.
 */
export async function processPosOrderDeleteEvent(payload: RichPosPayload): Promise<Order | null> {
  const { venueId, orderData } = payload
  const { externalId } = orderData

  logger.info(`[🥾 PosSyncOrder] Processing delete event for order ${externalId} at Venue ${venueId}`)

  // Usar la misma lógica de resolución inteligente para encontrar la orden
  const entityParts = externalId.split(':')
  const folio = entityParts.length === 3 ? entityParts[2] : externalId

  const order = await findExistingOrderWithSmartResolution(prisma, externalId, venueId, folio)

  if (!order) {
    logger.warn(
      `[🥾 PosSyncOrder] Order with externalId ${externalId} not found at Venue ${venueId} for deletion (even with smart resolution).`,
    )
    return null
  }

  const updatedOrder = await prisma.order.update({
    where: {
      id: order.id,
    },
    data: {
      status: OrderStatus.DELETED,
      syncedAt: new Date(),
      syncStatus: SyncStatus.SYNCED,
    },
  })

  // Emit socket event for real-time updates to POS devices
  try {
    socketManager.broadcastToVenue(venueId, SocketEventType.ORDER_DELETED, {
      orderId: updatedOrder.id,
      orderNumber: updatedOrder.orderNumber,
      venueId: venueId,
      status: updatedOrder.status,
      externalId: updatedOrder.externalId,
      eventType: 'deleted', // For Android compatibility
      timestamp: new Date().toISOString(),
    })

    logger.info('[🔔 PosSyncOrder] Socket event ORDER_DELETED emitted', {
      orderId: updatedOrder.id,
      orderNumber: updatedOrder.orderNumber,
      venueId: venueId,
    })
  } catch (error) {
    logger.error('[❌ PosSyncOrder] Failed to emit socket event for deletion', { orderId: updatedOrder.id, error })
    // Don't fail the order sync if socket emission fails
  }

  logger.info(
    `[🥾 PosSyncOrder] Order ${updatedOrder.id} (externalId: ${updatedOrder.externalId}) marked as DELETED. Original request was for: ${externalId}`,
  )
  return updatedOrder
}

/**
 * Mapea un ID de método de pago del POS a nuestro enum de Prisma,
 * utilizando un catálogo dinámico proporcionado desde el POS.
 * @param posMethodId - El ID del método de pago del POS (ej. 'CRE', 'EFE').
 * @param catalog - El catálogo completo de formas de pago desde el POS.
 * @returns El enum PaymentMethod correspondiente.
 */
function mapPaymentMethodFromCatalog(posMethodId: string, catalog: PosPaymentMethod[]): PaymentMethod {
  const methodInfo = catalog.find(m => m.idformadepago.trim() === posMethodId.trim())

  if (!methodInfo) {
    logger.warn(`[🥾 PosSyncOrder] Información para el método de pago '${posMethodId}' no encontrada en el catálogo. Usando 'OTHER'.`)
    return PaymentMethod.OTHER
  }

  // La columna 'tipo' de formasdepago define la categoría del método de pago.
  // 1: Efectivo, 2: Tarjeta, 3: Vales, 4: Otros.
  switch (methodInfo.tipo) {
    case 1:
      return PaymentMethod.CASH
    case 2:
      // No podemos distinguir entre Crédito y Débito solo con el tipo.
      // Usamos una heurística basada en la descripción para ser más precisos.
      const description = methodInfo.descripcion.toUpperCase()
      if (description.includes('DEB') || description.includes('DÉBITO')) {
        return PaymentMethod.DEBIT_CARD
      }
      // Por defecto, cualquier tarjeta se considera de crédito.
      return PaymentMethod.CREDIT_CARD
    case 3: // Vales
    case 4: // Otros
    default:
      return PaymentMethod.OTHER
  }
}
