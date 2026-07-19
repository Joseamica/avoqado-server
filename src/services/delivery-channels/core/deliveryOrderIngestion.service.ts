import prisma from '../../../utils/prismaClient'
import logger from '../../../config/logger'
import {
  DeliveryChannelLink,
  Order,
  OrderAcceptanceMode,
  OrderType,
  OriginSystem,
  PaymentMethod,
  PaymentSource,
  Prisma,
  SplitType,
  TransactionStatus,
} from '@prisma/client'
import { socketManager } from '../../../communication/sockets/managers/socketManager'
import { SocketEventType } from '../../../communication/sockets/types'
import { dispatchOrderStatus } from './statusDispatcher.service'
import { NormalizedDeliveryOrder } from './types'

const PLACEHOLDER_CATEGORY_SLUG = 'delivery-desconocido'

/**
 * Slug determinístico para el sku placeholder de un item sin PLU: lowercase,
 * no-alfanumérico → '-', recortado a 40 chars. Determinístico (nunca `Date.now()`) para que
 * el MISMO item sin PLU en pedidos distintos reutilice el mismo producto placeholder
 * (`findUnique` por venueId_sku lo encuentra) en vez de crear uno nuevo cada vez.
 */
function toPlaceholderSlug(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (cleaned || 'item').slice(0, 40)
}

/**
 * Resuelve el Product.id de Avoqado para un item de delivery por su sku (= Product.sku,
 * PLU del canal o el fallback determinístico si el canal no mandó PLU — ver toPlaceholderSlug).
 * Si el sku no existe en el catálogo (menú desincronizado con el canal), crea un producto
 * placeholder inactivo bajo la categoría `delivery-desconocido` (find-or-create) para no
 * bloquear la ingesta — el staff lo re-mapea después desde el dashboard.
 */
async function resolveProductId(
  tx: Prisma.TransactionClient,
  venueId: string,
  sku: string,
  name: string,
  unitPrice: number,
): Promise<string> {
  const existing = await tx.product.findUnique({ where: { venueId_sku: { venueId, sku } } })
  if (existing) return existing.id

  logger.warn(`[🛵 DeliveryIngest] PLU/sku desconocido '${sku}' en venue ${venueId} — creando placeholder`)

  let category = await tx.menuCategory.findUnique({ where: { venueId_slug: { venueId, slug: PLACEHOLDER_CATEGORY_SLUG } } })
  if (!category) {
    category = await tx.menuCategory.create({
      data: { venueId, name: 'Delivery (sin mapear)', slug: PLACEHOLDER_CATEGORY_SLUG, active: false },
    })
  }

  const created = await tx.product.create({
    data: {
      venueId,
      sku,
      name,
      price: new Prisma.Decimal(unitPrice),
      categoryId: category.id,
      active: false,
    },
  })
  return created.id
}

/**
 * Convierte una NormalizedDeliveryOrder (Task 2) en una Order real de Avoqado con su Payment
 * externo ya liquidado (Avoqado no procesó el dinero — fee 0 explícito) y emite el socket de
 * tiempo real. Patrón calcado de processPosOrderEvent (src/services/pos-sync/posSyncOrder.service.ts):
 * upsert por venueId_externalId para idempotencia, payments guardados detrás de un count===0,
 * y el socket se emite DESPUÉS de que la transacción confirma (su fallo nunca tumba la ingesta).
 */
export async function ingestDeliveryOrder(
  normalized: NormalizedDeliveryOrder,
  link: DeliveryChannelLink,
): Promise<{ order: Order; created: boolean }> {
  const venue = await prisma.venue.findUnique({ where: { id: link.venueId } })
  if (!venue) throw new Error(`Venue ${link.venueId} del channel link no existe`)

  const existing = await prisma.order.findUnique({
    where: { venueId_externalId: { venueId: venue.id, externalId: normalized.externalId } },
  })
  const isNew = !existing

  const order = await prisma.$transaction(async tx => {
    const order = await tx.order.upsert({
      where: { venueId_externalId: { venueId: venue.id, externalId: normalized.externalId } },
      update: { posRawData: normalized.raw as Prisma.InputJsonValue, syncedAt: new Date() },
      create: {
        externalId: normalized.externalId,
        orderNumber: normalized.displayId,
        source: normalized.source,
        originSystem: OriginSystem.DELIVERY_PLATFORM,
        type: OrderType.DELIVERY,
        status: 'CONFIRMED', // AUTO-accept: entra confirmada directo a cocina
        kitchenStatus: 'PENDING',
        paymentStatus: 'PAID',
        subtotal: new Prisma.Decimal(normalized.subtotal),
        taxAmount: new Prisma.Decimal(normalized.taxAmount),
        discountAmount: new Prisma.Decimal(normalized.discountAmount),
        tipAmount: new Prisma.Decimal(normalized.tipAmount),
        total: new Prisma.Decimal(normalized.total),
        posRawData: normalized.raw as Prisma.InputJsonValue,
        createdAt: normalized.placedAt,
        syncedAt: new Date(),
        venue: { connect: { id: venue.id } },
      },
    })

    if (isNew) {
      // Índice explícito (no forEach con await): distintos pedidos con payloads idénticos
      // reintentados producen el MISMO índice por línea → externalId sigue siendo idempotente.
      // Necesario porque un pedido puede repetir el mismo PLU en 2 líneas (p.ej. "Taco" solo +
      // "Taco" con extra queso) — usar solo `${externalId}-${plu}` chocaría con
      // @@unique([orderId, externalId]) de OrderItem (P2002) y tumbaría la tx completa,
      // perdiendo el pedido pagado permanentemente (ver C1 en el review de este scaffold).
      for (let idx = 0; idx < normalized.items.length; idx++) {
        const item = normalized.items[idx]
        // sku determinístico: el PLU del canal, o (si vino vacío) un placeholder derivado
        // del NOMBRE — nunca `Date.now()`, que generaría un producto nuevo por ocurrencia.
        const sku = item.plu || `delivery-unknown-${toPlaceholderSlug(item.name)}`
        const productId = await resolveProductId(tx, venue.id, sku, item.name, item.unitPrice)
        // Modifiers: monto en total + nombres en notes (v1). Resolución a OrderItemModifier rows con PLUs MOD-* = fase staging.
        // El total de línea DEBE incluir sus modifiers para que sum(OrderItem.total) == Order.subtotal (conciliación al centavo).
        const lineTotal = item.modifiers.reduce(
          (acc, m) => acc.add(new Prisma.Decimal(m.unitPrice).mul(m.quantity)),
          new Prisma.Decimal(item.unitPrice).mul(item.quantity),
        )
        const modifierNotes = item.modifiers.map(m => `+ ${m.quantity}x ${m.name}`)
        const notes = [item.notes, ...modifierNotes].filter(Boolean).join(' | ') || undefined
        await tx.orderItem.create({
          data: {
            orderId: order.id,
            productId,
            productName: item.name,
            productSku: sku,
            quantity: item.quantity,
            unitPrice: new Prisma.Decimal(item.unitPrice),
            total: lineTotal,
            taxAmount: new Prisma.Decimal(0),
            externalId: `${normalized.externalId}-${item.plu || 'noplu'}-${idx}`,
            notes,
          },
        })
      }

      const existingPayments = await tx.payment.count({ where: { orderId: order.id } })
      if (existingPayments === 0) {
        const payment = await tx.payment.create({
          data: {
            amount: new Prisma.Decimal(normalized.total),
            tipAmount: new Prisma.Decimal(normalized.tipAmount),
            method: PaymentMethod.OTHER,
            source: PaymentSource.DELIVERY_PLATFORM,
            externalSource: normalized.source, // 'UBER_EATS' | 'RAPPI' | ...
            status: TransactionStatus.COMPLETED,
            splitType: SplitType.FULLPAYMENT,
            processor: link.provider.toLowerCase(),
            // Avoqado NO procesó este dinero: fee 0, neto = monto. La comisión de la
            // plataforma es entre restaurante y plataforma (fuera de Avoqado).
            feePercentage: new Prisma.Decimal(0),
            feeAmount: new Prisma.Decimal(0),
            netAmount: new Prisma.Decimal(normalized.total),
            originSystem: OriginSystem.DELIVERY_PLATFORM,
            externalId: `${normalized.externalId}-platform`,
            posRawData: normalized.raw as Prisma.InputJsonValue,
            venue: { connect: { id: venue.id } },
            order: { connect: { id: order.id } },
          },
        })
        await tx.paymentAllocation.create({
          data: { amount: payment.amount, payment: { connect: { id: payment.id } }, order: { connect: { id: order.id } } },
        })
      }
    }
    return order
  })

  try {
    socketManager.broadcastToVenue(venue.id, isNew ? SocketEventType.ORDER_CREATED : SocketEventType.ORDER_UPDATED, {
      orderId: order.id,
      orderNumber: order.orderNumber,
      venueId: venue.id,
      status: order.status,
      paymentStatus: order.paymentStatus,
      source: order.source,
      externalId: order.externalId,
      eventType: isNew ? 'created' : 'updated',
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    logger.error('[❌ DeliveryIngest] Socket emit falló (no fatal)', { orderId: order.id, error })
  }

  // Modo AUTO: el pedido ya entró CONFIRMED (línea ~102) — le avisamos al canal que lo
  // aceptamos. Solo en la primera ingesta (isNew): una actualización de un pedido ya
  // aceptado jamás debe re-disparar el accept. Doble defensa: dispatchOrderStatus YA traga
  // sus propios errores (statusDispatcher.service.ts), pero este try/catch + .catch()
  // asegura que NADA de esta llamada (ni siquiera un throw síncrono al invocarla) tumbe la
  // ingesta — el pedido ya está persistido y pagado, eso jamás se revierte por un fallo aquí.
  if (isNew && link.orderAcceptanceMode === OrderAcceptanceMode.AUTO) {
    try {
      void dispatchOrderStatus(order, 'ACCEPTED').catch(error => {
        logger.error('[❌ DeliveryIngest] AUTO-accept dispatch falló (async, no fatal)', {
          orderId: order.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
      })
    } catch (error) {
      logger.error('[❌ DeliveryIngest] AUTO-accept dispatch falló al invocar (sync, no fatal)', {
        orderId: order.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }

  return { order, created: isNew }
}
