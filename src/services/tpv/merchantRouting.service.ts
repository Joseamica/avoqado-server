/**
 * Orquestación del feature MERCHANT_ROUTING_RULES (reglas condicionales de
 * visibilidad/auto-selección de merchants en TPV). Feature PREMIUM.
 *
 * - El set de merchants evaluado es EXACTAMENTE el que la TPV ve hoy
 *   (getVenueMerchantAccounts: config venue→org, 3 slots, activos con credenciales).
 * - Gating 100 % server-side: venue sin el feature ⇒ todos elegibles, sin
 *   auto-select ⇒ la TPV se comporta idéntico a hoy (APKs viejos incluidos).
 * - Los topes de volumen agregan `Payment` COMPLETED del período en TZ del venue
 *   (montos en PESOS; propina incluida en el bruto procesado por el merchant).
 * - fallbackAll (0 elegibles) se audita en ActivityLog — señal de regla mal
 *   configurada; la venta nunca se bloquea.
 */
import { Prisma, TransactionStatus } from '@prisma/client'
import logger from '../../config/logger'
import { NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { merchantRoutingConditionsSchema } from '../../schemas/dashboard/merchantRouting.schema'
import { venueHasFeatureAccess } from '../access/basePlan.service'
import { logAction } from '../dashboard/activity-log.service'
import { getEffectivePaymentConfig } from '../organization-payment-config.service'
import {
  evaluateEligibilitySet,
  periodStartUtc,
  venueNowParts,
  type CircuitBreakerCondition,
  type EvaluationContext,
  type MerchantForEvaluation,
  type MerchantRoutingConditions,
} from './merchantRouting.engine'

export const MERCHANT_ROUTING_FEATURE_CODE = 'MERCHANT_ROUTING_RULES'

export interface MerchantEligibilityInput {
  /** Monto del ticket actual en PESOS. */
  amount: number
  staffId?: string
  lat?: number
  lng?: number
  terminalSerial?: string
  /** Solo simulador del dashboard: evaluar como si fuera esta fecha/hora ISO. */
  simulateAt?: string
}

export interface EligibleMerchant {
  merchantAccountId: string
  eligible: boolean
  reasons: string[]
  /** Config de circuit breaker para que la TPV la aplique localmente. */
  circuitBreaker?: CircuitBreakerCondition
}

export interface MerchantEligibilityResult {
  /** false ⇒ feature no activo en el venue: todos visibles, comportamiento actual. */
  routingFeatureActive: boolean
  merchants: EligibleMerchant[]
  autoSelectMerchantAccountId: string | null
  fallbackAll: boolean
  evaluatedAt: string
}

type Actor = { staffId?: string; role?: string }

export interface VisibleMerchant {
  id: string
  displayName: string
  providerCode: string
  displayOrder: number
}

/**
 * Universo de merchants que una TPV puede usar en un venue — la MISMA fuente
 * que alimenta a las terminales:
 *  1. Si viene `terminalSerial` y esa terminal tiene `assignedMerchantIds`, ese
 *     set exacto (así se asignan merchants por terminal desde superadmin).
 *  2. Si no, la unión de `assignedMerchantIds` de todas las terminales del venue
 *     + los slots del payment config (venue → org, getEffectivePaymentConfig).
 * Siempre filtrado a merchants `active`. NUNCA expone credenciales.
 */
export async function getVisibleMerchants(venueId: string, terminalSerial?: string): Promise<VisibleMerchant[]> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { id: true } })
  if (!venue) throw new NotFoundError('Venue no encontrado')

  const ids = new Set<string>()

  if (terminalSerial) {
    const terminal = await prisma.terminal.findFirst({
      where: { serialNumber: terminalSerial, venueId },
      select: { assignedMerchantIds: true },
    })
    for (const id of terminal?.assignedMerchantIds ?? []) ids.add(id)
  }

  if (ids.size === 0) {
    const terminals = await prisma.terminal.findMany({ where: { venueId }, select: { assignedMerchantIds: true } })
    for (const t of terminals) for (const id of t.assignedMerchantIds) ids.add(id)

    const effective = await getEffectivePaymentConfig(venueId)
    const cfg: any = effective?.config
    for (const slot of [cfg?.primaryAccount, cfg?.secondaryAccount, cfg?.tertiaryAccount]) {
      if (slot?.id) ids.add(slot.id)
    }
  }

  if (ids.size === 0) return []

  const accounts = await prisma.merchantAccount.findMany({
    where: { id: { in: [...ids] }, active: true },
    select: { id: true, displayName: true, displayOrder: true, provider: { select: { code: true } } },
    orderBy: { displayOrder: 'asc' },
  })
  return accounts.map(a => ({
    id: a.id,
    displayName: a.displayName ?? a.provider.code,
    providerCode: a.provider.code,
    displayOrder: a.displayOrder,
  }))
}

export async function getMerchantEligibility(
  venueId: string,
  input: MerchantEligibilityInput,
  actor?: Actor,
): Promise<MerchantEligibilityResult> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { id: true, timezone: true } })
  if (!venue) throw new NotFoundError('Venue no encontrado')

  const at = input.simulateAt ? new Date(input.simulateAt) : new Date()

  // Mismo set que ve la TPV (terminal-específico si viene serial; si no, venue-level).
  const visibleAccounts = await getVisibleMerchants(venueId, input.terminalSerial)
  const merchantIds: string[] = visibleAccounts.map(a => a.id)

  const featureActive = await venueHasFeatureAccess(venueId, MERCHANT_ROUTING_FEATURE_CODE)
  if (!featureActive || merchantIds.length === 0) {
    return {
      routingFeatureActive: false,
      merchants: merchantIds.map(id => ({ merchantAccountId: id, eligible: true, reasons: [] })),
      autoSelectMerchantAccountId: null,
      fallbackAll: false,
      evaluatedAt: at.toISOString(),
    }
  }

  // Reglas activas del venue para los merchants visibles. Json inválido en DB
  // (drift de versiones) ⇒ regla ignorada (fail-open) + warn, nunca bloquea.
  const rules = await prisma.merchantRoutingRule.findMany({
    where: { venueId, active: true, merchantAccountId: { in: merchantIds } },
  })
  const conditionsByMerchant = new Map<string, MerchantRoutingConditions>()
  for (const rule of rules) {
    const parsed = merchantRoutingConditionsSchema.safeParse(rule.conditions)
    if (parsed.success) {
      conditionsByMerchant.set(rule.merchantAccountId, parsed.data as MerchantRoutingConditions)
    } else {
      logger.warn('MerchantRoutingRule con conditions inválidas — regla ignorada (fail-open)', {
        ruleId: rule.id,
        venueId,
        issues: parsed.error.issues.slice(0, 3),
      })
    }
  }

  // Agregados por período SOLO para los períodos que alguna regla usa.
  const periodsNeeded = new Set<'DAY' | 'WEEK' | 'MONTH'>()
  for (const cond of conditionsByMerchant.values()) {
    if (cond.volumeCap) periodsNeeded.add(cond.volumeCap.period)
  }
  const aggregatesByPeriod = new Map<string, Map<string, { grossAmount: number; txCount: number }>>()
  for (const period of periodsNeeded) {
    const since = periodStartUtc(period, venue.timezone, at)
    const rows = await prisma.payment.groupBy({
      by: ['merchantAccountId'],
      where: {
        venueId,
        merchantAccountId: { in: merchantIds },
        status: TransactionStatus.COMPLETED,
        createdAt: { gte: since, lte: at },
      },
      _sum: { amount: true, tipAmount: true },
      _count: { _all: true },
    })
    const byMerchant = new Map<string, { grossAmount: number; txCount: number }>()
    for (const row of rows) {
      if (!row.merchantAccountId) continue
      // Bruto procesado por el merchant = monto + propina (lo que pasó por la afiliación). PESOS.
      byMerchant.set(row.merchantAccountId, {
        grossAmount: Number(row._sum.amount ?? 0) + Number(row._sum.tipAmount ?? 0),
        txCount: row._count._all,
      })
    }
    aggregatesByPeriod.set(period, byMerchant)
  }

  // Resolución de quién cobra: body.staffId gana; si no, el usuario autenticado.
  const staffId = input.staffId ?? actor?.staffId
  let staffRole: string | undefined = staffId && staffId === actor?.staffId ? actor?.role : undefined
  if (staffId && !staffRole) {
    const sv = await prisma.staffVenue.findFirst({ where: { staffId, venueId, active: true }, select: { role: true } })
    staffRole = sv?.role
  }

  const ctx: EvaluationContext = {
    now: venueNowParts(venue.timezone, at),
    amount: input.amount,
    location: input.lat !== undefined && input.lng !== undefined ? { lat: input.lat, lng: input.lng } : undefined,
    staffId,
    staffRole,
  }

  const items: MerchantForEvaluation[] = merchantIds.map(id => {
    const conditions = conditionsByMerchant.get(id) ?? null
    // Merchant con tope y sin pagos en el período ⇒ {0,0} (elegible), NO undefined (fallaría cerrado).
    const aggregates = conditions?.volumeCap
      ? (aggregatesByPeriod.get(conditions.volumeCap.period)?.get(id) ?? { grossAmount: 0, txCount: 0 })
      : undefined
    return { merchantAccountId: id, conditions, aggregates }
  })

  const result = evaluateEligibilitySet(items, ctx)

  if (result.fallbackAll) {
    // Fire-and-forget (regla del repo): una falla de auditoría jamás rompe el cobro.
    void logAction({
      staffId: staffId ?? null,
      venueId,
      action: 'MERCHANT_ROUTING_FALLBACK',
      entity: 'MerchantRoutingRule',
      data: {
        amount: input.amount,
        terminalSerial: input.terminalSerial ?? null,
        evaluatedAt: at.toISOString(),
        merchants: result.merchants.map(m => ({ merchantAccountId: m.merchantAccountId, reasons: m.reasons })),
      } as Prisma.InputJsonValue,
    })
  }

  const merchants: EligibleMerchant[] = result.merchants.map(m => {
    const circuitBreaker = conditionsByMerchant.get(m.merchantAccountId)?.circuitBreaker
    return circuitBreaker ? { ...m, circuitBreaker } : { ...m }
  })

  return {
    routingFeatureActive: true,
    merchants,
    autoSelectMerchantAccountId: result.autoSelectMerchantAccountId,
    fallbackAll: result.fallbackAll,
    evaluatedAt: at.toISOString(),
  }
}
