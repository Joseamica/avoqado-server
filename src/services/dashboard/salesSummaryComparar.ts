/**
 * Resumen de ventas · comparar con otro periodo (carril F2, hz:fefa11b6:D7). Plan v5 y su auditoría en el workspace:
 * `docs/audit/2026-11-21-resumen-de-ventas/comparar/promesa.md`.
 *
 * Una sola petición trae los dos lados: se toma UN instante `T` antes de leer; el periodo actual se lee hasta `T` si va a la mitad y el
 * comparado hasta `T` movido igual («hasta la misma hora», como el «Yesterday at this hour» de BigCommerce). El comparado se lee con la
 * cabecera de siempre (misma regla de qué es venta) y sin el puente del QR anterior. El cambio y el % se calculan SÓLO aquí.
 */
import { DateTime, type DurationLikeObject } from 'luxon'

import { BadRequestError } from '@/errors/AppError'
import { legacyAdmission, getSalesSummary } from '@/services/dashboard/sales-summary.dashboard.service'
import type {
  CompararCon,
  SalesSummaryFilters,
  SalesSummaryMetrics,
  SalesSummaryResponse,
} from '@/services/dashboard/sales-summary.dashboard.service'
import { comparacionBloqueadaPorPlan } from '@/services/dashboard/salesSummaryPlanRange'
import { sumsLegacyQrPayments } from '@/services/legacy/qrPayments.legacy.service'
import { zonaDelCalculo } from '@/utils/sanitizeTimezone'

export const OPCIONES_DE_COMPARAR: readonly CompararCon[] = ['previous_period', 'previous_year']

export type RangoComparado =
  | { status: 'notStarted' | 'tooLong' }
  | {
      status: 'ok'
      /** Lo que se lee del periodo actual (hasta `T` si va a la mitad). */
      base: { startDate: string; endDate: string }
      comparado: { startDate: string; endDate: string }
      untilSameTime: boolean
      /** 52 semanas antes: mismos días de la semana (puede caer en el mismo año: 31-dic ⇒ 1-ene). */
      matchedWeekday: boolean
    }

const iso = (d: DateTime) => d.toUTC().toISO()!

/**
 * Qué periodo se compara. Primero meses completos, luego días completos, luego «otro» (horas sueltas). Nunca se encima con el actual.
 * Más de 366 fechas del calendario del negocio ⇒ `tooLong`; un periodo que todavía no empieza ⇒ `notStarted`.
 */
export function rangoComparado(
  startDate: string,
  endDate: string,
  compararCon: CompararCon,
  zonaGuardada: string,
  T: Date,
): RangoComparado {
  const zona = zonaDelCalculo(zonaGuardada)
  // Se leen como las lee `getSalesSummary` (`new Date`): comparar no mueve el rango del reporte de siempre («2026-11-20» sin desfase = UTC).
  const inicio = DateTime.fromJSDate(new Date(startDate)).setZone(zona)
  const finPedido = DateTime.fromJSDate(new Date(endDate)).setZone(zona)
  if (!inicio.isValid) throw new BadRequestError(`Invalid startDate: ${startDate}`)
  if (!finPedido.isValid) throw new BadRequestError(`Invalid endDate: ${endDate}`)
  const ahora = DateTime.fromJSDate(T).setZone(zona)
  if (+ahora <= +inicio) return { status: 'notStarted' }
  const fechas = Math.round(finPedido.startOf('day').diff(inicio.startOf('day'), 'days').days) + 1
  if (fechas > 366) return { status: 'tooLong' }

  const diasCompletos = +inicio === +inicio.startOf('day') && +finPedido === +finPedido.endOf('day')
  const mesesCompletos = diasCompletos && +inicio === +inicio.startOf('month') && +finPedido === +finPedido.endOf('month')
  const meses = (finPedido.year - inicio.year) * 12 + finPedido.month - inicio.month + 1

  let mover: DurationLikeObject
  let matchedWeekday = false
  if (compararCon === 'previous_period') {
    mover = mesesCompletos ? { months: meses } : diasCompletos ? { days: fechas } : { milliseconds: +finPedido - +inicio + 1 }
  } else if (mesesCompletos) {
    mover = { years: 1 }
  } else if (diasCompletos && (fechas === 1 || fechas % 7 === 0)) {
    mover = { weeks: 52 }
    matchedWeekday = true
  } else {
    mover = { years: 1 }
  }

  const untilSameTime = +ahora < +finPedido
  const inicioComparado = inicio.minus(mover)
  // Un mes completo termina en el último día de SU mes (febrero bisiesto).
  let finComparado: DateTime = mesesCompletos ? finPedido.minus(mover).endOf('month') : finPedido.minus(mover)
  if (untilSameTime) finComparado = DateTime.min(finComparado, ahora.minus(mover))
  finComparado = DateTime.min(finComparado, inicio.minus({ milliseconds: 1 }))

  return {
    status: 'ok',
    base: { startDate: iso(inicio), endDate: iso(untilSameTime ? ahora : finPedido) },
    comparado: { startDate: iso(inicioComparado), endDate: iso(finComparado) },
    untilSameTime,
    matchedWeekday,
  }
}

export interface CambioDeCifra {
  difference: number
  /** Con un decimal; null si la base es 0 o negativa. */
  percent: number | null
  /** Antes era $0 y ahora no. */
  isNew: boolean
}

const CENTAVOS = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false })
/** A centavos como los pinta el panel (el mismo motor `Intl`: 1.005 ⇒ 1.01). `|| 0` quita el −0. */
const aCentavos = (n: number) => Number(CENTAVOS.format(n)) || 0

export function cambioDe(actual: number | null | undefined, comparado: number | null | undefined): CambioDeCifra | null {
  if (actual == null || comparado == null) return null
  const a = aCentavos(actual)
  const c = aCentavos(comparado)
  const difference = aCentavos(a - c)
  if (c > 0) return { difference, percent: difference === 0 ? 0 : Math.round((difference / c) * 1000) / 10 || 0, isNew: false }
  return { difference, percent: null, isNew: c === 0 && a !== 0 }
}

/** Las cifras del Resumen (y del número grande) que se comparan. */
export const CIFRAS_QUE_SE_COMPARAN = [
  'grossSales',
  'items',
  'serviceCosts',
  'chargedAmount',
  'refunds',
  'refundCount',
  'discounts',
  'netSales',
  'taxes',
  'tips',
  'platformFees',
  'tenderCommissions',
  'totalCollected',
  'paidWithGiftCardBalance',
  'staffCommissions',
  'netProfit',
  'unpaidSales',
  'unpaidOrders',
  'giftCardLoads',
  'giftCardLoadsCount',
  'packagesSoldOnline',
  'packagesSoldOnlineCount',
  'reservationDeposits',
  'reservationDepositsCount',
  'transactionCount',
] as const satisfies ReadonlyArray<keyof SalesSummaryMetrics>

export type CambiosDelResumen = Record<(typeof CIFRAS_QUE_SE_COMPARAN)[number], CambioDeCifra | null>

export function cambiosDelResumen(
  actual: SalesSummaryMetrics,
  comparado: SalesSummaryMetrics,
  { sinCambios = false } = {},
): CambiosDelResumen {
  return Object.fromEntries(
    CIFRAS_QUE_SE_COMPARAN.map(k => [
      k,
      sinCambios ? null : cambioDe(actual[k] as number | null | undefined, comparado[k] as number | null | undefined),
    ]),
  ) as CambiosDelResumen
}

export const MENSAJES_DE_COMPARAR = {
  plan: 'Comparar con otro periodo requiere el plan Pro.',
  notStarted: 'Ese periodo todavía no empieza: no hay con qué compararlo.',
  tooLong: 'Para comparar, elige un periodo de un año o menos.',
  legacyQr: 'Los cobros del QR anterior no se comparan.',
} as const

export interface ComparacionDelResumen {
  compareTo: CompararCon
  status: 'ok' | keyof typeof MENSAJES_DE_COMPARAR
  message?: string
  asOf?: string
  baseRange?: { startDate: string; endDate: string }
  dateRange?: { startDate: string; endDate: string }
  untilSameTime?: boolean
  matchedWeekday?: boolean
  summary?: SalesSummaryMetrics
  changes?: CambiosDelResumen
  /** El negocio del puente del QR anterior: el comparado no trae esos cobros y no se calcula el cambio. */
  excludesLegacyQr?: true
}

/**
 * El reporte del periodo actual (con los filtros que pidió la pantalla) más la comparación. Lo que impide comparar va DENTRO de
 * `comparison.status`: el reporte sale siempre.
 */
export async function leerConComparacion(
  venueId: string,
  filters: SalesSummaryFilters,
  compareTo: CompararCon,
  T: Date = new Date(),
): Promise<SalesSummaryResponse & { comparison: ComparacionDelResumen }> {
  const sinComparar = async (status: keyof typeof MENSAJES_DE_COMPARAR) => ({
    ...(await getSalesSummary(venueId, filters)),
    comparison: { compareTo, status, message: MENSAJES_DE_COMPARAR[status] },
  })
  // Con el filtro «QR anterior» todo es del puente, que la comparación no lee (y el atajo del servicio entra al puente directo).
  if (filters.paymentMethod === 'QR_LEGACY') return sinComparar('legacyQr')
  if (await comparacionBloqueadaPorPlan(venueId)) return sinComparar('plan')
  const rango = rangoComparado(filters.startDate, filters.endDate, compareTo, filters.timezone ?? 'America/Mexico_City', T)
  if (rango.status !== 'ok') return sinComparar(rango.status)

  const [actual, otro] = await Promise.all([
    getSalesSummary(venueId, { ...filters, startDate: rango.base.startDate, endDate: rango.base.endDate }),
    getSalesSummary(venueId, {
      startDate: rango.comparado.startDate,
      endDate: rango.comparado.endDate,
      groupBy: 'none',
      reportType: 'summary',
      timezone: filters.timezone,
      merchantAccountId: filters.merchantAccountId,
      paymentMethod: filters.paymentMethod,
      cardType: filters.cardType,
      includePrepaid: filters.includePrepaid,
      skipLegacyQr: true,
    }),
  ])
  // La misma compuerta del puente que la cabecera (`getSalesSummary`): con un comercio o un método sin QR, el actual tampoco lo trae.
  const excludesLegacyQr =
    sumsLegacyQrPayments(venueId) && legacyAdmission(filters.paymentMethod, filters.cardType).include && !filters.merchantAccountId
  return {
    ...actual,
    comparison: {
      compareTo,
      status: 'ok',
      asOf: T.toISOString(),
      baseRange: rango.base,
      dateRange: rango.comparado,
      untilSameTime: rango.untilSameTime,
      matchedWeekday: rango.matchedWeekday,
      summary: otro.summary,
      // Con el QR anterior en un solo lado, un % entre «con QR» y «sin QR» engañaría: se ven las dos cifras, sin cambio.
      changes: cambiosDelResumen(actual.summary, otro.summary, { sinCambios: excludesLegacyQr }),
      ...(excludesLegacyQr ? { excludesLegacyQr: true as const } : {}),
    },
  }
}
