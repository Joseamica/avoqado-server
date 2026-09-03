/**
 * Upsell "¿Algo más?" — job nocturno: propone reglas desde los datos del propio local.
 *
 * Spec: Avoqado-HQ/specs/upsell-pantalla-cliente-2026-08-03.md (capas 2 y 4, C13)
 *
 * 🔴 POR QUÉ EXISTE. Sin esto, la única forma de que exista una sugerencia es que el
 * dueño la escriba a mano, una por una. En la práctica eso significa dos reglas la
 * primera semana y nunca más: las tarjetas dejan de aparecer, nadie nota nada, y la
 * función queda muerta sin que se rompa un solo test. Este job convierte "crear
 * reglas" en "aprobar propuestas".
 *
 * Lo que corre hoy:
 *
 *   Capa 2 (BASKET_DATA) → qué se vende junto de verdad, en 90 días de tickets.
 *                          Nace PROPOSED: el dueño aprueba.
 *
 * Lo que está escrito pero APAGADO (`UPSELL_PROMOTION_LAYER`, ver la constante):
 *
 *   Capa 4 (PROMOTION)   → espejo de los Descuentos vigentes. No corre porque el DTO
 *                          al POS todavía no lleva el descuento y la tarjeta pintaría
 *                          el precio de lista sobre un producto rebajado.
 *
 * Lo que este job NUNCA hace:
 *   - Prender una regla de la capa 2 por su cuenta.
 *   - Tocar una regla OWNER o AI.
 *   - Resucitar algo que el dueño descartó.
 */

import { CronJob } from 'cron'
import { Prisma, UpsellOrigin, UpsellRuleStatus, UpsellTriggerType } from '@prisma/client'
import prisma from '../utils/prismaClient'
import logger from '../config/logger'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { venuesWithFeatureAccess } from '../services/access/basePlan.service'
import { computeDedupeKey, PRODUCT_VALIDATION_SELECT } from '../services/upsell/upsell.service'
import { autoProposeRejectionReason, type ProductForValidation } from '../services/upsell/upsellModifiers'
import { scheduleJob } from '../observability/jobContext'
import { utcTs } from '../utils/sqlDates'

// ═══════════════════════════════════════════════════════════════════════════
// Umbrales — con nombre, no mágicos
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 🔴 Los dos umbrales se pueden ajustar por variable de entorno, y NO es scaffolding
 * de pruebas: el spec los deja explícitamente SIN CALIBRAR contra un local real, y
 * calibrar un umbral es exactamente lo que no debería exigir un despliegue. Los
 * valores de abajo son el default sensato, no un dogma.
 */
function envNumber(key: string, fallback: number): number {
  const raw = process.env[key]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Ventana de análisis. Menos que esto y un local de fin de semana no junta señal. */
const ANALYSIS_DAYS = envNumber('UPSELL_ANALYSIS_DAYS', 90)

/**
 * Mínimo de tickets que deben contener el par.
 *
 * Medido en datos reales por qué importa: un venue de demo con 268 órdenes tenía
 * "Pizza Hawaiana → Flan" con **lift 16.75**… sobre 3 tickets. Sin este piso, esa
 * casualidad se presenta al dueño como el hallazgo del mes.
 */
const MIN_SUPPORT = envNumber('UPSELL_MIN_SUPPORT', 20)

/**
 * 🔴 LIFT mínimo, NO confianza.
 *
 *   confianza(A→B) = tickets(A y B) / tickets(A)
 *   soporte(B)     = tickets(B) / tickets totales
 *   lift(A→B)      = confianza(A→B) / soporte(B)
 *
 * La confianza sola premia al producto UBICUO: si el 90% de los tickets llevan
 * refresco, "café → refresco" sale con 90% de confianza y no significa nada — el
 * refresco sale con todo. El lift pregunta lo único que importa: ¿el que pide café
 * se lleva refresco MÁS que el cliente promedio? `lift > 1` es señal, `lift ≈ 1` es
 * coincidencia.
 *
 * Implementar esto con confianza produce un job que propone los tres productos más
 * vendidos del local y los presenta como descubrimientos.
 *
 * ⚠️ 1.2 es un punto de partida razonable, NO está calibrado contra un local real.
 */
const MIN_LIFT = envNumber('UPSELL_MIN_LIFT', 1.2)

/** Tope de propuestas por venue y corrida. Una bandeja de 200 no se revisa nunca. */
const MAX_PROPOSALS_PER_VENUE = 15

/**
 * 🔴 Capa 4 (espejo de descuentos) APAGADA por defecto — y no es prudencia vaga.
 *
 * Dos razones concretas:
 *
 * 1. **La tarjeta mentiría el precio.** El DTO que viaja al POS
 *    (`listActiveRulesForPos`) NO incluye `linkedDiscount`, así que una regla de
 *    promoción llega sin distintivo y el POS pinta el PRECIO DE LISTA. El cliente
 *    vería "$40" en algo promocionado a "-50%". Prenderla exige completar antes ese
 *    contrato (y los dos POS ya saben pintarlo: el código está y sin usar).
 * 2. **El founder decidió "núcleo primero, SIN descuento ligado".** Esta capa se
 *    escribió de más; queda lista y probada, pero no corre hasta que él lo decida.
 */
const PROMOTION_LAYER_ENABLED = process.env.UPSELL_PROMOTION_LAYER === 'true'

/** Venues por lote. Secuencial entre lotes: esto corre de noche, no hay prisa. */
const VENUE_BATCH_SIZE = 10

// ═══════════════════════════════════════════════════════════════════════════
// Capa 2 — market basket
// ═══════════════════════════════════════════════════════════════════════════

interface BasketPair {
  triggerProductId: string
  suggestedProductId: string
  triggerName: string
  suggestedName: string
  supportCount: number
  confidence: number
  lift: number
}

/**
 * Una propuesta que el SQL/el espejo de descuentos encontró, pero que el job
 * decide NO escribir. `reason` es el mensaje humano de `autoProposeRejectionReason`
 * (o el caso "ya no está en el catálogo") — lo que el dueño necesita leer para
 * entender por qué su promoción no generó tarjeta, no un código interno.
 */
export interface DiscardedProposal {
  suggestedName: string
  reason: string
}

/**
 * Una SOLA consulta agregada por venue.
 *
 * 🔴 Jamás `findMany` sobre 90 días de `OrderItem`. Ese patrón exacto ya tumbó
 * producción por OOM (memoria `oom-render-analytics-512mb`): el agregado se hace en
 * Postgres y vuelven a lo mucho MAX_PROPOSALS_PER_VENUE renglones.
 *
 * El lado SUGERIDO se filtra por `upsellEnabled` DENTRO del SQL — el veto del dueño
 * gana sobre todas las capas (R6.1), y filtrarlo aquí evita proponer reglas que
 * nacerían muertas.
 */
async function findBasketPairs(venueId: string, since: Date): Promise<BasketPair[]> {
  return prisma.$queryRaw<BasketPair[]>`
    WITH paid_orders AS (
      SELECT o.id
      FROM "Order" o
      WHERE o."venueId" = ${venueId}
        AND o."paymentStatus" = 'PAID'
        AND o."createdAt" >= ${utcTs(since)}
    ),
    -- DISTINCT: dos cafés en el mismo ticket son UN ticket con café, no dos.
    order_products AS (
      SELECT DISTINCT oi."orderId", oi."productId"
      FROM "OrderItem" oi
      JOIN paid_orders po ON po.id = oi."orderId"
      WHERE oi."productId" IS NOT NULL
    ),
    totals AS (
      SELECT COUNT(*)::int AS n FROM paid_orders
    ),
    product_counts AS (
      SELECT "productId", COUNT(*)::int AS cnt
      FROM order_products
      GROUP BY "productId"
    ),
    pairs AS (
      SELECT a."productId" AS trigger_id, b."productId" AS suggested_id, COUNT(*)::int AS both_cnt
      FROM order_products a
      JOIN order_products b ON a."orderId" = b."orderId" AND a."productId" <> b."productId"
      GROUP BY 1, 2
      HAVING COUNT(*) >= ${MIN_SUPPORT}
    )
    SELECT
      p.trigger_id                                                          AS "triggerProductId",
      p.suggested_id                                                        AS "suggestedProductId",
      pa.name                                                               AS "triggerName",
      pb.name                                                               AS "suggestedName",
      p.both_cnt                                                            AS "supportCount",
      (p.both_cnt::numeric / ca.cnt)::float8                                AS "confidence",
      ((p.both_cnt::numeric / ca.cnt) / (cb.cnt::numeric / t.n))::float8    AS "lift"
    FROM pairs p
    JOIN product_counts ca ON ca."productId" = p.trigger_id
    JOIN product_counts cb ON cb."productId" = p.suggested_id
    CROSS JOIN totals t
    JOIN "Product" pa ON pa.id = p.trigger_id
    JOIN "Product" pb ON pb.id = p.suggested_id
    WHERE t.n > 0
      AND cb.cnt > 0
      -- El veto del dueño, aplicado en la fuente.
      AND pb."upsellEnabled" = true
      AND pb.active = true
      AND pb."deletedAt" IS NULL
      AND pa.active = true
      AND pa."deletedAt" IS NULL
      AND ((p.both_cnt::numeric / ca.cnt) / (cb.cnt::numeric / t.n)) >= ${MIN_LIFT}
    ORDER BY "lift" DESC, "supportCount" DESC
    LIMIT ${MAX_PROPOSALS_PER_VENUE}
  `
}

/**
 * La razón que lee el DUEÑO al aprobar. En español, con números, sin jerga.
 *
 * 🔴 Cada número tiene que significar exactamente lo que dice. `supportCount` es la
 * cantidad de cuentas que llevaron LOS DOS productos — NO la base del porcentaje.
 * Escribirlo como "26% de 6 cuentas" (primer intento) invita a leer 6 como el total
 * analizado, que es falso y hace que el dueño desconfíe del resto del reporte.
 */
export function buildRationale(pair: BasketPair): string {
  const deCada10 = Math.round(pair.confidence * 10)
  const veces = pair.lift.toFixed(1)
  const cuentas = `${pair.supportCount} ${pair.supportCount === 1 ? 'cuenta' : 'cuentas'}`
  return (
    `De cada 10 cuentas con ${pair.triggerName}, ${deCada10} se llevan también ${pair.suggestedName}. ` +
    `Pasó en ${cuentas} en los últimos ${ANALYSIS_DAYS} días, ${veces}× más seguido que el cliente promedio.`
  )
}

async function proposeBasketRules(venueId: string, since: Date): Promise<{ written: number; discarded: DiscardedProposal[] }> {
  const pairs = await findBasketPairs(venueId, since)
  if (pairs.length === 0) return { written: 0, discarded: [] }

  // 🔴 Ronda final de correcciones (2026-08-17). El SQL de `findBasketPairs` ya
  // filtra el veto del dueño y el catálogo (`upsellEnabled`, `active`,
  // `deletedAt`); lo que le falta —venderse por peso, o pedir una opción
  // obligatoria que este job no sabe elegir por el dueño— se checa aquí, con
  // el MISMO validador que usa `approveRule` (`autoProposeRejectionReason`,
  // `upsellModifiers.ts`), en vez de reimplementar la regla. Sin esto el
  // dueño ve la propuesta en su bandeja, da "Activar", y el server la
  // rechaza — parece un bug del sistema, no una regla mal armada. Y este job
  // es justo el de MAYOR volumen: propone lo que se compra junto, que suele
  // incluir lo que se vende por peso o pide talla/sabor.
  //
  // 🔴 P2 (2026-08-17): lo que aquí se descarta NO se pierde mudo. Antes esa
  // propuesta rota igual se escribía —el dashboard la pintaba con badge rojo
  // "Pide elegir opciones"— rota pero VISIBLE. Ahora no se escribe nada, así
  // que sin este `discarded` el dueño no tiene forma de saber por qué su
  // producto estrella nunca generó una tarjeta de sugerencia.
  const productos = await prisma.product.findMany({
    where: { id: { in: [...new Set(pairs.map(p => p.suggestedProductId))] }, venueId },
    select: PRODUCT_VALIDATION_SELECT,
  })
  const porId = new Map(productos.map(p => [p.id, p as ProductForValidation]))

  let written = 0
  const discarded: DiscardedProposal[] = []
  for (const pair of pairs) {
    const producto = porId.get(pair.suggestedProductId)
    if (!producto) {
      discarded.push({ suggestedName: pair.suggestedName, reason: 'Ya no está en el catálogo de este venue' })
      continue
    }
    const rechazo = autoProposeRejectionReason(producto)
    if (rechazo) {
      discarded.push({ suggestedName: pair.suggestedName, reason: rechazo })
      continue
    }

    const dedupeKey = computeDedupeKey({
      origin: UpsellOrigin.BASKET_DATA,
      triggerType: UpsellTriggerType.PRODUCT,
      triggerProductIds: [pair.triggerProductId],
      suggestedProductId: pair.suggestedProductId,
    })

    // 🔴 No resucitar lo descartado. El dueño ya dijo que no a ESTA regla; volver a
    // proponerla cada noche convierte la bandeja en ruido y enseña a ignorarla.
    const existing = await prisma.upsellRule.findUnique({
      where: { venueId_dedupeKey: { venueId, dedupeKey } },
      select: { id: true, status: true },
    })
    if (existing?.status === UpsellRuleStatus.DISMISSED) continue

    await prisma.upsellRule.upsert({
      where: { venueId_dedupeKey: { venueId, dedupeKey } },
      // Si ya existe (PROPOSED o ACTIVE) se refresca la EVIDENCIA, nunca el estado:
      // una regla que el dueño ya aprobó no se apaga sola porque bajó el lift.
      update: {
        supportCount: pair.supportCount,
        lift: new Prisma.Decimal(pair.lift.toFixed(4)),
        rationale: buildRationale(pair),
      },
      create: {
        venueId,
        triggerType: UpsellTriggerType.PRODUCT,
        triggerProductIds: [pair.triggerProductId],
        suggestedProductId: pair.suggestedProductId,
        origin: UpsellOrigin.BASKET_DATA,
        status: UpsellRuleStatus.PROPOSED,
        supportCount: pair.supportCount,
        lift: new Prisma.Decimal(pair.lift.toFixed(4)),
        rationale: buildRationale(pair),
        dedupeKey,
      },
    })
    written++
  }
  return { written, discarded }
}

// ═══════════════════════════════════════════════════════════════════════════
// Capa 4 — espejo de los Descuentos vigentes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Una regla PROMOTION nace y muere con su descuento.
 *
 * Nace ACTIVE —no PROPOSED— porque el dueño YA tomó la decisión al crear el
 * descuento; volvérsela a preguntar sería burocracia.
 *
 * Se saltan COMP y 2x1 a propósito: la tarjeta muestra UN precio, y "llévate 2 y
 * paga 1" o "va por cuenta de la casa" no se pueden pintar como un precio sin
 * mentir. Es el mismo filtro que rechaza esos tipos al crear una regla a mano.
 */
async function syncPromotionRules(
  venueId: string,
  now: Date,
): Promise<{ activated: number; retired: number; discarded: DiscardedProposal[] }> {
  const discounts = await prisma.discount.findMany({
    where: {
      venueId,
      active: true,
      scope: 'ITEM',
      type: { in: ['PERCENTAGE', 'FIXED_AMOUNT'] },
      buyQuantity: null, // sin 2x1
      OR: [{ validFrom: null }, { validFrom: { lte: now } }],
      AND: [{ OR: [{ validUntil: null }, { validUntil: { gte: now } }] }],
    },
    select: {
      id: true,
      targetItemIds: true,
      daysOfWeek: true,
      timeFrom: true,
      timeUntil: true,
    },
  })

  const vigentes = new Set<string>()
  let activated = 0
  // 🔴 P2 (2026-08-17): esta capa nace ACTIVE directo — el dueño ya decidió al
  // crear el descuento. Antes rechazar aquí era mudo; ahora se explica igual
  // que la capa 2, porque el dueño ve su descuento vigente y ninguna tarjeta.
  const discarded: DiscardedProposal[] = []

  for (const d of discounts) {
    if (d.targetItemIds.length === 0) continue

    // El veto del dueño también aquí: un descuento sobre un producto no marcado
    // como sugerible NO produce tarjeta.
    //
    // 🔴 Ronda final de correcciones (2026-08-17): el select ahora trae lo que
    // `autoProposeRejectionReason` necesita (+ `name` para poder explicar el
    // rechazo). Esta capa es la más delicada de las tres: nace ACTIVE directo,
    // SIN pasar por `approveRule` (el dueño "ya decidió" al crear el
    // descuento) — así que sin este filtro un producto por peso o con un
    // obligatorio sin resolver se guardaría ACTIVE y el POS lo ignoraría para
    // siempre, en silencio, sin que ningún "Activar" fallido lo delatara.
    const sugeribles = await prisma.product.findMany({
      where: { id: { in: d.targetItemIds }, venueId, upsellEnabled: true, active: true, deletedAt: null },
      select: { ...PRODUCT_VALIDATION_SELECT, name: true },
    })

    for (const p of sugeribles) {
      const rechazo = autoProposeRejectionReason(p as ProductForValidation)
      if (rechazo) {
        discarded.push({ suggestedName: p.name, reason: rechazo })
        continue
      }

      const dedupeKey = computeDedupeKey({
        origin: UpsellOrigin.PROMOTION,
        triggerType: UpsellTriggerType.ALWAYS,
        suggestedProductId: p.id,
        linkedDiscountId: d.id,
      })
      vigentes.add(dedupeKey)

      const existing = await prisma.upsellRule.findUnique({
        where: { venueId_dedupeKey: { venueId, dedupeKey } },
        select: { status: true },
      })
      if (existing?.status === UpsellRuleStatus.DISMISSED) continue

      await prisma.upsellRule.upsert({
        where: { venueId_dedupeKey: { venueId, dedupeKey } },
        update: { daysOfWeek: d.daysOfWeek, timeFrom: d.timeFrom, timeUntil: d.timeUntil, status: UpsellRuleStatus.ACTIVE },
        create: {
          venueId,
          triggerType: UpsellTriggerType.ALWAYS,
          suggestedProductId: p.id,
          origin: UpsellOrigin.PROMOTION,
          status: UpsellRuleStatus.ACTIVE,
          linkedDiscountId: d.id,
          daysOfWeek: d.daysOfWeek,
          timeFrom: d.timeFrom,
          timeUntil: d.timeUntil,
          dedupeKey,
        },
      })
      activated++
    }
  }

  // Lo que ya no está vigente se retira. 🔴 SOLO reglas PROMOTION: jamás una OWNER,
  // AI ni BASKET_DATA — apagar el trabajo del dueño porque venció un descuento
  // ajeno sería exactamente el bug que nadie relaciona con su causa.
  const { count: retired } = await prisma.upsellRule.updateMany({
    where: {
      venueId,
      origin: UpsellOrigin.PROMOTION,
      status: UpsellRuleStatus.ACTIVE,
      dedupeKey: { notIn: vigentes.size > 0 ? [...vigentes] : ['__ninguna__'] },
    },
    data: { status: UpsellRuleStatus.INACTIVE },
  })

  return { activated, retired, discarded }
}

// ═══════════════════════════════════════════════════════════════════════════
// El job
// ═══════════════════════════════════════════════════════════════════════════

export interface UpsellJobResult {
  venuesProcessed: number
  proposed: number
  promotionsActivated: number
  promotionsRetired: number
  /**
   * Propuestas que un generador ENCONTRÓ pero no escribió (producto por peso,
   * o pide una opción obligatoria sin resolver). El detalle con nombre de
   * venue + motivo va al log por venue en `run()`, no aquí — este número es
   * sólo el total agregado de la corrida.
   */
  discarded: number
  errors: number
}

export class NightlyUpsellRulesJob {
  private job: CronJob | null = null
  private isRunning = false

  constructor() {
    // 03:15 hora de Ciudad de México: fuera de la hora en punto, donde se alinean
    // todos los cron y revienta el pool (`.claude/rules/cron-jobs.md`).
    this.job = scheduleJob(
      'nightly-upsell-rules',
      '15 3 * * *',
      async () => {
        await this.run()
      },
      null,
      false,
      'America/Mexico_City',
    )
  }

  start() {
    this.job?.start()
    logger.info('🛒 [UPSELL] Job nocturno de sugerencias programado (03:15 CDMX)')
  }

  stop() {
    this.job?.stop()
  }

  async run(): Promise<UpsellJobResult> {
    if (this.isRunning) {
      logger.warn('🛒 [UPSELL] La corrida anterior sigue viva, se omite esta')
      return { venuesProcessed: 0, proposed: 0, promotionsActivated: 0, promotionsRetired: 0, discarded: 0, errors: 0 }
    }
    this.isRunning = true

    const result: UpsellJobResult = {
      venuesProcessed: 0,
      proposed: 0,
      promotionsActivated: 0,
      promotionsRetired: 0,
      discarded: 0,
      errors: 0,
    }
    const now = new Date()
    const since = new Date(now.getTime() - ANALYSIS_DAYS * 24 * 60 * 60 * 1000)

    try {
      // Lectura de ENTRADA envuelta en retry: es la que muere en la estampida de
      // P1001 del minuto en punto. Obligatorio por `.claude/rules/cron-jobs.md`.
      const venues = await retry(() => prisma.venue.findMany({ where: { active: true }, select: { id: true, name: true } }), {
        retries: 2,
        initialDelay: 1500,
        shouldRetry: shouldRetryDbConnectionError,
        context: 'nightly-upsell.venues',
      })

      const conUpsell = await venuesWithFeatureAccess(
        venues.map(v => v.id),
        'UPSELL',
      )
      const objetivo = venues.filter(v => conUpsell.has(v.id))
      logger.info(`🛒 [UPSELL] ${objetivo.length} venues con la función activa`)

      for (let i = 0; i < objetivo.length; i += VENUE_BATCH_SIZE) {
        const lote = objetivo.slice(i, i + VENUE_BATCH_SIZE)
        await Promise.all(
          lote.map(async venue => {
            try {
              const basket = await proposeBasketRules(venue.id, since)
              const promo = PROMOTION_LAYER_ENABLED
                ? await syncPromotionRules(venue.id, now)
                : { activated: 0, retired: 0, discarded: [] as DiscardedProposal[] }
              result.proposed += basket.written
              result.promotionsActivated += promo.activated
              result.promotionsRetired += promo.retired

              // 🔴 P2 (2026-08-17): "apagado se VE y se EXPLICA, nunca desaparece en
              // silencio" (regla del workspace). Antes de este filtro, un producto por
              // peso o con un obligatorio sin resolver igual generaba una regla ROTA
              // pero VISIBLE —el dashboard la pintaba con badge rojo "Pide elegir
              // opciones"—; ahora no se escribe nada. Sin este log por venue, el dueño
              // no tiene forma de saber por qué su promoción no generó tarjeta.
              const omitidas = [...basket.discarded, ...promo.discarded]
              if (omitidas.length > 0) {
                result.discarded += omitidas.length
                logger.info(`🛒 [UPSELL] ${venue.name} (${venue.id}): ${omitidas.length} propuesta(s) omitida(s)`, {
                  venueId: venue.id,
                  venueName: venue.name,
                  omitidas,
                })
              }

              result.venuesProcessed++
            } catch (error) {
              // Un venue que truena NO tumba la corrida. Si no, un solo local con
              // datos raros deja a todos los demás sin propuestas y nadie lo nota.
              result.errors++
              logger.error(`🛒 [UPSELL] Falló el venue ${venue.name} (${venue.id})`, { error })
            }
          }),
        )
      }

      logger.info(
        `🛒 [UPSELL] Listo: ${result.venuesProcessed} venues · ${result.proposed} propuestas · ` +
          `${result.promotionsActivated} promos activas · ${result.promotionsRetired} retiradas · ` +
          `${result.discarded} omitidas · ${result.errors} errores`,
      )
    } catch (error) {
      logger.error('🛒 [UPSELL] La corrida nocturna falló entera', { error })
      result.errors++
    } finally {
      this.isRunning = false
    }

    return result
  }
}

export const nightlyUpsellRulesJob = new NightlyUpsellRulesJob()
export { findBasketPairs, proposeBasketRules, syncPromotionRules, MIN_SUPPORT, MIN_LIFT, ANALYSIS_DAYS, MAX_PROPOSALS_PER_VENUE }
