import { Prisma, type LoyaltyPromotion } from '@prisma/client'
import logger from '@/config/logger'
import { lineRevenueSql } from '@/services/dashboard/lineRevenue'
import { venueEndOfDay, venueStartOfDay } from '@/utils/datetime'
import type { TxConReintento } from '@/utils/serializableRetry'
import { evaluarPromo, type PromoCandidata, type PromoDecidida, type VentaParaPromo } from './evaluarPromo'

/**
 * Qué promo de lealtad lleva UNA venta (spec §4.3, regla 14): se decide una sola vez y la comparten sellos y puntos.
 * No toma candados: la llama quien ya tiene el de la clienta (así dos ventas a la vez no se saltan el límite).
 */

/** El panel deja 10 activas o programadas; las terminadas que aún cubren una venta tardía también cuentan, por eso hay holgura. */
const PROMOS_POR_VENTA = 25
/** Mismo tope de renglones por orden que los libros fiscales (`TOPES_POR_ORDEN.renglones`). */
const RENGLONES_POR_VENTA = 2_000

type Venta = { venueId: string; customerId: string; orderId: string; soldAt: Date; amount: number }
type Linea = VentaParaPromo['lineas'][number]

export async function decidirPromoDeLaVentaEnTx(tx: TxConReintento, a: Venta): Promise<PromoDecidida | null> {
  const { venueId, customerId, orderId, soldAt } = a
  // Regla 14: si una mitad ya registró el uso, la venta ya está decidida con ESA promo, aunque después se haya creado otra.
  const uso = await tx.loyaltyPromotionUse.findUnique({
    where: { venueId_orderId: { venueId, orderId } },
    select: { customerId: true, promotion: true },
  })
  // El uso es de otra clienta (la venta cambió de clienta): ni se reusa ni se decide otra vez.
  if (uso && uso.customerId !== customerId) return null
  const promos = uso
    ? [uso.promotion]
    : await tx.loyaltyPromotion.findMany({
        where: {
          venueId,
          startsAt: { lte: soldAt },
          AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: soldAt } }] }, { OR: [{ endedAt: null }, { endedAt: { gt: soldAt } }] }],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: PROMOS_POR_VENTA,
      })
  if (promos.length === 0) return null
  if (!uso && promos.length === PROMOS_POR_VENTA) {
    logger.warn('Promo de lealtad: la venta llegó al tope de promos candidatas; las más viejas no se leyeron', { venueId, orderId })
  }

  const venue = await tx.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  const timezone = venue?.timezone ?? 'America/Mexico_City'
  const conFiltro = promos.some(p => p.productIds.length > 0 || p.categoryIds.length > 0)
  const lineas = conFiltro ? await lineasDeLaVenta(tx, venueId, orderId) : []
  const nombres = await nombresDeCategorias(tx, venueId, promos)
  const candidatas = promos.map(p => candidata(p, nombres))

  if (uso) return evaluarPromo(candidatas.map(yaDecidida), { soldAt, timezone, amount: a.amount, lineas, usos: {} })
  const usos = promos.some(p => p.limit !== 'NONE') ? await usosDeLaClienta(tx, venueId, customerId, promos, soldAt, timezone) : {}
  return evaluarPromo(candidatas, { soldAt, timezone, amount: a.amount, lineas, usos })
}

/**
 * Suma el bono de una mitad (sellos o puntos) al uso de la venta: una fila por venta. Sólo se llama cuando esa mitad dio bono > 0
 * (r2 #3), así que toda fila de uso tiene bono y el límite por clienta cuenta filas.
 */
export async function registrarUsoEnTx(
  tx: TxConReintento,
  a: {
    venueId: string
    customerId: string
    orderId: string
    soldAt: Date
    decision: PromoDecidida
    stampsBonus?: number
    pointsBonus?: number
  },
): Promise<void> {
  const stampsBonus = a.stampsBonus ?? 0
  const pointsBonus = a.pointsBonus ?? 0
  // Toda fila de uso tiene bono (r2 #3): sin bono no se gasta el límite. Aquí pasan todos los llamadores.
  if (stampsBonus <= 0 && pointsBonus <= 0) return
  await tx.loyaltyPromotionUse.upsert({
    where: { venueId_orderId: { venueId: a.venueId, orderId: a.orderId } },
    create: {
      venueId: a.venueId,
      promotionId: a.decision.promotionId,
      customerId: a.customerId,
      orderId: a.orderId,
      soldAt: a.soldAt,
      stampsBonus,
      pointsBonus,
    },
    update: { stampsBonus: { increment: stampsBonus }, pointsBonus: { increment: pointsBonus } },
  })
}

/** La venta ya se decidió: fechas, horario, gasto mínimo y límite ya pasaron; sólo se recalcula el monto que califica. */
const yaDecidida = (p: PromoCandidata): PromoCandidata => ({
  ...p,
  startsAt: new Date(0),
  endsAt: null,
  endedAt: null,
  daysOfWeek: [],
  timeFrom: null,
  timeUntil: null,
  minSpend: null,
  limit: 'NONE',
})

const candidata = (p: LoyaltyPromotion, nombres: Map<string, string>): PromoCandidata => ({
  id: p.id,
  name: p.name,
  createdAt: p.createdAt,
  startsAt: p.startsAt,
  endsAt: p.endsAt,
  endedAt: p.endedAt,
  daysOfWeek: p.daysOfWeek,
  timeFrom: p.timeFrom,
  timeUntil: p.timeUntil,
  productIds: p.productIds,
  categoryIds: p.categoryIds,
  categoryNames: p.categoryIds.flatMap(id => nombres.get(id) ?? []),
  categoryProductIds: p.categoryProductIds,
  minSpend: p.minSpend === null ? null : p.minSpend.toNumber(),
  limit: p.limit,
  kind: p.kind,
  multiplier: p.multiplier,
  extraStamps: p.extraStamps,
  extraPoints: p.extraPoints,
})

/**
 * Cada renglón con su NETO = `lineRevenueSql`, la definición única de «lo que ganó un renglón» de los reportes: precio × unidades
 * (kilos si es por peso) + modificadores − su descuento − su parte de los descuentos repartidos (dirigidos y de cuenta); 0 si la
 * plataforma lo quitó. `categoryIdActual` = la categoría de hoy del producto; `categoryName` = la que guardó el renglón al venderse.
 */
async function lineasDeLaVenta(tx: TxConReintento, venueId: string, orderId: string): Promise<Linea[]> {
  const filas = await tx.$queryRaw<
    { productId: string | null; categoryIdActual: string | null; categoryName: string | null; neto: unknown }[]
  >`
    SELECT oi."productId", p."categoryId" AS "categoryIdActual", oi."categoryName", ${Prisma.raw(lineRevenueSql('oi'))} AS "neto"
    FROM "OrderItem" oi
    JOIN "Order" o ON o."id" = oi."orderId"
    LEFT JOIN "Product" p ON p."id" = oi."productId"
    WHERE oi."orderId" = ${orderId} AND o."venueId" = ${venueId}
    ORDER BY oi."id"
    LIMIT ${RENGLONES_POR_VENTA + 1}`
  if (filas.length > RENGLONES_POR_VENTA) {
    // Sin todos los renglones la proporción mentiría: las promos de producto o categoría no aplican; las de toda la venta, sí.
    logger.warn('Promo de lealtad: la venta rebasa el tope de renglones, sin promos de producto o categoría', { venueId, orderId })
    return []
  }
  return filas.map(f => ({ ...f, neto: new Prisma.Decimal(String(f.neto)) }))
}

async function nombresDeCategorias(tx: TxConReintento, venueId: string, promos: LoyaltyPromotion[]): Promise<Map<string, string>> {
  const ids = [...new Set(promos.flatMap(p => p.categoryIds))]
  if (ids.length === 0) return new Map()
  const cats = await tx.menuCategory.findMany({ where: { venueId, id: { in: ids } }, select: { id: true, name: true }, take: ids.length })
  return new Map(cats.map(c => [c.id, c.name]))
}

/** Usos de ESTA clienta por promo: en total y en el día del negocio de `soldAt` (no el de hoy ni el día UTC). */
async function usosDeLaClienta(
  tx: TxConReintento,
  venueId: string,
  customerId: string,
  promos: LoyaltyPromotion[],
  soldAt: Date,
  timezone: string,
): Promise<VentaParaPromo['usos']> {
  const where = { venueId, customerId, promotionId: { in: promos.map(p => p.id) } }
  const total = await tx.loyaltyPromotionUse.groupBy({ by: ['promotionId'], where, _count: { _all: true } })
  const delDia = await tx.loyaltyPromotionUse.groupBy({
    by: ['promotionId'],
    where: { ...where, soldAt: { gte: venueStartOfDay(timezone, soldAt), lte: venueEndOfDay(timezone, soldAt) } },
    _count: { _all: true },
  })
  const usos: VentaParaPromo['usos'] = {}
  for (const g of total) usos[g.promotionId] = { total: g._count._all, delDia: 0 }
  for (const g of delDia) usos[g.promotionId].delDia = g._count._all
  return usos
}
