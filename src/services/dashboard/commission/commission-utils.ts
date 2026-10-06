/**
 * Commission Utils
 *
 * Helper functions shared across commission services.
 * Follows TransactionCost pattern for financial calculations.
 *
 * Key patterns:
 * - effectiveFrom/effectiveTo date range queries for active configs
 * - Rate cascade: Override > Tier > Role Rate > Default Rate
 * - All rates stored as decimals (0.03 = 3%)
 */

import prisma from '../../../utils/prismaClient'
import logger from '../../../config/logger'
import { Decimal } from '@prisma/client/runtime/library'
import { Prisma, CommissionRecipient, StaffRole, CommissionCalcType, TierType, TierPeriod, ThresholdType } from '@prisma/client'
import { startOfDay, endOfDay, startOfWeek, endOfWeek, startOfMonth, endOfMonth } from 'date-fns'
import { toZonedTime, fromZonedTime } from 'date-fns-tz'
import { DEFAULT_TIMEZONE } from '../../../utils/datetime'
import { utcTs } from '../../../utils/sqlDates'
import { isDeadlockError } from '../../../utils/serializableRetry'
import {
  baseSinIvaPorTasa,
  commissionableAmount,
  orderLevelDiscountOf,
  precioTraeIva,
  resolveCommissionBase,
  selectCommissionableLines,
  OrderLineForCommission,
} from './commission-base'
import { computeStoredOrderTotal } from '../../shared/orderBalance'
import { ivaDelCobroComoContabilidad, type OrderItemRow } from '../../fiscal/ivaMath'
import { type CobroDeLaOrden, type OtroCobro, repartir } from './repartoPorCobro'

// ============================================
// Type Definitions
// ============================================

export interface RoleRates {
  [role: string]: number // e.g., { "WAITER": 0.03, "CASHIER": 0.02 }
}

export interface CommissionConfigWithRelations {
  id: string
  venueId: string | null
  name: string
  priority: number
  recipient: CommissionRecipient
  calcType: CommissionCalcType
  defaultRate: Decimal
  minAmount: Decimal | null
  maxAmount: Decimal | null
  includeTips: boolean
  includeDiscount: boolean
  includeTax: boolean
  roleRates: RoleRates | null
  filterByCategories: boolean
  categoryIds: string[]
  useGoalAsTier: boolean
  goalBonusRate: Decimal | null
  attendanceLinked: boolean
  attendanceLatePenaltyRate: Decimal | null
  effectiveFrom: Date
  effectiveTo: Date | null
  tiers?: CommissionTierData[]
}

export interface CommissionTierData {
  id: string
  tierLevel: number
  tierName: string
  tierType: TierType
  minThreshold: Decimal
  maxThreshold: Decimal | null
  rate: Decimal
  tierPeriod: TierPeriod
  minThresholdType: ThresholdType
  maxThresholdType: ThresholdType
}

export interface CommissionOverrideData {
  id: string
  staffId: string
  customRate: Decimal | null
  excludeFromCommissions: boolean
  effectiveFrom: Date
  effectiveTo: Date | null
}

// ============================================
// Rate Validation
// ============================================

/**
 * Validate that a rate is within valid bounds (0-1 inclusive)
 * Commission rates should be between 0% and 100%
 *
 * @param rate - Rate to validate (as decimal, e.g., 0.03 for 3%)
 * @throws Error if rate is invalid
 */
export function validateRate(rate: number): void {
  if (typeof rate !== 'number' || isNaN(rate)) {
    throw new Error(`Invalid commission rate: must be a number, got ${typeof rate}`)
  }
  if (rate < 0 || rate > 1) {
    throw new Error(`Invalid commission rate: ${rate}. Must be between 0 and 1 (0% to 100%)`)
  }
}

/**
 * Parse Decimal to number safely
 */
export function decimalToNumber(value: Decimal | null | undefined): number {
  if (value === null || value === undefined) return 0
  return parseFloat(value.toString())
}

// ============================================
// Active Configuration Lookups
// ============================================

/**
 * Find active commission config for a venue at a given date
 *
 * Rules:
 * - Must be active (not deleted)
 * - effectiveFrom <= date <= effectiveTo (or effectiveTo is null)
 * - If multiple configs match, return the one with highest priority
 *
 * @param venueId - Venue ID
 * @param effectiveDate - Date to check (defaults to now)
 * @returns Active CommissionConfig or null if none found
 */
export async function findActiveCommissionConfig(
  venueId: string,
  effectiveDate: Date = new Date(),
  db: Prisma.TransactionClient = prisma,
): Promise<CommissionConfigWithRelations | null> {
  // 1. Check venue-level configs first
  const config = await db.commissionConfig.findFirst({
    where: {
      venueId,
      active: true,
      deletedAt: null,
      effectiveFrom: { lte: effectiveDate },
      OR: [
        { effectiveTo: null }, // No end date (ongoing)
        { effectiveTo: { gte: effectiveDate } },
      ],
    },
    include: {
      tiers: {
        where: { active: true },
        orderBy: { tierLevel: 'asc' },
      },
    },
    orderBy: {
      priority: 'desc', // Highest priority first
    },
  })

  if (config) {
    const roleRates = config.roleRates as RoleRates | null
    return {
      ...config,
      roleRates,
      tiers: config.tiers as CommissionTierData[],
    }
  }

  // 2. Fallback: check org-level configs
  const venue = await db.venue.findUnique({
    where: { id: venueId },
    select: { organizationId: true },
  })

  if (venue?.organizationId) {
    const orgConfig = await db.commissionConfig.findFirst({
      where: {
        orgId: venue.organizationId,
        venueId: null, // Org-level configs have no venueId
        active: true,
        deletedAt: null,
        effectiveFrom: { lte: effectiveDate },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveDate } }],
      },
      include: {
        tiers: {
          where: { active: true },
          orderBy: { tierLevel: 'asc' },
        },
      },
      orderBy: {
        priority: 'desc',
      },
    })

    if (orgConfig) {
      const roleRates = orgConfig.roleRates as RoleRates | null
      return {
        ...orgConfig,
        roleRates,
        tiers: orgConfig.tiers as CommissionTierData[],
      }
    }
  }

  logger.debug('No active commission config found (venue or org)', { venueId, effectiveDate })
  return null
}

/**
 * Find active commission override for a specific staff member
 *
 * @param configId - Commission config ID
 * @param staffId - Staff member ID
 * @param effectiveDate - Date to check (defaults to now)
 * @returns Active CommissionOverride or null
 */
export async function findActiveOverride(
  configId: string,
  staffId: string,
  effectiveDate: Date = new Date(),
  db: Prisma.TransactionClient = prisma,
): Promise<CommissionOverrideData | null> {
  const override = await db.commissionOverride.findFirst({
    where: {
      configId,
      staffId,
      active: true,
      effectiveFrom: { lte: effectiveDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveDate } }],
    },
    orderBy: {
      effectiveFrom: 'desc', // Most recent first
    },
  })

  if (!override) {
    return null
  }

  return override as CommissionOverrideData
}

// ============================================
// Staff Recipient Resolution
// ============================================

/**
 * Get the staff ID who should receive the commission based on recipient type
 *
 * Fallback chain for each type:
 * - CREATOR: createdById → processedById (for kiosk mode)
 * - SERVER: servedById → createdById → processedById (for kiosk mode)
 * - PROCESSOR: processedById
 *
 * The final fallback to processedById handles KIOSK MODE where:
 * - Orders have no createdById (created by kiosk itself)
 * - Orders have no servedById (no server in self-service)
 * - But payments DO have processedById (staff who processed the card payment)
 *
 * @param payment - Payment record with order relation
 * @param order - Order record (may be null for direct payments)
 * @param recipientType - Who receives commission (CREATOR, SERVER, PROCESSOR)
 * @returns Staff ID or null if not determinable
 */
export function getRecipientStaffId(
  payment: { processedById: string | null },
  order: { createdById: string | null; servedById: string | null } | null,
  recipientType: CommissionRecipient,
): string | null {
  switch (recipientType) {
    case CommissionRecipient.CREATOR:
      // Order creator (who entered the order)
      // Falls back to payment processor for kiosk mode
      return order?.createdById ?? payment.processedById ?? null

    case CommissionRecipient.SERVER:
      // Order server (who served the customer)
      // Falls back to creator, then to payment processor for kiosk mode
      return order?.servedById ?? order?.createdById ?? payment.processedById ?? null

    case CommissionRecipient.PROCESSOR:
      // Payment processor (who completed the payment)
      return payment.processedById ?? null

    default:
      logger.warn('Unknown commission recipient type', { recipientType })
      return null
  }
}

// ============================================
// Rate Calculation
// ============================================

/**
 * Determine the final commission rate to apply
 *
 * Rate cascade (highest priority first):
 * 1. Staff override (if exists and has customRate)
 * 2. Tier rate (based on current period performance)
 * 3. Role-based rate (from config.roleRates)
 * 4. Default rate (from config.defaultRate)
 *
 * @param config - Commission config
 * @param override - Staff override (may be null)
 * @param staffRole - Staff member's role
 * @param tierRate - Applicable tier rate (may be null)
 * @returns Final rate to apply (as decimal, e.g., 0.03 for 3%)
 */
export function calculateFinalRate(
  config: CommissionConfigWithRelations,
  override: CommissionOverrideData | null,
  staffRole: StaffRole | null,
  tierRate: number | null,
): number {
  // 1. Check override first (highest priority)
  if (override?.customRate) {
    const rate = decimalToNumber(override.customRate)
    logger.debug('Using override rate', { rate, overrideId: override.id })
    return rate
  }

  // 2. Tasa de NIVEL — escalonado por tramos (TIERED) y META COMO NIVEL (`useGoalAsTier`).
  // 🔴 DINERO: la meta como nivel es un mecanismo INDEPENDIENTE del `calcType`. Se resuelve en
  // su propia rama de `createCalcForConfig` (`if (config.useGoalAsTier && config.goalBonusRate)
  // … else if (calcType === TIERED)`) y llega aquí ya calculada. Al exigir TIERED, el bonus por
  // meta superada se calculaba correctamente y se TIRABA: el vendedor que alcanzó su meta cobraba
  // la tasa BASE. Medido contra PostgreSQL: meta 100, acumulado 110, bonus 0.2 resuelto — y se
  // pagaba 0.1. No cambia nada para TIERED ni para quien no usa meta (ahí `tierRate` es null).
  const usaMetaComoNivel = Boolean(config.useGoalAsTier && config.goalBonusRate)
  if (tierRate !== null && (config.calcType === CommissionCalcType.TIERED || usaMetaComoNivel)) {
    logger.debug('Using tier rate', { rate: tierRate, viaMeta: usaMetaComoNivel })
    return tierRate
  }

  // 3. Check role-based rate
  if (config.roleRates && staffRole && config.roleRates[staffRole]) {
    const rate = config.roleRates[staffRole]
    logger.debug('Using role-based rate', { role: staffRole, rate })
    return rate
  }

  // 4. Fall back to default rate
  const defaultRate = decimalToNumber(config.defaultRate)
  logger.debug('Using default rate', { rate: defaultRate })
  return defaultRate
}

/**
 * Apply min/max bounds to a commission amount
 *
 * @param amount - Calculated commission amount
 * @param config - Commission config with min/max bounds
 * @returns Bounded commission amount
 */
export function applyCommissionBounds(amount: number, config: { minAmount: Decimal | null; maxAmount: Decimal | null }): number {
  let bounded = amount

  const minAmount = decimalToNumber(config.minAmount)
  const maxAmount = decimalToNumber(config.maxAmount)

  if (minAmount > 0 && bounded < minAmount) {
    bounded = minAmount
    logger.debug('Commission clamped to minimum', { original: amount, min: minAmount })
  }

  if (maxAmount > 0 && bounded > maxAmount) {
    bounded = maxAmount
    logger.debug('Commission clamped to maximum', { original: amount, max: maxAmount })
  }

  return bounded
}

// ============================================
// Base Amount Calculation
// ============================================

/**
 * Base comisionable de UN cobro cuando el esquema no filtra por categoría.
 *
 * 🔴 `discountAmount` y `taxAmount` son la PARTE DE ESTE COBRO (`repartir`, fase 3 A1), nunca los de toda la orden: con la
 * cuenta en dos cobros, cada uno recibía el descuento completo y «precio de lista» comisionaba $550 sobre una venta de $500.
 * El tope del descuento por subtotal (B2/B2c) se aplica ANTES de repartir, en `cobroDeLaOrden`.
 *
 *   LO_COBRADO      → `payment.amount` (lo que el cliente pagó de verdad)
 *   PRECIO_DE_LISTA → `payment.amount` + su parte del descuento
 *   «Sin IVA» (default)     → eso − el IVA del cobro;  «Con IVA» → eso
 *
 * El cobro SIEMPRE trae el IVA (incluido en el precio o cobrado aparte), por eso «con IVA» nunca lo suma otra vez. El IVA del
 * cobro (`taxAmount`) es el de su póliza contable (`ivaDelCobro`): en «Lo cobrado», con un solo cobro, sin categorías y antes
 * de la propina, «sin IVA» es exactamente la venta neta de la póliza (D5 enmendada por el founder el 5-oct: sin IVA de
 * fábrica, como Phorest y Mindbody). «Precio de lista» con orden no pasa por aquí: va por `listaDeLaOrden` (A1e).
 *
 * 🔴 La PROPINA no es parte de la base de la venta: se suma DESPUÉS y sólo si el esquema trae `includeTips`.
 */
export function calculateBaseAmount(
  payment: {
    amount: Decimal
    tipAmount?: Decimal | null
    /** El IVA de ESTE cobro según su póliza contable (`ivaDelCobro`). */
    taxAmount?: Decimal | null
    /** La parte de ESTE cobro del descuento efectivo de la orden. */
    discountAmount?: Decimal | null
  },
  config: {
    includeTips: boolean
    includeDiscount: boolean
    includeTax: boolean
  },
): { baseAmount: number; tipAmount: number; discountAmount: number; taxAmount: number } {
  const paidAmount = decimalToNumber(payment.amount)
  const tipAmount = decimalToNumber(payment.tipAmount)
  const taxAmount = decimalToNumber(payment.taxAmount)
  const discountAmount = decimalToNumber(payment.discountAmount)

  let baseAmount = commissionableAmount([{ gross: paidAmount + discountAmount, lineDiscount: discountAmount, tax: taxAmount }], {
    base: resolveCommissionBase(config),
    includeTax: config.includeTax,
    ivaIncluidoEnPrecio: true,
  })

  // Tips are NOT included by default (tips are already direct bonus for employees)
  if (config.includeTips) {
    baseAmount += tipAmount
  }

  return { baseAmount, tipAmount, discountAmount, taxAmount }
}

// ============================================
// Un cobro dentro de su orden (fase 3, A1)
// ============================================

/** Lo que el reparto por cobro lee de la orden: el `select` de `payment.order` en los dos creadores de comisión. */
export const ORDEN_PARA_REPARTO_SELECT = {
  id: true,
  createdById: true,
  servedById: true,
  subtotal: true,
  discountAmount: true,
  taxAmount: true,
  serviceChargeAmount: true,
  contratoDePrecio: true,
  status: true,
  // A1e: los renglones como los lee la póliza contable (`OrderItemRow`) más sus extras (la lista de la orden). Sin `take`: son
  // los de UNA orden y truncarlos cambiaría dinero.
  items: {
    select: {
      quantity: true,
      unitPrice: true,
      weightQuantity: true,
      discountAmount: true,
      modifiers: { select: { price: true, quantity: true } },
      product: { select: { taxRate: true } },
    },
  },
} satisfies Prisma.OrderSelect

export type OrdenParaReparto = Prisma.OrderGetPayload<{ select: typeof ORDEN_PARA_REPARTO_SELECT }>

const CERO = new Prisma.Decimal(0)
const dec = (v: Prisma.Decimal | number | string | null | undefined) => new Prisma.Decimal(v == null ? 0 : String(v))

/**
 * ESTE cobro dentro de su orden: lo que la orden cobra sin propina (`computeStoredOrderTotal`, la regla del saldo) y el valor de la
 * orden que se reparte entre cobros:
 *
 * - `descuento`: el EFECTIVO de mercancía, min(cabecera, subtotal). Es el tope de B2/B2c que vivía en `calculateBaseAmount`
 *   (`origin/develop` `commission-utils.ts:419`): la cabecera es la Σ de las filas, sin tope, y puede pasar al subtotal.
 *
 * Sin orden (cobro suelto) el cobro es todo: no hay nada que repartir. Los OTROS cobros los lee `otrosCobros`, por esquema.
 */
export function cobroDeLaOrden(payment: { amount: Decimal; orderId: string | null; order: OrdenParaReparto | null }): CobroDeLaOrden {
  const cobro = new Prisma.Decimal(payment.amount)
  const o = payment.order
  if (!payment.orderId || !o) return { totalOrden: cobro, cobro, descuento: CERO }
  const subtotal = Prisma.Decimal.max(CERO, new Prisma.Decimal(o.subtotal ?? 0))
  return {
    totalOrden: computeStoredOrderTotal({
      subtotal: o.subtotal,
      discountAmount: o.discountAmount,
      serviceChargeAmount: o.serviceChargeAmount,
      contratoDePrecio: o.contratoDePrecio,
      taxAmount: o.taxAmount,
      status: o.status,
      tipAmount: 0,
    }),
    cobro,
    descuento: Prisma.Decimal.min(Prisma.Decimal.max(CERO, new Prisma.Decimal(o.discountAmount ?? 0)), subtotal),
  }
}

/**
 * El IVA de ESTE cobro con la regla de la póliza contable (A1e, D5 enmendada): `ivaDelCobroComoContabilidad`, la misma que
 * `buildSaleLines` —lo cobrado repartido por la mezcla de tasas de los renglones de la orden; sin renglones, al 16 %—. Es lo
 * que «sin IVA» le resta a «Lo cobrado».
 */
export function ivaDelCobro(payment: { amount: Decimal; order: { items?: OrderItemRow[] } | null }): Prisma.Decimal {
  const centavos = new Prisma.Decimal(payment.amount).mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber()
  return new Prisma.Decimal(ivaDelCobroComoContabilidad(centavos, payment.order?.items).taxCents).div(100)
}

/**
 * Lo que el POS le cobró a UN renglón antes de descuentos (A1e, Codex r4-1): por peso, precio/kg × kilos redondeado al centavo
 * —la expresión de `order.tpv.service.ts:1738` y `order.mobile.service.ts:666`; ninguno la exporta—; por pieza, precio ×
 * cantidad; y los extras, por unidad × cantidad. Las ventas por peso guardan `quantity = 1` y los kilos en `weightQuantity`:
 * multiplicar por `quantity` cobraba un kilo entero ($116 por 0.5 kg). Lo usan la lista de la orden y los renglones de
 * categorías.
 */
function importeDelRenglon(it: {
  quantity: number
  unitPrice: Decimal | number
  weightQuantity?: Decimal | number | null
  modifiers?: Array<{ price: Decimal | number; quantity: number }>
}): number {
  const extras = (it.modifiers ?? []).reduce((s, m) => s + Number(m.price) * m.quantity, 0) * it.quantity
  const base =
    it.weightQuantity != null
      ? Math.round(Number(it.unitPrice) * Number(it.weightQuantity) * 100) / 100
      : Number(it.unitPrice) * it.quantity
  return base + extras
}

/**
 * «Precio de lista» de la ORDEN en el esquema general (A1e, Codex r3-2 y r3-3): sus RENGLONES —lo que el POS cobró por cada uno
 * antes de descuentos (`importeDelRenglon`: kilos en la venta por peso, extras incluidos)— MÁS el cargo por servicio; sin
 * renglones, la cabecera (subtotal + cargo). Es la MISMA mercancía con y sin IVA: la cabecera no siempre refleja los renglones
 * (la cortesía del POS móvil deja el subtotal sin el descuento). «Sin IVA» le quita el IVA con la regla de la póliza
 * (`ivaDelCobroComoContabilidad`, pesando los renglones sin sus descuentos). Con el IVA cobrado aparte los renglones ya vienen
 * sin IVA: «sin IVA» es la lista y «con IVA» le suma el registrado (como A1c en categorías). Cada cobro se lleva su parte con
 * `baseDelCobro`.
 */
export function listaDeLaOrden(order: OrdenParaReparto, config: { includeTax: boolean }): number {
  const renglones = order.items ?? []
  const lista = (renglones.length ? renglones.reduce((s, it) => s.plus(importeDelRenglon(it)), CERO) : dec(order.subtotal)).plus(
    dec(order.serviceChargeAmount),
  )
  const pesos = (n: Prisma.Decimal) => n.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toNumber()
  if (!precioTraeIva(order)) return pesos(config.includeTax ? lista.plus(dec(order.taxAmount)) : lista)
  if (config.includeTax) return pesos(lista)
  const centavos = lista.mul(100).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber()
  return (
    ivaDelCobroComoContabilidad(
      centavos,
      renglones.map(it => ({ ...it, discountAmount: 0 })),
    ).netCents / 100
  )
}

/**
 * Los OTROS cobros confirmados de la orden que se ven AHORA, con lo que ya recibió cada uno de ESTE esquema: sus filas no
 * anuladas más sus comisiones todavía en cola (el worker marca DONE en la misma transacción en que crea la fila: una foto
 * nunca ve las dos). `null` = ese cobro no tiene registro de este esquema y `repartir` cuenta su parte proporcional.
 *
 * 🔴 Se llama con el candado de la orden TOMADO (el mismo de los dos creadores y del worker): así el segundo en confirmarse
 * ve al primero, sea cual sea la fecha de cada uno (Codex plan r2, el riesgo de A1b: ordenar por `createdAt` dejaba que dos
 * cobros confirmados al revés de sus fechas se llevaran cada uno 0.02 de un descuento de 0.03). Sin `take`: truncar
 * cambiaría dinero, y son los cobros de UNA orden.
 */
export async function otrosCobros(
  db: Prisma.TransactionClient,
  payment: { id: string; venueId: string; orderId: string | null },
  configId: string,
): Promise<OtroCobro[]> {
  if (!payment.orderId) return []
  const filas = await db.$queryRaw<
    Array<{ monto: Prisma.Decimal; registrado: boolean; base: Prisma.Decimal; descuento: Prisma.Decimal }>
  >(Prisma.sql`
    WITH otros_de_la_orden AS (
      SELECT p.id, p.amount AS monto FROM "Payment" p
      WHERE p."venueId" = ${payment.venueId} AND p."orderId" = ${payment.orderId} AND p.id <> ${payment.id}
        AND p.status = 'COMPLETED' AND (p.type IS NULL OR p.type NOT IN ('REFUND', 'TEST'))
    ),
    registrado AS (
      SELECT cc."paymentId" AS id, cc."baseAmount" - cc."tipAmount" AS base, cc."discountAmount" AS descuento
      FROM "CommissionCalculation" cc
      WHERE cc."venueId" = ${payment.venueId} AND cc."configId" = ${configId} AND cc."voidedAt" IS NULL
        AND cc."paymentId" IN (SELECT id FROM otros_de_la_orden)
      UNION ALL
      SELECT e."paymentId",
             (e.payload->>'baseAmount')::numeric - COALESCE((e.payload->>'tipAmount')::numeric, 0),
             COALESCE((e.payload->>'discountAmount')::numeric, 0)
      FROM "PaymentEffect" e
      WHERE e."venueId" = ${payment.venueId} AND e.kind = 'COMMISSION' AND e.status IN ('PENDING', 'PROCESSING', 'DEAD_LETTER')
        AND e.payload->>'configId' = ${configId} AND e."paymentId" IN (SELECT id FROM otros_de_la_orden)
    )
    SELECT o.monto, COUNT(r.id) > 0 AS registrado,
           COALESCE(SUM(r.base), 0) AS base, COALESCE(SUM(r.descuento), 0) AS descuento
    FROM otros_de_la_orden o LEFT JOIN registrado r ON r.id = o.id
    GROUP BY o.id, o.monto
  `)
  return filas.map(f => ({
    monto: dec(f.monto),
    base: f.registrado ? dec(f.base) : null,
    descuento: f.registrado ? dec(f.descuento) : null,
  }))
}

/**
 * La base de UNA orden (de unas categorías o del sobrante) que le toca a ESTE cobro: su parte —con lo que ya recibieron los
 * otros cobros de ese esquema, `otros`—, sin pasar de lo que el esquema todavía no comisionó de esa orden — el tope de
 * siempre: cobros calculados con la regla anterior ya consumieron la base completa (Mindform, $34.20 sobre una venta de
 * $380; 268c5fc6).
 */
export function baseDelCobro(c: CobroDeLaOrden, baseDeLaOrden: number, yaComisionado: number, otros: OtroCobro[]): number {
  // En decimal, no en binario: 0.1 + 0.2 no puede decidir un centavo (Codex plan r1-3).
  const base = new Prisma.Decimal(baseDeLaOrden)
  const queda = base.minus(new Prisma.Decimal(yaComisionado)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
  return Prisma.Decimal.max(CERO, Prisma.Decimal.min(repartir(c, base, otros, 'base'), queda)).toNumber()
}

// ============================================
// Period Helpers
// ============================================

/**
 * Get the start and end dates for a tier period in venue timezone
 *
 * Converts the reference date to venue timezone, computes period boundaries
 * in venue-local time, then converts back to UTC for Prisma queries.
 *
 * @param period - TierPeriod enum
 * @param referenceDate - Reference date (defaults to now)
 * @param timezone - Venue timezone (defaults to DEFAULT_TIMEZONE)
 * @returns { start: Date, end: Date } in UTC
 */
export function getPeriodDateRange(
  period: TierPeriod,
  referenceDate: Date = new Date(),
  timezone: string = DEFAULT_TIMEZONE,
): { start: Date; end: Date } {
  // Convert reference date to venue-local time
  const venueDate = toZonedTime(referenceDate, timezone)

  let venueStart: Date
  let venueEnd: Date

  switch (period) {
    case TierPeriod.DAILY:
      venueStart = startOfDay(venueDate)
      venueEnd = endOfDay(venueDate)
      break

    case TierPeriod.WEEKLY:
      // Start from Monday (weekStartsOn: 1)
      venueStart = startOfWeek(venueDate, { weekStartsOn: 1 })
      venueEnd = endOfWeek(venueDate, { weekStartsOn: 1 })
      break

    case TierPeriod.BIWEEKLY: {
      // Two weeks from start of year, week 1 starts Jan 1
      const yearStart = new Date(venueDate.getFullYear(), 0, 1)
      const weekNumber = Math.floor((venueDate.getTime() - yearStart.getTime()) / (7 * 24 * 60 * 60 * 1000))
      const biweekNumber = Math.floor(weekNumber / 2)
      const biweekStart = new Date(yearStart.getTime() + biweekNumber * 2 * 7 * 24 * 60 * 60 * 1000)
      venueStart = startOfDay(biweekStart)
      const biweekEnd = new Date(biweekStart.getTime() + 13 * 24 * 60 * 60 * 1000)
      venueEnd = endOfDay(biweekEnd)
      break
    }

    case TierPeriod.MONTHLY:
      venueStart = startOfMonth(venueDate)
      venueEnd = endOfMonth(venueDate)
      break

    case TierPeriod.QUARTERLY: {
      const quarter = Math.floor(venueDate.getMonth() / 3)
      const quarterStart = new Date(venueDate.getFullYear(), quarter * 3, 1)
      const quarterEnd = new Date(venueDate.getFullYear(), (quarter + 1) * 3, 0)
      venueStart = startOfDay(quarterStart)
      venueEnd = endOfDay(quarterEnd)
      break
    }

    case TierPeriod.YEARLY: {
      const yearStartDate = new Date(venueDate.getFullYear(), 0, 1)
      const yearEndDate = new Date(venueDate.getFullYear(), 11, 31)
      venueStart = startOfDay(yearStartDate)
      venueEnd = endOfDay(yearEndDate)
      break
    }

    default:
      // Default to monthly
      venueStart = startOfMonth(venueDate)
      venueEnd = endOfMonth(venueDate)
  }

  // Convert venue-local boundaries back to UTC for Prisma queries
  return {
    start: fromZonedTime(venueStart, timezone),
    end: fromZonedTime(venueEnd, timezone),
  }
}

/**
 * Get venue timezone from database
 *
 * @param venueId - Venue ID
 * @returns IANA timezone string (defaults to DEFAULT_TIMEZONE if not found)
 */
export async function getVenueTimezone(venueId: string, db: Prisma.TransactionClient = prisma): Promise<string> {
  const venue = await db.venue.findUnique({
    where: { id: venueId },
    select: { timezone: true },
  })
  return venue?.timezone || DEFAULT_TIMEZONE
}

// ============================================
// Staff Validation
// ============================================

/**
 * Check if a staff member is active and can receive commissions
 *
 * @param staffId - Staff member ID
 * @param venueId - Venue ID
 * @returns Staff data if active, null otherwise
 */
export async function validateStaffForCommission(
  staffId: string,
  venueId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<{ staffId: string; role: StaffRole } | null> {
  const staffVenue = await db.staffVenue.findFirst({
    where: {
      staffId,
      venueId,
      active: true,
    },
    include: {
      staff: {
        select: {
          id: true,
          active: true,
        },
      },
    },
  })

  if (!staffVenue || !staffVenue.staff.active) {
    logger.debug('Staff not eligible for commission', {
      staffId,
      venueId,
      reason: !staffVenue ? 'No active StaffVenue' : 'Staff not active',
    })
    return null
  }

  return {
    staffId: staffVenue.staffId,
    role: staffVenue.role,
  }
}

// ============================================
// Idempotency Check
// ============================================

/**
 * Check if a commission calculation already exists for a payment
 *
 * @param paymentId - Payment ID
 * @returns true if commission already exists
 */
export async function commissionExistsForPayment(paymentId: string): Promise<boolean> {
  const existing = await prisma.commissionCalculation.findFirst({
    where: {
      paymentId,
      status: { not: 'VOIDED' },
    },
  })

  return existing !== null
}

/**
 * Check if a commission calculation already exists for an order
 *
 * @param orderId - Order ID
 * @returns true if commission already exists
 */
export async function commissionExistsForOrder(orderId: string): Promise<boolean> {
  const existing = await prisma.commissionCalculation.findFirst({
    where: {
      orderId,
      status: { not: 'VOIDED' },
    },
  })

  return existing !== null
}

// ============================================
// Category-Filtered Amount Calculation
// ============================================

/**
 * Find ALL active commission configs for a venue at a given date.
 * Venue-level configs take precedence: if any exist, org-level configs are
 * ignored (mirrors findActiveCommissionConfig's venue-over-org fallback).
 * Returned highest-priority first.
 */
export async function findActiveCommissionConfigs(
  venueId: string,
  effectiveDate: Date = new Date(),
  db: Prisma.TransactionClient = prisma,
): Promise<CommissionConfigWithRelations[]> {
  const includeTiers = { tiers: { where: { active: true }, orderBy: { tierLevel: 'asc' as const } } }
  const dateFilter = {
    active: true,
    deletedAt: null,
    effectiveFrom: { lte: effectiveDate },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveDate } }],
  }

  const venueConfigs = await db.commissionConfig.findMany({
    where: { venueId, ...dateFilter },
    include: includeTiers,
    orderBy: { priority: 'desc' },
  })
  if (venueConfigs.length > 0) {
    return venueConfigs.map(c => ({ ...c, roleRates: c.roleRates as RoleRates | null, tiers: c.tiers as CommissionTierData[] }))
  }

  const venue = await db.venue.findUnique({ where: { id: venueId }, select: { organizationId: true } })
  if (!venue?.organizationId) return []

  const orgConfigs = await db.commissionConfig.findMany({
    where: { orgId: venue.organizationId, venueId: null, ...dateFilter },
    include: includeTiers,
    orderBy: { priority: 'desc' },
  })
  return orgConfigs.map(c => ({ ...c, roleRates: c.roleRates as RoleRates | null, tiers: c.tiers as CommissionTierData[] }))
}

/**
 * Lee la orden COMPLETA una sola vez y la normaliza a las líneas que consume la
 * base única, con el descuento de ORDEN ya separado del de renglón.
 *
 * 🔴 Se leen TODAS las líneas, no sólo las del esquema, por dos razones:
 *
 * 1. **El prorrateo necesita el denominador completo.** El descuento de orden se
 *    reparte entre todas las líneas; si sólo miráramos las de una categoría, ese
 *    esquema absorbería el descuento entero.
 * 2. **Filtrar en SQL por `product.categoryId` perdía los importes libres.** Un
 *    renglón de "Otro importe" no tiene `productId`, así que la relación no
 *    existe y no caía ni en el `in` (base por categoría) ni en el `notIn`
 *    (sobrante): esa venta no generaba comisión para NADIE en cuanto existía una
 *    configuración por categoría. La selección ahora se hace en memoria, donde
 *    "sin categoría" es un caso explícito y no un accidente del filtro.
 */
async function loadOrderCommissionLines(
  orderId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<{ lines: OrderLineForCommission[]; orderLevelDiscount: number; ivaIncluidoEnPrecio: boolean }> {
  const [orderItems, order] = await Promise.all([
    db.orderItem.findMany({
      where: { orderId },
      // A1e: en orden de `id`, para que el residuo de centavos de `baseSinIvaPorTasa` no dependa del orden de la consulta.
      orderBy: { id: 'asc' },
      select: {
        quantity: true,
        unitPrice: true,
        weightQuantity: true,
        taxAmount: true,
        discountAmount: true,
        modifiers: { select: { price: true, quantity: true } },
        product: { select: { categoryId: true, taxRate: true } },
      },
    }),
    db.order.findUnique({ where: { id: orderId }, select: { discountAmount: true, contratoDePrecio: true, taxAmount: true } }),
  ])

  const lines: OrderLineForCommission[] = orderItems.map(item => ({
    // A1e: el renglón como lo cobró el POS: kilos en la venta por peso y extras con precio (Codex r4-1).
    gross: importeDelRenglon(item),
    lineDiscount: decimalToNumber(item.discountAmount),
    tax: decimalToNumber(item.taxAmount),
    categoryId: item.product?.categoryId ?? null,
    taxRate: item.product?.taxRate != null ? decimalToNumber(item.product.taxRate) : null,
  }))

  return {
    lines,
    orderLevelDiscount: orderLevelDiscountOf(
      decimalToNumber(order?.discountAmount),
      lines.map(line => line.lineDiscount),
    ),
    // A1e: IVA_INCLUIDO, o DESCONOCIDO sin IVA registrado ⇒ los renglones traen el IVA y «sin IVA» lo separa por tasa; aparte
    // (o DESCONOCIDO con IVA registrado, la regla P12) los renglones ya vienen sin IVA.
    ivaIncluidoEnPrecio: precioTraeIva(order ?? {}),
  }
}

/**
 * Base comisionable de las líneas de UNAS categorías (config con
 * `filterByCategories=true`).
 *
 * Sólo entran las líneas cuyo producto pertenece a `categoryIds` — un importe
 * libre nunca se cuela aquí: no tiene categoría, así que su lugar es el
 * sobrante. La aritmética vive en `commission-base.ts`.
 *
 * @param orderId - Order ID to get items from
 * @param categoryIds - Allowed category IDs
 * @param config - Tax/discount inclusion settings
 * @returns Filtered base amount, or 0 if no matching items
 */
export async function calculateCategoryFilteredAmount(
  orderId: string,
  categoryIds: string[],
  config: { includeTax: boolean; includeDiscount: boolean },
  db: Prisma.TransactionClient = prisma,
): Promise<number> {
  const { lines, orderLevelDiscount, ivaIncluidoEnPrecio } = await loadOrderCommissionLines(orderId, db)

  const selected = selectCommissionableLines({
    orderLines: lines,
    orderLevelDiscount,
    include: line => line.categoryId !== null && categoryIds.includes(line.categoryId),
  })

  const base = resolveCommissionBase(config)
  // A1e: «sin IVA» con los renglones trayendo el IVA ⇒ la regla de tasas de la póliza; lo demás, la aritmética de A1c.
  return ivaIncluidoEnPrecio && !config.includeTax
    ? baseSinIvaPorTasa(selected, base)
    : commissionableAmount(selected, { base, includeTax: config.includeTax, ivaIncluidoEnPrecio })
}

/**
 * Base comisionable del SOBRANTE: lo que ninguna config por categoría reclama.
 *
 * Incluye las líneas de categorías no reclamadas **y las de importe libre**
 * ("Otro importe", sin producto) — juntas con la base por categoría cubren la
 * orden entera, sin huecos y sin solapes.
 */
export async function calculateLeftoverAmount(
  orderId: string,
  claimedCategoryIds: string[],
  config: { includeTax: boolean; includeDiscount: boolean },
  db: Prisma.TransactionClient = prisma,
): Promise<number> {
  const { lines, orderLevelDiscount, ivaIncluidoEnPrecio } = await loadOrderCommissionLines(orderId, db)

  const selected = selectCommissionableLines({
    orderLines: lines,
    orderLevelDiscount,
    include: line => line.categoryId === null || !claimedCategoryIds.includes(line.categoryId),
  })

  const base = resolveCommissionBase(config)
  // A1e: «sin IVA» con los renglones trayendo el IVA ⇒ la regla de tasas de la póliza; lo demás, la aritmética de A1c.
  return ivaIncluidoEnPrecio && !config.includeTax
    ? baseSinIvaPorTasa(selected, base)
    : commissionableAmount(selected, { base, includeTax: config.includeTax, ivaIncluidoEnPrecio })
}

/**
 * How much of THIS order's item base this config has already commissioned.
 *
 * 🔴 MONEY (bug real en prod, Mindform 2026-06-21/22): las bases de arriba se derivan de
 * los ITEMS DE LA ORDEN, pero `createCommissionForPayment` se dispara POR COBRO. Una orden
 * con 3 cobros recalculaba la MISMA base de $380 tres veces → $34.20 comisionados sobre
 * una venta de $380. El guard de idempotencia existente es por PAGO, así que no lo detiene.
 *
 * `CommissionCalculation.baseAmount` guarda base + propina cuando `includeTips`, así que la
 * porción de ITEMS ya cobrada es `baseAmount − tipAmount`. La propina es dinero POR COBRO y
 * no debe consumir la base de la orden.
 */
export async function alreadyCommissionedItemBase(
  orderId: string,
  configId: string,
  db: Prisma.TransactionClient = prisma,
  includePending = false,
): Promise<number> {
  // Retain the legacy helper contract for non-outbox callers.
  if (!includePending) {
    const prior = await db.commissionCalculation.findMany({
      where: { orderId, configId, voidedAt: null },
      select: { baseAmount: true, tipAmount: true },
    })
    return (
      Math.round(
        Math.max(
          0,
          prior.reduce((sum, calc) => sum + decimalToNumber(calc.baseAmount) - decimalToNumber(calc.tipAmount), 0),
        ) * 100,
      ) / 100
    )
  }
  const prior = await db.commissionCalculation.aggregate({
    where: { orderId, configId, voidedAt: null },
    _sum: { baseAmount: true, tipAmount: true },
  })
  // DONE has a committed calculation above. Dead letters still reserve their obligation.
  const [pending] = await db.$queryRaw<Array<{ base: Prisma.Decimal }>>(Prisma.sql`
    SELECT COALESCE(SUM((payload->>'baseAmount')::numeric - COALESCE((payload->>'tipAmount')::numeric, 0)), 0) AS base
    FROM "PaymentEffect" WHERE "orderId" = ${orderId} AND kind = 'COMMISSION'
      AND status IN ('PENDING', 'PROCESSING', 'DEAD_LETTER') AND payload->>'configId' = ${configId}
  `)
  const total = decimalToNumber(prior._sum.baseAmount) - decimalToNumber(prior._sum.tipAmount) + decimalToNumber(pending.base)
  return Math.round(Math.max(0, total) * 100) / 100
}

/** One MVCC snapshot counts either the pending plan or its committed calculation, never both. */
export async function committedAndPendingCommissionProgress(
  db: Prisma.TransactionClient,
  venueId: string,
  staffId: string,
  start: Date,
  end?: Date,
  configId?: string,
): Promise<{ amount: number; count: number }> {
  const [total] = await db.$queryRaw<Array<{ amount: Prisma.Decimal; count: bigint }>>(Prisma.sql`
    SELECT COALESCE(SUM(base), 0) AS amount, COUNT(*) AS count FROM (
      SELECT "baseAmount" AS base FROM "CommissionCalculation"
      WHERE "venueId" = ${venueId} AND "staffId" = ${staffId} AND status <> 'VOIDED'
        AND "calculatedAt" >= ${utcTs(start)}
        ${end ? Prisma.sql`AND "calculatedAt" <= ${utcTs(end)}` : Prisma.empty}
        ${configId ? Prisma.sql`AND "configId" = ${configId}` : Prisma.empty}
      UNION ALL
      SELECT (payload->>'baseAmount')::numeric AS base FROM "PaymentEffect"
      WHERE "venueId" = ${venueId} AND kind = 'COMMISSION'
        AND status IN ('PENDING', 'PROCESSING', 'DEAD_LETTER')
        AND payload->>'staffId' = ${staffId} AND payload ? 'baseAmount'
        AND payload->>'calculatedAt' >= ${start.toISOString()}
        ${end ? Prisma.sql`AND payload->>'calculatedAt' <= ${end.toISOString()}` : Prisma.empty}
        ${configId ? Prisma.sql`AND payload->>'configId' = ${configId}` : Prisma.empty}
    ) obligations
  `)
  return { amount: decimalToNumber(total.amount), count: Number(total.count) }
}

/**
 * Repite una operación COMPLETA —su transacción entera, que vuelve a leer todo— cuando Postgres la eligió víctima de un
 * bloqueo mutuo (40P01). A lo más 3 intentos; cualquier otro error sale tal cual. La anulación (filas → resumen) y el
 * agregador (resumen → filas) toman los mismos candados en orden contrario: la otra termina y el reintento lee lo que dejó
 * (Codex plan r1-5). `withSerializableRetry` no sirve aquí: no reintenta 40P01 a propósito.
 */
export async function reintentarSiHayBloqueoMutuo<T>(contexto: string, operacion: () => Promise<T>): Promise<T> {
  for (let intento = 1; ; intento++) {
    try {
      return await operacion()
    } catch (error) {
      if (!isDeadlockError(error) || intento >= 3) throw error
      logger.warn('Bloqueo mutuo: se repite la operación completa', { contexto, intento })
      await new Promise(resolve => setTimeout(resolve, 50 * intento))
    }
  }
}
