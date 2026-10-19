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
import { StampRewardType, LoyaltyTransactionType, Prisma, StampEventType } from '@prisma/client'
import logger from '@/config/logger'
import { logAction } from './activity-log.service'
import { grantStamp, type GrantStampResult } from '../wallet/stampLedger.service'
import { venueHasFeatureAccess } from '../access/basePlan.service'
import { leerSiEsCuentaDeTarjetas } from '../giftCards/giftCardMarks'

/**
 * Get or create loyalty configuration for a venue
 * Creates default config if none exists
 */
export async function getOrCreateLoyaltyConfig(venueId: string, db: Pick<Prisma.TransactionClient, 'loyaltyConfig'> = prisma) {
  let config = await db.loyaltyConfig.findUnique({
    where: { venueId },
  })

  // Create default config if none exists
  if (!config) {
    config = await db.loyaltyConfig.create({
      data: {
        venueId,
        pointsPerDollar: 1, // 1 point per $1 spent
        pointsPerVisit: 0, // No bonus per visit
        redemptionRate: 0.01, // 100 points = $1 discount (1 point = $0.01)
        minPointsRedeem: 100, // Minimum 100 points to redeem
        pointsExpireDays: 365, // Points expire after 1 year
        // Tier and activation are separate decisions. Creating/opening the
        // settings page must never silently turn on a money-valued reward.
        active: false,
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
 * 🔴 Cuarta ola (recheck 3 de Codex + re-revisión, 15-oct-2026): presupuesto EXPLÍCITO de la transacción de los puntos.
 *
 * Antes la escritura era un `$transaction([...])` por lotes: sin tope propio, sólo esperaba una conexión del pool
 * (`pool_timeout`, 10 s por defecto; ver `utils/prismaClient.ts`). Al volverse interactiva (H4, tercera ola: el candado de la
 * venta) heredaba los tiempos por defecto de Prisma —2 s para conseguir conexión, 5 s para TODO, esperas de candado
 * incluidas—, y un vencimiento (P2028) revertía el EARN y el saldo. Con un solo cliente basta una fila de saldo bloqueada por
 * otra operación. Por eso:
 *   · `maxWait` 10 s: lo mismo que el lote esperaba por una conexión (`pool_timeout`).
 *   · `timeout` 15 s: el mismo presupuesto que el repo da a las transacciones que esperan un candado
 *     (`ORDER_LOCK_WAIT_BUDGET.timeout`, `paymentShiftClaim.ts`). El trabajo de adentro son cuatro lecturas por índice y dos
 *     escrituras; lo que puede tardar es la espera del candado de la venta (otro intento de la MISMA venta) o de la fila del
 *     cliente (otro movimiento de su saldo), y ambas son cortas.
 * Lo usa también la transacción de `grantStamp`, que espera el mismo candado de la venta.
 */
export const PRESUPUESTO_DE_LA_LEALTAD_DE_LA_VENTA = { maxWait: 10_000, timeout: 15_000 } as const

/** Reintentos EXTRA de la escritura de puntos, sólo si la transacción se venció (P2028). Idempotente: ver `earnPoints`. */
const REINTENTOS_POR_VENCIMIENTO = 2

const seVencioLaTransaccion = (error: unknown): boolean => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2028'

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
): Promise<ResultadoDeEarnPoints> {
  // Paid entitlement and venue activation are BOTH required. Automatic award
  // paths must not create an active config merely because a payment happened.
  if (!(await venueHasFeatureAccess(venueId, 'LOYALTY_PROGRAM'))) {
    return { pointsEarned: 0, newBalance: 0 }
  }

  const storedConfig = await prisma.loyaltyConfig.findUnique({ where: { venueId } })
  if (!storedConfig) {
    return { pointsEarned: 0, newBalance: 0 }
  }
  const config = {
    ...storedConfig,
    pointsPerDollar: storedConfig.pointsPerDollar.toNumber(),
    redemptionRate: storedConfig.redemptionRate.toNumber(),
  }

  if (!config.active) {
    return { pointsEarned: 0, newBalance: 0 }
  }

  // R1 (tarjetas de regalo): comprar una tarjeta no da puntos ni sello. Cubre a quien llama directo (pago manual, ligas). Va después de
  // las salidas baratas: sólo los negocios con lealtad activa pagan esta lectura.
  if (await leerSiEsCuentaDeTarjetas(prisma, orderId)) return { pointsEarned: 0, newBalance: 0 }

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
  let sello: GrantStampResult | undefined
  try {
    sello = await grantStamp(venueId, customerId, orderId, { staffVenueId: staffId, config })
  } catch (stampError: any) {
    deferredStampError = stampError
    logger.error('⚠️ Falló el sellado — los puntos siguen su curso', {
      venueId,
      customerId,
      orderId,
      error: stampError?.message,
    })
  }

  // 🔴 R4-1 (ronda 4 post-QA de sellos tardíos; Codex recheck-8, P2): lo que ESTA llamada ya otorgó se conserva durante TODA
  // la ejecución y viaja colgado de CUALQUIER error posterior (`otorgadoAntesDelFallo`): las lecturas que siguen al sello (el
  // movimiento de puntos, el saldo, el cálculo que relee la config), la escritura de los puntos y la recuperación de un P2002.
  // Antes sólo dos caminos lo colgaban; si tronaba otra lectura después de sellar, el sello quedaba dado y la auditoría de la
  // liga tardía no se enteraba (cero filas en una re-liga; `otorgo: false` en una liga nueva).
  const otorgadoHastaAhora = { sello: sello?.granted === true, puntos: false }
  try {
    return await acreditarPuntosTrasElSello({
      venueId,
      customerId,
      amount,
      orderId,
      staffId,
      sello,
      deferredStampError,
      otorgadoHastaAhora,
    })
  } catch (error) {
    throw conLoOtorgado(error, otorgadoHastaAhora)
  }
}

export interface ResultadoDeEarnPoints {
  pointsEarned: number
  newBalance: number
  /**
   * 🔴 H4, tercera ola: OTRO cliente ya recibió los puntos o el sello de esta venta (dos intentos validaron a clientes
   * distintos). No se acreditó nada a éste. Sólo aparece en ese caso; los cobros de siempre no lo ven nunca.
   */
  otroCliente?: true
  /**
   * F2 (ronda 1 post-QA de sellos tardíos, 15-oct-2026): lo que ESTA llamada creó — el sello (`grantStamp` lo otorgó) y/o el
   * EARN de puntos. Sólo aparece si creó algo; un reintento idempotente no lo trae. Lo lee la auditoría de una re-liga
   * (`awardLoyaltyForLateCustomer`): audita sólo la llamada que de verdad otorgó.
   */
  otorgado?: { sello: boolean; puntos: boolean }
}

/**
 * La segunda mitad de `earnPoints`: todo lo que va DESPUÉS del sello (los puntos). Vive aparte sólo para que `earnPoints` la
 * envuelva con lo otorgado (R4-1); no se llama desde ningún otro lado.
 */
async function acreditarPuntosTrasElSello(ctx: {
  venueId: string
  customerId: string
  amount: number
  orderId: string
  staffId?: string
  sello: GrantStampResult | undefined
  deferredStampError: unknown
  /** Se va llenando: el envoltorio de `earnPoints` lo cuelga de cualquier error que salga de aquí. */
  otorgadoHastaAhora: { sello: boolean; puntos: boolean }
}): Promise<ResultadoDeEarnPoints> {
  const { venueId, customerId, amount, orderId, staffId, sello, deferredStampError, otorgadoHastaAhora } = ctx

  // The payment callers already isolate loyalty failures from the approved
  // charge. We therefore persist points first, then surface a stamp failure so
  // the durable paid-order reconciler can retry the missing stamp. Swallowing it
  // here would mark the order processed forever with a visibly missing reward.
  const finish = <T extends object>(result: T, puntosCreados = false): T => {
    // R3-1 (ronda 3) / R4-1: si ESTA llamada sí escribió los puntos, el error del sello lo dice (lo cuelga el envoltorio de
    // `earnPoints` con `otorgadoHastaAhora`): es un hecho que la auditoría de una liga tardía necesita aunque termine en error.
    if (deferredStampError) throw deferredStampError
    const selloCreado = sello?.granted === true
    // F2: sólo cuando ESTA llamada creó algo; los resultados de siempre no cambian de forma.
    return selloCreado || puntosCreados ? { ...result, otorgado: { sello: selloCreado, puntos: puntosCreados } } : result
  }
  const saldoActual = async (): Promise<number> =>
    (await prisma.customer.findUnique({ where: { id: customerId }, select: { loyaltyPoints: true } }))?.loyaltyPoints ?? 0

  // 🔴 H4, tercera ola (recheck 2 de Codex, 15-oct-2026): el sellado ya vio, con el candado de la VENTA, que OTRO cliente
  // recibió los puntos de esta venta. A éste no se le da nada.
  if (sello?.reason === 'OTHER_CUSTOMER') {
    logger.warn('⚠️ [LOYALTY] Another customer already earned this order: no points', { venueId, orderId, customerId })
    return finish({ pointsEarned: 0, newBalance: await saldoActual(), otroCliente: true as const })
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
    // H4, tercera ola: negocio de sólo sellos. «Ya sellada» con el sello de OTRO cliente quiere decir que la venta es de él:
    // quien llama no le cuenta la visita a éste. (Sólo se pregunta cuando el sellado dijo «ya sellada».)
    if (sello?.reason === 'ALREADY_STAMPED') {
      const selloDeLaVenta = await prisma.stampEvent.findFirst({
        where: { venueId, orderId, type: StampEventType.EARN },
        select: { stampCard: { select: { customerId: true } } },
      })
      if (selloDeLaVenta && selloDeLaVenta.stampCard.customerId !== customerId) {
        return finish({ pointsEarned: 0, newBalance: 0, otroCliente: true as const })
      }
    }
    return finish({ pointsEarned: 0, newBalance: 0 })
  }

  // 🔒 RACE CONDITION FIX: Database has partial unique index to prevent duplicates
  // If concurrent calls occur, the DB will reject duplicates with P2002
  try {
    // 🔴 H4, tercera ola (recheck 2 de Codex, 15-oct-2026): la escritura de los puntos y su comprobación van en UNA transacción
    // con el candado de la VENTA como PRIMERA sentencia (el mismo que toma `grantStamp` después del suyo). Dos intentos que
    // validaron a clientes distintos se forman aquí: el segundo ve los puntos o el sello del primero y no acredita. La
    // deduplicación de antes era por cliente + venta, así que no excluía a otro cliente.
    const escribirPuntos = async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${venueId}), hashtext(${orderId}))`
      const puntosDeOtro = await tx.loyaltyTransaction.findFirst({
        where: { orderId, type: LoyaltyTransactionType.EARN, customerId: { not: customerId }, customer: { venueId } },
        select: { customerId: true },
      })
      if (puntosDeOtro) return { tipo: 'OTRO_CLIENTE' as const }
      const selloDeOtro = await tx.stampEvent.findFirst({
        where: { venueId, orderId, type: StampEventType.EARN, stampCard: { customerId: { not: customerId } } },
        select: { id: true },
      })
      if (selloDeOtro) return { tipo: 'OTRO_CLIENTE' as const }
      // La otra llamada del MISMO cliente pudo escribir mientras ésta esperaba el candado: idempotente.
      const propio = await tx.loyaltyTransaction.findFirst({ where: { customerId, orderId, type: LoyaltyTransactionType.EARN } })
      if (propio) return { tipo: 'YA_ESTABA' as const, puntos: propio.points }
      await tx.loyaltyTransaction.create({
        data: {
          customerId,
          type: LoyaltyTransactionType.EARN,
          points: pointsEarned,
          orderId,
          reason: `Earned ${pointsEarned} points for purchase of $${amount.toFixed(2)}`,
          createdById: staffId,
        },
      })
      const customer = await tx.customer.update({
        where: { id: customerId },
        data: {
          loyaltyPoints: { increment: pointsEarned },
        },
        select: {
          loyaltyPoints: true,
        },
      })
      return { tipo: 'ACREDITADO' as const, saldo: customer.loyaltyPoints }
    }

    // 🔴 Cuarta ola: presupuesto explícito y, si aun así la transacción se vence (P2028), un reintento ACOTADO. Es
    // idempotente: cada intento vuelve a tomar el candado de la venta y relee el EARN de este cliente antes de escribir (si
    // el intento vencido alcanzó a escribir, el siguiente lo encuentra), y el índice único (cliente, venta) respalda.
    const escribirConReintento = async () => {
      for (let intento = 0; ; intento++) {
        try {
          return await prisma.$transaction(escribirPuntos, PRESUPUESTO_DE_LA_LEALTAD_DE_LA_VENTA)
        } catch (error) {
          if (!seVencioLaTransaccion(error) || intento >= REINTENTOS_POR_VENCIMIENTO) throw error
          logger.warn('⚠️ [LOYALTY] Points transaction expired (P2028); retrying', { venueId, orderId, customerId, intento: intento + 1 })
          await new Promise(resolve => setTimeout(resolve, 100 * 3 ** intento)) // 100 ms, 300 ms
        }
      }
    }
    const escrito = await escribirConReintento()
    // R4-1: los puntos de ESTA llamada ya quedaron (commit hecho): es un hecho desde aquí, pase lo que pase después.
    if (escrito.tipo === 'ACREDITADO') otorgadoHastaAhora.puntos = true

    if (escrito.tipo === 'OTRO_CLIENTE') {
      logger.warn('⚠️ [LOYALTY] Another customer already earned this order: no points', { venueId, orderId, customerId })
      return finish({ pointsEarned: 0, newBalance: await saldoActual(), otroCliente: true as const })
    }
    if (escrito.tipo === 'YA_ESTABA') return finish({ pointsEarned: escrito.puntos, newBalance: await saldoActual() })
    return finish(
      {
        pointsEarned,
        newBalance: escrito.saldo,
      },
      true,
    )
  } catch (error: any) {
    // R4-1: el error DIFERIDO del sellado (lo relanza `finish` después de escribir los puntos) no es una carrera de los puntos,
    // aunque sea un P2002: sube tal cual, con lo otorgado colgado por el envoltorio. Antes entraba a la recuperación de abajo,
    // que releía para nada y, si esa relectura tronaba, perdía el hecho «otorgó puntos».
    if (deferredStampError !== undefined && error === deferredStampError) throw error
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
    // R3-1 / R4-1: el sello de esta llamada ya quedó (va antes que los puntos) aunque los puntos fallen: el envoltorio de
    // `earnPoints` lo cuelga del error.
    throw error
  }
}

/**
 * R3-1 (ronda 3 post-QA de sellos tardíos, 15-oct-2026) + R4-1 (ronda 4): cuelga del error el hecho «esta llamada otorgó X
 * antes de fallar» (`otorgadoAntesDelFallo`), sin cambiar el error (mismo objeto, mismo mensaje). Si ya traía uno, los SUMA
 * (un hecho verdadero nunca se borra). Sin nada otorgado, no toca nada. Un error que no es objeto (un `throw 'texto'`) se
 * envuelve en un `Error` con su mismo texto para no perder el hecho.
 */
function conLoOtorgado(error: unknown, otorgado: { sello: boolean; puntos: boolean }): unknown {
  if (!otorgado.sello && !otorgado.puntos) return error
  if (!error || typeof error !== 'object') return Object.assign(new Error(String(error)), { otorgadoAntesDelFallo: { ...otorgado } })
  const previo = (error as { otorgadoAntesDelFallo?: { sello?: unknown; puntos?: unknown } }).otorgadoAntesDelFallo
  Object.assign(error, {
    otorgadoAntesDelFallo: {
      sello: otorgado.sello || previo?.sello === true,
      puntos: otorgado.puntos || previo?.puntos === true,
    },
  })
  return error
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
