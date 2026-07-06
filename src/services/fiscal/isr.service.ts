import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { getIncomeStatement } from '../dashboard/accounting.dashboard.service'
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
 * Es una ESTIMACIÓN preliminar (asume tasa de IVA 16% en el ingreso, no resta pérdidas de ejercicios
 * anteriores ni PTU; no captura retenciones de ISR en ventas). El número final lo valida el contador.
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
  /** Utilidad fiscal acumulada (GENERAL) = ingresos − deducciones, sin negativos. */
  utilidadFiscalCents: number
  /** Tasa RESICO aplicada (sólo RESICO). */
  tasaResico: number | null
  /** ISR causado del cálculo (RESICO: del mes; GENERAL: acumulado del ejercicio). */
  isrCausadoCents: number
  /** Pagos provisionales previos del ejercicio (GENERAL; estimado = ISR causado al mes anterior). */
  pagosProvisionalesPreviosCents: number
  /** ISR a pagar (estimado) del periodo. */
  isrAPagarCents: number
  /** Supera el tope de RESICO ($3.5M anuales) → ya no aplica RESICO. */
  excedeTopeResico: boolean
  zeroActivity: boolean
  computedAt16Percent: boolean
  rfcSpansMultipleOrgs: boolean
  /**
   * SIEMPRE `true`: este pago provisional es una ESTIMACIÓN, no la cifra final a declarar. Dos razones:
   * (1) los pagos provisionales previos del ejercicio se RE-ESTIMAN de la utilidad acumulada actual, no
   * son los realmente declarados (para ingresos disparejos difiere del cálculo legal); (2) la base usa
   * IVA plano 16% (`computedAt16Percent`). El consumidor (dashboard/MCP) DEBE mostrar la leyenda de que
   * es preliminar y confirmar con el contador antes de pagar.
   */
  isEstimate: boolean
}

/** Locales del contribuyente por RFC (de Venue.rfc O FiscalEmisor.rfc), case-insensitive. */
async function venuesOfRfc(venueId: string, rfc: string): Promise<{ id: string; organizationId: string }[]> {
  const venues = await prisma.venue.findMany({
    where: {
      OR: [{ rfc: { equals: rfc, mode: 'insensitive' } }, { fiscalEmisors: { some: { rfc: { equals: rfc, mode: 'insensitive' } } } }],
    },
    select: { id: true, organizationId: true },
  })
  if (!venues.some(v => v.id === venueId)) {
    const self = await prisma.venue.findUnique({ where: { id: venueId }, select: { id: true, organizationId: true } })
    if (self) venues.push(self)
  }
  return venues
}

const monthRange = (period: string) => {
  const [y, m] = period.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${period}-01`, to: `${period}-${String(lastDay).padStart(2, '0')}`, year: y, month: m }
}

/** Σ ingreso neto cobrado de TODOS los locales del RFC en un rango. */
async function ingresoNetoRfc(venueIds: string[], from: string, to: string): Promise<{ netCents: number; sales: number }> {
  const incomes = await Promise.all(venueIds.map(id => getIncomeStatement(id, { from, to })))
  return {
    netCents: incomes.reduce((s, r) => s + r.revenue.netRevenueCents, 0),
    sales: incomes.reduce((s, r) => s + r.metrics.salesCount, 0),
  }
}

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

/** ISR causado acumulado del ejercicio (GENERAL) hasta `period` (recursión para los pagos previos). */
async function isrCausadoGeneralAcum(venueIds: string[], rfc: string, period: string): Promise<number> {
  const { year, month, to } = monthRange(period)
  const { netCents } = await ingresoNetoRfc(venueIds, `${year}-01-01`, to)
  const ded = await deduccionesAcum(rfc, year, period)
  const utilidad = Math.max(0, netCents - ded)
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
    utilidadFiscalCents: 0,
    tasaResico: null,
    isrCausadoCents: 0,
    pagosProvisionalesPreviosCents: 0,
    isrAPagarCents: 0,
    excedeTopeResico: false,
    zeroActivity: true,
    computedAt16Percent: true,
    rfcSpansMultipleOrgs: false,
    isEstimate: true,
  }
  if (!scope) return base

  const venues = await venuesOfRfc(venueId, scope.rfc)
  const venueIds = venues.map(v => v.id)
  base.venueIds = venueIds
  base.rfcSpansMultipleOrgs = new Set(venues.map(v => v.organizationId)).size > 1

  const { year, month, from, to } = monthRange(period)
  const mes = await ingresoNetoRfc(venueIds, from, to)
  const acumIngreso = await ingresoNetoRfc(venueIds, `${year}-01-01`, to)
  base.ingresosMesCents = mes.netCents
  base.ingresosAcumCents = acumIngreso.netCents
  base.zeroActivity = mes.sales === 0
  base.excedeTopeResico = acumIngreso.netCents > RESICO_LIMITE_ANUAL_CENTS

  if (regime === 'RESICO') {
    const tasa = resicoTasa(mes.netCents)
    base.tasaResico = tasa
    base.isrCausadoCents = round(mes.netCents * tasa)
    base.isrAPagarCents = base.isrCausadoCents // − retenciones (no capturadas v1)
  } else {
    const ded = await deduccionesAcum(scope.rfc, year, period)
    base.deduccionesAcumCents = ded
    base.utilidadFiscalCents = Math.max(0, acumIngreso.netCents - ded)
    base.isrCausadoCents = await isrCausadoGeneralAcum(venueIds, scope.rfc, period)
    // Pagos provisionales previos = ISR causado acumulado al mes ANTERIOR (si lo hay).
    base.pagosProvisionalesPreviosCents =
      month > 1 ? await isrCausadoGeneralAcum(venueIds, scope.rfc, `${year}-${String(month - 1).padStart(2, '0')}`) : 0
    base.isrAPagarCents = Math.max(0, base.isrCausadoCents - base.pagosProvisionalesPreviosCents)
  }

  return base
}
