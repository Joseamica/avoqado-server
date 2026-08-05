/**
 * Upsell — impresiones, conversión y desempeño.
 *
 * Spec: Avoqado-HQ/specs/upsell-pantalla-cliente-2026-08-03.md (C4, C5, C15)
 *
 * 🔴 La regla de oro de este archivo: **el dinero del reporte NO sale de lo que
 * reportó el cliente.** Sale de las líneas reales de la orden que se pagó, atadas
 * por `orderItemExternalId`. Un POS alterado puede mandar cualquier monto; lo
 * único que no puede falsificar es una línea cobrada.
 *
 *   momento de upsell ──► UpsellImpression (orderId = null, aporta $0)
 *                              │
 *                              │  el pago cierra
 *                              ▼
 *                         PATCH conversión ──► orderId + convertedAt
 *                              │
 *                              ▼
 *                    ingreso = Σ líneas reales de esa orden
 *                              cuyo externalId está en UpsellAcceptance
 */

import { Prisma, UpsellSurface } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'

// ═══════════════════════════════════════════════════════════════════════════
// Grupo de control (holdout)
// ═══════════════════════════════════════════════════════════════════════════

/** Porcentaje de momentos que NO ven tarjetas, para poder medir el aumento real. */
export const HOLDOUT_PERCENT = 10

/**
 * Sorteo DETERMINISTA por `impressionId`: el mismo id siempre cae del mismo lado.
 *
 * 🔴 Determinista a propósito, no `Math.random()`. Así el reparto es auditable
 * (cualquiera puede recalcularlo) y no depende de que el cliente sortee honesto.
 * Además, un reintento del mismo momento no cambia de grupo a media venta.
 */
export function isHoldout(impressionId: string, percent: number = HOLDOUT_PERCENT): boolean {
  // FNV-1a de 32 bits: barato, sin dependencias, y reparte parejo.
  let hash = 0x811c9dc5
  for (let i = 0; i < impressionId.length; i++) {
    hash ^= impressionId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % 100 < percent
}

// ═══════════════════════════════════════════════════════════════════════════
// Registrar un momento
// ═══════════════════════════════════════════════════════════════════════════

export interface AcceptedLineInput {
  ruleId: string
  productId: string
  /** Determinista: `upsell:<impressionId>:<idx>`, el patrón de `sync:<intentId>:<idx>`. */
  orderItemExternalId: string
}

export interface RecordImpressionInput {
  /** Lo genera el CLIENTE (UUID local), como `localOrderId` en el reducer de sync. */
  impressionId: string
  venueId: string
  shownRuleIds: string[]
  accepted: AcceptedLineInput[]
  reportedAmount: number
  cartSubtotalBefore: number
  surface: UpsellSurface
  /** 'counter' | 'tableOrdering' | 'tablePaying' */
  context: string
}

/**
 * Registra el momento. **Idempotente por `impressionId`**: reenviarlo actualiza,
 * no duplica. Es fuego-y-olvido desde el POS: si esto falla, el cobro no se entera.
 */
export async function recordImpression(input: RecordImpressionInput) {
  // Sólo reglas de ESTE venue. Un id desconocido o de otro venue se descarta en
  // silencio: no vale tumbar una métrica por un dato sucio.
  const ownRules = await prisma.upsellRule.findMany({
    where: { id: { in: [...input.shownRuleIds, ...input.accepted.map(a => a.ruleId)] }, venueId: input.venueId },
    select: { id: true },
  })
  const ownIds = new Set(ownRules.map(r => r.id))

  const shownRuleIds = input.shownRuleIds.filter(id => ownIds.has(id))
  const accepted = input.accepted.filter(a => ownIds.has(a.ruleId))

  const dropped = input.shownRuleIds.length - shownRuleIds.length + (input.accepted.length - accepted.length)
  if (dropped > 0) {
    logger.warn(`⚠️ [UPSELL] ${dropped} ruleId(s) descartados por no pertenecer al venue ${input.venueId}`)
  }

  return prisma.$transaction(async tx => {
    const impression = await tx.upsellImpression.upsert({
      where: { id: input.impressionId },
      create: {
        id: input.impressionId,
        venueId: input.venueId,
        shownRuleIds,
        context: input.context,
        reportedAmount: new Prisma.Decimal(input.reportedAmount),
        cartSubtotalBefore: new Prisma.Decimal(input.cartSubtotalBefore),
        surface: input.surface,
      },
      update: {
        shownRuleIds,
        reportedAmount: new Prisma.Decimal(input.reportedAmount),
        cartSubtotalBefore: new Prisma.Decimal(input.cartSubtotalBefore),
        surface: input.surface,
      },
    })

    // Las aceptaciones son la parte que prueba la atribución. Se reescriben
    // completas en un reenvío para que el estado final sea el que mandó el POS.
    await tx.upsellAcceptance.deleteMany({ where: { impressionId: impression.id } })
    if (accepted.length > 0) {
      await tx.upsellAcceptance.createMany({
        data: accepted.map(a => ({
          impressionId: impression.id,
          ruleId: a.ruleId,
          productId: a.productId,
          orderItemExternalId: a.orderItemExternalId,
        })),
        skipDuplicates: true,
      })
    }

    return impression
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// Conversión
// ═══════════════════════════════════════════════════════════════════════════

export class UpsellConversionError extends Error {
  constructor(
    message: string,
    readonly code: 'ORDER_NOT_IN_VENUE' | 'ALREADY_CONVERTED_TO_OTHER_ORDER',
    readonly httpStatus: number,
  ) {
    super(message)
    this.name = 'UpsellConversionError'
  }
}

/**
 * Marca que el momento terminó en una venta pagada.
 *
 * 🔴 **Upsert, no update.** El POST es fuego-y-olvido y este PATCH puede llegar
 * ANTES de que la fila exista (o desde otro dispositivo, en mesa). Si aquí
 * exigiéramos que ya existiera, se perdería la conversión con un 404.
 */
export async function convertImpression(venueId: string, impressionId: string, orderId: string) {
  const order = await prisma.order.findFirst({ where: { id: orderId, venueId }, select: { id: true } })
  if (!order) {
    throw new UpsellConversionError('Esa orden no pertenece a este venue.', 'ORDER_NOT_IN_VENUE', 404)
  }

  const existing = await prisma.upsellImpression.findUnique({
    where: { id: impressionId },
    select: { id: true, venueId: true, orderId: true },
  })

  if (existing && existing.orderId && existing.orderId !== orderId) {
    throw new UpsellConversionError('Ese momento de upsell ya se había convertido en otra orden.', 'ALREADY_CONVERTED_TO_OTHER_ORDER', 409)
  }
  // Mismo orderId = no-op idempotente.
  if (existing?.orderId === orderId) return existing

  return prisma.upsellImpression.upsert({
    where: { id: impressionId },
    create: {
      id: impressionId,
      venueId,
      orderId,
      shownRuleIds: [],
      context: 'unknown',
      surface: UpsellSurface.NONE,
      convertedAt: new Date(),
    },
    update: { orderId, convertedAt: new Date() },
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// Desempeño
// ═══════════════════════════════════════════════════════════════════════════

export interface UpsellPerformance {
  hasData: boolean
  /** Momentos en que SÍ se mostraron tarjetas (excluye el grupo de control). */
  shownCount: number
  acceptedCount: number
  /** aceptados ÷ mostrados. 0 cuando no hubo momentos. */
  acceptanceRate: number
  /**
   * 🔴 "Ventas ATRIBUIDAS", no "ingreso incremental". Mide el dinero de las
   * líneas que el upsell puso en órdenes pagadas. NO descuenta lo que el cliente
   * habría comprado igual — para eso está `lift` de abajo.
   */
  attributedSales: number
  /** Momentos del grupo de control (no vieron nada, a propósito). */
  holdoutCount: number
  /** Ticket promedio de quienes vieron tarjetas vs quienes no. */
  avgTicketShown: number
  avgTicketHoldout: number
  /** El aumento REAL: diferencia de ticket promedio. null si falta muestra. */
  measuredLift: number | null
}

/**
 * 🔴 Una sola consulta agregada. NUNCA un `findMany` sin `take` cruzando
 * impresiones contra órdenes y líneas: este repo ya murió por OOM exactamente así
 * (memoria `oom-render-analytics-512mb`).
 */
export async function getPerformance(venueId: string, from: Date, to: Date): Promise<UpsellPerformance> {
  const rows = await prisma.$queryRaw<
    Array<{
      surface: string
      impressions: bigint
      converted: bigint
      accepted: bigint
      attributed: Prisma.Decimal | null
      avg_ticket: Prisma.Decimal | null
    }>
  >`
    WITH imp AS (
      SELECT i.id,
             i."surface",
             i."orderId",
             (SELECT COUNT(*) FROM "UpsellAcceptance" a WHERE a."impressionId" = i.id) AS acc_count
      FROM "UpsellImpression" i
      WHERE i."venueId" = ${venueId}
        AND i."shownAt" >= ${from}
        AND i."shownAt" <= ${to}
    )
    SELECT
      CASE WHEN imp."surface" = 'HOLDOUT' THEN 'HOLDOUT' ELSE 'SHOWN' END AS surface,
      COUNT(*)::bigint AS impressions,
      -- 🔴 Momentos que SÍ terminaron en venta. El promedio de ticket sólo puede
      -- salir de éstos, y sólo se pueden comparar dos lados que ambos tengan.
      COUNT(*) FILTER (WHERE imp."orderId" IS NOT NULL)::bigint AS converted,
      COUNT(*) FILTER (WHERE imp.acc_count > 0)::bigint AS accepted,
      COALESCE(SUM(
        (SELECT COALESCE(SUM(oi."total"), 0)
           FROM "UpsellAcceptance" a
           JOIN "OrderItem" oi ON oi."externalId" = a."orderItemExternalId" AND oi."orderId" = imp."orderId"
          WHERE a."impressionId" = imp.id)
      ), 0) AS attributed,
      AVG((SELECT o."total" FROM "Order" o WHERE o.id = imp."orderId")) AS avg_ticket
    FROM imp
    GROUP BY 1
  `

  const shown = rows.find(r => r.surface === 'SHOWN')
  const holdout = rows.find(r => r.surface === 'HOLDOUT')

  const shownCount = Number(shown?.impressions ?? 0)
  const acceptedCount = Number(shown?.accepted ?? 0)
  const holdoutCount = Number(holdout?.impressions ?? 0)
  const avgTicketShown = Number(shown?.avg_ticket ?? 0)
  const avgTicketHoldout = Number(holdout?.avg_ticket ?? 0)

  // 🔴 Se comparan momentos CONVERTIDOS, no momentos mostrados.
  //
  // El promedio de ticket sale de `Order.total` vía `orderId`; una impresión sin
  // convertir no aporta al promedio (AVG salta los NULL). Si un lado tiene cero
  // convertidas, su promedio es 0 y la resta devuelve el ticket ENTERO del otro
  // lado disfrazado de "aumento".
  //
  // No es hipotético: así estaba, y con un ticket de $647 el reporte decía
  // "+$647 de aumento". Este guard es la red que atrapa cualquier cliente —
  // viejo, nuevo o ajeno— que registre momentos sin marcar su conversión.
  const shownConverted = Number(shown?.converted ?? 0)
  const holdoutConverted = Number(holdout?.converted ?? 0)
  const measuredLift = shownConverted > 0 && holdoutConverted > 0 ? avgTicketShown - avgTicketHoldout : null

  return {
    hasData: shownCount + holdoutCount > 0,
    shownCount,
    acceptedCount,
    acceptanceRate: shownCount > 0 ? acceptedCount / shownCount : 0,
    attributedSales: Number(shown?.attributed ?? 0),
    holdoutCount,
    avgTicketShown,
    avgTicketHoldout,
    measuredLift,
  }
}
