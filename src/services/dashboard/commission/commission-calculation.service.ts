/**
 * Commission Calculation Service
 *
 * Creates immutable commission records following the TransactionCost pattern.
 * Called automatically when a Payment is COMPLETED.
 *
 * Key Business Rules:
 * - Commissions are BONUSES for employees (they earn MORE based on sales)
 * - Tips are NOT included by default (tips are already direct bonus)
 * - Idempotent: Won't create duplicate for same payment
 * - Rate cascade: Override > Tier > Role Rate > Default Rate
 * - Creates negative records for refunds (proportional to original)
 *
 * Flow:
 * 1. Payment COMPLETED → createCommissionForPayment()
 * 2. Find active config for venue
 * 3. Determine recipient (CREATOR/SERVER/PROCESSOR)
 * 4. Check for override/tier rates
 * 5. Calculate commission
 * 6. Create immutable CommissionCalculation record
 */

import prisma from '../../../utils/prismaClient'
import logger from '../../../config/logger'
import { PaymentEffect, Prisma, CommissionCalcType, CommissionCalcStatus, PaymentType } from '@prisma/client'
import { NotFoundError, BadRequestError } from '../../../errors/AppError'
import { logAction } from '../activity-log.service'
import { applyAttendancePenalty, resolveAttendancePenaltyRate } from './commission-attendance'
import {
  committedAndPendingCommissionProgress,
  findActiveCommissionConfig,
  findActiveCommissionConfigs,
  findActiveOverride,
  getRecipientStaffId,
  calculateFinalRate,
  applyCommissionBounds,
  calculateBaseAmount,
  alreadyCommissionedItemBase,
  calculateCategoryFilteredAmount,
  calculateLeftoverAmount,
  validateStaffForCommission,
  commissionExistsForPayment,
  decimalToNumber,
  getVenueTimezone,
  CommissionConfigWithRelations,
  cobroDeLaOrden,
  otrosCobros,
  baseDelCobro,
  ORDEN_PARA_REPARTO_SELECT,
} from './commission-utils'
import { redondearRepartido, repartir } from './repartoPorCobro'
import { subMonths, startOfMonth, endOfMonth } from 'date-fns'
import { toZonedTime, fromZonedTime } from 'date-fns-tz'
import { getApplicableTierRate, resolveGoalBasedTier } from './commission-tier.service'

// ============================================
// Type Definitions
// ============================================

export interface CommissionCalculationResult {
  calculationId: string
  paymentId: string
  staffId: string
  baseAmount: number
  effectiveRate: number
  grossCommission: number
  netCommission: number
  tierLevel?: number
  tierName?: string
}

// ============================================
// Internal helpers
// ============================================

type CommissionSink = (data: Prisma.CommissionCalculationUncheckedCreateInput) => Promise<{ id: string }>
type CommissionOptions = { db?: Prisma.TransactionClient; sink?: CommissionSink }

type LoadedPayment = {
  id: string
  venueId: string
  orderId: string | null
  processedById: string | null
  tipAmount: Prisma.Decimal
  createdAt: Date
  order: { createdById: string | null; servedById: string | null } | null
  shift: { id: string } | null
}

async function createCalcForConfig(
  payment: LoadedPayment,
  config: CommissionConfigWithRelations,
  amounts: { baseAmount: number; tipAmount: number; discountAmount: number; taxAmount: number },
  options: CommissionOptions = {},
): Promise<CommissionCalculationResult | null> {
  const db = options.db ?? prisma
  const recipientStaffId = getRecipientStaffId({ processedById: payment.processedById }, payment.order, config.recipient)
  if (!recipientStaffId) {
    logger.warn('Could not determine commission recipient', { paymentId: payment.id, configId: config.id })
    return null
  }

  const staffInfo = await validateStaffForCommission(recipientStaffId, payment.venueId, db)
  if (!staffInfo) return null

  // Idempotency: one calc per (payment, config, staff). Lets webhook retries
  // run safely and lets multiple configs coexist on the same payment.
  const existing = await db.commissionCalculation.findFirst({
    where: { paymentId: payment.id, configId: config.id, staffId: recipientStaffId, status: { not: CommissionCalcStatus.VOIDED } },
    select: { id: true },
  })
  if (existing) {
    logger.info('Commission already exists for (payment, config, staff)', {
      paymentId: payment.id,
      configId: config.id,
      staffId: recipientStaffId,
    })
    return null
  }

  const override = await findActiveOverride(config.id, recipientStaffId, payment.createdAt, db)
  if (override?.excludeFromCommissions) return null

  let tierLevel: number | undefined
  let tierName: string | undefined
  let tierRate: number | null = null

  if (config.useGoalAsTier && config.goalBonusRate) {
    const timezone = await getVenueTimezone(payment.venueId, db)
    const monthStart = fromZonedTime(startOfMonth(toZonedTime(new Date(), timezone)), timezone)
    const periodBase = (await committedAndPendingCommissionProgress(db, payment.venueId, recipientStaffId, monthStart)).amount
    const goalTierInfo = await resolveGoalBasedTier(recipientStaffId, payment.venueId, config, periodBase, db)
    if (goalTierInfo) {
      tierLevel = goalTierInfo.tierLevel
      tierName = goalTierInfo.tierName
      tierRate = goalTierInfo.rate
    }
  } else if (config.calcType === CommissionCalcType.TIERED) {
    const tierInfo = await getApplicableTierRate(config.id, recipientStaffId, payment.venueId, db)
    if (tierInfo) {
      tierLevel = tierInfo.tierLevel
      tierName = tierInfo.tierName
      tierRate = tierInfo.rate
    }
  }

  const effectiveRate = calculateFinalRate(config, override, staffInfo.role, tierRate)

  let grossCommission =
    config.calcType === CommissionCalcType.FIXED ? decimalToNumber(config.defaultRate) : amounts.baseAmount * effectiveRate

  let netCommission = applyCommissionBounds(grossCommission, config)
  grossCommission = Math.round(grossCommission * 100) / 100
  netCommission = Math.round(netCommission * 100) / 100

  // Asistencia → comisiones: sólo si el esquema la prendió; falla abierta (comisión completa).
  const attendancePenaltyRate = await resolveAttendancePenaltyRate(
    {
      config,
      staffId: recipientStaffId,
      venueId: payment.venueId,
      at: payment.createdAt,
    },
    db,
  )
  netCommission = applyAttendancePenalty(netCommission, attendancePenaltyRate)

  const calculationData: Prisma.CommissionCalculationUncheckedCreateInput = {
    venueId: payment.venueId,
    staffId: recipientStaffId,
    paymentId: payment.id,
    orderId: payment.orderId,
    shiftId: payment.shift?.id,
    configId: config.id,
    baseAmount: amounts.baseAmount,
    tipAmount: amounts.tipAmount,
    discountAmount: amounts.discountAmount,
    taxAmount: amounts.taxAmount,
    effectiveRate,
    grossCommission,
    netCommission,
    calcType: config.calcType,
    tier: tierLevel,
    tierName,
    attendancePenaltyRate,
    status: CommissionCalcStatus.CALCULATED,
    calculatedAt: options.sink ? payment.createdAt : new Date(),
  }
  const calculation = options.sink ? await options.sink(calculationData) : await db.commissionCalculation.create({ data: calculationData })

  return {
    calculationId: calculation.id,
    paymentId: payment.id,
    staffId: recipientStaffId,
    baseAmount: amounts.baseAmount,
    effectiveRate,
    grossCommission,
    netCommission,
    tierLevel,
    tierName,
  }
}

// ============================================
// Main Entry Points
// ============================================

/**
 * Create commission calculation for a payment
 *
 * This is the main entry point, called after payment COMPLETED.
 * Follows TransactionCost pattern: create immutable financial record.
 * Evaluates ALL active configs — category-scoped configs each bill their
 * own categories; a catch-all config bills the leftover.
 *
 * @param paymentId - Payment ID that triggered this calculation
 * @returns Array of commission calculation results (one per config that fired)
 */
export async function createCommissionForPayment(
  paymentId: string,
  options: CommissionOptions = {},
): Promise<CommissionCalculationResult[]> {
  if (!options.db) return prisma.$transaction(tx => createCommissionForPayment(paymentId, { ...options, db: tx }))
  const db = options.db
  logger.info('Creating commission for payment', { paymentId })

  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    include: {
      order: { select: ORDEN_PARA_REPARTO_SELECT },
      shift: { select: { id: true } },
      venue: { select: { id: true, timezone: true } },
    },
  })
  if (!payment) throw new NotFoundError(`Payment ${paymentId} not found`)
  if (payment.type === PaymentType.TEST) {
    logger.info('Skipping commission: TEST payment', { paymentId })
    return []
  }
  if (payment.status !== 'COMPLETED') {
    logger.info('Skipping commission: not COMPLETED', { paymentId, status: payment.status })
    return []
  }

  const configs = await findActiveCommissionConfigs(payment.venueId, payment.createdAt, db)
  if (configs.length === 0) {
    logger.info('No active commission config', { paymentId, venueId: payment.venueId })
    return []
  }

  {
    if (payment.orderId)
      await db.$queryRaw(Prisma.sql`SELECT id FROM "Order" WHERE id = ${payment.orderId} AND "venueId" = ${payment.venueId} FOR UPDATE`)
    const recipients = [
      ...new Set(
        configs
          .map(config => getRecipientStaffId({ processedById: payment.processedById }, payment.order, config.recipient))
          .filter((id): id is string => !!id),
      ),
    ].sort()
    if (recipients.length)
      await db.$queryRaw(
        Prisma.sql`SELECT id FROM "StaffVenue" WHERE "venueId" = ${payment.venueId} AND "staffId" IN (${Prisma.join(recipients)}) ORDER BY "staffId" FOR UPDATE`,
      )
  }

  // A1 (Codex r3-14): el descuento, el IVA y la base por categorías son de la ORDEN; cada cobro comisiona SU parte. Los
  // otros cobros se leen por esquema (`otrosCobros`) con el candado de la orden ya tomado arriba.
  const enLaOrden = cobroDeLaOrden(payment)

  const categoryScoped = configs.filter(c => c.filterByCategories && c.categoryIds.length > 0)
  const catchAll = configs.filter(c => !(c.filterByCategories && c.categoryIds.length > 0))
  const claimed = [...new Set(categoryScoped.flatMap(c => c.categoryIds))]

  const results: CommissionCalculationResult[] = []

  // 1) Category-scoped configs — each bills its own categories.
  for (const config of categoryScoped) {
    if (!payment.orderId) continue
    const orderBase = await calculateCategoryFilteredAmount(
      payment.orderId,
      config.categoryIds,
      {
        includeTax: config.includeTax,
        includeDiscount: config.includeDiscount,
      },
      db,
    )
    // 🔴 MONEY: la base viene de los ITEMS DE LA ORDEN pero esto corre POR COBRO. Cada cobro se lleva su parte proporcional
    // (antes el PRIMERO se llevaba toda: devolverlo dejaba la comisión en $0 aunque seguía cobrada la otra mitad) y nunca más
    // de lo que queda por comisionar (Mindform, $34.20 sobre una venta de $380; 268c5fc6).
    let base = baseDelCobro(
      enLaOrden,
      orderBase,
      await alreadyCommissionedItemBase(payment.orderId, config.id, db, true),
      await otrosCobros(db, payment, config.id),
    )
    const tip = config.includeTips ? decimalToNumber(payment.tipAmount) : 0
    if (config.includeTips) base += tip
    if (base <= 0) continue
    const r = await createCalcForConfig(payment, config, { baseAmount: base, tipAmount: tip, discountAmount: 0, taxAmount: 0 }, options)
    if (r) results.push(r)
  }

  // 2) Catch-all config (highest priority) — bills the leftover. If there are
  //    no category-scoped configs, claimed is empty → whole payment (today's behavior).
  const generalConfig = catchAll[0]
  if (generalConfig) {
    let amounts: { baseAmount: number; tipAmount: number; discountAmount: number; taxAmount: number } | null = null
    if (claimed.length === 0) {
      // A1: la parte de ESTE cobro del IVA registrado y del descuento efectivo de la orden, no los de toda la orden; lo que
      // ya recibieron los otros cobros sale de SUS filas de este esquema, no del orden de las fechas.
      const otros = await otrosCobros(db, payment, generalConfig.id)
      const r = calculateBaseAmount(
        {
          amount: payment.amount,
          tipAmount: payment.tipAmount,
          taxAmount: repartir(enLaOrden, enLaOrden.iva, otros, 'iva'),
          discountAmount: repartir(enLaOrden, enLaOrden.descuento, otros, 'descuento'),
        },
        generalConfig,
      )
      // La fila guarda la propina que ENTRÓ a la base (el reverso de un reembolso lo lee así).
      amounts = { ...r, tipAmount: generalConfig.includeTips ? r.tipAmount : 0 }
    } else if (payment.orderId) {
      const orderLeftover = await calculateLeftoverAmount(
        payment.orderId,
        claimed,
        {
          includeTax: generalConfig.includeTax,
          includeDiscount: generalConfig.includeDiscount,
        },
        db,
      )
      // 🔴 MONEY: mismo reparto que la rama por categorías — el sobrante también es base DE ORDEN evaluada POR COBRO.
      let base = baseDelCobro(
        enLaOrden,
        orderLeftover,
        await alreadyCommissionedItemBase(payment.orderId, generalConfig.id, db, true),
        await otrosCobros(db, payment, generalConfig.id),
      )
      const tip = generalConfig.includeTips ? decimalToNumber(payment.tipAmount) : 0
      if (generalConfig.includeTips) base += tip
      amounts = { baseAmount: base, tipAmount: tip, discountAmount: 0, taxAmount: 0 }
    }
    if (amounts && amounts.baseAmount > 0) {
      const r = await createCalcForConfig(payment, generalConfig, amounts, options)
      if (r) results.push(r)
    }
  }

  logger.info('Commission(s) created for payment', { paymentId, count: results.length })
  return results
}

/**
 * Create negative commission records for a refund.
 *
 * Mirrors ALL original payment's commissions proportionally (one per config).
 * This ensures SUM(netCommission) reflects actual earnings after refunds.
 *
 * @param refundPaymentId - The refund Payment ID
 * @param originalPaymentId - The original Payment that was refunded
 * @returns Array of commission calculation results (one per original calc)
 */
export async function createRefundCommission(
  refundPaymentId: string,
  originalPaymentId: string,
  options: CommissionOptions = {},
): Promise<CommissionCalculationResult[]> {
  if (!options.db) return prisma.$transaction(tx => createRefundCommission(refundPaymentId, originalPaymentId, { ...options, db: tx }))
  const db = options.db
  const refundPayment = await db.payment.findUnique({ where: { id: refundPaymentId } })
  if (!refundPayment) throw new NotFoundError(`Refund payment ${refundPaymentId} not found`)
  if (refundPayment.orderId)
    await db.$queryRaw(
      Prisma.sql`SELECT id FROM "Order" WHERE id = ${refundPayment.orderId} AND "venueId" = ${refundPayment.venueId} FOR UPDATE`,
    )
  const originalPayment = await db.payment.findFirst({
    where: { id: originalPaymentId, venueId: refundPayment.venueId, orderId: refundPayment.orderId },
  })
  if (!originalPayment) throw new Error('REFUND_COMMISSION_SOURCE_MISMATCH')
  const originalCalcs = await db.commissionCalculation.findMany({
    where: { paymentId: originalPaymentId, status: { not: CommissionCalcStatus.VOIDED } },
  })
  const pending = await db.paymentEffect.findMany({
    where: {
      venueId: refundPayment.venueId,
      paymentId: originalPaymentId,
      kind: 'COMMISSION',
      status: { in: ['PENDING', 'PROCESSING', 'DEAD_LETTER'] },
    },
  })
  for (const effect of pending) {
    const data = effect.payload as unknown as (typeof originalCalcs)[number]
    if (data.configId && data.staffId && !originalCalcs.some(c => c.configId === data.configId && c.staffId === data.staffId))
      originalCalcs.push(data)
  }

  // 🔴 MONEY: la parte devuelta se mide contra el COBRO original, venta y propina por separado — no
  // contra la base de cada fila. Dividir (venta + propina) entre la base revertía el 110% de una base
  // sin propina, y el 100% de CADA fila de una comisión dividida por una devolución de la mitad.
  // El servidor ya topa lo reembolsado a lo cobrado, así que la suma de reversos no pasa del 100%.
  const fraccion = (devuelto: Prisma.Decimal | null, cobrado: Prisma.Decimal | null) => {
    const total = Math.abs(decimalToNumber(cobrado))
    return total > 0 ? Math.min(1, Math.abs(decimalToNumber(devuelto)) / total) : 0
  }
  const saleRatio = fraccion(refundPayment.amount, originalPayment.amount)
  const tipRatio = fraccion(refundPayment.tipAmount, originalPayment.tipAmount)
  const results: CommissionCalculationResult[] = []

  for (const originalCalc of originalCalcs) {
    const existing = await db.commissionCalculation.findFirst({
      where: {
        paymentId: refundPaymentId,
        configId: originalCalc.configId,
        staffId: originalCalc.staffId,
        status: { not: CommissionCalcStatus.VOIDED },
      },
      select: { id: true },
    })
    if (existing) continue

    const originalBaseAmount = decimalToNumber(originalCalc.baseAmount)
    // `tipAmount` de la fila = la propina que ENTRÓ a su base (0 si la config la excluye), así que la
    // propina devuelta sólo pesa en la comisión que la incluyó.
    const tipInBase = Math.min(Math.max(decimalToNumber(originalCalc.tipAmount), 0), Math.max(originalBaseAmount, 0))
    const refundRatio =
      originalBaseAmount > 0 ? ((originalBaseAmount - tipInBase) * saleRatio + tipInBase * tipRatio) / originalBaseAmount : saleRatio
    if (refundRatio <= 0) continue

    const data: Prisma.CommissionCalculationUncheckedCreateInput = {
      venueId: originalCalc.venueId,
      staffId: originalCalc.staffId,
      paymentId: refundPaymentId,
      orderId: originalCalc.orderId,
      shiftId: originalCalc.shiftId,
      configId: originalCalc.configId,
      // La parte de SU base que se devolvió (no el reembolso completo): `alreadyCommissionedItemBase`
      // suma `baseAmount − tipAmount` de estas filas.
      baseAmount: -originalBaseAmount * refundRatio,
      tipAmount: -tipInBase * tipRatio,
      discountAmount: -decimalToNumber(originalCalc.discountAmount) * refundRatio,
      taxAmount: -decimalToNumber(originalCalc.taxAmount) * refundRatio,
      effectiveRate: originalCalc.effectiveRate,
      grossCommission: -decimalToNumber(originalCalc.grossCommission) * refundRatio,
      netCommission: -decimalToNumber(originalCalc.netCommission) * refundRatio,
      calcType: originalCalc.calcType,
      tier: originalCalc.tier,
      tierName: originalCalc.tierName,
      status: CommissionCalcStatus.CALCULATED,
      calculatedAt: refundPayment.createdAt,
    }
    const calculation = options.sink ? { ...data, ...(await options.sink(data)) } : await db.commissionCalculation.create({ data })
    results.push({
      calculationId: calculation.id,
      paymentId: refundPaymentId,
      staffId: originalCalc.staffId,
      baseAmount: Number(data.baseAmount),
      effectiveRate: decimalToNumber(originalCalc.effectiveRate),
      grossCommission: Number(calculation.grossCommission),
      netCommission: Number(calculation.netCommission),
    })
  }
  return results
}

// ============================================
// Void / Correction Operations
// ============================================

/**
 * Void a commission calculation (mark as VOIDED with reason)
 *
 * Used when a calculation was created in error or needs to be excluded.
 * Does NOT delete the record - maintains audit trail.
 */
export async function voidCommissionCalculation(calculationId: string, venueId: string, voidedById: string, reason: string): Promise<void> {
  const calculation = await prisma.commissionCalculation.findFirst({
    where: {
      id: calculationId,
      venueId,
      status: { not: CommissionCalcStatus.VOIDED },
    },
  })

  if (!calculation) {
    throw new NotFoundError(`Commission calculation ${calculationId} not found`)
  }

  // Cannot void if already aggregated into a summary
  if (calculation.status === CommissionCalcStatus.AGGREGATED) {
    throw new BadRequestError('Cannot void calculation that has been aggregated. Create a correction instead.')
  }

  await prisma.commissionCalculation.update({
    where: { id: calculationId },
    data: {
      status: CommissionCalcStatus.VOIDED,
      voidedAt: new Date(),
      voidedBy: voidedById,
      voidReason: reason,
    },
  })

  logger.info('Commission calculation voided', {
    calculationId,
    venueId,
    voidedById,
    reason,
  })

  logAction({
    staffId: voidedById,
    venueId,
    action: 'COMMISSION_CALCULATION_VOIDED',
    entity: 'CommissionCalculation',
    entityId: calculationId,
    data: { reason, staffId: calculation.staffId },
  })
}

/**
 * Create a manual commission calculation (for adjustments/corrections)
 */
export async function createManualCommission(
  venueId: string,
  staffId: string,
  amount: number,
  reason: string,
  createdById: string,
  orderId?: string,
  shiftId?: string,
): Promise<CommissionCalculationResult> {
  // Validate staff
  const staffInfo = await validateStaffForCommission(staffId, venueId)
  if (!staffInfo) {
    throw new BadRequestError(`Staff ${staffId} is not active in venue ${venueId}`)
  }

  // Find any active config (for reference, not for rate calculation)
  const config = await findActiveCommissionConfig(venueId)

  const calculation = await prisma.commissionCalculation.create({
    data: {
      venueId,
      staffId,
      orderId,
      shiftId,
      configId: config?.id ?? '', // May be empty for pure manual adjustments

      baseAmount: Math.abs(amount), // Store absolute value
      tipAmount: 0,
      discountAmount: 0,
      taxAmount: 0,

      effectiveRate: amount >= 0 ? 1 : -1, // +1 for bonus, -1 for deduction
      grossCommission: amount,
      netCommission: amount,

      calcType: CommissionCalcType.MANUAL,

      status: CommissionCalcStatus.CALCULATED,
      calculatedAt: new Date(),
    },
  })

  logger.info('Manual commission created', {
    calculationId: calculation.id,
    venueId,
    staffId,
    amount,
    reason,
    createdById,
  })

  logAction({
    staffId: createdById,
    venueId,
    action: 'COMMISSION_MANUAL_CREATED',
    entity: 'CommissionCalculation',
    entityId: calculation.id,
    data: { targetStaffId: staffId, amount, reason },
  })

  return {
    calculationId: calculation.id,
    paymentId: '', // No payment for manual
    staffId,
    baseAmount: Math.abs(amount),
    effectiveRate: amount >= 0 ? 1 : -1,
    grossCommission: amount,
    netCommission: amount,
  }
}

// ============================================
// Query Operations
// ============================================

/**
 * Get commission calculations for a staff member
 * Returns calculations, summaries, stats, and tier progress
 */
export async function getStaffCommissions(
  staffId: string,
  venueId: string,
  filters: {
    startDate?: Date
    endDate?: Date
    status?: CommissionCalcStatus
    limit?: number
    offset?: number
  } = {},
): Promise<{
  calculations: any[]
  total: number
  summaries: any[]
  stats: {
    thisMonth: number
    lastMonth: number
    total: number
  }
  tierProgress: {
    currentTier: string | null
    nextTier: string | null
    currentAmount: number
    nextThreshold: number | null
    progress: number
  } | null
}> {
  const where: Prisma.CommissionCalculationWhereInput = {
    staffId,
    venueId,
  }

  if (filters.status) {
    where.status = filters.status
  }

  if (filters.startDate || filters.endDate) {
    where.calculatedAt = {}
    if (filters.startDate) where.calculatedAt.gte = filters.startDate
    if (filters.endDate) where.calculatedAt.lte = filters.endDate
  }

  // Calculate date ranges for stats in venue timezone
  const timezone = await getVenueTimezone(venueId)
  const now = new Date()
  const venueNow = toZonedTime(now, timezone)

  // This month: start of current month in venue timezone → UTC
  const thisMonthStart = fromZonedTime(startOfMonth(venueNow), timezone)

  // Last month: start and end of previous month in venue timezone → UTC
  const lastMonthVenue = subMonths(venueNow, 1)
  const lastMonthStart = fromZonedTime(startOfMonth(lastMonthVenue), timezone)
  const lastMonthEnd = fromZonedTime(endOfMonth(lastMonthVenue), timezone)

  const [calculations, total, summaries, thisMonthStats, lastMonthStats, totalStats] = await Promise.all([
    // Calculations
    prisma.commissionCalculation.findMany({
      where,
      include: {
        payment: {
          select: {
            id: true,
            amount: true,
            tipAmount: true,
            method: true,
          },
        },
        order: {
          select: {
            id: true,
            orderNumber: true,
          },
        },
        config: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      // `id` is the TIEBREAK — without it a tie group crossing a skip/take page boundary repeats a row
      // on one page and drops another for good (Asana 1217127206664238).
      orderBy: [{ calculatedAt: 'desc' }, { id: 'desc' }],
      take: filters.limit ?? 50,
      skip: filters.offset ?? 0,
    }),
    // Total count
    prisma.commissionCalculation.count({ where }),
    // Summaries for this staff member
    prisma.commissionSummary.findMany({
      where: {
        staffId,
        venueId,
      },
      orderBy: { periodEnd: 'desc' },
      take: 12, // Last 12 periods
    }),
    // This month stats
    prisma.commissionCalculation.aggregate({
      where: {
        staffId,
        venueId,
        status: { not: CommissionCalcStatus.VOIDED },
        calculatedAt: { gte: thisMonthStart },
      },
      _sum: { netCommission: true },
    }),
    // Last month stats
    prisma.commissionCalculation.aggregate({
      where: {
        staffId,
        venueId,
        status: { not: CommissionCalcStatus.VOIDED },
        calculatedAt: { gte: lastMonthStart, lte: lastMonthEnd },
      },
      _sum: { netCommission: true },
    }),
    // Total all-time stats
    prisma.commissionCalculation.aggregate({
      where: {
        staffId,
        venueId,
        status: { not: CommissionCalcStatus.VOIDED },
      },
      _sum: { netCommission: true },
    }),
  ])

  // Calculate stats
  const stats = {
    thisMonth: decimalToNumber(thisMonthStats._sum.netCommission),
    lastMonth: decimalToNumber(lastMonthStats._sum.netCommission),
    total: decimalToNumber(totalStats._sum.netCommission),
  }

  // Get tier progress (if tiered config exists)
  let tierProgress: {
    currentTier: string | null
    nextTier: string | null
    currentAmount: number
    nextThreshold: number | null
    progress: number
  } | null = null

  // Find active tiered config for this venue
  const tieredConfig = await prisma.commissionConfig.findFirst({
    where: {
      venueId,
      active: true,
      calcType: CommissionCalcType.TIERED,
    },
    include: {
      tiers: {
        orderBy: { tierLevel: 'asc' },
      },
    },
  })

  if (tieredConfig && tieredConfig.tiers.length > 0) {
    // Get current period sales for tier calculation
    const currentPeriodAmount = stats.thisMonth // Use this month for now (could be configurable)

    // Find current and next tier
    let currentTier: string | null = null
    let nextTier: string | null = null
    let nextThreshold: number | null = null

    for (let i = 0; i < tieredConfig.tiers.length; i++) {
      const tier = tieredConfig.tiers[i]
      const minThreshold = decimalToNumber(tier.minThreshold)
      const maxThreshold = tier.maxThreshold ? decimalToNumber(tier.maxThreshold) : Infinity

      if (currentPeriodAmount >= minThreshold && currentPeriodAmount < maxThreshold) {
        currentTier = tier.tierName
        if (i + 1 < tieredConfig.tiers.length) {
          nextTier = tieredConfig.tiers[i + 1].tierName
          nextThreshold = decimalToNumber(tieredConfig.tiers[i + 1].minThreshold)
        }
        break
      }
    }

    // If no tier matched, they're below the first tier
    if (!currentTier && tieredConfig.tiers.length > 0) {
      nextTier = tieredConfig.tiers[0].tierName
      nextThreshold = decimalToNumber(tieredConfig.tiers[0].minThreshold)
    }

    tierProgress = {
      currentTier,
      nextTier,
      currentAmount: currentPeriodAmount,
      nextThreshold,
      progress: nextThreshold ? Math.min((currentPeriodAmount / nextThreshold) * 100, 100) : 100,
    }
  }

  return { calculations, total, summaries, stats, tierProgress }
}

/**
 * Get commission summary stats for a staff member
 */
export async function getStaffCommissionStats(
  staffId: string,
  venueId: string,
  startDate: Date,
  endDate: Date,
): Promise<{
  totalEarned: number
  totalCalculations: number
  averageCommission: number
  averageRate: number
}> {
  const aggregation = await prisma.commissionCalculation.aggregate({
    where: {
      staffId,
      venueId,
      status: { not: CommissionCalcStatus.VOIDED },
      calculatedAt: { gte: startDate, lte: endDate },
    },
    _sum: {
      netCommission: true,
    },
    _count: {
      id: true,
    },
    _avg: {
      netCommission: true,
      effectiveRate: true,
    },
  })

  return {
    totalEarned: decimalToNumber(aggregation._sum.netCommission),
    totalCalculations: aggregation._count.id,
    averageCommission: decimalToNumber(aggregation._avg.netCommission),
    averageRate: decimalToNumber(aggregation._avg.effectiveRate),
  }
}

/**
 * Get pending (non-aggregated) calculations for a venue
 */
export async function getPendingCalculations(venueId: string, staffId?: string): Promise<any[]> {
  const where: Prisma.CommissionCalculationWhereInput = {
    venueId,
    status: CommissionCalcStatus.CALCULATED,
  }

  if (staffId) {
    where.staffId = staffId
  }

  return prisma.commissionCalculation.findMany({
    where,
    include: {
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
    orderBy: { calculatedAt: 'desc' },
  })
}

/**
 * Get venue-wide commission statistics
 */
export async function getVenueCommissionStats(venueId: string): Promise<{
  totalPaid: number
  totalPending: number
  totalApproved: number
  staffWithCommissions: number
  averageCommission: number
  topEarners: Array<{
    staffId: string
    staffName: string
    totalEarned: number
    calculationCount: number
  }>
}> {
  // Get summary stats by status
  const summaryStats = await prisma.commissionSummary.groupBy({
    by: ['status'],
    where: { venueId },
    _sum: { netAmount: true },
  })

  const totalPaid = decimalToNumber(summaryStats.find(s => s.status === 'PAID')?._sum.netAmount)
  const totalPending = decimalToNumber(summaryStats.find(s => s.status === 'PENDING_APPROVAL')?._sum.netAmount)
  const totalApproved = decimalToNumber(summaryStats.find(s => s.status === 'APPROVED')?._sum.netAmount)

  // Count unique staff with commissions
  const staffCount = await prisma.commissionCalculation.groupBy({
    by: ['staffId'],
    where: {
      venueId,
      status: { not: CommissionCalcStatus.VOIDED },
    },
  })

  // Get average commission
  const avgStats = await prisma.commissionCalculation.aggregate({
    where: {
      venueId,
      status: { not: CommissionCalcStatus.VOIDED },
    },
    _avg: { netCommission: true },
  })

  // Get top earners
  const topEarnersRaw = await prisma.commissionCalculation.groupBy({
    by: ['staffId'],
    where: {
      venueId,
      status: { not: CommissionCalcStatus.VOIDED },
    },
    _sum: { netCommission: true },
    _count: { id: true },
    orderBy: { _sum: { netCommission: 'desc' } },
    take: 5,
  })

  // Get staff names for top earners
  const staffIds = topEarnersRaw.map(e => e.staffId)
  const staffMembers = await prisma.staff.findMany({
    where: { id: { in: staffIds } },
    select: { id: true, firstName: true, lastName: true },
  })

  const staffMap = new Map(staffMembers.map(s => [s.id, s]))

  const topEarners = topEarnersRaw.map(e => {
    const staff = staffMap.get(e.staffId)
    return {
      staffId: e.staffId,
      staffName: staff ? `${staff.firstName} ${staff.lastName}` : 'Unknown',
      totalEarned: decimalToNumber(e._sum.netCommission),
      calculationCount: e._count.id,
    }
  })

  return {
    totalPaid,
    totalPending,
    totalApproved,
    staffWithCommissions: staffCount.length,
    averageCommission: decimalToNumber(avgStats._avg.netCommission),
    topEarners,
  }
}

/**
 * Get commissions for multiple payments in a single query
 *
 * @param paymentIds - Array of Payment IDs to look up
 * @param venueId - Venue ID for tenant isolation
 * @returns Map of paymentId to commission data
 */
export async function getCommissionsByPaymentIds(
  paymentIds: string[],
  venueId: string,
): Promise<
  Record<
    string,
    {
      id: string
      staffId: string
      staffName: string
      netCommission: number
      effectiveRate: number
      baseAmount: number
      status: string
      calculatedAt: Date
      configName: string
    }
  >
> {
  if (paymentIds.length === 0) return {}

  const calculations = await prisma.commissionCalculation.findMany({
    where: {
      paymentId: { in: paymentIds },
      venueId,
      status: { not: CommissionCalcStatus.VOIDED },
    },
    include: {
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      config: {
        select: {
          name: true,
        },
      },
    },
  })

  const result: Record<
    string,
    {
      id: string
      staffId: string
      staffName: string
      netCommission: number
      effectiveRate: number
      baseAmount: number
      status: string
      calculatedAt: Date
      configName: string
    }
  > = {}
  for (const calc of calculations) {
    if (calc.paymentId) {
      result[calc.paymentId] = {
        id: calc.id,
        staffId: calc.staffId,
        staffName: `${calc.staff.firstName} ${calc.staff.lastName}`,
        netCommission: decimalToNumber(calc.netCommission),
        effectiveRate: decimalToNumber(calc.effectiveRate),
        baseAmount: decimalToNumber(calc.baseAmount),
        status: calc.status,
        calculatedAt: calc.calculatedAt,
        configName: calc.config.name,
      }
    }
  }
  return result
}

/**
 * Get commission calculation for a specific payment
 *
 * Returns the commission record associated with a payment, including
 * staff information for display in the payment detail view.
 *
 * @param paymentId - Payment ID to look up
 * @param venueId - Venue ID for tenant isolation
 * @returns Commission calculation with staff info, or null if no commission exists
 */
export async function getCommissionByPaymentId(
  paymentId: string,
  venueId: string,
): Promise<{
  id: string
  staffId: string
  staffName: string
  netCommission: number
  effectiveRate: number
  baseAmount: number
  status: string
  calculatedAt: Date
  configName: string
} | null> {
  const calculation = await prisma.commissionCalculation.findFirst({
    where: {
      paymentId,
      venueId,
      status: { not: CommissionCalcStatus.VOIDED },
    },
    include: {
      staff: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
      config: {
        select: {
          name: true,
        },
      },
    },
  })

  if (!calculation) {
    return null
  }

  return {
    id: calculation.id,
    staffId: calculation.staffId,
    staffName: `${calculation.staff.firstName} ${calculation.staff.lastName}`,
    netCommission: decimalToNumber(calculation.netCommission),
    effectiveRate: decimalToNumber(calculation.effectiveRate),
    baseAmount: decimalToNumber(calculation.baseAmount),
    status: calculation.status,
    calculatedAt: calculation.calculatedAt,
    configName: calculation.config.name,
  }
}

// ============================================
// Split Commission (Payment Links — multi-staff attribution)
// ============================================

/**
 * Create N commission rows for a single payment, splitting the base amount
 * (and any tips/discounts/taxes carried into the commission base) equally
 * across the provided staff list.
 *
 * Used exclusively by payment links with multiple attributed staff. Bypasses
 * the recipient-enum cascade in `getRecipientStaffId` (the link itself names
 * the recipients) and bypasses the paymentId-level idempotency guard (which
 * was designed for the 1-recipient-per-payment TPV model). Per-staff
 * idempotency is enforced row-by-row with `(paymentId, staffId)` lookups.
 *
 * Each row is computed independently:
 *   1. Validate the staff is still active in the venue.
 *   2. Apply any staff-level override (custom rate / exclusion).
 *   3. Use the staff's role-based rate from `config.roleRates` if set,
 *      otherwise the config defaultRate. (Tiered rates are intentionally
 *      NOT applied for splits — the per-staff base is artificially small,
 *      which would force everyone into the lowest tier.)
 *   4. Apply min/max bounds AFTER splitting.
 *   5. Round to cents.
 *
 * Failures for individual staff (excluded, inactive, override-excluded) are
 * logged and skipped — they do not abort the other rows. This matches the
 * spirit of `createCommissionForPayment`, which returns null silently on
 * non-fatal skips.
 *
 * @returns Array of created calculations (one per eligible staff). May be
 *          shorter than the input if some staff were filtered out.
 */
export async function createSplitCommissionForPayment(
  paymentId: string,
  staffIds: string[],
  options: CommissionOptions = {},
): Promise<CommissionCalculationResult[]> {
  // 🔴 MONEY: una persona repetida en la liga es UNA persona — ni divide entre N de más ni recibe dos filas.
  const personas = [...new Set(staffIds)]
  logger.info('Creating SPLIT commission for payment', { paymentId, staffCount: personas.length })

  if (personas.length === 0) return []
  if (personas.length === 1) {
    // Caller should have routed through createCommissionForPayment; guard
    // anyway so this function is safe to call with any list length.
    return createCommissionForPayment(paymentId, options)
  }
  if (!options.db) return prisma.$transaction(tx => createSplitCommissionForPayment(paymentId, personas, { ...options, db: tx }))
  const db = options.db

  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    include: {
      order: { select: ORDEN_PARA_REPARTO_SELECT },
      shift: { select: { id: true } },
    },
  })

  if (!payment) throw new NotFoundError(`Payment ${paymentId} not found`)
  if (payment.type === PaymentType.TEST) {
    logger.info('Skipping split commission: TEST payment', { paymentId })
    return []
  }
  if (payment.status !== 'COMPLETED') {
    logger.info('Skipping split commission: Payment not COMPLETED', { paymentId, status: payment.status })
    return []
  }

  const config = await findActiveCommissionConfig(payment.venueId, payment.createdAt, db)
  if (!config) {
    logger.info('No active commission config for venue (split)', { paymentId, venueId: payment.venueId })
    return []
  }

  // A1: la base de la venta que le toca a ESTE cobro (su parte del descuento, del IVA o de la base por categorías). Se
  // calcula UNA vez y se divide entre las personas de la liga. Bajo el candado de la orden, como `createCommissionForPayment`:
  // los otros cobros se leen ya confirmados (Codex plan r2). Congelando (A5) ya lo tomó `freezePaymentCommissionInTx`.
  if (payment.orderId)
    await db.$queryRaw(Prisma.sql`SELECT id FROM "Order" WHERE id = ${payment.orderId} AND "venueId" = ${payment.venueId} FOR UPDATE`)
  const enLaOrden = cobroDeLaOrden(payment)
  const otros = await otrosCobros(db, payment, config.id)
  let totalBaseAmount: number
  let totalTipAmount: number
  let totalDiscountAmount: number
  let totalTaxAmount: number

  if (config.filterByCategories && config.categoryIds.length > 0 && payment.orderId) {
    const orderBase = await calculateCategoryFilteredAmount(
      payment.orderId,
      config.categoryIds,
      { includeTax: config.includeTax, includeDiscount: config.includeDiscount },
      db,
    )
    // 🔴 MONEY: base DE ORDEN evaluada POR COBRO — su parte, y nunca más de lo que queda por comisionar (las N filas de un
    // cobro dividido suman la base completa, que es lo que `alreadyCommissionedItemBase` ve).
    totalBaseAmount = baseDelCobro(enLaOrden, orderBase, await alreadyCommissionedItemBase(payment.orderId, config.id, db), otros)
    totalTipAmount = config.includeTips ? decimalToNumber(payment.tipAmount) : 0
    totalDiscountAmount = 0
    totalTaxAmount = 0
    if (config.includeTips) totalBaseAmount += totalTipAmount
  } else {
    const result = calculateBaseAmount(
      {
        amount: payment.amount,
        tipAmount: payment.tipAmount,
        taxAmount: repartir(enLaOrden, enLaOrden.iva, otros, 'iva'),
        discountAmount: repartir(enLaOrden, enLaOrden.descuento, otros, 'descuento'),
      },
      config,
    )
    totalBaseAmount = result.baseAmount
    // La fila guarda la propina que ENTRÓ a la base (el reverso de un reembolso lo lee así).
    totalTipAmount = config.includeTips ? result.tipAmount : 0
    totalDiscountAmount = result.discountAmount
    totalTaxAmount = result.taxAmount
  }

  // Al centavo ANTES de decidir y de repartir: los totales llegan como `number` (base + propina en binario: 225.1 + 0.2 =
  // 225.29999999999998) y `redondearRepartido` exige un total que sus partes de centavos sumen exacto. Una base de basura
  // binaria (3e-14) pasaría un `<= 0` en crudo y crearía N filas de $0.00.
  const alCentavo = (n: number) => new Prisma.Decimal(n).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
  if (alCentavo(totalBaseAmount).lte(0)) {
    logger.info('Skipping split commission: base amount zero or negative', { paymentId, totalBaseAmount })
    return []
  }

  const splitCount = personas.length
  // 🔴 MONEY (Codex plan r1-4): base, propina, descuento e IVA se reparten en CENTAVOS, con el centavo que sobra asignado en
  // un orden estable (por id de persona): las filas suman exacto lo cobrado. Antes cada una guardaba total/N y la base de
  // datos redondeaba cada fila por su cuenta.
  const orden = [...personas].sort()
  const enPartes = (total: number) => {
    const t = alCentavo(total)
    return redondearRepartido(
      orden.map(() => t.div(splitCount)),
      t,
    )
  }
  const bases = enPartes(totalBaseAmount)
  const propinas = enPartes(totalTipAmount)
  const descuentos = enPartes(totalDiscountAmount)
  const impuestos = enPartes(totalTaxAmount)

  // 1) Quién cobra y con qué tasa: las reglas de cada persona que deciden SI cobra.
  const elegibles: Array<{ i: number; staffId: string; effectiveRate: number }> = []
  for (const [i, staffId] of orden.entries()) {
    // Per-staff idempotency: skip if a calc already exists for this
    // (paymentId, staffId). Lets webhooks retry without creating duplicates.
    const existing = await db.commissionCalculation.findFirst({
      where: { paymentId, staffId, status: { not: CommissionCalcStatus.VOIDED } },
      select: { id: true },
    })
    if (existing) {
      logger.info('Split commission row already exists, skipping', { paymentId, staffId })
      continue
    }

    const staffInfo = await validateStaffForCommission(staffId, payment.venueId, db)
    if (!staffInfo) {
      logger.info('Staff not eligible for split commission, skipping', { paymentId, staffId })
      continue
    }

    const override = await findActiveOverride(config.id, staffId, payment.createdAt, db)
    if (override?.excludeFromCommissions) {
      logger.info('Staff excluded via override, skipping split row', { paymentId, staffId })
      continue
    }

    // Splits intentionally skip TIERED rate calculation — see function-level
    // docstring. Pass tierRate=null so the cascade falls back to override →
    // role-based → default.
    elegibles.push({ i, staffId, effectiveRate: calculateFinalRate(config, override, staffInfo.role, null) })
  }

  // 2) 🔴 MONEY (Codex plan r1-4): la comisión de cada una sobre SU parte, con los centavos repartidos sobre el total exacto:
  // $10 entre tres son 3.34 + 3.33 + 3.33, nunca $9.99. Un FIXED se divide entre las N personas de la liga, como siempre.
  const brutas = redondearRepartido(
    elegibles.map(e =>
      config.calcType === CommissionCalcType.FIXED
        ? new Prisma.Decimal(config.defaultRate).div(splitCount)
        : bases[e.i].mul(e.effectiveRate),
    ),
  )

  // 3) Las reglas de cada persona que quedan: topes y asistencia.
  const results: CommissionCalculationResult[] = []
  for (const [k, e] of elegibles.entries()) {
    const grossCommission = brutas[k].toNumber()
    let netCommission = Math.round(applyCommissionBounds(grossCommission, config) * 100) / 100

    // Cada persona del split se juzga con SU asistencia — el retardo de una no toca a la otra.
    const attendancePenaltyRate = await resolveAttendancePenaltyRate(
      { config, staffId: e.staffId, venueId: payment.venueId, at: payment.createdAt },
      db,
    )
    netCommission = applyAttendancePenalty(netCommission, attendancePenaltyRate)

    const calc = await db.commissionCalculation.create({
      data: {
        venueId: payment.venueId,
        staffId: e.staffId,
        attendancePenaltyRate,
        paymentId: payment.id,
        orderId: payment.orderId,
        shiftId: payment.shift?.id,
        configId: config.id,
        baseAmount: bases[e.i],
        tipAmount: propinas[e.i],
        discountAmount: descuentos[e.i],
        taxAmount: impuestos[e.i],
        effectiveRate: e.effectiveRate,
        grossCommission,
        netCommission,
        calcType: config.calcType,
        status: CommissionCalcStatus.CALCULATED,
        calculatedAt: new Date(),
      },
    })

    logger.info('Split commission row created', { calculationId: calc.id, paymentId, staffId: e.staffId, netCommission, splitCount })

    results.push({
      calculationId: calc.id,
      paymentId,
      staffId: e.staffId,
      baseAmount: bases[e.i].toNumber(),
      effectiveRate: e.effectiveRate,
      grossCommission,
      netCommission,
    })
  }

  return results
}

/** Freeze the existing calculation rules at financial commit, before any asynchronous delivery. */
export async function freezePaymentCommissionInTx(
  tx: Prisma.TransactionClient,
  paymentId: string,
  persist?: (plan: import('../../tpv/paymentEffects.service').PaymentEffectInput) => Promise<void>,
) {
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: { id: true, venueId: true, orderId: true } })
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Order" WHERE id = ${payment.orderId} AND "venueId" = ${payment.venueId} FOR UPDATE`)
  if (await tx.paymentEffect.findFirst({ where: { venueId: payment.venueId, paymentId, kind: 'COMMISSION' }, select: { id: true } }))
    return []
  const plans: import('../../tpv/paymentEffects.service').PaymentEffectInput[] = []
  await createCommissionForPayment(paymentId, {
    db: tx,
    sink: async data => {
      const dedupeKey = `commission:${paymentId}:${data.configId}:${data.staffId}:v1`
      const plan: import('../../tpv/paymentEffects.service').PaymentEffectInput = {
        venueId: payment.venueId,
        paymentId,
        orderId: payment.orderId,
        kind: 'COMMISSION',
        dedupeKey,
        payload: JSON.parse(JSON.stringify(data)) as Prisma.InputJsonValue,
      }
      if (persist) await persist(plan)
      else plans.push(plan)
      return { id: dedupeKey }
    },
  })
  return plans
}

/** Effect and calculation are committed together by the caller holding the Order/effect locks. */
export async function applyFrozenCommissionInTx(tx: Prisma.TransactionClient, effect: PaymentEffect): Promise<void> {
  const data = effect.payload as unknown as Prisma.CommissionCalculationUncheckedCreateInput
  if (
    data.venueId !== effect.venueId ||
    data.paymentId !== effect.paymentId ||
    data.orderId !== effect.orderId ||
    !data.configId ||
    !data.staffId
  ) {
    throw new Error('INVALID_COMMISSION_SNAPSHOT')
  }
  // Fase 3 (A2, Codex r1-3): una fila existente en CUALQUIER estado —también VOIDED— ya está materializada. Antes se buscaba
  // excluyendo VOIDED y un efecto pendiente revivía una comisión que alguien anuló.
  const existing = await tx.commissionCalculation.findFirst({
    where: { venueId: effect.venueId, paymentId: effect.paymentId, configId: data.configId, staffId: data.staffId },
    select: { id: true },
  })
  if (existing) return
  // Fase 3 (A2, Codex r2-1): un REVERSO todavía en cola no revive cuando su comisión original ya se anuló. El worker tiene
  // el candado de la orden; la anulación de hoy (`voidCommissionCalculation`) todavía no lo toma —A4 hace que la anulación
  // lo tome—, y hasta entonces una anulación que entre justo entre esta lectura y el `create` no se ve aquí.
  if (await esReversoDeUnaComisionAnulada(tx, effect, data.configId, data.staffId)) return
  await tx.commissionCalculation.create({ data })
}

/** ¿El efecto es el reverso de una devolución cuya comisión original (misma persona y esquema) está toda anulada? */
async function esReversoDeUnaComisionAnulada(
  tx: Prisma.TransactionClient,
  effect: PaymentEffect,
  configId: string,
  staffId: string,
): Promise<boolean> {
  const devolucion = await tx.payment.findFirst({
    where: { id: effect.paymentId, venueId: effect.venueId },
    select: { type: true, processorData: true },
  })
  if (devolucion?.type !== PaymentType.REFUND) return false
  const originalPaymentId = (devolucion.processorData as { originalPaymentId?: unknown } | null)?.originalPaymentId
  if (typeof originalPaymentId !== 'string') return false
  const originales = await tx.commissionCalculation.findMany({
    where: { venueId: effect.venueId, paymentId: originalPaymentId, configId, staffId },
    select: { status: true },
    take: 10,
  })
  // Sin original materializada todavía (su efecto sigue en cola) el reverso se crea: la original llegará después.
  return originales.length > 0 && originales.every(o => o.status === CommissionCalcStatus.VOIDED)
}
