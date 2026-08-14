import { Prisma } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { DEFAULT_TIMEZONE, isWithinVenueSchedule } from '@/utils/datetime'
import { resolvePromotionLines, type PromotionOptionSnapshot } from './resolvePromotionLines'

export interface ApplyPromotionParams {
  venueId: string
  orderId: string
  promotionId: string
  /** UUID del POS. Ancla la idempotencia del replay offline. */
  instanceId: string
  selections: Array<{ groupId: string; optionId: string }>
  /** Cuándo se vendió de verdad (ya acotado por el llamador). */
  soldAt: Date
}

/**
 * Aplica una promoción a una orden.
 *
 * 🔴 TODO ocurre en UNA transacción — líneas, instancia y RECÁLCULO de los
 * totales de la orden (audit 2026-08-13: sin el recálculo, una ronda de puras
 * promociones dejaba Order.total viejo y el combo salía de cocina sin
 * cobrarse).
 *
 * 🔴 La venta nunca se rechaza por vigencia. Si la promoción no estaba viva en
 * `soldAt` —típico de una venta offline que sincroniza tarde—, o ya estaba
 * ARCHIVADA al sincronizar, las líneas entran a precio de lista y la instancia
 * queda marcada para revisión. Rechazar mercancía ya entregada es peor que
 * revisar un ticket. (Una promo en DRAFT sí se rechaza: nunca fue visible para
 * un POS legítimo.)
 */
export async function applyPromotionToOrder(
  params: ApplyPromotionParams,
): Promise<{ orderPromotionId: string; netCents: number; created: boolean }> {
  const { venueId, orderId, promotionId, instanceId, selections, soldAt } = params

  const existing = await prisma.orderPromotion.findUnique({
    where: { orderId_instanceId: { orderId, instanceId } },
    select: { id: true, netCents: true },
  })
  if (existing) {
    return { orderPromotionId: existing.id, netCents: existing.netCents, created: false }
  }

  // La ORDEN también se valida contra el tenant y contra su estado: sin esto,
  // una promoción de A podía colgarse de una orden de B, o agregarse líneas a
  // una cuenta ya pagada/cancelada (audit 2026-08-13).
  const order = await prisma.order.findFirst({
    where: { id: orderId, venueId },
    select: { paymentStatus: true, status: true, discountAmount: true, paidAmount: true },
  })
  if (!order) {
    throw new NotFoundError('No encontramos esa cuenta en este establecimiento.')
  }
  if (order.paymentStatus === 'PAID' || order.paymentStatus === 'REFUNDED') {
    throw new BadRequestError('A una cuenta ya pagada no se le pueden agregar promociones.')
  }
  if (order.status === 'COMPLETED' || order.status === 'CANCELLED' || order.status === 'DELETED') {
    throw new BadRequestError('Esa cuenta ya está cerrada.')
  }

  const promotion = await prisma.promotion.findFirst({
    where: { id: promotionId, venueId },
    include: {
      groups: {
        include: {
          options: {
            include: { product: { select: { price: true, venueId: true, name: true, sku: true, category: { select: { name: true } } } } },
          },
        },
      },
    },
  })
  if (!promotion) {
    throw new NotFoundError('No encontramos esa promoción en este establecimiento.')
  }
  const archivada = promotion.status === 'ARCHIVED'
  if (promotion.status !== 'PUBLISHED' && !archivada) {
    throw new BadRequestError('Esa promoción no está publicada.')
  }

  // Resolver lo elegido contra la definición: una opción tiene que pertenecer
  // a su grupo, y no puede faltar ningún grupo por elegir.
  const chosen: PromotionOptionSnapshot[] = []
  const denorm: Array<{ productName: string | null; productSku: string | null; categoryName: string | null }> = []
  for (const group of promotion.groups) {
    const selection = selections.find(s => s.groupId === group.id)
    if (!selection) {
      throw new BadRequestError(`Falta elegir una opción de "${group.name}".`)
    }
    const option = group.options.find(o => o.id === selection.optionId)
    if (!option) {
      throw new BadRequestError(`Esa opción no pertenece al grupo "${group.name}".`)
    }
    // Defensa a nivel dato (además del validador de publicación): cantidades
    // corruptas generan descuentos fantasma o líneas negativas.
    if (option.quantity < 1 || option.chargedQuantity < 0) {
      throw new BadRequestError(`La promoción está mal configurada en "${group.name}". Revísala en el dashboard.`)
    }
    // 🔴 Tenant: el producto de la opción tiene que ser de ESTE venue. Los FKs
    // no lo garantizan (Promotion→Venue y PromotionOption→Product son
    // independientes) y cobrar mercancía ajena sería invisible para ambos.
    if (option.product.venueId !== venueId) {
      throw new BadRequestError(`La promoción referencia un producto que no pertenece a este establecimiento.`)
    }
    chosen.push({
      productId: option.productId,
      quantity: option.quantity,
      chargedQuantity: option.chargedQuantity,
      priceDeltaCents: option.priceDeltaCents,
      listPriceCents: Math.round(Number(option.product.price) * 100),
    })
    denorm.push({
      productName: option.product.name ?? null,
      productSku: option.product.sku ?? null,
      categoryName: option.product.category?.name ?? null,
    })
  }

  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  // Vigencia = FECHAS (validFrom/validUntil) ∧ horario (días/horas). El check
  // de fechas faltaba (audit max 2026-08-13): una promo vencida pero aún
  // PUBLISHED se aplicaba a precio de promo desde un catálogo cacheado o un
  // intent offline re-aplicado — el listado del catálogo la filtraba, pero
  // aplicar era otra puerta. Misma filosofía de siempre: fuera de vigencia la
  // venta NO se rechaza; entra a precio de lista con needsReview.
  const withinDates = (!promotion.validFrom || soldAt >= promotion.validFrom) && (!promotion.validUntil || soldAt <= promotion.validUntil)
  const vigente = !archivada && withinDates && isWithinVenueSchedule(promotion, soldAt, venue?.timezone || DEFAULT_TIMEZONE)

  // Fuera de vigencia: los productos entran igual, a precio de lista.
  const resolved = vigente
    ? resolvePromotionLines({ pricingMode: promotion.pricingMode, priceCents: promotion.priceCents, selections: chosen })
    : resolvePromotionLines({
        pricingMode: 'PER_UNIT',
        priceCents: 0,
        selections: chosen.map(c => ({ ...c, chargedQuantity: c.quantity })),
      })

  try {
    return await prisma.$transaction(async tx => {
      const created = await tx.orderPromotion.create({
        data: {
          orderId,
          promotionId,
          instanceId,
          snapshotJson: {
            name: promotion.name,
            type: promotion.type,
            pricingMode: promotion.pricingMode,
            priceCents: promotion.priceCents,
            selections: chosen,
          } as unknown as Prisma.InputJsonValue,
          grossCents: resolved.grossCents,
          discountCents: resolved.discountCents,
          netCents: resolved.netCents,
          needsReview: !vigente,
          reviewReason: vigente
            ? null
            : archivada
              ? 'La promoción ya estaba archivada al sincronizar la venta.'
              : 'La promoción no estaba en vigencia al momento de la venta.',
        },
      })

      await tx.orderItem.createMany({
        data: resolved.lines.map((line, i) => ({
          orderId,
          orderPromotionId: created.id,
          productId: line.productId,
          // Denormalizados (contrato Toast/Square del schema): sin esto, el
          // recibo y el picker de reembolso muestran líneas sin nombre, y si el
          // producto se borra la línea pierde su identidad.
          productName: denorm[i]?.productName ?? null,
          productSku: denorm[i]?.productSku ?? null,
          categoryName: denorm[i]?.categoryName ?? null,
          quantity: line.quantity,
          unitPrice: line.unitPriceCents / 100,
          discountAmount: line.discountCents / 100,
          taxAmount: 0, // Las promociones NUNCA tocan el impuesto: el CFDI lo deriva del neto.
          total: line.totalCents / 100,
        })),
      })

      // 🔴 El recálculo de totales cae o persiste JUNTO con las líneas: una
      // ronda de puras promociones sin esto ACKeaba con el total viejo.
      const { recalculateOrderTotals } = await import('../mobile/comp-item.mobile.service')
      await recalculateOrderTotals(orderId, Number(order.discountAmount ?? 0), Number(order.paidAmount ?? 0), tx)

      return { orderPromotionId: created.id, netCents: resolved.netCents, created: true }
    })
  } catch (err) {
    // Carrera del replay: dos intents con el MISMO instanceId pueden pasar
    // ambos el pre-read; el unique [orderId, instanceId] detiene al segundo.
    // Ese P2002 no es un error del negocio — es "ya está aplicado": se devuelve
    // el ganador en vez de convertir el replay en REJECTED (audit 2026-08-13).
    if ((err as { code?: string })?.code === 'P2002') {
      const winner = await prisma.orderPromotion.findUnique({
        where: { orderId_instanceId: { orderId, instanceId } },
        select: { id: true, netCents: true },
      })
      if (winner) {
        return { orderPromotionId: winner.id, netCents: winner.netCents, created: false }
      }
    }
    throw err
  }
}

/**
 * Retira una promoción COMPLETA de una orden.
 *
 * 🔴 Nunca línea por línea. Quitar sólo el refresco de un combo de $99 dejaría
 * hamburguesa + papas cobradas a $99. Y antes, borrar una línea dejaba VIVO el
 * descuento que la mencionaba, que luego se volvía a sumar sobre las otras.
 */
export async function removePromotionFromOrder(params: { venueId: string; orderId: string; orderPromotionId: string }): Promise<void> {
  const { venueId, orderId, orderPromotionId } = params

  const found = await prisma.orderPromotion.findFirst({
    where: { id: orderPromotionId, orderId, order: { venueId } },
    select: { id: true, order: { select: { paymentStatus: true, discountAmount: true, paidAmount: true } } },
  })
  if (!found) {
    throw new NotFoundError('No encontramos esa promoción en la cuenta.')
  }
  // De una cuenta pagada no se borra una venta: eso es un reembolso, con su
  // rastro. Borrar líneas históricas dejaría el corte sin cuadrar.
  if (found.order.paymentStatus === 'PAID' || found.order.paymentStatus === 'REFUNDED') {
    throw new BadRequestError('Esta cuenta ya se pagó: retira la promoción con un reembolso, no borrándola.')
  }

  await prisma.$transaction(async tx => {
    await tx.orderItem.deleteMany({ where: { orderPromotionId } })
    await tx.orderPromotion.delete({ where: { id: orderPromotionId } })
    // El total de la orden deja de incluir la promoción EN la misma transacción
    // (audit 2026-08-13: quitar el combo de $99 dejaba el total en $199).
    const { recalculateOrderTotals } = await import('../mobile/comp-item.mobile.service')
    await recalculateOrderTotals(orderId, Number(found.order.discountAmount ?? 0), Number(found.order.paidAmount ?? 0), tx)
  })
}

/**
 * Compensación de una ronda de sync rechazada: retira TODAS las promociones
 * que un intent dejó en la orden, buscándolas por su `instanceId`.
 *
 * 🔴 Por instanceId y no por "las creadas en esta llamada" (audit 2026-08-14):
 * el replay tras un RETRY entra por la guarda de idempotencia y regresa
 * `created:false`, así que un rastreo de recién-creadas queda VACÍO y las
 * promos del intento anterior del MISMO intent sobreviven huérfanas cuando la
 * ronda al final se rechaza en definitivo.
 *
 * Best-effort por promoción: un fallo se loguea y no detiene a las demás ni
 * tapa el error original de la ronda. Devuelve cuántas retiró.
 */
export async function removeIntentPromotions(venueId: string, orderId: string, instanceIds: string[]): Promise<number> {
  if (instanceIds.length === 0) return 0

  const orphans = await prisma.orderPromotion.findMany({
    where: { orderId, instanceId: { in: instanceIds } },
    select: { id: true },
  })

  let removed = 0
  for (const orphan of orphans) {
    try {
      await removePromotionFromOrder({ venueId, orderId, orderPromotionId: orphan.id })
      removed += 1
    } catch (err) {
      logger.error('❌ [PROMOS] No se pudo compensar una promoción de una ronda rechazada', {
        orderId,
        orderPromotionId: orphan.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return removed
}
