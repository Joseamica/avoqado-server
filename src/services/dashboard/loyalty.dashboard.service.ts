/**
 * Loyalty Program Service (HTTP-Agnostic Business Logic)
 *
 * WHY: Reward customers with points for purchases, increase retention, drive repeat business.
 *
 * DESIGN DECISION: Points-based loyalty system with configurable earn/redeem rates per venue.
 * - Customers earn points on every purchase (e.g., 1 point per $1 spent)
 * - Points can be redeemed for discounts (e.g., 100 points = $1 discount)
 * - Points can expire after configurable period (e.g., 1 year)
 * - Staff can manually adjust points (corrections, bonuses, penalties)
 *
 * PATTERN: Thin Controller + Fat Service Architecture
 * - This service contains ALL business logic
 * - Controllers only orchestrate HTTP (extract params, call service, return response)
 * - Services know NOTHING about Express (req, res, next)
 *
 * CRITICAL: All loyalty operations are scoped to venueId for multi-tenant isolation.
 */

import { BadRequestError, NotFoundError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'
import { StampRewardType, LoyaltyTransactionType } from '@prisma/client'
import logger from '@/config/logger'
import { logAction } from './activity-log.service'
import { grantStamp } from '../wallet/stampLedger.service'

/**
 * Get or create loyalty configuration for a venue
 * Creates default config if none exists
 */
export async function getOrCreateLoyaltyConfig(venueId: string) {
  let config = await prisma.loyaltyConfig.findUnique({
    where: { venueId },
  })

  // Create default config if none exists
  if (!config) {
    config = await prisma.loyaltyConfig.create({
      data: {
        venueId,
        pointsPerDollar: 1, // 1 point per $1 spent
        pointsPerVisit: 0, // No bonus per visit
        redemptionRate: 0.01, // 100 points = $1 discount (1 point = $0.01)
        minPointsRedeem: 100, // Minimum 100 points to redeem
        pointsExpireDays: 365, // Points expire after 1 year
        active: true,
      },
    })
  }

  return {
    ...config,
    pointsPerDollar: config.pointsPerDollar.toNumber(),
    redemptionRate: config.redemptionRate.toNumber(),
  }
}

/**
 * Get loyalty configuration for a venue
 */
export async function getLoyaltyConfig(venueId: string) {
  return getOrCreateLoyaltyConfig(venueId)
}

/**
 * Update loyalty configuration for a venue
 */
export async function updateLoyaltyConfig(
  venueId: string,
  data: {
    pointsPerDollar?: number
    pointsPerVisit?: number
    redemptionRate?: number
    minPointsRedeem?: number
    pointsExpireDays?: number | null
    active?: boolean
    // --- Programa de sellos (la tarjeta de la cartera) ---
    stampsEnabled?: boolean
    stampsRequired?: number
    maxStampsPerDay?: number
    stampRewardType?: StampRewardType
    stampRewardValue?: number | null
    stampRewardProductId?: string | null
    stampRewardLabel?: string
  },
) {
  // Validate inputs
  if (data.pointsPerDollar !== undefined && data.pointsPerDollar < 0) {
    throw new BadRequestError('Points per dollar must be non-negative')
  }
  if (data.pointsPerVisit !== undefined && data.pointsPerVisit < 0) {
    throw new BadRequestError('Points per visit must be non-negative')
  }
  if (data.redemptionRate !== undefined && data.redemptionRate < 0) {
    throw new BadRequestError('Redemption rate must be non-negative')
  }
  if (data.minPointsRedeem !== undefined && data.minPointsRedeem < 0) {
    throw new BadRequestError('Minimum redemption points must be non-negative')
  }
  if (data.pointsExpireDays !== undefined && data.pointsExpireDays !== null && data.pointsExpireDays < 0) {
    throw new BadRequestError('Points expiration days must be non-negative or null')
  }

  // ── Programa de sellos ───────────────────────────────────────────────────
  // Estos campos deciden CUÁNTO SE REGALA, así que se validan aquí y no sólo en la
  // pantalla: el MCP y cualquier cliente futuro entran por este mismo camino.
  const MIN_SELLOS = 2
  const MAX_SELLOS = 50

  if (data.stampsRequired !== undefined) {
    if (!Number.isInteger(data.stampsRequired) || data.stampsRequired < MIN_SELLOS) {
      // Una cartilla de 1 sello regala en CADA compra; de 0 rompe el cálculo del avance.
      throw new BadRequestError(`La cartilla necesita al menos ${MIN_SELLOS} sellos`)
    }
    if (data.stampsRequired > MAX_SELLOS) {
      throw new BadRequestError(`La cartilla no puede pedir más de ${MAX_SELLOS} sellos`)
    }
  }
  if (data.maxStampsPerDay !== undefined && (!Number.isInteger(data.maxStampsPerDay) || data.maxStampsPerDay < 1)) {
    throw new BadRequestError('El tope de sellos por día debe ser al menos 1')
  }

  // Ensure config exists
  const configActual = await getOrCreateLoyaltyConfig(venueId)

  // El premio sólo se exige completo cuando el programa QUEDA ENCENDIDO. Apagar nunca
  // se bloquea: si no, una configuración a medias dejaría al negocio atrapado sin poder
  // desactivar lo que ya está prendido.
  const quedaEncendido = data.stampsEnabled ?? configActual.stampsEnabled
  if (quedaEncendido) {
    const tipo = data.stampRewardType ?? configActual.stampRewardType
    const crudo = data.stampRewardValue !== undefined ? data.stampRewardValue : configActual.stampRewardValue
    const valor = crudo === null || crudo === undefined ? null : Number(crudo)

    if (tipo === StampRewardType.PERCENTAGE) {
      if (valor === null || !(valor > 0)) {
        throw new BadRequestError('Un premio de porcentaje necesita un porcentaje mayor a 0')
      }
      if (valor > 100) {
        throw new BadRequestError('El porcentaje del premio no puede pasar de 100')
      }
    }
    if (tipo === StampRewardType.FIXED_AMOUNT && (valor === null || !(valor > 0))) {
      throw new BadRequestError('Un premio de monto fijo necesita un monto mayor a 0')
    }
  }

  // Aislamiento: el producto del premio tiene que ser de ESTE negocio. Sin esto, un id
  // de otro venue se guardaría sin ruido y el premio apuntaría fuera del catálogo.
  if (data.stampRewardProductId) {
    const producto = await prisma.product.findFirst({
      where: { id: data.stampRewardProductId, venueId },
      select: { id: true },
    })
    if (!producto) {
      throw new BadRequestError('El producto del premio no pertenece a este negocio')
    }
  }

  const config = await prisma.loyaltyConfig.update({
    where: { venueId },
    data,
  })

  logAction({
    venueId,
    action: 'LOYALTY_CONFIG_UPDATED',
    entity: 'LoyaltyConfig',
    entityId: venueId,
    data: {
      active: config.active,
      // Prender los sellos o cambiar el premio es lo que un dueño audita después
      // ("¿quién puso 3 sellos en vez de 10?"), así que va al registro.
      ...(data.stampsEnabled !== undefined ? { stampsEnabled: config.stampsEnabled } : {}),
      ...(data.stampsRequired !== undefined ? { stampsRequired: config.stampsRequired } : {}),
      ...(data.stampRewardType !== undefined ? { stampRewardType: config.stampRewardType } : {}),
      ...(data.stampRewardValue !== undefined ? { stampRewardValue: Number(config.stampRewardValue ?? 0) } : {}),
      ...(data.stampRewardLabel !== undefined ? { stampRewardLabel: config.stampRewardLabel } : {}),
    },
  })

  return {
    ...config,
    pointsPerDollar: config.pointsPerDollar.toNumber(),
    redemptionRate: config.redemptionRate.toNumber(),
  }
}

/**
 * Calculate how many points a customer earns for a purchase amount
 */
export async function calculatePointsForAmount(venueId: string, amount: number): Promise<number> {
  const config = await getOrCreateLoyaltyConfig(venueId)

  if (!config.active) {
    return 0
  }

  // Calculate points: amount * pointsPerDollar
  const points = Math.floor(amount * config.pointsPerDollar)

  return points
}

/**
 * Calculate discount value from points
 */
export async function calculateDiscountFromPoints(venueId: string, points: number, orderTotal: number): Promise<number> {
  const config = await getOrCreateLoyaltyConfig(venueId)

  if (!config.active || points < config.minPointsRedeem) {
    return 0
  }

  // Calculate discount: points * redemptionRate
  const discount = points * config.redemptionRate

  // Cap discount at order total (can't be more than the order)
  const finalDiscount = Math.min(discount, orderTotal)

  // Round to 2 decimals
  return Math.round(finalDiscount * 100) / 100
}

/**
 * Get customer's current loyalty points balance
 */
export async function getCustomerPointsBalance(venueId: string, customerId: string): Promise<number> {
  const customer = await prisma.customer.findFirst({
    where: {
      id: customerId,
      venueId,
    },
    select: {
      loyaltyPoints: true,
    },
  })

  if (!customer) {
    throw new NotFoundError('Customer not found')
  }

  return customer.loyaltyPoints
}

/**
 * Check if customer can redeem points
 */
export async function canRedeemPoints(venueId: string, customerId: string, points: number): Promise<boolean> {
  const config = await getOrCreateLoyaltyConfig(venueId)
  const currentBalance = await getCustomerPointsBalance(venueId, customerId)

  return config.active && points >= config.minPointsRedeem && currentBalance >= points
}

/**
 * Award loyalty points to customer for a purchase
 * Called automatically when order payment is completed
 *
 * 🔒 IDEMPOTENCY: If points were already awarded for this order+customer,
 * returns the existing values without creating duplicates.
 * This prevents double-earning on payment retries.
 */
export async function earnPoints(
  venueId: string,
  customerId: string,
  amount: number,
  orderId: string,
  staffId?: string,
): Promise<{ pointsEarned: number; newBalance: number }> {
  const config = await getOrCreateLoyaltyConfig(venueId)

  if (!config.active) {
    return { pointsEarned: 0, newBalance: 0 }
  }

  // ── SELLOS (Plan B) ────────────────────────────────────────────────────────
  //
  // 🔴 Va AQUÍ, antes del chequeo de idempotencia de puntos y del `return` de
  // `pointsEarned === 0` que está más abajo.
  //
  // Un negocio que usa SELLOS y no puntos tiene `pointsPerDollar` en 0, así que
  // ese return lo sacaría de la función antes de sellar nada — y el defecto sería
  // INVISIBLE: los puntos seguirían "funcionando" (dando cero) mientras su
  // programa de sellos no arranca jamás.
  //
  // Aislado en su propio try/catch a propósito: un fallo al sellar NO puede
  // impedir que se acumulen los puntos, igual que un fallo de lealtad no impide
  // un cobro. Y `grantStamp` es no-op cuando el venue no tiene sellos habilitados
  // (nacen en `false`), así que para los venues de hoy esto no cambia nada.
  //
  // Se le pasa la config que ya tenemos: esta función corre en CADA cobro de CADA
  // negocio, y releerla serían miles de consultas diarias que no aportan nada.
  let deferredStampError: unknown
  try {
    await grantStamp(venueId, customerId, orderId, { staffVenueId: staffId, config })
  } catch (stampError: any) {
    deferredStampError = stampError
    logger.error('⚠️ Falló el sellado — los puntos siguen su curso', {
      venueId,
      customerId,
      orderId,
      error: stampError?.message,
    })
  }

  // The payment callers already isolate loyalty failures from the approved
  // charge. We therefore persist points first, then surface a stamp failure so
  // the durable paid-order reconciler can retry the missing stamp. Swallowing it
  // here would mark the order processed forever with a visibly missing reward.
  const finish = <T>(result: T): T => {
    if (deferredStampError) throw deferredStampError
    return result
  }

  // 🔒 IDEMPOTENCY CHECK: Prevent double-earning on payment retries
  const existingEarnTransaction = await prisma.loyaltyTransaction.findFirst({
    where: {
      customerId,
      orderId,
      type: LoyaltyTransactionType.EARN,
    },
  })

  if (existingEarnTransaction) {
    // Points already awarded for this order - return existing values (idempotent)
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      select: { loyaltyPoints: true },
    })
    logger.warn(`⚠️ [LOYALTY] Idempotency: Points already earned for order ${orderId}, customer ${customerId}`, {
      existingPoints: existingEarnTransaction.points,
      currentBalance: customer?.loyaltyPoints,
    })
    return finish({
      pointsEarned: existingEarnTransaction.points,
      newBalance: customer?.loyaltyPoints ?? 0,
    })
  }

  const pointsEarned = await calculatePointsForAmount(venueId, amount)

  if (pointsEarned === 0) {
    return finish({ pointsEarned: 0, newBalance: 0 })
  }

  // 🔒 RACE CONDITION FIX: Database has partial unique index to prevent duplicates
  // If concurrent calls occur, the DB will reject duplicates with P2002
  try {
    // Create transaction and update customer balance in a transaction
    const [_transaction, customer] = await prisma.$transaction([
      prisma.loyaltyTransaction.create({
        data: {
          customerId,
          type: LoyaltyTransactionType.EARN,
          points: pointsEarned,
          orderId,
          reason: `Earned ${pointsEarned} points for purchase of $${amount.toFixed(2)}`,
          createdById: staffId,
        },
      }),
      prisma.customer.update({
        where: { id: customerId },
        data: {
          loyaltyPoints: { increment: pointsEarned },
        },
        select: {
          loyaltyPoints: true,
        },
      }),
    ])

    return finish({
      pointsEarned,
      newBalance: customer.loyaltyPoints,
    })
  } catch (error: any) {
    // Handle unique constraint violation from partial unique index
    // This happens when concurrent calls race past the idempotency check
    if (error.code === 'P2002') {
      logger.warn(`⚠️ [LOYALTY] Race condition caught by DB constraint - returning existing values`, {
        customerId,
        orderId,
        attemptedPoints: pointsEarned,
      })
      // Fetch the existing transaction that won the race
      const existingTransaction = await prisma.loyaltyTransaction.findFirst({
        where: { customerId, orderId, type: LoyaltyTransactionType.EARN },
      })
      const customer = await prisma.customer.findUnique({
        where: { id: customerId },
        select: { loyaltyPoints: true },
      })
      return finish({
        pointsEarned: existingTransaction?.points ?? pointsEarned,
        newBalance: customer?.loyaltyPoints ?? 0,
      })
    }
    throw error
  }
}

/**
 * Canjea puntos por un descuento en la cuenta.
 *
 * 🔴 DINERO. Esta función QUEMABA los puntos y sólo DEVOLVÍA el monto del
 * descuento: nadie creaba el OrderDiscount, así que el saldo del cliente
 * desaparecía y la cuenta no bajaba un peso. El endpoint que la expone
 * (`POST /api/v1/dashboard/venues/:venueId/customers/:customerId/loyalty/redeem`,
 * permiso `loyalty:redeem`) está vivo en producción; lo único que evitó el daño
 * es que ninguna pantalla lo llamaba todavía — el método ya existe esperando en
 * `avoqado-web-dashboard/src/services/loyalty.service.ts`.
 *
 * Ahora delega en el ÚNICO canje que mueve las dos cosas juntas.
 * `redeemPointsToOrder` hace, en UNA transacción: crea la LoyaltyTransaction
 * REDEEM, decrementa el saldo de forma CONDICIONAL (`updateMany` con
 * `loyaltyPoints: { gte }`, que es lo que impide que dos canjes concurrentes
 * quemen los mismos puntos) y crea el OrderDiscount ligado a esa transacción
 * — ese vínculo es lo que permite devolver los puntos si el descuento se quita.
 * Además topa el descuento contra la BASE (subtotal − descuentos) y no contra
 * el total, que incluye cargos por servicio que un descuento no compensa.
 *
 * No se duplican aquí las validaciones (programa activo, saldo, mínimo, orden
 * ya pagada): viven en el delegado. Un segundo juego de reglas es exactamente
 * cómo nacieron estos dos caminos divergentes.
 *
 * Import dinámico a propósito: `loyalty.mobile.service` importa
 * `getOrCreateLoyaltyConfig` de este archivo, así que un import estático cierra
 * un ciclo. Mismo patrón que ya usa `order.mobile.service`.
 *
 * 🔴 `staffId` tiene que ser un **Staff.id**, NO un StaffVenue.id: el delegado
 * resuelve la fila de StaffVenue por su cuenta. Pasarle un StaffVenue.id no
 * revienta — devuelve undefined y pierde la atribución en silencio.
 */
export async function redeemPoints(venueId: string, customerId: string, points: number, orderId: string, staffId?: string) {
  const { redeemPointsToOrder } = await import('../mobile/loyalty.mobile.service')
  return redeemPointsToOrder(venueId, orderId, customerId, points, staffId)
}

/**
 * Manual point adjustment by staff (corrections, bonuses, penalties)
 */
export async function adjustPoints(
  venueId: string,
  customerId: string,
  points: number,
  reason: string,
  staffId: string,
): Promise<{ newBalance: number }> {
  // Validate customer exists and belongs to venue
  const customer = await prisma.customer.findFirst({
    where: {
      id: customerId,
      venueId,
    },
  })

  if (!customer) {
    throw new NotFoundError('Customer not found')
  }

  // Check that adjustment won't result in negative balance
  const newBalance = customer.loyaltyPoints + points
  if (newBalance < 0) {
    throw new BadRequestError(`Cannot adjust points. Would result in negative balance (${newBalance})`)
  }

  // Create transaction and update balance
  const [_transaction, updatedCustomer] = await prisma.$transaction([
    prisma.loyaltyTransaction.create({
      data: {
        customerId,
        type: LoyaltyTransactionType.ADJUST,
        points,
        reason,
        createdById: staffId,
      },
    }),
    prisma.customer.update({
      where: { id: customerId },
      data: {
        loyaltyPoints: { increment: points },
      },
      select: {
        loyaltyPoints: true,
      },
    }),
  ])

  logAction({
    staffId,
    venueId,
    action: 'LOYALTY_POINTS_ADJUSTED',
    entity: 'Customer',
    entityId: customerId,
    data: { points, newBalance: updatedCustomer.loyaltyPoints },
  })

  return {
    newBalance: updatedCustomer.loyaltyPoints,
  }
}

/**
 * Get loyalty transaction history for a customer
 */
export async function getLoyaltyTransactions(
  venueId: string,
  customerId: string,
  options: {
    page?: number
    pageSize?: number
    type?: LoyaltyTransactionType
  } = {},
) {
  // Validate customer belongs to venue
  const customer = await prisma.customer.findFirst({
    where: {
      id: customerId,
      venueId,
    },
  })

  if (!customer) {
    throw new NotFoundError('Customer not found')
  }

  const page = options.page || 1
  const pageSize = options.pageSize || 20
  const skip = (page - 1) * pageSize

  const whereCondition: any = {
    customerId,
  }

  if (options.type) {
    whereCondition.type = options.type
  }

  const [transactions, totalCount] = await prisma.$transaction([
    prisma.loyaltyTransaction.findMany({
      where: whereCondition,
      skip,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            total: true,
            createdAt: true,
          },
        },
        createdBy: {
          select: {
            id: true,
            staff: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        },
      },
    }),
    prisma.loyaltyTransaction.count({ where: whereCondition }),
  ])

  const totalPages = Math.ceil(totalCount / pageSize)

  return {
    data: transactions.map((t: any) => ({
      id: t.id,
      customerId: t.customerId,
      type: t.type,
      points: t.points,
      reason: t.reason,
      orderId: t.orderId,
      createdById: t.createdById,
      createdAt: t.createdAt,
      order: t.order
        ? {
            id: t.order.id,
            orderNumber: t.order.orderNumber,
            total: t.order.total.toNumber(),
            createdAt: t.order.createdAt,
          }
        : null,
      createdBy: t.createdBy?.staff
        ? {
            id: t.createdBy.staff.id,
            name: `${t.createdBy.staff.firstName || ''} ${t.createdBy.staff.lastName || ''}`.trim(),
          }
        : null,
    })),
    meta: {
      totalCount,
      pageSize,
      currentPage: page,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
    currentBalance: customer.loyaltyPoints,
  }
}

/**
 * Expire old loyalty points based on config
 * Should be run periodically (e.g., daily cron job)
 */
export async function expireOldPoints(venueId: string): Promise<{ customersAffected: number; pointsExpired: number }> {
  const config = await getOrCreateLoyaltyConfig(venueId)

  if (!config.active || !config.pointsExpireDays) {
    return { customersAffected: 0, pointsExpired: 0 }
  }

  const expirationDate = new Date()
  expirationDate.setDate(expirationDate.getDate() - config.pointsExpireDays)

  // Find all EARN transactions older than expiration date
  const oldTransactions = await prisma.loyaltyTransaction.findMany({
    where: {
      customer: {
        venueId,
      },
      type: LoyaltyTransactionType.EARN,
      createdAt: { lt: expirationDate },
    },
    include: {
      customer: {
        select: {
          id: true,
          loyaltyPoints: true,
        },
      },
    },
  })

  let totalPointsExpired = 0
  const affectedCustomerIds = new Set<string>()

  for (const transaction of oldTransactions) {
    const pointsToExpire = Math.min(transaction.points, transaction.customer.loyaltyPoints)

    if (pointsToExpire > 0) {
      // Create EXPIRE transaction and update customer balance
      await prisma.$transaction([
        prisma.loyaltyTransaction.create({
          data: {
            customerId: transaction.customerId,
            type: LoyaltyTransactionType.EXPIRE,
            points: -pointsToExpire,
            reason: `Expired ${pointsToExpire} points from transaction ${transaction.id} (older than ${config.pointsExpireDays} days)`,
          },
        }),
        prisma.customer.update({
          where: { id: transaction.customerId },
          data: {
            loyaltyPoints: { decrement: pointsToExpire },
          },
        }),
      ])

      totalPointsExpired += pointsToExpire
      affectedCustomerIds.add(transaction.customerId)
    }
  }

  return {
    customersAffected: affectedCustomerIds.size,
    pointsExpired: totalPointsExpired,
  }
}
