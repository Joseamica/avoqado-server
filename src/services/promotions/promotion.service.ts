import { bloquearCuentaParaEditar } from '../shared/cuentaCancelada'
import { Prisma } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import { withDeadlockRetry } from '@/utils/serializableRetry'
import { BadRequestError, NotFoundError } from '@/errors/AppError'
import { DEFAULT_TIMEZONE, isWithinVenueSchedule } from '@/utils/datetime'
import { resolvePromotionLines, type PromotionOptionSnapshot } from './resolvePromotionLines'
import { leerModifierIds, revisarExtrasDeLaPieza, type ExtraCobrado, type ExtraDelVenue, type GrupoDeLaPieza } from './extrasDeLaPieza'
import { ORDER_LOCK_WAIT_BUDGET } from '@/services/shared/paymentShiftClaim'
import { assertCardOrderMoneyFrozenInTx } from '@/services/online-ordering/card/guards'
import { rechazarSiEsImportada } from '@/services/shared/ordenImportada'
import { rechazarSiEsCuentaDeTarjetas } from '@/services/giftCards/cuentaDeTarjetas'
import { conservarDescuentoHistorico, recortarDescuentosDeRenglones } from '@/services/shared/repartoDescuentoTx'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  parseServiceCourseSnapshot,
  legacyCourseForSnapshot,
  type ServiceCourseSnapshot,
} from '@/services/service-courses/serviceCourseContract'

/** Tope de grupos de modificadores que se leen por producto al revisar los extras de una pieza (una pieza real trae un puñado). */
const MAX_GRUPOS_DE_MODIFICADORES_POR_PRODUCTO = 50

export interface PromotionSelection {
  groupId: string
  optionId: string
  serviceCourse?: ServiceCourseSnapshot | null
  /** Extras de ESA pieza (id repetido = más unidades). Ausente = como hoy, sin revisión; presente (aunque `[]`) = se revisa. */
  modifierIds?: string[]
}

export interface ApplyPromotionParams {
  venueId: string
  orderId: string
  promotionId: string
  /** UUID del POS. Ancla la idempotencia del replay offline. */
  instanceId: string
  selections: PromotionSelection[]
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
 *
 * 🔴 Candado de la orden (Plan3b): ANTES de la guarda de idempotencia y de cualquier lectura, y todo —instancia,
 * líneas y totales— con la foto leída bajo ese candado. Con `tx` (la venta de `createOrderWithItems`) el servicio no
 * abre otra transacción ni hace nada fuera de ella: quien llama ya tiene la orden (o la creó en privado en esa `tx`).
 */
export async function applyPromotionToOrder(
  params: ApplyPromotionParams,
  tx?: Prisma.TransactionClient,
  /** Internal: a mixed table round recalculates totals once, on its own tx. */
  options: { deferTotalsToCaller?: boolean; sentToKitchenAt?: Date; componentExternalIdPrefix?: string } = {},
): Promise<{ orderPromotionId: string; netCents: number; created: boolean }> {
  if (options.deferTotalsToCaller && !tx) throw new BadRequestError('El recálculo diferido requiere la transacción de la ronda')
  if (tx) return applyPromotionInTransaction(tx, params, options)

  const { orderId, instanceId } = params
  try {
    return await prisma.$transaction(own => applyPromotionInTransaction(own, params, options), ORDER_LOCK_WAIT_BUDGET)
  } catch (err) {
    // Carrera del replay: dos intents con el MISMO instanceId pueden pasar
    // ambos el pre-read; el unique [orderId, instanceId] detiene al segundo.
    // Ese P2002 no es un error del negocio — es "ya está aplicado": se devuelve
    // el ganador en vez de convertir el replay en REJECTED (audit 2026-08-13).
    // Sólo con la transacción PROPIA: la de quien llama quedó abortada y no se consulta.
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

async function applyPromotionInTransaction(
  tx: Prisma.TransactionClient,
  params: ApplyPromotionParams,
  options: { deferTotalsToCaller?: boolean; sentToKitchenAt?: Date; componentExternalIdPrefix?: string },
): Promise<{ orderPromotionId: string; netCents: number; created: boolean }> {
  const { venueId, orderId, promotionId, instanceId, selections, soldAt } = params

  if (!(await bloquearCuentaParaEditar(tx, { venueId, orderId }))) {
    throw new NotFoundError('No encontramos esa cuenta en este establecimiento.')
  }
  // Pedidos en línea fase 2: un pedido de tarjeta sin cobrar tiene un total fijo (el de la tarjeta apartada).
  await assertCardOrderMoneyFrozenInTx(tx, { venueId, orderId })

  const existing = await tx.orderPromotion.findUnique({
    where: { orderId_instanceId: { orderId, instanceId } },
    select: { id: true, netCents: true },
  })
  if (existing) {
    return { orderPromotionId: existing.id, netCents: existing.netCents, created: false }
  }

  // La ORDEN también se valida contra el tenant y contra su estado: sin esto,
  // una promoción de A podía colgarse de una orden de B, o agregarse líneas a
  // una cuenta ya pagada/cancelada (audit 2026-08-13).
  const order = await tx.order.findFirst({
    where: { id: orderId, venueId },
    select: { paymentStatus: true, status: true, discountAmount: true, paidAmount: true, originSystem: true, tableId: true },
  })
  if (!order) {
    throw new NotFoundError('No encontramos esa cuenta en este establecimiento.')
  }
  // R11 (Codex r5): la cabecera de una importada manda y sus renglones traen el IVA dentro y por pieza; rearmarla aquí cobraría
  // el IVA dos veces (P12). Esos cambios se hacen en el POS externo.
  rechazarSiEsImportada(order)
  await rechazarSiEsCuentaDeTarjetas(tx, orderId, 'promociones')
  if (order.paymentStatus === 'PAID' || order.paymentStatus === 'REFUNDED') {
    throw new BadRequestError('A una cuenta ya pagada no se le pueden agregar promociones.')
  }
  if (order.status === 'COMPLETED' || order.status === 'CANCELLED' || order.status === 'DELETED') {
    throw new BadRequestError('Esa cuenta ya está cerrada.')
  }

  const promotion = await tx.promotion.findFirst({
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
  const selectedCourses: Array<{ groupId: string; optionId: string; serviceCourse: ServiceCourseSnapshot | null }> = []
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
    selectedCourses.push({ groupId: group.id, optionId: option.id, serviceCourse: parseServiceCourseSnapshot(selection.serviceCourse) })
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

  const venue = await tx.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
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

  // Extras de cada pieza (modificadores del combo). SIEMPRE después de resolver los precios: si entraran al bruto, FIXED_TOTAL los
  // volvería descuento. Sólo se consulta si alguna selección trae la llave `modifierIds`; nunca lanza (marca revisión).
  const modifierIdsPorPieza = chosen.map((_, i) => {
    const grupo = promotion.groups[i]
    return leerModifierIds(selections.find(s => s.groupId === grupo.id)?.modifierIds)
  })
  const extrasPorPieza: Array<{ extras: ExtraCobrado[]; extrasCents: number }> = chosen.map(() => ({ extras: [], extrasCents: 0 }))
  const problemasDeExtras: string[] = []
  if (modifierIdsPorPieza.some(ids => ids !== undefined)) {
    const productIds = [...new Set(chosen.filter((_, i) => modifierIdsPorPieza[i] !== undefined).map(c => c.productId))]
    const todosLosIds = [...new Set(modifierIdsPorPieza.flatMap(ids => ids ?? []))]
    const topeDeLigas = productIds.length * MAX_GRUPOS_DE_MODIFICADORES_POR_PRODUCTO
    const ligas = await tx.productModifierGroup.findMany({
      take: topeDeLigas,
      where: { productId: { in: productIds }, group: { venueId, active: true } },
      select: {
        productId: true,
        group: { select: { id: true, name: true, required: true, allowMultiple: true, minSelections: true, maxSelections: true } },
      },
    })
    const modificadores = todosLosIds.length
      ? await tx.modifier.findMany({
          take: todosLosIds.length, // ids ya deduplicados: tope exacto
          where: { id: { in: todosLosIds }, group: { venueId } },
          select: { id: true, name: true, price: true, groupId: true },
        })
      : []
    // Si la consulta llega al tope no se descarta en silencio: la revisión de grupos pudo quedar incompleta.
    if (ligas.length >= topeDeLigas) {
      problemasDeExtras.push('No se revisaron todos los grupos de modificadores de las piezas del combo.')
    }
    const extrasDelVenue = new Map<string, ExtraDelVenue>(
      modificadores.map(m => [m.id, { id: m.id, name: m.name, priceCents: Math.round(Number(m.price) * 100), groupId: m.groupId }]),
    )
    const gruposPorProducto = new Map<string, GrupoDeLaPieza[]>()
    for (const liga of ligas) {
      const lista = gruposPorProducto.get(liga.productId) ?? []
      lista.push(liga.group)
      gruposPorProducto.set(liga.productId, lista)
    }
    chosen.forEach((pieza, i) => {
      const revision = revisarExtrasDeLaPieza({
        productName: denorm[i]?.productName ?? 'la pieza',
        quantity: pieza.quantity,
        modifierIds: modifierIdsPorPieza[i],
        gruposDelProducto: gruposPorProducto.get(pieza.productId) ?? [],
        extrasDelVenue,
      })
      extrasPorPieza[i] = { extras: revision.extras, extrasCents: revision.extrasCents }
      problemasDeExtras.push(...revision.problemas)
    })
  }
  const razones = [
    ...(vigente
      ? []
      : [
          archivada
            ? 'La promoción ya estaba archivada al sincronizar la venta.'
            : 'La promoción no estaba en vigencia al momento de la venta.',
        ]),
    ...problemasDeExtras,
  ]

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
        selections: chosen.map((selection, index) => ({
          ...selection,
          ...selectedCourses[index],
          ...(extrasPorPieza[index].extras.length ? { extras: extrasPorPieza[index].extras } : {}),
        })),
      } as unknown as Prisma.InputJsonValue,
      grossCents: resolved.grossCents,
      discountCents: resolved.discountCents,
      netCents: resolved.netCents,
      needsReview: razones.length > 0,
      reviewReason: razones.length ? razones.join(' ') : null,
    },
  })

  const filaDeLaLinea = (line: (typeof resolved.lines)[number], i: number) => ({
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
    course: selectedCourses[i].serviceCourse ? legacyCourseForSnapshot(selectedCourses[i].serviceCourse!) : null,
    ...(selectedCourses[i].serviceCourse ? { serviceCourse: selectedCourses[i].serviceCourse as Prisma.InputJsonValue } : {}),
    ...(options.sentToKitchenAt ? { sentToKitchenAt: options.sentToKitchenAt } : {}),
    ...(options.componentExternalIdPrefix ? { externalId: `${options.componentExternalIdPrefix}:g:${selectedCourses[i].groupId}` } : {}),
  })

  // Sin extras: createMany como siempre. Con extras: un create por renglón (createMany no anida modificadores).
  const sinExtras = resolved.lines.map((line, i) => ({ line, i })).filter(({ i }) => extrasPorPieza[i].extras.length === 0)
  if (sinExtras.length > 0) {
    await tx.orderItem.createMany({ data: sinExtras.map(({ line, i }) => filaDeLaLinea(line, i)) })
  }
  for (const [i, line] of resolved.lines.entries()) {
    const { extras, extrasCents } = extrasPorPieza[i]
    if (extras.length === 0) continue
    await tx.orderItem.create({
      data: {
        ...filaDeLaLinea(line, i),
        // total = lista×q − parte del combo + Σextras; discountAmount (la parte del combo) no cambia.
        total: (line.totalCents + extrasCents) / 100,
        modifiers: {
          create: extras.map(e => ({ modifierId: e.modifierId, name: e.name, quantity: 1, price: e.priceCents / 100 })),
        },
      },
    })
  }

  // 🔴 El recálculo de totales cae o persiste JUNTO con las líneas: una
  // ronda de puras promociones sin esto ACKeaba con el total viejo.
  if (!options.deferTotalsToCaller) {
    const { recalculateOrderTotals } = await import('../mobile/comp-item.mobile.service')
    await recalculateOrderTotals(orderId, Number(order.discountAmount ?? 0), Number(order.paidAmount ?? 0), tx)
  }

  return { orderPromotionId: created.id, netCents: resolved.netCents, created: true }
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
  const { recalculateOrderTotals } = await import('../mobile/comp-item.mobile.service')

  // 🔴 Candado de la orden (Plan3b) ANTES de releer la instancia y el estado: el retiro, sus líneas y el total se
  // deciden y escriben sobre la misma foto.
  const recorte = await withDeadlockRetry(
    async tx => {
      if (!(await bloquearCuentaParaEditar(tx, { venueId, orderId }))) {
        throw new NotFoundError('No encontramos esa promoción en la cuenta.')
      }
      // Pedidos en línea fase 2: un pedido de tarjeta sin cobrar tiene un total fijo (el de la tarjeta apartada).
      await assertCardOrderMoneyFrozenInTx(tx, { venueId, orderId })
      const found = await tx.orderPromotion.findFirst({
        where: { id: orderPromotionId, orderId, order: { venueId } },
        select: { id: true, order: { select: { paymentStatus: true, discountAmount: true, paidAmount: true, originSystem: true } } },
      })
      if (!found) {
        throw new NotFoundError('No encontramos esa promoción en la cuenta.')
      }
      // R11 (Codex r5): la cabecera de una importada manda y sus renglones traen el IVA dentro y por pieza; rearmarla aquí cobraría
      // el IVA dos veces (P12). Esos cambios se hacen en el POS externo.
      rechazarSiEsImportada(found.order)
      await rechazarSiEsCuentaDeTarjetas(tx, orderId, 'cambios de promoción')
      // De una cuenta pagada no se borra una venta: eso es un reembolso, con su
      // rastro. Borrar líneas históricas dejaría el corte sin cuadrar.
      if (found.order.paymentStatus === 'PAID' || found.order.paymentStatus === 'REFUNDED') {
        throw new BadRequestError('Esta cuenta ya se pagó: retira la promoción con un reembolso, no borrándola.')
      }

      // R7-1 (ruling de B2): el resto de cabecera sin fila se congela ANTES de recortar; si no, el recálculo (Σ filas) lo perdería.
      await conservarDescuentoHistorico(tx, orderId, found.order.discountAmount)
      // P4 (founder, 1-oct): lo dirigido a las líneas del combo (un premio de cartilla) se retira con su beneficio ANTES de
      // borrarlas; si no, el premio seguía restando sobre el resto de la cuenta.
      const lineas = await tx.orderItem.findMany({ where: { orderId, orderPromotionId }, select: { id: true } })
      const resultado = await recortarDescuentosDeRenglones(tx, orderId, { renglones: lineas.map(l => l.id), venueId })
      await tx.orderItem.deleteMany({ where: { orderPromotionId } })
      await tx.orderPromotion.delete({ where: { id: orderPromotionId } })
      // El total de la orden deja de incluir la promoción EN la misma transacción
      // (audit 2026-08-13: quitar el combo de $99 dejaba el total en $199).
      await recalculateOrderTotals(
        orderId,
        Math.max(0, Number(found.order.discountAmount ?? 0) - resultado.recortadoPesos),
        Number(found.order.paidAmount ?? 0),
        tx,
      )
      return resultado
    },
    { etiqueta: 'removePromotionFromOrder', ...ORDER_LOCK_WAIT_BUDGET },
  )

  for (const r of recorte.retiradas) {
    void logAction({
      staffId: null,
      venueId,
      action: 'DISCOUNT_REMOVED',
      entity: 'Order',
      entityId: orderId,
      data: {
        orderDiscountId: r.id,
        name: r.name,
        motivo: 'promocion-retirada',
        pointsRefunded: r.pointsRefunded,
        stampRewardReturned: r.stampRewardReturned,
      },
    })
  }
}
