import { CfdiStatus } from '@prisma/client'

import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { parseDbDateRange } from '../../utils/datetime'
import { getIncomeStatement } from '../dashboard/accounting.dashboard.service'
import { resolveScopeOrNull } from './chartOfAccounts.service'
import { splitIvaIncluded } from './ivaMath'

/**
 * IVA en flujo de efectivo (Capa B) — read-model HONESTO sobre las pólizas de cobro.
 *
 * En México el IVA se causa sobre **flujo de efectivo** (LIVA art. 1-B: cuando se cobran
 * efectivamente las contraprestaciones). Este resumen calcula el **IVA trasladado cobrado**
 * (lado VENTAS) del periodo a nivel del **contribuyente (org, RFC)** — sumando TODOS los
 * locales que comparten el RFC, porque la declaración mensual de IVA es por RFC, no por local.
 *
 * Decisiones fiscales (verificadas por workflow adversario 2026-06-16, ver memoria
 * `iva-flujo-diot-fiscal-spec`):
 *  - **Fuente = Payments** (vía `getIncomeStatement`), NO los CFDIs: `Cfdi.taxBreakdown` está
 *    declarado pero NUNCA se escribe, así que el desglose por tasa no existe; solo
 *    `Cfdi.taxCents` se persiste → se usa como **línea de contraste**, no como base.
 *  - **Split UNA vez a nivel contribuyente** (Σ netRevenueCents → splitIvaIncluded), no por local
 *    (Σ de splits ≠ split de Σ → cuadra al centavo al filer).
 *  - **Tasa 16% asumida** (`getIncomeStatement` hardcodea `DEFAULT_IVA_RATE`, no une `Product.taxRate`)
 *    → flag `computedAt16Percent`; venues con 0%/8%/exento ven el IVA SOBREESTIMADO (caveat en UI).
 *  - **IVA acreditable pagado, retenciones, DIOT = NO disponibles** (lado proveedores): no existe
 *    modelo de gastos/CFDIs recibidos → placeholders `null` (NUNCA 0 silencioso), Fase 2 (Buzón de CFDIs).
 *  - El número grande es **"IVA trasladado cobrado (causado)"**, NUNCA "IVA a cargo a enterar"; el
 *    `ivaAPagarPreliminar` es un **TECHO** (solo lado ventas; el real será MENOR al restar el acreditable).
 *
 * Gated PREMIUM (CFDI). Read-only (sin ActivityLog). Money en centavos enteros.
 */

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/ // AAAA-MM con mes real 01-12
const IVA_RATE = 0.16

const DIOT_MOTIVO =
  'La DIOT lista el IVA pagado a tus PROVEEDORES (lado gastos). Requiere registrar tus CFDIs recibidos — disponible en Fase 2 (Buzón de CFDIs).'

export interface IvaCashflowResult {
  needsFiscalSetup: boolean
  organizationId: string | null
  rfc: string | null
  period: string
  /** Locales del contribuyente incluidos en la suma. */
  venueIds: string[]
  // ── Lado VENTAS (computable hoy, al 16% asumido) ──
  baseGravableCents: number
  /** IVA trasladado efectivamente cobrado en el periodo (LIVA art 1-B). */
  ivaTrasladadoCobradoCents: number
  /** Contraste informativo: Σ Cfdi.taxCents timbrados en el periodo (NO es la base). */
  ivaAmparadoPorCfdiCents: number
  cfdiCount: number
  // ── Lado ENTRADAS (Fase 2 — placeholders, NUNCA 0 silencioso) ──
  acreditablePagadoCents: number | null
  retencionesCents: number | null
  saldoAFavorAplicadoCents: number | null
  // ── Derivados (PRELIMINARES — solo lado ventas) ──
  /** Techo preliminar: trasladado − (acreditable||0) − (retenciones||0) − (saldoAplicado||0), sin negativos. */
  ivaAPagarPreliminarCents: number
  /** Saldo a favor del periodo (magnitud positiva) si el neto fuera negativo. */
  saldoAFavorDelPeriodoCents: number
  // ── Flags de honestidad ──
  computedAt16Percent: boolean
  acreditableDisponible: boolean
  diotDisponible: boolean
  /** El cálculo es parcial: falta el IVA de gastos (acreditable). */
  incompletoPorFaltaDeGastos: boolean
  /** El RFC opera en venues de más de una organización Avoqado (igual se suman). */
  rfcSpansMultipleOrgs: boolean
  /** Sin ventas cobradas en el periodo → recordar declaración en ceros. */
  zeroActivity: boolean
  /** DIOT (lado proveedores) — stub honesto, no se genera. */
  diot: { disponible: boolean; motivo: string }
}

const emptyResult = (period: string, scope: { organizationId: string; rfc: string } | null): IvaCashflowResult => ({
  needsFiscalSetup: scope === null,
  organizationId: scope?.organizationId ?? null,
  rfc: scope?.rfc ?? null,
  period,
  venueIds: [],
  baseGravableCents: 0,
  ivaTrasladadoCobradoCents: 0,
  ivaAmparadoPorCfdiCents: 0,
  cfdiCount: 0,
  acreditablePagadoCents: null,
  retencionesCents: null,
  saldoAFavorAplicadoCents: null,
  ivaAPagarPreliminarCents: 0,
  saldoAFavorDelPeriodoCents: 0,
  computedAt16Percent: true,
  acreditableDisponible: false,
  diotDisponible: false,
  incompletoPorFaltaDeGastos: true,
  rfcSpansMultipleOrgs: false,
  zeroActivity: true,
  diot: { disponible: false, motivo: DIOT_MOTIVO },
})

/**
 * Resumen de IVA en flujo de efectivo del periodo para el contribuyente (org, RFC) del local.
 */
export async function getIvaCashflow(venueId: string, period: string): Promise<IvaCashflowResult> {
  if (!PERIOD_RE.test(period)) throw new BadRequestError('El periodo debe tener formato AAAA-MM (mes 01-12).')

  const scope = await resolveScopeOrNull(venueId)
  if (!scope) return emptyResult(period, null)

  // Enumerar TODOS los locales del contribuyente por RFC (de Venue.rfc O FiscalEmisor.rfc),
  // case-insensitive (hay RFCs guardados en minúscula). NO filtrar por org: la declaración de
  // IVA cubre TODOS los locales del RFC, aunque estén en otra organización de Avoqado.
  const venues = await prisma.venue.findMany({
    where: {
      OR: [
        { rfc: { equals: scope.rfc, mode: 'insensitive' } },
        { fiscalEmisors: { some: { rfc: { equals: scope.rfc, mode: 'insensitive' } } } },
      ],
    },
    select: { id: true, organizationId: true, timezone: true },
  })
  // Defensivo: el local consultado siempre debe estar en el set.
  if (!venues.some(v => v.id === venueId)) {
    const self = await prisma.venue.findUnique({ where: { id: venueId }, select: { id: true, organizationId: true, timezone: true } })
    if (self) venues.push(self)
  }

  const venueIds = venues.map(v => v.id)
  const rfcSpansMultipleOrgs = new Set(venues.map(v => v.organizationId)).size > 1

  // period AAAA-MM → rango de día completo (strings, host-tz-safe vía parseDbDateRange).
  const [y, m] = period.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const fromStr = `${period}-01`
  const toStr = `${period}-${String(lastDay).padStart(2, '0')}`

  // IVA trasladado cobrado = split ÚNICO sobre la suma de ingresos netos cobrados de TODOS los locales.
  const incomes = await Promise.all(venues.map(v => getIncomeStatement(v.id, { from: fromStr, to: toStr })))
  const totalNetRevenueCents = incomes.reduce((s, r) => s + r.revenue.netRevenueCents, 0)
  const totalSalesCount = incomes.reduce((s, r) => s + r.metrics.salesCount, 0)
  const { netCents: baseGravableCents, taxCents: ivaTrasladadoCobradoCents } = splitIvaIncluded(totalNetRevenueCents, IVA_RATE)

  // Contraste (NO base): IVA amparado por los CFDIs timbrados del periodo (eje = stampedAt).
  const tz = venues.find(v => v.id === venueId)?.timezone || 'America/Mexico_City'
  const { from: fromUtc, to: toUtc } = parseDbDateRange(fromStr, toStr, tz)
  const cfdiAgg = await prisma.cfdi.aggregate({
    where: { venueId: { in: venueIds }, status: CfdiStatus.STAMPED, stampedAt: { gte: fromUtc, lte: toUtc } },
    _sum: { taxCents: true },
    _count: { _all: true },
  })

  // Lado entradas = Fase 2 (placeholders null). El neto se calcula sin truncar para detectar saldo a favor.
  const acreditablePagadoCents = null
  const retencionesCents = null
  const saldoAFavorAplicadoCents = null
  const neto = ivaTrasladadoCobradoCents - (acreditablePagadoCents ?? 0) - (retencionesCents ?? 0) - (saldoAFavorAplicadoCents ?? 0)

  return {
    needsFiscalSetup: false,
    organizationId: scope.organizationId,
    rfc: scope.rfc,
    period,
    venueIds,
    baseGravableCents,
    ivaTrasladadoCobradoCents,
    ivaAmparadoPorCfdiCents: cfdiAgg._sum.taxCents ?? 0,
    cfdiCount: cfdiAgg._count._all,
    acreditablePagadoCents,
    retencionesCents,
    saldoAFavorAplicadoCents,
    ivaAPagarPreliminarCents: Math.max(0, neto),
    saldoAFavorDelPeriodoCents: neto < 0 ? -neto : 0,
    computedAt16Percent: true,
    acreditableDisponible: false,
    diotDisponible: false,
    incompletoPorFaltaDeGastos: true,
    rfcSpansMultipleOrgs,
    zeroActivity: totalSalesCount === 0,
    diot: { disponible: false, motivo: DIOT_MOTIVO },
  }
}
