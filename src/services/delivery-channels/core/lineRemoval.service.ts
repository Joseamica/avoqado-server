/**
 * La ÚNICA aplicación del retiro de un renglón de reparto (spec §3.0 [N-7][N-21]).
 *
 * Un renglón retirado es uno que el proveedor dejó de cobrar. Aquí sólo se MARCA: la venta
 * (`OrderItem.removedAt`), cada comanda de cocina del pedido (`removedAt` + prefijo
 * `RETIRADO · `, que los APK viejos ven sin saber del campo) y la acción de línea pasa a
 * `CONFIRMED`. El dinero NO se mueve aquí: lo liquida la reconciliación contra la foto del
 * proveedor, y una liquidación terminal (`settlement`, `refundPaymentId`) jamás se reabre.
 *
 * 🔴 Siempre dentro de `withDeliveryOrderLock(orderId)`: los dos productores de comandas
 * (ingesta y liberación de un programado) crean bajo el mismo candado y llaman
 * `marcarRetirosEnComandas`, así que una comanda nacida DESPUÉS de un retiro nace marcada.
 */
import { DeliveryProvider, Prisma } from '@prisma/client'

import logger from '@/config/logger'

import { contexto } from './respondToDeliveryOrder.service'

export const PREFIJO_RETIRADO = 'RETIRADO · '

/**
 * Marca toda línea de comanda del pedido cuyo `OrderItem` está retirado y ella todavía no.
 * Liga por `orderItemId`, o por el id de línea del proveedor en comandas que nacieron antes
 * de esa columna. El `removedAt IS NULL` es lo que hace idempotente el prefijo.
 */
export async function marcarRetirosEnComandas(tx: Prisma.TransactionClient, orderId: string, venueId: string): Promise<number> {
  return tx.$executeRaw`
    UPDATE "KdsOrderItem" ki
    SET "removedAt" = oi."removedAt", "productName" = ${PREFIJO_RETIRADO} || ki."productName"
    FROM "KdsOrder" k, "OrderItem" oi
    WHERE ki."kdsOrderId" = k.id
      AND k."orderId" = ${orderId} AND k."venueId" = ${venueId}
      AND oi."orderId" = ${orderId} AND oi."removedAt" IS NOT NULL
      AND (ki."orderItemId" = oi.id
           OR (ki."orderItemId" IS NULL AND oi."externalLineId" IS NOT NULL AND ki."externalLineId" = oi."externalLineId"))
      AND ki."removedAt" IS NULL`
}

export async function applyLineRemoval(
  tx: Prisma.TransactionClient,
  p: { orderId: string; orderItemId: string; origin: 'STAFF' | 'PROVIDER'; staffId?: string },
): Promise<void> {
  // El renglón se resuelve DENTRO de su pedido: un id de otro pedido (u otro negocio) no retira nada.
  const item = await tx.orderItem.findFirst({
    where: { id: p.orderItemId, orderId: p.orderId },
    select: { id: true, removedAt: true, externalLineId: true, productName: true, order: { select: { venueId: true } } },
  })
  if (!item) throw new Error(`applyLineRemoval: el renglón ${p.orderItemId} no es del pedido ${p.orderId}`)
  const venueId = item.order.venueId

  const primeraVez = item.removedAt === null
  if (primeraVez) await tx.orderItem.updateMany({ where: { id: item.id, removedAt: null }, data: { removedAt: new Date() } })

  // Reparadora: corre aunque el renglón ya estuviera retirado, para marcar comandas nacidas después.
  await marcarRetirosEnComandas(tx, p.orderId, venueId)

  if (item.externalLineId) {
    const clave = { orderId_lineId_action: { orderId: p.orderId, lineId: item.externalLineId, action: 'REMOVE_ITEM' } }
    const accion = await tx.deliveryLineAction.findUnique({ where: clave, select: { id: true, status: true } })
    if (accion) {
      // Sólo el estado: `settlement` y `refundPaymentId` son de la liquidación y no se reabren.
      if (accion.status !== 'CONFIRMED') {
        await tx.deliveryLineAction.update({ where: { id: accion.id }, data: { status: 'CONFIRMED', resolvedAt: new Date() } })
      }
    } else {
      const ctx = await contexto(venueId, p.orderId)
      if (ctx) {
        await tx.deliveryLineAction.create({
          data: {
            venueId,
            orderId: p.orderId,
            orderItemId: item.id,
            provider: ctx.provider as DeliveryProvider,
            externalOrderId: ctx.externalOrderId,
            storeId: ctx.storeId,
            lineId: item.externalLineId,
            action: 'REMOVE_ITEM',
            status: 'CONFIRMED',
            origin: p.origin,
            requestedByStaffId: p.staffId ?? null,
            resolvedAt: new Date(),
          },
        })
      } else {
        logger.error('🚨 [Delivery] renglón retirado sin canal resoluble: no hay acción de línea que liquidar', {
          orderId: p.orderId,
          orderItemId: item.id,
        })
      }
    }
  }

  if (primeraVez) {
    await tx.activityLog.create({
      data: {
        venueId,
        staffId: p.staffId ?? null,
        action: 'DELIVERY_ITEM_REMOVED',
        entity: 'Order',
        entityId: p.orderId,
        data: { orderItemId: item.id, lineId: item.externalLineId, productName: item.productName, origin: p.origin },
      },
    })
  }
}
