/**
 * Fase 5 del kiosco — el reto de check-in.
 *
 * La lista de nombres resuelve el caso normal: la clase está por empezar, tu nombre está
 * ahí, lo tocas. Este carril resuelve los dos que quedan fuera:
 *
 *   · quien NO aparece en la lista (reservó a otro nombre, llegó fuera de ventana, se
 *     apuntó por otro canal), y
 *   · quien prefiere no tocar una pantalla que acaba de tocar media clase.
 *
 * El aparato enseña un QR. La persona lo abre en SU teléfono, con SU sesión, y ahí se
 * identifica. **El kiosco nunca ve la identidad**: sólo pregunta "¿ya lo resolvió alguien?"
 * y recibe sí o no. Por eso el secreto viaja en el FRAGMENTO de la URL (`#secret=…`), que
 * el navegador no manda al servidor ni en el `Referer`, y de él aquí sólo queda un hash.
 */

import { createHash, randomBytes } from 'crypto'
import { Prisma } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { ConflictError, GoneError, NotFoundError, TooManyRequestsError } from '@/errors/AppError'
import { getReservationSettings } from '@/services/dashboard/reservationSettings.service'
import { checkInReservation, evaluateKioskWindow, KIOSK_EARLY_CHECK_IN_MIN } from './checkIn.service'

export const CHECK_IN_NOT_FOUND = 'CHECK_IN_NOT_FOUND' as const
export const CHECK_IN_ALREADY_CLAIMED = 'CHECK_IN_ALREADY_CLAIMED' as const
export const CHECK_IN_CHALLENGE_EXPIRED = 'CHECK_IN_CHALLENGE_EXPIRED' as const

/** Vida del QR. Corta a propósito: una foto de la pantalla no sirve diez minutos después. */
export const CHALLENGE_TTL_SECONDS = 180

/**
 * El pepper es el MISMO de los OTP a propósito: ya es obligatorio en `env.ts` (mín. 16
 * caracteres) y ya está desplegado en todos los entornos. Introducir una variable nueva
 * habría hecho que el server no arrancara donde nadie la hubiera puesto todavía — un
 * riesgo peor que el de compartir un secreto de servidor entre dos usos internos.
 */
function pepper(): string {
  return process.env.OTP_PEPPER ?? ''
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(`${secret}${pepper()}`).digest('hex')
}

/** Sólo para las pruebas: verifica que el hash es el que se guarda. */
export const __hashSecretForTest = hashSecret

// ─────────────────────────────────────────────────────────────────────────────
// Límite de intentos DURABLE
// ─────────────────────────────────────────────────────────────────────────────

/** Ventana fija de un minuto. */
const RATE_WINDOW_MS = 60_000

function windowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / RATE_WINDOW_MS) * RATE_WINDOW_MS)
}

/**
 * Suma un intento y devuelve cuántos van en esta ventana.
 *
 * 🔴 Durable a propósito. El limitador que ya existe (`express-rate-limit`) vive en la
 * memoria del proceso: se reinicia con cada deploy y no se comparte entre instancias, así
 * que no frena a quien barre códigos con paciencia — que es exactamente el ataque que
 * importa aquí, porque el premio es hacer check-in como otra persona.
 */
export async function consumeDurableAttempt(args: {
  venueId: string
  scope: string
  now: Date
  max: number
}): Promise<{ count: number; blocked: boolean }> {
  const ws = windowStart(args.now)
  const row = await prisma.kioskCheckInAttempt.upsert({
    where: { venueId_scope_windowStart: { venueId: args.venueId, scope: args.scope.slice(0, 128), windowStart: ws } },
    create: { venueId: args.venueId, scope: args.scope.slice(0, 128), windowStart: ws, count: 1 },
    update: { count: { increment: 1 } },
    select: { count: true },
  })
  return { count: row.count, blocked: row.count > args.max }
}

export async function assertDurableRateLimit(args: { venueId: string; scope: string; now: Date; max: number }): Promise<void> {
  const { count, blocked } = await consumeDurableAttempt(args)
  if (blocked) {
    logger.warn('⛔ [KIOSK CHECK-IN] Límite de intentos alcanzado', { venueId: args.venueId, scope: args.scope, count })
    throw new TooManyRequestsError('Demasiados intentos. Espera un minuto e inténtalo de nuevo.')
  }
}

/** Suma un intento SIN tumbar la petición si el contador falla: nunca es la parte crítica. */
async function recordAttemptSafely(args: { venueId: string; scope?: string; now: Date; max: number }): Promise<void> {
  if (!args.scope) return
  try {
    await assertDurableRateLimit({ venueId: args.venueId, scope: args.scope, now: args.now, max: args.max })
  } catch (err) {
    if (err instanceof TooManyRequestsError) throw err
    logger.error('[KIOSK CHECK-IN] No se pudo registrar el intento', { err })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Crear / consultar el reto
// ─────────────────────────────────────────────────────────────────────────────

export async function createKioskCheckInChallenge(args: {
  venueId: string
  terminalId: string | null
  stationKey: string
  kioskSessionId: string
  now: Date
  ttlSeconds?: number
}): Promise<{ id: string; secret: string; expiresAt: Date }> {
  const ttl = args.ttlSeconds ?? CHALLENGE_TTL_SECONDS
  const expiresAt = new Date(args.now.getTime() + ttl * 1000)

  // Un solo QR vivo por cara. La base también lo garantiza (índice único parcial), pero
  // cancelar aquí es lo que evita chocar contra él en la operación normal.
  await prisma.kioskCheckInChallenge.updateMany({
    where: { venueId: args.venueId, terminalId: args.terminalId, stationKey: args.stationKey, status: 'PENDING' },
    data: { status: 'CANCELLED' },
  })

  const secret = randomBytes(32).toString('hex')
  const created = await prisma.kioskCheckInChallenge.create({
    data: {
      venueId: args.venueId,
      terminalId: args.terminalId,
      stationKey: args.stationKey,
      kioskSessionId: args.kioskSessionId,
      nonceHash: hashSecret(secret),
      status: 'PENDING',
      expiresAt,
    },
    select: { id: true, expiresAt: true },
  })

  // El secreto se devuelve UNA vez, a quien lo pidió, y no vuelve a existir en ningún lado.
  return { id: created.id, secret, expiresAt: created.expiresAt }
}

/**
 * Lo que el aparato puede preguntar mientras espera.
 *
 * 🔴 SIN PII, y no es un detalle: la cara del kiosco está a la vista de la fila entera y
 * cualquiera puede sondear con el id del reto, que va impreso en el QR. Devolver el nombre
 * de quien acaba de llegar convertiría el sondeo en una lista de asistencia pública.
 */
export async function getKioskCheckInChallengeStatus(args: {
  venueId: string
  challengeId: string
  now: Date
}): Promise<{ id: string; status: string; expiresAt: Date | null }> {
  const ch = await prisma.kioskCheckInChallenge.findFirst({
    where: { id: args.challengeId, venueId: args.venueId },
    select: { id: true, status: true, expiresAt: true },
  })
  if (!ch) throw new NotFoundError('Reto no encontrado', CHECK_IN_NOT_FOUND)

  const status = ch.status === 'PENDING' && ch.expiresAt <= args.now ? 'EXPIRED' : ch.status
  return { id: ch.id, status, expiresAt: ch.expiresAt }
}

// ─────────────────────────────────────────────────────────────────────────────
// Consumirlo (desde el teléfono del cliente, con SU sesión)
// ─────────────────────────────────────────────────────────────────────────────

export interface ConsumeChallengeResult {
  outcome: 'CHECKED_IN' | 'ALREADY_CHECKED_IN'
  reservationId: string | null
  /**
   * Lo mínimo para pintar la confirmación sin una segunda llamada.
   *
   * Sale SÓLO después de un check-in exitoso: para entonces la persona ya demostró que es
   * ella (tecleó su propio teléfono y había una reserva suya lista ahora mismo). Antes de
   * eso el endpoint no dice absolutamente nada — es lo que impide usarlo como buscador de
   * quién viene hoy.
   */
  display?: {
    /** "Ana G." — nombre e inicial, nunca completo: esto se pinta de cara a la entrada. */
    displayName: string
    title: string
    startsAt: Date
    staffLabel: string | null
  }
}

export async function consumeKioskCheckInChallenge(args: {
  venueId: string
  challengeId: string
  secret: string
  customerId: string
  now: Date
  ip?: string
}): Promise<ConsumeChallengeResult> {
  const nonceHash = hashSecret(args.secret)

  const ch = await prisma.kioskCheckInChallenge.findFirst({
    where: { id: args.challengeId, venueId: args.venueId, nonceHash },
  })

  // 🔴 404 GENÉRICO. No distingue "no existe" de "existe pero tu secreto no es": cualquier
  // diferencia entre las dos respuestas es un oráculo para adivinar el secreto a ciegas.
  if (!ch) {
    await recordAttemptSafely({ venueId: args.venueId, scope: args.ip ? `ip:${args.ip}` : undefined, now: args.now, max: 10 })
    throw new NotFoundError('No encontramos ese check-in', CHECK_IN_NOT_FOUND)
  }

  if (ch.status === 'CONSUMED') {
    // Repetir es normal: se recarga la página, se pierde la señal a medio camino.
    if (ch.customerId && ch.customerId === args.customerId) {
      const reservation = ch.reservationId
        ? await prisma.reservation.findFirst({ where: { id: ch.reservationId }, select: { id: true, status: true } })
        : null
      return { outcome: 'ALREADY_CHECKED_IN', reservationId: reservation?.id ?? ch.reservationId ?? null }
    }
    // Otra persona con el mismo QR: es el caso que este carril existe para negar.
    throw new ConflictError('Este check-in ya lo usó alguien más', CHECK_IN_ALREADY_CLAIMED)
  }

  if (ch.status !== 'PENDING') {
    throw new GoneError('Este código ya no sirve. Pide uno nuevo en la pantalla.', CHECK_IN_CHALLENGE_EXPIRED)
  }

  if (ch.expiresAt <= args.now) {
    await prisma.kioskCheckInChallenge.updateMany({ where: { id: ch.id, status: 'PENDING' }, data: { status: 'EXPIRED' } })
    throw new GoneError('Este código ya venció. Pide uno nuevo en la pantalla.', CHECK_IN_CHALLENGE_EXPIRED)
  }

  // La reserva elegible de ESTE cliente, dentro de la ventana del kiosco.
  const settings = await getReservationSettings(args.venueId)
  const noShowGraceMin = settings.scheduling.noShowGraceMin
  const from = new Date(args.now.getTime() - noShowGraceMin * 60_000)
  const to = new Date(args.now.getTime() + KIOSK_EARLY_CHECK_IN_MIN * 60_000)

  const candidates = await prisma.reservation.findMany({
    where: {
      venueId: args.venueId,
      customerId: args.customerId,
      status: { in: ['PENDING', 'CONFIRMED'] },
      startsAt: { gte: from, lte: to },
    },
    orderBy: { startsAt: 'asc' },
    select: { id: true, startsAt: true },
  })
  const target = candidates.find(r => evaluateKioskWindow({ startsAt: r.startsAt, now: args.now, noShowGraceMin }))

  if (!target) {
    throw new NotFoundError('No encontramos una reservación tuya lista para check-in', CHECK_IN_NOT_FOUND)
  }

  const result = await prisma.$transaction(async tx => {
    // CAS sobre el reto: sólo un consumidor gana, aunque dos teléfonos lo abran a la vez.
    const claimed = await tx.kioskCheckInChallenge.updateMany({
      where: { id: ch.id, status: 'PENDING' },
      data: {
        status: 'CONSUMED',
        consumedAt: args.now,
        customerId: args.customerId,
        reservationId: target.id,
        version: { increment: 1 },
      },
    })
    if (claimed.count === 0) throw new ConflictError('Este check-in ya lo usó alguien más', CHECK_IN_ALREADY_CLAIMED)

    return checkInReservation(tx, {
      reservationId: target.id,
      venueId: args.venueId,
      actor: { type: 'SERVICE', servicePrincipalId: 'kiosk' },
      source: 'KIOSK',
      now: args.now,
    })
  })

  logger.info('✅ [KIOSK CHECK-IN] Reto consumido', {
    venueId: args.venueId,
    challengeId: ch.id,
    reservationId: target.id,
    outcome: result.outcome,
  })

  return { outcome: result.outcome, reservationId: target.id }
}

/** "Ana", "Gómez" → "Ana G." */
function shortName(first?: string | null, last?: string | null): string {
  const f = (first ?? '').trim()
  const l = (last ?? '').trim()
  if (!f && !l) return 'Invitado'
  return l ? `${f} ${l[0].toUpperCase()}.` : f
}

/** "Ana Gómez" → "Ana G." */
function shortNameFromFull(full?: string | null): string {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'Invitado'
  return shortName(parts[0], parts.slice(1).join(' '))
}

// ─────────────────────────────────────────────────────────────────────────────
// D9 — respaldo "no aparezco en la lista": el código de confirmación
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deja hacer check-in tecleando el TELÉFONO o el código de confirmación.
 *
 * Se aceptan los dos porque nadie recuerda su código de confirmación, pero todos saben su
 * teléfono. Es también lo que hace el mercado: WellnessLiving identifica por "Client ID,
 * Email, or Phone number" y los demás por escaneo o búsqueda de nombre. (Los artículos de
 * Mindbody no se pudieron leer — su centro de ayuda se dibuja con JavaScript.)
 *
 * 🔴 Cuatro llaves de límite a la vez —terminal, cara, IP y la reserva— porque cada una
 * tapa un hueco distinto: la IP no sirve si el atacante rota de red, la terminal no sirve
 * si trae la suya, y el límite por reserva es el único que impide machacar UNA reserva
 * concreta desde muchos lados. Y la respuesta es siempre la misma: un código que no
 * existe y uno que existe pero no toca ahora se ven idénticos desde fuera.
 */
export async function checkInByIdentifier(args: {
  venueId: string
  terminalId: string | null
  stationKey: string
  /// Código de confirmación O teléfono. Se acepta lo que la persona SÍ sepa de memoria.
  identifier: string
  now: Date
  ip?: string
}): Promise<ConsumeChallengeResult> {
  const raw = args.identifier.trim()
  const code = raw.toUpperCase().slice(0, 32)
  // Un identificador de puros dígitos es un teléfono. Se comparan los ÚLTIMOS 10 para
  // que dé igual si lo teclea con lada, con +52 o sin nada.
  const digits = raw.replace(/\D/g, '')
  const phoneTail = digits.length >= 10 ? digits.slice(-10) : null

  const scopes = [
    args.terminalId ? `terminal:${args.terminalId}` : null,
    `station:${args.stationKey}`,
    args.ip ? `ip:${args.ip}` : null,
    `identifier:${code}`,
  ].filter(Boolean) as string[]

  for (const scope of scopes) {
    await assertDurableRateLimit({ venueId: args.venueId, scope, now: args.now, max: scope.startsWith('identifier:') ? 5 : 30 })
  }

  // Ventana primero, en la CONSULTA: por teléfono puede haber varias reservas a lo largo
  // del año, y la que importa es la de ahora. Buscar sin acotar y elegir después haría que
  // teclear un teléfono contestara cosas sobre citas de otro día.
  const settingsForWindow = await getReservationSettings(args.venueId)
  const graceMin = settingsForWindow.scheduling.noShowGraceMin
  const windowFrom = new Date(args.now.getTime() - graceMin * 60_000)
  const windowTo = new Date(args.now.getTime() + KIOSK_EARLY_CHECK_IN_MIN * 60_000)

  const reservation = await prisma.reservation.findFirst({
    where: {
      venueId: args.venueId,
      startsAt: { gte: windowFrom, lte: windowTo },
      ...(phoneTail
        ? {
            OR: [{ guestPhone: { endsWith: phoneTail } }, { customer: { phone: { endsWith: phoneTail } } }],
          }
        : { confirmationCode: code }),
    },
    orderBy: { startsAt: 'asc' },
    select: {
      id: true,
      status: true,
      startsAt: true,
      guestName: true,
      customer: { select: { firstName: true, lastName: true } },
      classSession: { select: { assignedStaff: { select: { firstName: true } } } },
      product: { select: { name: true } },
    },
  })

  // Respuesta genérica: no revela si el código existe.
  const notFound = () => new NotFoundError('No encontramos esa reservación lista para check-in', CHECK_IN_NOT_FOUND)
  if (!reservation) throw notFound()

  const display = {
    displayName: reservation.customer
      ? shortName(reservation.customer.firstName, reservation.customer.lastName)
      : shortNameFromFull(reservation.guestName),
    title: reservation.product?.name ?? 'Tu clase',
    startsAt: reservation.startsAt,
    staffLabel: reservation.classSession?.assignedStaff?.firstName ? `con ${reservation.classSession.assignedStaff.firstName}` : null,
  }

  if (reservation.status === 'CHECKED_IN') {
    return { outcome: 'ALREADY_CHECKED_IN', reservationId: reservation.id, display }
  }
  if (!['PENDING', 'CONFIRMED'].includes(reservation.status)) throw notFound()

  if (!evaluateKioskWindow({ startsAt: reservation.startsAt, now: args.now, noShowGraceMin: graceMin })) {
    throw notFound()
  }

  const result = await prisma.$transaction(tx =>
    checkInReservation(tx, {
      reservationId: reservation.id,
      venueId: args.venueId,
      actor: { type: 'SERVICE', servicePrincipalId: 'kiosk' },
      source: 'KIOSK',
      now: args.now,
    }),
  )

  logger.info('✅ [KIOSK CHECK-IN] Check-in por identificador', { venueId: args.venueId, reservationId: reservation.id })
  return { outcome: result.outcome, reservationId: reservation.id, display }
}

export type KioskCheckInChallengeRow = Prisma.KioskCheckInChallengeGetPayload<{}>
