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
import { type Audiencia, LUGAR_DEL_PASE, errorIlimitado, errorVenceAntes } from '@/services/credits/ilimitado'

type Lector = Pick<Prisma.TransactionClient, 'creditItemBalance' | 'customer'>

/**
 * D679 (C1–C3) · el Ilimitado es personal: si algún saldo con el que se va a pagar es Ilimitado, la reserva toma el nombre, el
 * teléfono y el correo de la FICHA de la clienta de la sesión, nunca los del formulario. Lo que le falte a su ficha queda vacío
 * (`null`): un teléfono escrito por otra persona le abriría el kiosco. `null` si ninguno es Ilimitado (o no hay sesión: el canje
 * contesta 401). La marca de un saldo no cambia nunca, así que se lee sin candado y ANTES de crear la reserva: la confirmación por
 * correo y WhatsApp ya sale a la titular.
 */
export async function titularDelPase(
  db: Lector,
  args: { venueId: string; sessionCustomerId: string | null | undefined; balanceIds: string[] },
): Promise<{ guestName: string | null; guestPhone: string | null; guestEmail: string | null } | null> {
  if (!args.sessionCustomerId || args.balanceIds.length === 0) return null
  const ilimitado = await db.creditItemBalance.findFirst({
    where: { id: { in: args.balanceIds }, unlimited: true, creditPackPurchase: { venueId: args.venueId } },
    select: { id: true },
  })
  if (!ilimitado) return null
  return fichaDeLaTitular(db, args.venueId, args.sessionCustomerId)
}

/** Nombre (`firstName lastName`), teléfono y correo de la ficha; lo que falte, `null`. */
async function fichaDeLaTitular(
  db: Pick<Prisma.TransactionClient, 'customer'>,
  venueId: string,
  customerId: string,
): Promise<{ guestName: string | null; guestPhone: string | null; guestEmail: string | null } | null> {
  const ficha = await db.customer.findFirst({
    where: { id: customerId, venueId },
    select: { firstName: true, lastName: true, phone: true, email: true },
  })
  if (!ficha) return null
  const nombre = [ficha.firstName, ficha.lastName]
    .map(parte => parte?.trim())
    .filter(Boolean)
    .join(' ')
  return { guestName: nombre || null, guestPhone: ficha.phone || null, guestEmail: ficha.email || null }
}

/**
 * D679 · las reglas del pase, en orden: (a) 1 persona; (b) la clase o cita empieza antes de que venza; (c) en una clase, la titular
 * no tiene otra reserva viva (o en «No asistió») pagada con un Ilimitado suyo. Lo usan el canje y los cambios de horario.
 */
export async function revisarPase(
  tx: Prisma.TransactionClient,
  args: {
    venueId: string
    customerId: string
    expiresAt: Date | null
    timezone: string
    startsAt: Date
    classSessionId: string | null
    personas: number
    excludeReservationId: string
    /** D687: a quién le habla el texto del error. Default: a quien compró el pase. */
    audiencia?: Audiencia
  },
): Promise<void> {
  if (args.personas > 1) throw errorIlimitado('CREDIT_UNLIMITED_ONE_SEAT', args.audiencia)
  if (args.expiresAt && args.startsAt >= args.expiresAt) throw errorVenceAntes(args.expiresAt, args.timezone, args.audiencia)
  if (args.classSessionId) {
    const otroLugar = await tx.creditTransaction.findFirst({
      where: {
        venueId: args.venueId,
        type: 'REDEEM',
        customerId: args.customerId,
        creditItemBalance: { unlimited: true },
        reservation: { classSessionId: args.classSessionId, status: { in: LUGAR_DEL_PASE }, id: { not: args.excludeReservationId } },
      },
      select: { id: true },
    })
    if (otroLugar) throw errorIlimitado('CREDIT_UNLIMITED_SAME_CLASS', args.audiencia)
  }
}

/** Los pases Ilimitados con los que se pagó una reserva: uno por compra, con su titular y su vencimiento. */
export async function pasesDeLaReserva(
  tx: Prisma.TransactionClient,
  venueId: string,
  reservationId: string,
): Promise<{ customerId: string; expiresAt: Date | null }[]> {
  // Una reserva tiene pocos canjes (uno por servicio); el tope sólo cuida la consulta.
  const canjes = await tx.creditTransaction.findMany({
    where: { venueId, reservationId, type: 'REDEEM', creditItemBalance: { unlimited: true } },
    select: { customerId: true, creditPackPurchaseId: true, creditPackPurchase: { select: { expiresAt: true } } },
    take: 50,
  })
  const porCompra = new Map(
    canjes.map(c => [c.creditPackPurchaseId, { customerId: c.customerId, expiresAt: c.creditPackPurchase.expiresAt }]),
  )
  return [...porCompra.values()]
}

/** La zona del negocio, para escribir la fecha de vencimiento como la ve la clienta. */
export async function zonaDelNegocio(tx: Prisma.TransactionClient, venueId: string): Promise<string> {
  const venue = await tx.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  return venue?.timezone || 'America/Mexico_City'
}

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

  // D679 (regla 5): la reserva bajo candado ANTES que los saldos (el mismo orden que cancelar). Así un cambio de horario y el canje
  // de un pase no se cruzan. Un paquete normal cobra EXACTAMENTE como antes (Codex código r1 #6): la reserva sólo se exige viva
  // —no cancelada— para un Ilimitado.
  const [reserva] = await tx.$queryRaw<
    { status: string; startsAt: Date; partySize: number; classSessionId: string | null }[]
  >`SELECT status, "startsAt", "partySize", "classSessionId" FROM "Reservation" WHERE id = ${args.reservationId} AND "venueId" = ${args.venueId} FOR UPDATE`
  let pagoConIlimitado = false

  let totalCreditsUsed = 0
  for (const balanceId of args.balanceIds) {
    const balances = await tx.$queryRaw<
      { id: string; remainingQuantity: number; creditPackPurchaseId: string; productId: string; unlimited: boolean }[]
    >`
      SELECT id, "remainingQuantity", "creditPackPurchaseId", "productId", "unlimited"
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

    const purchase = await tx.creditPackPurchase.findUnique({
      where: { id: balance.creditPackPurchaseId },
      select: { status: true, expiresAt: true, customerId: true },
    })
    const validarCompra = () => {
      if (!purchase || purchase.customerId !== customer.id) {
        throw new BadRequestError('Credito no valido para este cliente')
      }
      if (purchase.status !== CreditPurchaseStatus.ACTIVE) {
        throw new BadRequestError('Los creditos ya no estan activos')
      }
      if (purchase.expiresAt && purchase.expiresAt < new Date()) {
        throw new BadRequestError('Los creditos han expirado')
      }
    }

    if (balance.unlimited) {
      // D679: el pase se revisa ANTES de «no alcanza» (su 99,999 nunca se enseña), y después de que la compra es suya y vigente.
      if (!reserva || reserva.status === 'CANCELLED') throw errorIlimitado('CREDIT_RESERVATION_NOT_ALIVE')
      validarCompra()
      const clase = reserva.classSessionId
        ? await tx.classSession.findUnique({ where: { id: reserva.classSessionId }, select: { startsAt: true } })
        : null
      await revisarPase(tx, {
        venueId: args.venueId,
        customerId: customer.id,
        expiresAt: purchase!.expiresAt,
        timezone: await zonaDelNegocio(tx, args.venueId),
        startsAt: clase?.startsAt ?? reserva.startsAt,
        classSessionId: reserva.classSessionId,
        personas: Math.max(reserva.partySize, args.creditsPerBalance),
        excludeReservationId: args.reservationId,
      })
      pagoConIlimitado = true
    }

    if (balance.remainingQuantity < args.creditsPerBalance) {
      throw new BadRequestError(textos.noAlcanza(balance.remainingQuantity, args.creditsPerBalance))
    }
    validarCompra()

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

  if (pagoConIlimitado) {
    // D679: con la reserva bajo candado, queda a nombre y contacto de la titular (Codex código r1 #2: recepción pudo cambiarlo
    // entre el alta de la cita y este canje). Y se TOCA: un cambio de horario en SERIALIZABLE que la tomó con una foto de antes
    // de este canje choca aquí (40001) y se reintenta viendo el pase; sin esto, su foto no ve el REDEEM.
    const titular = await fichaDeLaTitular(tx, args.venueId, customer.id)
    await tx.reservation.update({ where: { id: args.reservationId }, data: { updatedAt: new Date(), ...(titular ?? {}) } })
  }

  logger.info(
    `[CREDIT REDEEM] ${totalCreditsUsed} credit(s) redeemed across ${args.balanceIds.length} balance(s) for reservation ${args.confirmationCode}`,
  )

  return { creditsUsed: totalCreditsUsed, redeemed: true }
}
