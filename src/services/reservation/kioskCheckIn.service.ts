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
import { formatInTimeZone } from 'date-fns-tz'
import { ConflictError, GoneError, NotFoundError, TooManyRequestsError, ValidationError } from '@/errors/AppError'
import { getReservationSettings } from '@/services/dashboard/reservationSettings.service'
import {
  activityActorFields,
  CHECK_IN_OUTSIDE_WINDOW,
  checkInReservation,
  checkInReservationAndOpenOrder,
  evaluateKioskWindow,
  KIOSK_EARLY_CHECK_IN_MIN,
  RESERVATION_NOT_CHECKINABLE,
  venueOrganizationId,
} from './checkIn.service'
import { spotLabel } from './coachClass.service'

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

// ─────────────────────────────────────────────────────────────────────────────
// Modo Autoservicio 0.e — la lista y el check-in PROPIOS del kiosco
//
// Rutas con `self-service:check-in` (que `reservations:update` implica). El servidor calcula la ventana
// (el aparato no manda rango: sólo podría ampliarla) y vuelve a checarla en cada check-in.
// ─────────────────────────────────────────────────────────────────────────────

export interface KioskRosterPerson {
  reservationId: string
  /** "Ana R." — la pantalla mira a la fila: nunca nombre completo, teléfono ni correo. */
  displayName: string
  checkedIn: boolean
  spotLabel: string | null
}

export interface KioskRoster {
  classTitle: string
  startsAt: Date
  staffFirstName: string | null
  people: KioskRosterPerson[]
  /** Cierre de la ventana (startsAt + tolerancia), con la hora del SERVIDOR. */
  closesAt: Date
  /** `closesAt − now` del servidor: el aparato cuenta desde aquí con su reloj monótono, nunca con su hora de pared. */
  closesInMs: number
}

/** La clase (o cita) del kiosco ahora mismo: la que empieza primero dentro de la ventana. */
export async function getKioskRoster(args: { venueId: string; now: Date }): Promise<KioskRoster | null> {
  const grace = (await getReservationSettings(args.venueId)).scheduling.noShowGraceMin
  const t = args.now.getTime()

  const rows = await prisma.reservation.findMany({
    where: {
      venueId: args.venueId,
      status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] },
      // `evaluateKioskWindow` despejada para startsAt: now − tolerancia < startsAt ≤ now + 20 min.
      startsAt: { gt: new Date(t - grace * 60_000), lte: new Date(t + KIOSK_EARLY_CHECK_IN_MIN * 60_000) },
    },
    // Desempates fijos: dos clases a la misma hora no se turnan en la pantalla entre una consulta y otra.
    orderBy: [{ startsAt: 'asc' }, { classSessionId: 'asc' }, { id: 'asc' }],
    take: 200, // ponytail: 200 reservas en 35 min nunca pasa; paginar si un negocio lo rebasa
    select: {
      id: true,
      status: true,
      startsAt: true,
      classSessionId: true,
      spotIds: true,
      guestName: true,
      customer: { select: { firstName: true, lastName: true } },
      product: { select: { name: true, layoutConfig: true } },
      assignedStaff: { select: { firstName: true } },
      classSession: { select: { product: { select: { name: true, layoutConfig: true } }, assignedStaff: { select: { firstName: true } } } },
    },
  })

  const open = rows.filter(r => evaluateKioskWindow({ startsAt: r.startsAt, now: args.now, noShowGraceMin: grace }))
  if (open.length === 0) return null

  // Una clase = sus reservas; una cita suelta es su propio grupo. Gana la que empieza primero.
  const first = open[0]
  const key = first.classSessionId ?? first.id
  const closesAt = new Date(first.startsAt.getTime() + grace * 60_000)

  return {
    classTitle: first.classSession?.product?.name ?? first.product?.name ?? 'Tu cita',
    startsAt: first.startsAt,
    staffFirstName: first.classSession?.assignedStaff?.firstName ?? first.assignedStaff?.firstName ?? null,
    people: open
      .filter(r => (r.classSessionId ?? r.id) === key)
      .map(r => ({
        reservationId: r.id,
        displayName: r.customer ? shortName(r.customer.firstName, r.customer.lastName) : shortNameFromFull(r.guestName),
        checkedIn: r.status === 'CHECKED_IN',
        spotLabel: spotLabel(r.spotIds, r.classSession?.product?.layoutConfig ?? r.product?.layoutConfig),
      })),
    closesAt,
    closesInMs: closesAt.getTime() - t, // > 0: el filtro de la ventana ya lo garantiza
  }
}

/** Un toque guardado sin red se registra solo hasta 3 días después; más viejo, lo decide una persona. */
export const KIOSK_MAX_OFFLINE_MS = 72 * 60 * 60_000
export const CHECK_IN_TOO_OLD = 'CHECK_IN_TOO_OLD' as const

/**
 * El check-in desde la lista del kiosco. Abre la orden como el toque de hoy, pero con `source: 'KIOSK'`:
 * `checkInReservation` vuelve a checar la ventana con el horario VIGENTE de la reserva.
 *
 * `tapped` (cola sin red): el cierre que vio la persona y cuánto faltaba al tocar. La hora del toque es
 * `closesAt − msBeforeClose` — sin ningún reloj del aparato, así que corregirle la hora no la mueve.
 */
export async function kioskCheckInReservation(args: {
  venueId: string
  reservationId: string
  now: Date
  tapped?: { closesAt: Date; msBeforeClose: number }
}): Promise<{ reservationId: string; orderId: string | null }> {
  const at = args.tapped ? new Date(args.tapped.closesAt.getTime() - args.tapped.msBeforeClose) : args.now

  // Antes de tocar nada. Un minuto de holgura para el redondeo del aparato, no para adelantar llegadas.
  if (at.getTime() > args.now.getTime() + 60_000) {
    throw new ValidationError(
      'El check-in solo esta disponible desde 20 minutos antes de tu clase hasta su inicio',
      CHECK_IN_OUTSIDE_WINDOW,
    )
  }
  if (args.now.getTime() - at.getTime() > KIOSK_MAX_OFFLINE_MS) {
    throw new ValidationError(
      'Esta llegada se guardó hace más de 3 días y ya no se puede registrar sola. Regístrala en Reservaciones.',
      CHECK_IN_TOO_OLD,
    )
  }

  const actor = { type: 'SERVICE', servicePrincipalId: 'kiosk' } as const
  try {
    const result = await checkInReservationAndOpenOrder({
      reservationId: args.reservationId,
      venueId: args.venueId,
      actor,
      source: 'KIOSK',
      now: at,
    })
    return { reservationId: args.reservationId, orderId: result.orderId }
  } catch (err) {
    // Sólo el toque guardado sin red merece explicación: en vivo, la persona ve el «no» al instante.
    if (!args.tapped || !(err instanceof ConflictError) || err.code !== RESERVATION_NOT_CHECKINABLE) throw err

    const r = await prisma.reservation.findFirst({
      where: { id: args.reservationId, venueId: args.venueId },
      select: {
        status: true,
        guestName: true,
        customer: { select: { firstName: true, lastName: true } },
        venue: { select: { timezone: true } },
      },
    })
    if (r?.status !== 'NO_SHOW') throw err

    // Llegó, pero el «No asistió» le ganó mientras no había red. No se revierte aquí (0.e): queda el rastro
    // para el gerente. Mismo molde que ORDER_FROM_RESERVATION_FAILED: el rastro nunca tumba la respuesta.
    try {
      const organizationId = await venueOrganizationId(prisma, args.venueId)
      await prisma.activityLog.create({
        data: {
          ...activityActorFields(actor, organizationId),
          venueId: args.venueId,
          action: 'RESERVATION_KIOSK_CHECK_IN_AFTER_NO_SHOW',
          entity: 'Reservation',
          entityId: args.reservationId,
          data: { tappedAt: at.toISOString(), msBeforeClose: args.tapped.msBeforeClose },
        },
      })
    } catch (logErr) {
      logger.error('[KIOSK CHECK-IN] RESERVATION_KIOSK_CHECK_IN_AFTER_NO_SHOW could not be logged', {
        reservationId: args.reservationId,
        err: (logErr as Error)?.message,
      })
    }

    const name = r.customer ? shortName(r.customer.firstName, r.customer.lastName) : shortNameFromFull(r.guestName)
    throw new ConflictError(
      `${name} llegó a las ${formatInTimeZone(at, r.venue.timezone, 'HH:mm')} sin conexión, pero su reserva ya estaba como «No asistió» y la app no puede deshacerlo. Avísale al gerente.`,
      RESERVATION_NOT_CHECKINABLE,
    )
  }
}
