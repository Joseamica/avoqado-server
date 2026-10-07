import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import {
  conFotoDeReporte,
  estadoDeResultadosEnFoto,
  LIMITES_DEL_REPORTE,
  MENSAJE_MES_NO_CALCULADO,
} from '../dashboard/accounting.dashboard.service'
import { getSalesRetentionCents } from './salesRetention.service'
import { comoErrorDelMes } from './errorDelMes'
import { computePeriodCogsCentsRange } from './cogs.service'
import { getYearDepreciationCents } from './fixedAssetDepreciation.service'
import { getPendingLossCents } from './fiscalLoss.service'
import { resolveScopeOrNull } from './chartOfAccounts.service'

/**
 * ISR — estimación de PAGO PROVISIONAL del periodo (persona física), Capa B. Read-only.
 *
 * Dos regímenes de PF con actividad empresarial:
 *  - **RESICO** (Régimen Simplificado de Confianza, LISR 113-E): ISR = ingresos del mes efectivamente
 *    cobrados × una tasa fija por tramo (1.00%–2.50%). SIN deducciones. Tope $3.5M anuales.
 *  - **GENERAL** (actividad empresarial): acumulado del ejercicio (ingresos − deducciones autorizadas)
 *    × tarifa art-96 acumulada, menos los pagos provisionales previos y las retenciones.
 *
 * Es una ESTIMACIÓN preliminar. La base de ingresos es SIN IVA, con el tratamiento real de cada venta, e
 * incluye lo exento y lo no objeto (LISR art 113-E excluye el IVA). En los dos regímenes resta la retención
 * de ISR en ventas que el contador capturó del periodo; en GENERAL, además, las pérdidas de ejercicios
 * anteriores topadas a la utilidad. No resta PTU. El número final lo valida el contador.
 * Importes en centavos enteros. Gated PREMIUM (CFDI).
 */

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export type IsrRegime = 'RESICO' | 'GENERAL'

/** RESICO PF mensual (LISR art 113-E) — tabla estable 2022-2026. `hastaCents` = tope superior del tramo. */
const RESICO_TABLE: { hastaCents: number; tasa: number }[] = [
  { hastaCents: 25_000_00, tasa: 0.01 },
  { hastaCents: 50_000_00, tasa: 0.011 },
  { hastaCents: 83_333_33, tasa: 0.015 },
  { hastaCents: 208_333_33, tasa: 0.02 },
  { hastaCents: Number.MAX_SAFE_INTEGER, tasa: 0.025 },
]
const RESICO_LIMITE_ANUAL_CENTS = 3_500_000_00

/**
 * Tarifa MENSUAL del art 96 LISR (régimen general PF). **VERIFICADA por workflow de 4 contadores
 * (verify-isr-2026-tables, confidence high): coincide con la tarifa mensual oficial 2024/2025** (= anual
 * Anexo 8 RMF / 12). ⚠️ Al corte NO hay tarifa 2026 distinta publicada en el DOF (art 152: sólo se
 * actualiza si la inflación acumulada > 10%) → en 2026 se usa esta misma; confirmar Anexo 8 RMF 2026
 * antes de un cálculo definitivo. Renglones: límite inferior, cuota fija, % sobre excedente. La tarifa
 * del PERIODO acumulado = mensual con límInf y cuotaFija × número de meses.
 */
export const ART96_MONTHLY: { limInfCents: number; cuotaFijaCents: number; pct: number }[] = [
  { limInfCents: 1, cuotaFijaCents: 0, pct: 0.0192 },
  { limInfCents: 746_05, cuotaFijaCents: 14_32, pct: 0.064 },
  { limInfCents: 6_332_06, cuotaFijaCents: 371_83, pct: 0.1088 },
  { limInfCents: 11_128_02, cuotaFijaCents: 893_63, pct: 0.16 },
  { limInfCents: 12_935_83, cuotaFijaCents: 1_182_88, pct: 0.1792 },
  { limInfCents: 15_487_72, cuotaFijaCents: 1_640_18, pct: 0.2136 },
  { limInfCents: 31_236_50, cuotaFijaCents: 5_004_12, pct: 0.2352 },
  { limInfCents: 49_233_01, cuotaFijaCents: 9_236_89, pct: 0.3 },
  { limInfCents: 93_993_91, cuotaFijaCents: 22_665_17, pct: 0.32 },
  { limInfCents: 125_325_21, cuotaFijaCents: 32_691_18, pct: 0.34 },
  { limInfCents: 375_975_62, cuotaFijaCents: 117_912_32, pct: 0.35 },
]

const round = (n: number) => Math.round(n)

/** Aplica una tarifa progresiva (renglones límInf/cuotaFija/pct) a una base en centavos. */
export function applyTariff(baseCents: number, rows: { limInfCents: number; cuotaFijaCents: number; pct: number }[]): number {
  if (baseCents <= 0) return 0
  let row = rows[0]
  for (const r of rows) if (baseCents >= r.limInfCents) row = r
  return round(row.cuotaFijaCents + (baseCents - row.limInfCents) * row.pct)
}

/** Tasa RESICO aplicable a un ingreso mensual. */
function resicoTasa(ingresosMesCents: number): number {
  for (const r of RESICO_TABLE) if (ingresosMesCents <= r.hastaCents) return r.tasa
  return RESICO_TABLE[RESICO_TABLE.length - 1].tasa
}

export interface IsrProvisionalResult {
  needsFiscalSetup: boolean
  organizationId: string | null
  rfc: string | null
  period: string
  regime: IsrRegime
  venueIds: string[]
  /** Ingresos efectivamente cobrados del MES (neto de IVA). */
  ingresosMesCents: number
  /** Ingresos acumulados del ejercicio (ene→periodo). */
  ingresosAcumCents: number
  /** Deducciones autorizadas acumuladas (gastos deducibles pagados, ene→periodo) — sólo GENERAL. */
  deduccionesAcumCents: number
  /** Costo de ventas acumulado del ejercicio (inventario consumido, FIFO) — deducción en GENERAL, 0 en RESICO. */
  costoVentasAcumCents: number
  /** Deducción de inversiones (depreciación de activos fijos) acumulada del ejercicio — GENERAL, 0 en RESICO. */
  deduccionInversionesAcumCents: number
  /** Pérdida fiscal de ejercicios anteriores APLICADA en el periodo (topada a la utilidad) — GENERAL, 0 en RESICO. */
  perdidasFiscalesAplicadaCents: number
  /** Utilidad fiscal acumulada (GENERAL) = ingresos − deducciones − costo de ventas − depreciación − pérdidas, sin negativos. */
  utilidadFiscalCents: number
  /** Tasa RESICO aplicada (sólo RESICO). */
  tasaResico: number | null
  /** ISR causado del cálculo (RESICO: del mes; GENERAL: acumulado del ejercicio). */
  isrCausadoCents: number
  /** Pagos provisionales previos del ejercicio (GENERAL; estimado = ISR causado al mes anterior). */
  pagosProvisionalesPreviosCents: number
  /** Retención de ISR en ventas capturada del periodo (clientes morales) — reduce el ISR a pagar. */
  retencionesIsrCents: number
  /** ISR a pagar (estimado) del periodo. */
  isrAPagarCents: number
  /** Supera el tope de RESICO ($3.5M anuales) → ya no aplica RESICO. */
  excedeTopeResico: boolean
  zeroActivity: boolean
  computedAt16Percent: boolean
  rfcSpansMultipleOrgs: boolean
  /**
   * SIEMPRE `true`: este pago provisional es una ESTIMACIÓN, no la cifra final a declarar. Razones:
   * (1) los pagos provisionales previos del ejercicio se RE-ESTIMAN de la utilidad acumulada actual, no
   * son los realmente declarados (para ingresos disparejos difiere del cálculo legal); (2) la base sin IVA
   * es por tasa real, pero las ventas de importe libre (sin items) y productos sin `taxRate` caen al 16%
   * por defecto. El consumidor (dashboard/MCP) DEBE mostrar la leyenda de que es preliminar y confirmar
   * con el contador antes de pagar.
   */
  isEstimate: boolean
}

/**
 * B4b (fallo 1 de la ronda 8; Codex r7 R7-1; T7-I1): cuánto puede durar la foto del ISR. El peor mes permitido debe correr en ≤ 60 s
 * (Tarea 8) ⇒ ≥ 5,000 órdenes/s; 90 s alcanzan 450,000 órdenes en el ejercicio, 1.25 veces el año de 30,000 órdenes al mes.
 * Queda bajo el corte de 100 s del proxy de Cloudflare, para que `REPORT_TIMEOUT` llegue al navegador (un 524 nunca trae nuestro código).
 */
export const TIEMPO_MAXIMO_DEL_ISR_MS = 90_000

/**
 * Locales del contribuyente por RFC (de Venue.rfc O FiscalEmisor.rfc), case-insensitive. B4b: trae también `name` y `timezone`, que
 * pide el estado de resultados dentro de la foto del ISR (`estadoDeResultadosEnFoto`) y el aviso del log.
 */
async function venuesOfRfc(
  venueId: string,
  rfc: string,
): Promise<{ id: string; organizationId: string; name: string; timezone: string | null }[]> {
  const venues = await prisma.venue.findMany({
    where: {
      OR: [{ rfc: { equals: rfc, mode: 'insensitive' } }, { fiscalEmisors: { some: { rfc: { equals: rfc, mode: 'insensitive' } } } }],
    },
    select: { id: true, organizationId: true, name: true, timezone: true },
  })
  if (!venues.some(v => v.id === venueId)) {
    const self = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { id: true, organizationId: true, name: true, timezone: true },
    })
    if (self) venues.push(self)
  }
  return venues
}

const monthRange = (period: string) => {
  const [y, m] = period.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${period}-01`, to: `${period}-${String(lastDay).padStart(2, '0')}`, year: y, month: m }
}

/**
 * B4b (fallo 2 de la ronda 7, fallo 1 de la ronda 8; Codex r6 R6-2, r7 R7-1): el ingreso sin IVA de cada mes del ejercicio hasta
 * `period`, de enero en adelante, UNO TRAS OTRO y, en cada mes, local por local, TODO dentro de UNA foto. El acumulado es su suma:
 * exacto (misma versión de los datos para todos los meses; la parte de cada movimiento no depende del cierre del reporte) y cada mes
 * dentro de los topes. Un rango de enero a diciembre podría pasar de 300,000 órdenes aunque cada mes quepa. Base de ISR sin IVA: el
 * campo de 4b (`ingresosSinIvaCents`) o, sin él, la base gravable.
 *
 * La base de ISR excluye el IVA (LISR 113-E; en régimen general el IVA trasladado no es ingreso acumulable) y, desde el plan 4b
 * (criterio 3), incluye TODOS los tratamientos: gravado, tasa 0, exento y no objeto. Sacar lo exento de la base gravable del IVA no
 * lo saca del ISR. Las deducciones se toman del `subtotalCents` (sin IVA) de los gastos: los dos lados quedan consistentes.
 *
 * Una sola conexión: los locales NO se reparten con `enParaleloAcotado` (una transacción corre sus consultas una tras otra). Un mes
 * que pasa un tope da `REPORT_TOO_LARGE` y detiene todo el ISR; si la foto vence, `REPORT_TIMEOUT` con el texto mensual.
 */
async function ingresosPorMes(
  venues: Array<{ id: string; name: string; timezone: string | null }>,
  period: string,
  quien: { venueName: string },
): Promise<Array<{ netCents: number; sales: number }>> {
  const { year, month, to } = monthRange(period)
  return conFotoDeReporte(
    {
      venueName: quien.venueName,
      from: `${year}-01-01`,
      to,
      tiempoMaximoMs: TIEMPO_MAXIMO_DEL_ISR_MS,
      mensajeDeTiempo: MENSAJE_MES_NO_CALCULADO,
    },
    async tx => {
      const meses: Array<{ netCents: number; sales: number }> = []
      for (let m = 1; m <= month; m++) {
        const rango = monthRange(`${year}-${String(m).padStart(2, '0')}`)
        let netCents = 0
        let sales = 0
        for (const v of venues) {
          const r = await estadoDeResultadosEnFoto(tx, v, { from: rango.from, to: rango.to }, LIMITES_DEL_REPORTE)
          // Sin el campo (Ruling 4b-R9) la base gravable, que con todo al 16 % es la misma cifra.
          netCents += r.fiscalRevenue.ingresosSinIvaCents ?? r.fiscalRevenue.taxableBaseCents
          sales += r.metrics.salesCount
        }
        meses.push({ netCents, sales })
      }
      return meses
    },
  )
}
const sumaDeIngresos = (meses: Array<{ netCents: number }>) => meses.reduce((s, x) => s + x.netCents, 0)

/** Σ base deducible de gastos PAGADOS (cash-basis) del RFC en [year-01, period]. */
async function deduccionesAcum(rfc: string, year: number, period: string): Promise<number> {
  const months: string[] = []
  for (let m = 1; m <= Number(period.split('-')[1]); m++) months.push(`${year}-${String(m).padStart(2, '0')}`)
  const agg = await prisma.expense.aggregate({
    where: { rfc, status: 'REGISTERED', comprobanteTipo: 'INGRESO', deducible: true, paymentStatus: 'PAID', paidPeriod: { in: months } },
    _sum: { subtotalCents: true, descuentoCents: true, iepsCents: true },
  })
  return (agg._sum.subtotalCents ?? 0) - (agg._sum.descuentoCents ?? 0) + (agg._sum.iepsCents ?? 0)
}

/** Costo de ventas acumulado del ejercicio (todas las venues del RFC) hasta `to`. Deducción en GENERAL. */
async function cogsAcumRfc(venueIds: string[], year: number, to: string): Promise<number> {
  const perVenue = await Promise.all(venueIds.map(id => computePeriodCogsCentsRange(id, `${year}-01-01`, to)))
  return perVenue.reduce((s, c) => s + c, 0)
}

/** Deducción de inversiones (depreciación) acumulada del ejercicio hasta `period` (AAAA-MM). Solo GENERAL. */
async function deducInversionesAcum(organizationId: string, rfc: string, period: string): Promise<number> {
  return getYearDepreciationCents(organizationId, rfc, Number(period.slice(0, 4)), period)
}

/**
 * ISR causado acumulado del ejercicio (GENERAL) hasta `period` (también para los pagos previos). B4b (fallo 2 de la ronda 7): recibe
 * el ingreso acumulado ya sumado mes por mes (`ingresosPorMes`), así el mes y el mes anterior salen de la MISMA lista, sin pedir otro.
 */
async function isrCausadoGeneralAcum(
  ingresoAcumCents: number,
  venueIds: string[],
  organizationId: string,
  rfc: string,
  period: string,
): Promise<number> {
  const { year, month, to } = monthRange(period)
  const ded = await deduccionesAcum(rfc, year, period)
  const cogs = await cogsAcumRfc(venueIds, year, to)
  const deprec = await deducInversionesAcum(organizationId, rfc, period)
  const utilAntes = Math.max(0, ingresoAcumCents - ded - cogs - deprec)
  const perdidas = Math.min(await getPendingLossCents(organizationId, rfc), utilAntes) // topada, no la vuelve negativa
  const utilidad = utilAntes - perdidas
  // Tarifa acumulada = tarifa mensual con límInf y cuotaFija × número de meses.
  const acumRows = ART96_MONTHLY.map(r => ({ limInfCents: r.limInfCents * month, cuotaFijaCents: r.cuotaFijaCents * month, pct: r.pct }))
  return applyTariff(utilidad, acumRows)
}

/** Estimación del pago provisional de ISR del periodo. */
export async function getIsrProvisional(venueId: string, period: string, regime: IsrRegime = 'RESICO'): Promise<IsrProvisionalResult> {
  if (!PERIOD_RE.test(period)) throw new BadRequestError('El periodo debe tener formato AAAA-MM (mes 01-12).')

  const scope = await resolveScopeOrNull(venueId)
  const base: IsrProvisionalResult = {
    needsFiscalSetup: scope === null,
    organizationId: scope?.organizationId ?? null,
    rfc: scope?.rfc ?? null,
    period,
    regime,
    venueIds: [],
    ingresosMesCents: 0,
    ingresosAcumCents: 0,
    deduccionesAcumCents: 0,
    costoVentasAcumCents: 0,
    deduccionInversionesAcumCents: 0,
    perdidasFiscalesAplicadaCents: 0,
    utilidadFiscalCents: 0,
    tasaResico: null,
    isrCausadoCents: 0,
    pagosProvisionalesPreviosCents: 0,
    retencionesIsrCents: 0,
    isrAPagarCents: 0,
    excedeTopeResico: false,
    zeroActivity: true,
    computedAt16Percent: false, // base ISR sin IVA por tasa real; solo importe-libre/sin-taxRate cae al 16%
    rfcSpansMultipleOrgs: false,
    isEstimate: true,
  }
  if (!scope) return base

  const venues = await venuesOfRfc(venueId, scope.rfc)
  const venueIds = venues.map(v => v.id)
  base.venueIds = venueIds
  base.rfcSpansMultipleOrgs = new Set(venues.map(v => v.organizationId)).size > 1

  const { year, month, to } = monthRange(period)
  // B4b: cada mes del ejercicio, uno tras otro, en UNA foto; el mes pedido es el último y el acumulado, la suma. T6 M5: si no se
  // puede calcular, el texto es el mensual (aquí no hay rango que acortar), salvo el de una venta que pasa un tope (nombra su folio).
  const meses = await ingresosPorMes(venues, period, { venueName: venues.find(v => v.id === venueId)?.name ?? venueId }).catch(
    (e: unknown) => {
      throw comoErrorDelMes(e)
    },
  )
  const mes = meses[meses.length - 1]
  const acumIngreso = { netCents: sumaDeIngresos(meses) }
  base.ingresosMesCents = mes.netCents
  base.ingresosAcumCents = acumIngreso.netCents
  base.zeroActivity = mes.sales === 0
  base.excedeTopeResico = acumIngreso.netCents > RESICO_LIMITE_ANUAL_CENTS

  if (regime === 'RESICO') {
    const tasa = resicoTasa(mes.netCents)
    base.tasaResico = tasa
    base.isrCausadoCents = round(mes.netCents * tasa)
    base.isrAPagarCents = base.isrCausadoCents
  } else {
    const ded = await deduccionesAcum(scope.rfc, year, period)
    base.deduccionesAcumCents = ded
    const cogsAcum = await cogsAcumRfc(venueIds, year, to)
    base.costoVentasAcumCents = cogsAcum
    const deprecAcum = await deducInversionesAcum(scope.organizationId, scope.rfc, period)
    base.deduccionInversionesAcumCents = deprecAcum
    const utilAntesPerdidas = Math.max(0, acumIngreso.netCents - ded - cogsAcum - deprecAcum)
    base.perdidasFiscalesAplicadaCents = Math.min(await getPendingLossCents(scope.organizationId, scope.rfc), utilAntesPerdidas)
    base.utilidadFiscalCents = utilAntesPerdidas - base.perdidasFiscalesAplicadaCents
    base.isrCausadoCents = await isrCausadoGeneralAcum(acumIngreso.netCents, venueIds, scope.organizationId, scope.rfc, period)
    // Pagos provisionales previos = ISR causado acumulado al mes ANTERIOR (si lo hay), con los mismos meses menos el último.
    base.pagosProvisionalesPreviosCents =
      month > 1
        ? await isrCausadoGeneralAcum(
            sumaDeIngresos(meses.slice(0, -1)),
            venueIds,
            scope.organizationId,
            scope.rfc,
            `${year}-${String(month - 1).padStart(2, '0')}`,
          )
        : 0
    base.isrAPagarCents = Math.max(0, base.isrCausadoCents - base.pagosProvisionalesPreviosCents)
  }

  // Retención de ISR en ventas capturada del periodo (clientes morales que nos retuvieron) → reduce el
  // ISR a pagar. Si el contador no la capturó, es 0 (no se resta).
  const salesRet = await getSalesRetentionCents(scope.organizationId, scope.rfc, period)
  base.retencionesIsrCents = salesRet?.isrRetenidoCents ?? 0
  base.isrAPagarCents = Math.max(0, base.isrAPagarCents - base.retencionesIsrCents)

  return base
}
