/**
 * El canje de créditos de una RESERVA, en un solo lugar (D679, Task 1).
 *
 * Lo usan los tres caminos que reservan con créditos: la clase del widget (`createClassReservation`), la cita del widget
 * (`redeemCreditsWithCompensation`) y la clase de la app de clientes (`createClassReservationForConsumer`). Antes eran tres
 * copias. El canje a mano del DASHBOARD y «Sí llegó» son correcciones de una persona y van aparte (guardia:
 * `tests/unit/architecture/canjeUnicoDeReservas.test.ts`).
 */
import { CreditPurchaseStatus, Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { BadRequestError, UnauthorizedError } from '@/errors/AppError'

/**
 * Fase 0.B — quién puede gastar créditos al reservar: SÓLO el customer de la sesión.
 *
 * Antes, sin sesión, el dueño se resolvía por `guestEmail/guestPhone` del body; como el
 * balance también era público por contacto, conocer el email de alguien bastaba para
 * obtener un balanceId y gastar sus créditos (auditoría 2, P1).
 *
 * - sin sesión → 401 CUSTOMER_AUTH_REQUIRED (antes de tocar la DB)
 * - sesión cuyo customer ya no existe en el venue → 400
 */
export async function requireSessionCustomerForCredits(
  tx: Prisma.TransactionClient,
  input: { sessionCustomerId: string | null | undefined; venueId: string },
): Promise<{ id: string }> {
  if (!input.sessionCustomerId) {
    throw new UnauthorizedError('Inicia sesión para pagar con tus créditos', 'CUSTOMER_AUTH_REQUIRED')
  }
  const customer = await tx.customer.findFirst({ where: { id: input.sessionCustomerId, venueId: input.venueId }, select: { id: true } })
  if (!customer) {
    throw new BadRequestError('No se encontro el cliente para canjear creditos')
  }
  return customer
}

/** Qué textos ve la clienta: la clase (widget y app de clientes) y la cita hablaban distinto, y se conservan. */
export type ContextoDeCanje = 'CLASE' | 'CITA'

const TEXTOS: Record<
  ContextoDeCanje,
  {
    sinSaldo: (balanceId: string) => string
    otroProducto: string
    noAlcanza: (disponibles: number, necesarios: number) => string
    reason: (n: number) => string
  }
> = {
  CLASE: {
    sinSaldo: () => 'Balance de credito no encontrado',
    otroProducto: 'El credito no corresponde al producto de esta clase',
    noAlcanza: (d, n) => `No tienes suficientes creditos. Disponibles: ${d}, necesarios: ${n}. Compra mas creditos para continuar.`,
    reason: n => `Reserva de ${n} lugares`,
  },
  CITA: {
    sinSaldo: id => `Balance de credito no encontrado: ${id}`,
    otroProducto: 'El credito no corresponde a los servicios reservados',
    noAlcanza: (d, n) => `No tienes suficientes creditos. Disponibles: ${d}, necesarios: ${n}.`,
    reason: n => `Reserva de ${n} creditos`,
  },
}

/**
 * Canjea créditos de uno o más saldos contra una reserva ya creada. Cada saldo:
 *   1. se bloquea (`FOR UPDATE`);
 *   2. se valida: producto esperado, saldo suficiente, compra de la clienta de la sesión, ACTIVE y sin vencer;
 *   3. baja `creditsPerBalance` y deja un REDEEM;
 *   4. si la compra se quedó sin saldo, pasa a EXHAUSTED.
 *
 * Quien llama pasa la transacción: la clase canjea en la MISMA que crea la reserva (todo o nada); la cita, en la suya, con
 * compensación si falla.
 */
export async function redeemCreditsForReservation(
  tx: Prisma.TransactionClient,
  args: {
    venueId: string
    reservationId: string
    confirmationCode: string
    /** Un saldo por canje (largo 1 = un solo producto). */
    balanceIds: string[]
    creditsPerBalance: number
    /** Identidad de SESIÓN — obligatoria (ver `requireSessionCustomerForCredits`). */
    customerId?: string | null
    /** Sólo informativos; NO identifican al dueño de los créditos. */
    customerEmail?: string
    customerPhone?: string
    /** Cada saldo debe ser de uno de estos productos (nunca un balanceId de otro servicio). */
    expectedProductIds?: string[]
    /** Sólo elige los textos. Default `CITA`. */
    contexto?: ContextoDeCanje
  },
): Promise<{ creditsUsed: number; redeemed: boolean }> {
  if (args.balanceIds.length === 0) {
    return { creditsUsed: 0, redeemed: false }
  }
  const textos = TEXTOS[args.contexto ?? 'CITA']

  const customer = await requireSessionCustomerForCredits(tx, { sessionCustomerId: args.customerId, venueId: args.venueId })

  let totalCreditsUsed = 0
  for (const balanceId of args.balanceIds) {
    const balances = await tx.$queryRaw<{ id: string; remainingQuantity: number; creditPackPurchaseId: string; productId: string }[]>`
      SELECT id, "remainingQuantity", "creditPackPurchaseId", "productId"
      FROM "CreditItemBalance"
      WHERE id = ${balanceId}
      FOR UPDATE
    `
    if (balances.length === 0) {
      throw new BadRequestError(textos.sinSaldo(balanceId))
    }
    const balance = balances[0]

    if (args.expectedProductIds && !args.expectedProductIds.includes(balance.productId)) {
      throw new BadRequestError(textos.otroProducto)
    }

    if (balance.remainingQuantity < args.creditsPerBalance) {
      throw new BadRequestError(textos.noAlcanza(balance.remainingQuantity, args.creditsPerBalance))
    }

    const purchase = await tx.creditPackPurchase.findUnique({
      where: { id: balance.creditPackPurchaseId },
      select: { status: true, expiresAt: true, customerId: true },
    })
    if (!purchase || purchase.customerId !== customer.id) {
      throw new BadRequestError('Credito no valido para este cliente')
    }
    if (purchase.status !== CreditPurchaseStatus.ACTIVE) {
      throw new BadRequestError('Los creditos ya no estan activos')
    }
    if (purchase.expiresAt && purchase.expiresAt < new Date()) {
      throw new BadRequestError('Los creditos han expirado')
    }

    await tx.creditItemBalance.update({
      where: { id: balanceId },
      data: { remainingQuantity: { decrement: args.creditsPerBalance } },
    })

    await tx.creditTransaction.create({
      data: {
        venueId: args.venueId,
        customerId: customer.id,
        creditPackPurchaseId: balance.creditPackPurchaseId,
        creditItemBalanceId: balanceId,
        type: 'REDEEM',
        quantity: -args.creditsPerBalance,
        reservationId: args.reservationId,
        reason: args.creditsPerBalance > 1 ? textos.reason(args.creditsPerBalance) : null,
      },
    })

    totalCreditsUsed += args.creditsPerBalance

    const remaining = await tx.creditItemBalance.findFirst({
      where: { creditPackPurchaseId: balance.creditPackPurchaseId, remainingQuantity: { gt: 0 } },
      select: { id: true },
    })
    if (!remaining) {
      await tx.creditPackPurchase.update({
        where: { id: balance.creditPackPurchaseId },
        data: { status: CreditPurchaseStatus.EXHAUSTED },
      })
    }
  }

  logger.info(
    `[CREDIT REDEEM] ${totalCreditsUsed} credit(s) redeemed across ${args.balanceIds.length} balance(s) for reservation ${args.confirmationCode}`,
  )

  return { creditsUsed: totalCreditsUsed, redeemed: true }
}
