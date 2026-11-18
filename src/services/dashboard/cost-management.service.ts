import prisma from '../../utils/prismaClient'
import { Prisma, TransactionCardType, ProfitStatus } from '@prisma/client'
import logger from '../../config/logger'
import { subDays } from 'date-fns'
import { fromZonedTime } from 'date-fns-tz'
import { BadRequestError, ConflictError } from '../../errors/AppError'
import { logAction } from './activity-log.service'
import { getEffectivePricingForSlot } from '../organization-payment-config.service'
import { findActiveProviderCostStructure } from '../payments/transactionCost.service'

// ===== INTERFACES =====

export interface ProfitMetricsParams {
  startDate?: string
  endDate?: string
  venueId?: string
  providerId?: string
}

export interface ProfitMetrics {
  totalGrossProfit: number
  totalProviderCosts: number
  totalVenueCharges: number
  averageProfitMargin: number
  transactionCount: number
  profitGrowth: number
  topProviders: ProviderProfitSummary[]
  topVenues: VenueProfitSummary[]
}

export interface ProviderProfitSummary {
  providerId: string
  providerName: string
  providerCode: string
  totalCosts: number
  totalTransactions: number
  averageRate: number
  share: number
}

export interface VenueProfitSummary {
  venueId: string
  venueName: string
  totalProfit: number
  profitMargin: number
  totalVolume: number
  transactionCount: number
  growth: number
}

export interface MonthlyProfitParams {
  startDate?: string
  endDate?: string
  venueId?: string
  status?: string
}

export interface CostStructureAnalysis {
  providerId: string
  providerName: string
  providerCode: string
  merchantAccounts: {
    id: string
    alias: string
    externalMerchantId: string
    currentCosts: {
      debitRate: number
      creditRate: number
      amexRate: number
      internationalRate: number
      fixedCostPerTransaction: number
      monthlyFee: number
      effectiveFrom: string
      effectiveTo?: string
    }
    transactionVolume: number
    totalCosts: number
    lastUpdated: string
  }[]
}

export interface TransactionCostParams {
  startDate?: string
  endDate?: string
  venueId?: string
  providerId?: string
  transactionType?: string
  limit?: number
  offset?: number
}

// ===== CORE BUSINESS LOGIC =====

/**
 * Get comprehensive profit metrics with filtering
 */
export async function getProfitMetrics(params: ProfitMetricsParams & { skipGrowthCalculation?: boolean }): Promise<ProfitMetrics> {
  const { startDate, endDate, venueId, providerId, skipGrowthCalculation = false } = params

  logger.info('Getting profit metrics', { params })

  // Build date filter
  const dateFilter = {}
  if (startDate || endDate) {
    Object.assign(dateFilter, {
      createdAt: {
        ...(startDate && { gte: new Date(startDate) }),
        ...(endDate && { lte: new Date(endDate) }),
      },
    })
  }

  // Build venue filter
  const venueFilter = venueId
    ? {
        payment: {
          venue: { id: venueId },
        },
      }
    : {}

  // Build provider filter (through merchant account)
  const providerFilter = providerId
    ? {
        merchantAccount: {
          providerId: providerId,
        },
      }
    : {}

  // Get transaction costs with filters
  const transactionCosts = await prisma.transactionCost.findMany({
    where: {
      ...dateFilter,
      ...venueFilter,
      ...providerFilter,
    },
    include: {
      payment: {
        include: {
          venue: { select: { id: true, name: true } },
        },
      },
      merchantAccount: {
        include: {
          provider: { select: { id: true, name: true, code: true } },
        },
      },
    },
  })

  // Calculate totals
  const totalGrossProfit = transactionCosts.reduce((sum, cost) => sum + Number(cost.grossProfit), 0)
  const totalProviderCosts = transactionCosts.reduce(
    (sum, cost) => sum + Number(cost.providerCostAmount) + Number(cost.providerFixedFee),
    0,
  )
  const totalVenueCharges = transactionCosts.reduce((sum, cost) => sum + Number(cost.venueChargeAmount) + Number(cost.venueFixedFee), 0)
  const averageProfitMargin =
    transactionCosts.length > 0 ? transactionCosts.reduce((sum, cost) => sum + Number(cost.profitMargin), 0) / transactionCosts.length : 0
  const transactionCount = transactionCosts.length

  // Calculate growth (compare with previous period) - skip if flag is set to prevent recursion
  const profitGrowth = skipGrowthCalculation ? 0 : await calculateProfitGrowth(params, totalGrossProfit)

  // Get top providers
  const topProviders = calculateTopProviders(transactionCosts)

  // Get top venues
  const topVenues = calculateTopVenues(transactionCosts)

  return {
    totalGrossProfit,
    totalProviderCosts,
    totalVenueCharges,
    averageProfitMargin,
    transactionCount,
    profitGrowth,
    topProviders,
    topVenues,
  }
}

/**
 * Get monthly profit summaries
 */
export async function getMonthlyProfits(params: MonthlyProfitParams) {
  const { startDate, endDate, venueId, status } = params

  logger.info('Getting monthly profits', { params })

  const whereClause: any = {}

  if (startDate || endDate) {
    whereClause.OR = []
    if (startDate) {
      const startYear = new Date(startDate).getFullYear()
      const startMonth = new Date(startDate).getMonth() + 1
      whereClause.OR.push({
        AND: [{ year: { gte: startYear } }, { month: { gte: startMonth } }],
      })
    }
    if (endDate) {
      const endYear = new Date(endDate).getFullYear()
      const endMonth = new Date(endDate).getMonth() + 1
      whereClause.OR.push({
        AND: [{ year: { lte: endYear } }, { month: { lte: endMonth } }],
      })
    }
  }

  if (venueId) {
    whereClause.venueId = venueId
  }

  if (status) {
    whereClause.status = status as ProfitStatus
  }

  return await prisma.monthlyVenueProfit.findMany({
    where: whereClause,
    include: {
      venue: {
        select: { id: true, name: true },
      },
    },
    orderBy: [{ year: 'desc' }, { month: 'desc' }, { venue: { name: 'asc' } }],
  })
}

/**
 * Get cost structure analysis by provider
 */
export async function getCostStructureAnalysis(): Promise<CostStructureAnalysis[]> {
  logger.info('Getting cost structure analysis')

  const providers = await prisma.paymentProvider.findMany({
    where: { active: true },
    include: {
      merchants: {
        include: {
          costStructures: {
            where: { active: true },
            orderBy: { effectiveFrom: 'desc' },
            take: 1,
          },
        },
      },
    },
  })

  const analysis: CostStructureAnalysis[] = []

  for (const provider of providers) {
    const merchantAccounts = []

    for (const merchant of provider.merchants) {
      const currentCost = merchant.costStructures[0]
      if (!currentCost) continue

      // Get transaction volume for this merchant account
      const transactionStats = await prisma.transactionCost.aggregate({
        where: {
          merchantAccountId: merchant.id,
          createdAt: { gte: subDays(new Date(), 30) }, // Last 30 days
        },
        _sum: {
          amount: true,
          providerCostAmount: true,
          providerFixedFee: true,
        },
      })

      merchantAccounts.push({
        id: merchant.id,
        alias: merchant.alias || merchant.externalMerchantId,
        externalMerchantId: merchant.externalMerchantId,
        currentCosts: {
          debitRate: Number(currentCost.debitRate),
          creditRate: Number(currentCost.creditRate),
          amexRate: Number(currentCost.amexRate),
          internationalRate: Number(currentCost.internationalRate),
          fixedCostPerTransaction: Number(currentCost.fixedCostPerTransaction || 0),
          monthlyFee: Number(currentCost.monthlyFee || 0),
          effectiveFrom: currentCost.effectiveFrom.toISOString(),
          effectiveTo: currentCost.effectiveTo?.toISOString(),
        },
        transactionVolume: Number(transactionStats._sum.amount || 0),
        totalCosts: Number(transactionStats._sum.providerCostAmount || 0) + Number(transactionStats._sum.providerFixedFee || 0),
        lastUpdated: currentCost.updatedAt.toISOString(),
      })
    }

    if (merchantAccounts.length > 0) {
      analysis.push({
        providerId: provider.id,
        providerName: provider.name,
        providerCode: provider.code,
        merchantAccounts,
      })
    }
  }

  return analysis
}

/**
 * Get detailed transaction costs
 */
export async function getTransactionCosts(params: TransactionCostParams) {
  const { startDate, endDate, venueId, providerId, transactionType, limit = 50, offset = 0 } = params

  logger.info('Getting transaction costs', { params })

  const whereClause: any = {}

  // Date filter
  if (startDate || endDate) {
    whereClause.createdAt = {
      ...(startDate && { gte: new Date(startDate) }),
      ...(endDate && { lte: new Date(endDate) }),
    }
  }

  // Venue filter
  if (venueId) {
    whereClause.payment = {
      venue: { id: venueId },
    }
  }

  // Provider filter
  if (providerId) {
    whereClause.merchantAccount = {
      providerId: providerId,
    }
  }

  // Transaction type filter
  if (transactionType) {
    whereClause.transactionType = transactionType as TransactionCardType
  }

  const [transactionCosts, total] = await Promise.all([
    prisma.transactionCost.findMany({
      where: whereClause,
      include: {
        payment: {
          include: {
            order: { select: { orderNumber: true } },
            venue: { select: { id: true, name: true } },
          },
        },
        merchantAccount: {
          include: {
            provider: { select: { id: true, name: true, code: true } },
          },
        },
      },
      // `id` is the TIEBREAK — without it a tie group crossing a skip/take page boundary repeats a row
      // on one page and drops another for good (Asana 1217127206664238).
      // TransactionCost rows are written per-payment in batches, so ties are real here.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit,
    }),
    prisma.transactionCost.count({ where: whereClause }),
  ])

  // Calculate summary statistics
  const totalProfit = transactionCosts.reduce((sum, cost) => sum + Number(cost.grossProfit), 0)
  const averageMargin =
    transactionCosts.length > 0 ? transactionCosts.reduce((sum, cost) => sum + Number(cost.profitMargin), 0) / transactionCosts.length : 0

  return {
    data: transactionCosts.map(cost => ({
      id: cost.id,
      paymentId: cost.paymentId,
      orderNumber: cost.payment?.order?.orderNumber,
      venueId: cost.payment?.venue?.id,
      venueName: cost.payment?.venue?.name,
      merchantAccountId: cost.merchantAccountId,
      providerName: cost.merchantAccount?.provider?.name,
      transactionType: cost.transactionType,
      amount: Number(cost.amount),
      providerRate: Number(cost.providerRate),
      providerCostAmount: Number(cost.providerCostAmount),
      providerFixedFee: Number(cost.providerFixedFee),
      venueRate: Number(cost.venueRate),
      venueChargeAmount: Number(cost.venueChargeAmount),
      venueFixedFee: Number(cost.venueFixedFee),
      grossProfit: Number(cost.grossProfit),
      profitMargin: Number(cost.profitMargin),
      createdAt: cost.createdAt.toISOString(),
    })),
    total,
    totalProfit,
    averageMargin,
  }
}

/**
 * Recalculate profits for a specific period
 */
export async function recalculateProfits(params: { startDate: string; endDate: string; venueId?: string }) {
  const { startDate, endDate, venueId } = params

  logger.info('Recalculating profits', { params })

  let processedTransactions = 0
  let calculatedProfits = 0
  const errors: string[] = []

  try {
    // Get all payments in the date range
    const payments = await prisma.payment.findMany({
      where: {
        createdAt: {
          gte: new Date(startDate),
          lte: new Date(endDate),
        },
        ...(venueId && { venueId }),
        status: 'COMPLETED',
      },
      include: {
        venue: true,
      },
    })

    for (const payment of payments) {
      try {
        // Check if transaction cost already exists
        const existingCost = await prisma.transactionCost.findUnique({
          where: { paymentId: payment.id },
        })

        if (existingCost) {
          // Skip already calculated
          continue
        }

        // Here you would implement the cost calculation logic
        // This is a placeholder - you'd use the actual calculation service
        processedTransactions++
        calculatedProfits++
      } catch (error) {
        logger.error('Error calculating cost for payment', {
          paymentId: payment.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        })
        errors.push(`Payment ${payment.id}: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    // Generate monthly summaries for affected months
    await generateMonthlySummaries(startDate, endDate, venueId)

    return {
      processedTransactions,
      calculatedProfits,
      errors,
    }
  } catch (error) {
    logger.error('Error in profit recalculation', { error: error instanceof Error ? error.message : 'Unknown error' })
    throw error
  }
}

// ===== HELPER FUNCTIONS =====

/**
 * Calculate profit growth compared to previous period
 */
async function calculateProfitGrowth(params: ProfitMetricsParams, currentProfit: number): Promise<number> {
  if (!params.startDate || !params.endDate) {
    return 0
  }

  try {
    const start = new Date(params.startDate)
    const end = new Date(params.endDate)
    const periodLength = end.getTime() - start.getTime()

    const prevStart = new Date(start.getTime() - periodLength)
    const prevEnd = new Date(start.getTime())

    const prevParams = {
      ...params,
      startDate: prevStart.toISOString().split('T')[0],
      endDate: prevEnd.toISOString().split('T')[0],
      skipGrowthCalculation: true, // Prevent infinite recursion
    }

    const prevMetrics = await getProfitMetrics(prevParams)
    const prevProfit = prevMetrics.totalGrossProfit

    if (prevProfit === 0) return 0

    return (currentProfit - prevProfit) / prevProfit
  } catch (error) {
    logger.error('Error calculating profit growth', { error })
    return 0
  }
}

/**
 * Calculate top providers by cost
 */
function calculateTopProviders(transactionCosts: any[]): ProviderProfitSummary[] {
  const providerMap = new Map()

  for (const cost of transactionCosts) {
    const provider = cost.merchantAccount?.provider
    if (!provider) continue

    const key = provider.id
    if (!providerMap.has(key)) {
      providerMap.set(key, {
        providerId: provider.id,
        providerName: provider.name,
        providerCode: provider.code,
        totalCosts: 0,
        totalTransactions: 0,
        totalRate: 0,
      })
    }

    const entry = providerMap.get(key)
    entry.totalCosts += Number(cost.providerCostAmount) + Number(cost.providerFixedFee)
    entry.totalTransactions += 1
    entry.totalRate += Number(cost.providerRate)
  }

  const totalCosts = Array.from(providerMap.values()).reduce((sum, p) => sum + p.totalCosts, 0)

  return Array.from(providerMap.values())
    .map(provider => ({
      ...provider,
      averageRate: provider.totalTransactions > 0 ? provider.totalRate / provider.totalTransactions : 0,
      share: totalCosts > 0 ? provider.totalCosts / totalCosts : 0,
    }))
    .sort((a, b) => b.totalCosts - a.totalCosts)
    .slice(0, 10)
}

/**
 * Calculate top venues by profit
 */
function calculateTopVenues(transactionCosts: any[]): VenueProfitSummary[] {
  const venueMap = new Map()

  for (const cost of transactionCosts) {
    const venue = cost.payment?.venue
    if (!venue) continue

    const key = venue.id
    if (!venueMap.has(key)) {
      venueMap.set(key, {
        venueId: venue.id,
        venueName: venue.name,
        totalProfit: 0,
        totalVolume: 0,
        transactionCount: 0,
        totalMargin: 0,
      })
    }

    const entry = venueMap.get(key)
    entry.totalProfit += Number(cost.grossProfit)
    entry.totalVolume += Number(cost.amount)
    entry.transactionCount += 1
    entry.totalMargin += Number(cost.profitMargin)
  }

  return Array.from(venueMap.values())
    .map(venue => ({
      ...venue,
      profitMargin: venue.transactionCount > 0 ? venue.totalMargin / venue.transactionCount : 0,
      growth: 0, // TODO: Calculate growth vs previous period
    }))
    .sort((a, b) => b.totalProfit - a.totalProfit)
    .slice(0, 10)
}

/**
 * Generate monthly summaries for affected periods
 */
async function generateMonthlySummaries(startDate: string, endDate: string, venueId?: string): Promise<void> {
  const start = new Date(startDate)
  const end = new Date(endDate)

  const months = []
  const current = new Date(start.getFullYear(), start.getMonth(), 1)

  while (current <= end) {
    months.push({
      year: current.getFullYear(),
      month: current.getMonth() + 1,
    })
    current.setMonth(current.getMonth() + 1)
  }

  for (const { year, month } of months) {
    // Generate monthly summary logic here
    // This would aggregate transaction costs by venue and month
    logger.info('Generating monthly summary', { year, month, venueId })
  }
}

// ===== GUARDAR TARIFA O COSTO DESDE LAS TARJETAS DEL PANEL (hz:nube0000:naeba3d5) =====

export const TEXTO_VIGENCIA_FUTURA =
  'Esta pantalla aplica el cambio desde hoy: deja «Vigente desde» vacío o pon una fecha que ya pasó. Para programar una fecha futura usa la pantalla de tarifas.'
export const TEXTO_VERSION_QUE_YA_RIGIO =
  'Ya hay una versión que empezó ese día y ya rigió; no se cambió nada. Para cambiarla desde hoy deja «Vigente desde» vacío.'

/** Lo que se usa de `tx.venuePricingStructure` / `tx.providerCostStructure` (los dos tienen la misma forma de vigencia). */
type DelegadoDeVersiones = {
  findFirst(args: any): Promise<any>
  updateMany(args: any): Promise<unknown>
  update(args: any): Promise<any>
  create(args: any): Promise<any>
}

/** Hoy en México como lo manda el panel ('YYYY-MM-DD'), leído como lo lee esta ruta (medianoche UTC). */
function hoyDelPanel(ahora: Date): Date {
  return new Date(ahora.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }))
}

/** El instante en que empezó hoy en México. */
function inicioDeHoyEnMexico(ahora: Date): Date {
  return fromZonedTime(`${ahora.toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' })}T00:00:00.000`, 'America/Mexico_City')
}

/**
 * Una versión de la tarifa del negocio (o del costo de la cuenta) guardada desde las tarjetas del panel del superadmin.
 *
 * Antes se apagaba la vigente y DESPUÉS se creaba la nueva, sin transacción: si la nueva fallaba (la misma fecha que enseña
 * la tarjeta ⇒ llave única; el costo, siempre, por un campo inexistente en su `include`), la posición se quedaba SIN tarifa;
 * y una fecha futura la dejaba sin tarifa hasta ese día. Ahora, en UNA transacción y en fila (candado por alcance):
 * - fecha futura ⇒ 400 y no se apaga nada (para programar está la pantalla de tarifas; Codex r1 #5 y #8: sin dos vigentes);
 * - la misma fecha que una versión de HOY ⇒ se corrige esa versión; de un día que ya pasó ⇒ 409: no se reescribe lo que ya
 *   rigió (Codex r1 #7);
 * - si no ⇒ se apagan las demás vigentes (como siempre) y se crea la nueva.
 * 'YYYY-MM-DD' se sigue leyendo como medianoche UTC (como siempre): «hoy en México» siempre rige al instante. «Futura» se
 * mide por CALENDARIO de México (Codex r2 #2: a las 20:00 del 17 la fecha 18 ya empezó en UTC, pero es mañana).
 * El IVA (`includesTax`/`taxRate`) que no venga se hereda de la tarifa (o costo) que el COBRO usa hoy, con el mismo lector
 * (Codex r1 #9 y r2 #4: también la heredada de la organización; nunca una vencida).
 * Con fecha de fin ⇒ 400 (Codex r2 #3, r4 #4, r5 #3): la nueva apagaría la vigente y dejaría la posición sin tarifa al vencer.
 * ponytail: el candado pone en fila los guardados de ESTAS tarjetas; las pantallas de tarifas y de costos tienen sus propios
 * escritores (ver la deuda del 17-nov).
 */
async function guardarVersionDelPanel(
  tx: Prisma.TransactionClient,
  delegado: DelegadoDeVersiones,
  v: {
    alcance: Record<string, string>
    /** Candado de la fila padre (negocio o cuenta) en el MISMO orden que la limpieza del demo: padre y luego versiones. */
    padre: Prisma.Sql
    candado: string
    datos: Record<string, any>
    include: Record<string, unknown>
    /** La versión que el COBRO usa a esa hora (para heredar su IVA). */
    leerVigente: (ahora: Date) => Promise<{ includesTax: boolean | null; taxRate: unknown } | null>
  },
  ahoraFijo?: Date,
) {
  // Codex r3 #4: primero el padre (la limpieza del demo toma negocio/cuenta antes que sus versiones; al revés se trababan).
  await tx.$queryRaw(v.padre)
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${v.candado}, 0))::text`
  // Codex r3 #3: la hora se toma YA en fila (una espera larga no deja validar con un reloj viejo).
  const ahora = ahoraFijo ?? new Date()

  const { effectiveFrom, effectiveTo, includesTax, taxRate, ...resto } = v.datos
  const desde = new Date(effectiveFrom)
  if (Number.isNaN(desde.getTime())) throw new BadRequestError('La fecha de inicio de vigencia no es válida')
  const soloFecha = typeof effectiveFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)
  if (desde > (soloFecha ? hoyDelPanel(ahora) : ahora)) throw new BadRequestError(TEXTO_VIGENCIA_FUTURA, 'VIGENCIA_FUTURA')
  // Codex r2 #3, r4 #4 y r5 #3: con fecha de fin, la versión nueva apaga la vigente y deja la posición SIN tarifa cuando vence (o
  // ya nace vencida). Las tarjetas nunca la mandan; para una vigencia con fin está la pantalla de tarifas.
  if (effectiveTo) {
    throw new BadRequestError('Esta pantalla no pone fecha de fin: guarda sin ella o usa la pantalla de tarifas.', 'VIGENCIA_CON_FIN')
  }

  // Misma fecha EXACTA (Codex r5 #1 y #2: buscar por día UTC reactivaba versiones apagadas o reescribía la que rigió ayer en
  // México). Una versión guardada con hora (alta de AngelPay) no choca: se crea otra desde esa medianoche (ver la deuda).
  // Se corrige en su lugar sólo la versión que empieza hoy, se guardó hoy en México y SIGUE vigente: la de medianoche UTC
  // guardada ayer en la noche ya rigió desde las 18:00 de ayer (Codex r6), y una que otro guardado ya apagó rigió un rato y no
  // se reactiva reescrita (Codex r7).
  const misma = await delegado.findFirst({
    where: { ...v.alcance, effectiveFrom: desde },
    select: { id: true, createdAt: true, active: true },
  })
  const esLaDeHoy =
    misma && misma.active && desde.getTime() === hoyDelPanel(ahora).getTime() && misma.createdAt >= inicioDeHoyEnMexico(ahora)
  if (misma && !esLaDeHoy) throw new ConflictError(TEXTO_VERSION_QUE_YA_RIGIO, 'VERSION_QUE_YA_RIGIO')

  const vigente = await v.leerVigente(ahora)
  await delegado.updateMany({
    where: { ...v.alcance, active: true, ...(misma ? { id: { not: misma.id } } : {}) },
    data: { active: false, effectiveTo: ahora },
  })
  const fila = {
    // Codex r3 #2: lo que la tarjeta no manda (un cargo que borró) queda vacío también al corregir en su lugar, como al crear.
    ...Object.fromEntries(Object.entries(resto).map(([campo, valor]) => [campo, valor === undefined ? null : valor])),
    includesTax: includesTax !== undefined ? includesTax : (vigente?.includesTax ?? null),
    ...(taxRate !== undefined ? { taxRate } : vigente?.taxRate != null ? { taxRate: vigente.taxRate } : {}),
    effectiveTo: null,
    active: true,
  }
  return misma
    ? delegado.update({ where: { id: misma.id }, data: fila, include: v.include })
    : delegado.create({ data: { ...v.alcance, ...fila, effectiveFrom: desde }, include: v.include })
}

/** `POST /dashboard/superadmin/pricing-structures/venue` (tarjeta de tarifa del panel). */
export async function guardarTarifaDelNegocio(d: Record<string, any>, staffId?: string | null, ahora?: Date) {
  const fila = await prisma.$transaction(tx =>
    guardarVersionDelPanel(
      tx,
      tx.venuePricingStructure,
      {
        alcance: { venueId: d.venueId, accountType: d.accountType },
        padre: Prisma.sql`SELECT 1 FROM "Venue" WHERE id = ${d.venueId} FOR KEY SHARE`,
        candado: `version-de-tarifa:${d.venueId}:${d.accountType}`,
        datos: {
          debitRate: d.debitRate,
          creditRate: d.creditRate,
          amexRate: d.amexRate,
          internationalRate: d.internationalRate,
          includesTax: d.includesTax,
          taxRate: d.taxRate,
          fixedFeePerTransaction: d.fixedFeePerTransaction,
          monthlyServiceFee: d.monthlyServiceFee,
          minimumMonthlyVolume: d.minimumMonthlyVolume,
          volumePenalty: d.volumePenalty,
          effectiveFrom: d.effectiveFrom,
          effectiveTo: d.effectiveTo,
          contractReference: d.contractReference,
          notes: d.notes,
        },
        include: { venue: { select: { id: true, name: true, slug: true } } },
        leerVigente: async en => (await getEffectivePricingForSlot(d.venueId, d.accountType, en, tx))?.pricing[0] ?? null,
      },
      ahora,
    ),
  )
  await logAction({
    staffId: staffId ?? null,
    venueId: d.venueId,
    action: 'VENUE_PRICING_SAVED',
    entity: 'VenuePricingStructure',
    entityId: fila.id,
    data: {
      accountType: d.accountType,
      effectiveFrom: fila.effectiveFrom,
      debitRate: d.debitRate,
      creditRate: d.creditRate,
      amexRate: d.amexRate,
      internationalRate: d.internationalRate,
      includesTax: fila.includesTax,
    },
  })
  return fila
}

/** `POST /dashboard/superadmin/cost-structures/provider` (tarjeta de costo del panel). */
export async function guardarCostoDeLaCuenta(d: Record<string, any>, staffId?: string | null, ahora?: Date) {
  const fila = await prisma.$transaction(tx =>
    guardarVersionDelPanel(
      tx,
      tx.providerCostStructure,
      {
        alcance: { merchantAccountId: d.merchantAccountId },
        padre: Prisma.sql`SELECT 1 FROM "MerchantAccount" WHERE id = ${d.merchantAccountId} FOR KEY SHARE`,
        candado: `version-de-costo:${d.merchantAccountId}`,
        datos: {
          providerId: d.providerId,
          debitRate: d.debitRate,
          creditRate: d.creditRate,
          amexRate: d.amexRate,
          internationalRate: d.internationalRate,
          includesTax: d.includesTax,
          taxRate: d.taxRate,
          fixedCostPerTransaction: d.fixedCostPerTransaction,
          monthlyFee: d.monthlyFee,
          minimumVolume: d.minimumVolume,
          volumeDiscount: d.volumeDiscount,
          effectiveFrom: d.effectiveFrom,
          effectiveTo: d.effectiveTo,
          proposalReference: d.proposalReference,
          notes: d.notes,
        },
        // Sin `merchantAccount.ecommerceMerchantId`: la cuenta no tiene ese campo y Prisma rechazaba el guardado SIEMPRE.
        include: { provider: { select: { id: true, name: true, code: true } }, merchantAccount: { select: { id: true, alias: true } } },
        leerVigente: en => findActiveProviderCostStructure(d.merchantAccountId, en, tx),
      },
      ahora,
    ),
  )
  await logAction({
    staffId: staffId ?? null,
    action: 'PROVIDER_COST_SAVED',
    entity: 'ProviderCostStructure',
    entityId: fila.id,
    data: {
      merchantAccountId: d.merchantAccountId,
      effectiveFrom: fila.effectiveFrom,
      debitRate: d.debitRate,
      creditRate: d.creditRate,
      amexRate: d.amexRate,
      internationalRate: d.internationalRate,
      includesTax: fila.includesTax,
    },
  })
  return fila
}
