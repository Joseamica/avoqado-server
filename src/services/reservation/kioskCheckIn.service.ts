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
import { NotificationType, Prisma, ReservationStatus } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { utcTs } from '@/utils/sqlDates'
import { phonesMatch } from '@/utils/phone'
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
import { undoNoShow } from './undoNoShow.service'
import { afterNoShowCorrection, notifyNoShowNeedsReview } from './noShowNotices.service'
import { exigirSesionProbada, metodoDeLaSesion, type SesionDeLlegada } from './sesionDeLlegada'

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
    /** «Tapete 4». Opcional: sólo la respuesta del teléfono lo trae. */
    spotLabel?: string | null
  }
}

export async function consumeKioskCheckInChallenge(args: {
  venueId: string
  challengeId: string
  secret: string
  customerId: string
  /** Asistencia verificada (Codex r2 #1): la misma regla que el QR firmado: sólo una sesión que probó su contacto. */
  sesion: SesionDeLlegada
  now: Date
  ip?: string
}): Promise<ConsumeChallengeResult> {
  exigirSesionProbada(args.sesion)
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

  const metodo = await metodoDeLaSesion({ venueId: args.venueId, customerId: args.customerId, sesion: args.sesion, now: args.now })
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
      ...metodo,
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
  /**
   * Asistencia verificada (D-D): la hora en que se tecleó, cuando el aparato lo guardó sin red y lo manda después. Es la
   * hora del SERVIDOR estimada por el aparato (último `Date` que contestó + su reloj monótono). Sin ella: ahora.
   */
  occurredAt?: Date
  /**
   * Id de la llegada en la cola del aparato (Codex r1 #5). Si la reserva ya la tiene en su historia, se contesta «ya
   * registrada» sin escribir, aunque alguien la haya deshecho después: un reintento nunca pisa una corrección posterior.
   */
  opId?: string
}): Promise<ConsumeChallengeResult> {
  // La hora de la llegada: la tecleada sin red, o ahora. Nunca futura, nunca de hace más de 72 h (como la lista, D4).
  const at = args.occurredAt ?? args.now
  if (at.getTime() > args.now.getTime() + 60_000) {
    throw new ValidationError('La hora de esta llegada está en el futuro', CHECK_IN_OUTSIDE_WINDOW)
  }
  if (args.now.getTime() - at.getTime() > KIOSK_MAX_OFFLINE_MS) {
    throw new ValidationError(
      'Esta llegada se guardó hace más de 3 días y ya no se puede registrar sola. Regístrala en Reservaciones.',
      CHECK_IN_TOO_OLD,
    )
  }
  const raw = args.identifier.trim()
  const code = raw.toUpperCase().slice(0, 32)
  // Un identificador con 10 dígitos o más es un teléfono: la base prefiltra por los ÚLTIMOS 10 y después se confirma el
  // número completo con su lada (D4, `reservaDelTelefono`).
  const digits = raw.replace(/\D/g, '')
  const phoneTail = digits.length >= 10 ? digits.slice(-10) : null

  const scopes = [
    args.terminalId ? `terminal:${args.terminalId}` : null,
    `station:${args.stationKey}`,
    args.ip ? `ip:${args.ip}` : null,
    `identifier:${code}`,
  ].filter(Boolean) as string[]

  for (const scope of scopes) {
    // La cola sin red (con `opId`) reintenta sola tras un 5xx: el tope por teléfono (5/min, contra quien barre números) no
    // aplica a ella; sí los de la terminal, la cara y la IP (30/min). Codex r2 #5 y r4 #4.
    if (args.opId && scope.startsWith('identifier:')) continue
    await assertDurableRateLimit({ venueId: args.venueId, scope, now: args.now, max: scope.startsWith('identifier:') ? 5 : 30 })
  }

  // 🔴 Codex r4 (rediseño de la familia «la cola se aplica dos veces»): la operación de la cola tiene su RECIBO propio
  // (`KioskCheckInOp`, llave = `opId`). Si ya existe, se contesta con la reserva que le tocó la primera vez: no se vuelve a
  // buscar (podría caer en otra clase) ni a escribir (pisaría una corrección posterior). Se escribe en la MISMA transacción
  // que la llegada; si otra petición con el mismo `opId` ganó, ésta se deshace y contesta lo mismo.
  if (args.opId) {
    const previa = await prisma.kioskCheckInOp.findUnique({ where: { opId: args.opId }, select: { venueId: true, reservationId: true } })
    if (previa && previa.venueId === args.venueId) return yaRegistrada(args.venueId, previa.reservationId)
  }

  // Ventana primero, en la CONSULTA: por teléfono puede haber varias reservas a lo largo
  // del año, y la que importa es la de ahora. Buscar sin acotar y elegir después haría que
  // teclear un teléfono contestara cosas sobre citas de otro día.
  const settingsForWindow = await getReservationSettings(args.venueId)
  const graceMin = settingsForWindow.scheduling.noShowGraceMin
  const windowFrom = new Date(at.getTime() - graceMin * 60_000)
  const windowTo = new Date(at.getTime() + KIOSK_EARLY_CHECK_IN_MIN * 60_000)

  // Sólo las que pueden contestar algo: una cancelada no tapa a la buena del mismo teléfono. «No asistió» sólo cuenta
  // si la llegada viene de la cola sin red (su hora real cae antes de que corriera el «No asistió»).
  const statuses: ReservationStatus[] = args.occurredAt
    ? ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'NO_SHOW']
    : ['PENDING', 'CONFIRMED', 'CHECKED_IN']
  const ventana = { venueId: args.venueId, startsAt: { gte: windowFrom, lte: windowTo }, status: { in: statuses } }

  const reservation = phoneTail
    ? await reservaDelTelefono({ venueId: args.venueId, tecleado: raw, phoneTail, windowFrom, windowTo, statuses, ventana })
    : await prisma.reservation.findFirst({
        where: { ...ventana, confirmationCode: code },
        orderBy: { startsAt: 'asc' },
        select: DISPLAY_SELECT,
      })

  // Respuesta genérica: no revela si el código existe.
  const notFound = () => new NotFoundError('No encontramos esa reservación lista para check-in', CHECK_IN_NOT_FOUND)
  if (!reservation) throw notFound()
  const display = displayDe(reservation)

  // Con `opId`: el recibo va primero, en la transacción de la llegada. Sin `opId` (en vivo): nada.
  const conRecibo = async <T>(tx: Prisma.TransactionClient, fn: () => Promise<T>): Promise<T> => {
    // Codex r1 #2: entre buscar y escribir, recepción pudo corregir el teléfono de ESTA reserva. Con la fila bloqueada (el mismo
    // candado que toma el check-in, y primero, como `undoNoShow`) se vuelve a comparar; si ya no es el tecleado, no se marca.
    if (phoneTail) {
      const [fila] = await tx.$queryRaw<Array<{ guestPhone: string | null; customerPhone: string | null }>>`
        SELECT r."guestPhone", c.phone AS "customerPhone" FROM "Reservation" r
        LEFT JOIN "Customer" c ON c.id = r."customerId"
        WHERE r.id = ${reservation.id} AND r."venueId" = ${args.venueId}
        FOR UPDATE OF r`
      if (!fila || !(phonesMatch(raw, fila.guestPhone) || phonesMatch(raw, fila.customerPhone))) throw notFound()
    }
    if (args.opId) {
      const n = await tx.$executeRaw`
        INSERT INTO "KioskCheckInOp" ("opId", "venueId", "reservationId")
        VALUES (${args.opId}, ${args.venueId}, ${reservation.id})
        ON CONFLICT ("opId") DO NOTHING`
      if (n === 0) throw new OpYaRegistrada()
    }
    return fn()
  }
  const yaPorOtra = async (err: unknown) => {
    if (!(err instanceof OpYaRegistrada) || !args.opId) throw err
    const previa = await prisma.kioskCheckInOp.findUnique({ where: { opId: args.opId }, select: { reservationId: true } })
    return yaRegistrada(args.venueId, previa?.reservationId ?? reservation.id)
  }

  if (reservation.status === 'CHECKED_IN') {
    // Ya estaba (por QR, a mano u otra fila): con `opId`, queda su recibo para que un reintento nunca la vuelva a marcar.
    if (args.opId) {
      try {
        await prisma.$transaction(tx => conRecibo(tx, async () => undefined))
      } catch (err) {
        return yaPorOtra(err)
      }
    }
    return { outcome: 'ALREADY_CHECKED_IN', reservationId: reservation.id, display }
  }

  if (!evaluateKioskWindow({ startsAt: reservation.startsAt, now: at, noShowGraceMin: graceMin })) {
    throw notFound()
  }

  const actor = { type: 'SERVICE', servicePrincipalId: 'kiosk' } as const
  const corregirNoAsistio = async (): Promise<ConsumeChallengeResult> => {
    // Tecleó su teléfono sin red y el «No asistió» automático corrió antes de que subiera. Como la lista (D4): se corrige
    // con la hora en que lo tecleó y el gerente se entera (la hora la midió el aparato).
    let undone
    try {
      undone = await prisma.$transaction(tx =>
        conRecibo(tx, () =>
          undoNoShow(tx, {
            reservationId: reservation.id,
            venueId: args.venueId,
            actor,
            source: 'KIOSK',
            now: args.now,
            arrivedAt: at,
            method: 'PHONE',
            opId: args.opId,
          }),
        ),
      )
    } catch (err) {
      return yaPorOtra(err)
    }
    if (undone.outcome === 'UNDONE') void afterNoShowCorrection(undone.correction.id)
    logger.info('✅ [KIOSK CHECK-IN] Teléfono sin red que corrigió un «No asistió»', {
      venueId: args.venueId,
      reservationId: reservation.id,
    })
    return { outcome: 'CHECKED_IN', reservationId: reservation.id, display }
  }
  if (reservation.status === 'NO_SHOW') return corregirNoAsistio()
  if (!['PENDING', 'CONFIRMED'].includes(reservation.status)) throw notFound()

  let result
  try {
    result = await prisma.$transaction(tx =>
      conRecibo(tx, () =>
        checkInReservation(tx, {
          reservationId: reservation.id,
          venueId: args.venueId,
          actor,
          source: 'KIOSK',
          now: at,
          method: 'PHONE',
          opId: args.opId,
        }),
      ),
    )
  } catch (err) {
    if (err instanceof OpYaRegistrada) return yaPorOtra(err)
    // Codex r2 #4: el «No asistió» automático ganó entre la lectura y el check-in. Desde la cola (hora real) se corrige
    // (la transacción se deshizo entera, recibo incluido); en vivo, el 409 de siempre.
    if (!args.occurredAt || !(err instanceof ConflictError) || err.code !== RESERVATION_NOT_CHECKINABLE) throw err
    const ahora = await prisma.reservation.findFirst({ where: { id: reservation.id, venueId: args.venueId }, select: { status: true } })
    if (ahora?.status !== 'NO_SHOW') throw err
    return corregirNoAsistio()
  }

  logger.info('✅ [KIOSK CHECK-IN] Check-in por identificador', { venueId: args.venueId, reservationId: reservation.id })
  return { outcome: result.outcome, reservationId: reservation.id, display }
}

/** Otra petición con el mismo `opId` ya dejó su recibo: ésta no escribe nada. */
class OpYaRegistrada extends Error {}

/**
 * D4 (16-nov, full-testing de asistencia verificada): la reserva del teléfono tecleado, comparando el número COMPLETO con su lada.
 * Antes era un `endsWith` de los últimos 10 dígitos sobre el texto guardado: una invitada guardada «55 1234 5678» no se
 * encontraba, y un +1 551 234 5678 marcaba la llegada de un +52 55 1234 5678 (cuenta para el pago a la coach).
 * 1. La base prefiltra por los últimos 10 dígitos SIN espacios ni guiones (índice `venueId, startsAt`: es la ventana de una clase).
 * 2. `phonesMatch` confirma el número completo (otra lada ⇒ no empata; si no se entiende ⇒ no empata), como el resto del servidor.
 */
async function reservaDelTelefono(a: {
  venueId: string
  tecleado: string
  phoneTail: string
  windowFrom: Date
  windowTo: Date
  statuses: ReservationStatus[]
  ventana: Prisma.ReservationWhereInput
}) {
  // ponytail: tope de 20 con los mismos 10 dígitos en la ventana de una clase; si se llena, se manda a recepción (r2 #2).
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT r.id FROM "Reservation" r
    LEFT JOIN "Customer" c ON c.id = r."customerId"
    WHERE r."venueId" = ${a.venueId}
      AND r."startsAt" >= ${utcTs(a.windowFrom)} AND r."startsAt" <= ${utcTs(a.windowTo)}
      AND r.status::text IN (${Prisma.join(a.statuses)})
      AND (regexp_replace(COALESCE(r."guestPhone", ''), '[^0-9]', '', 'g') LIKE ${'%' + a.phoneTail}
        OR regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') LIKE ${'%' + a.phoneTail})
    ORDER BY r."startsAt" ASC, r.id ASC
    LIMIT ${TOPE_CANDIDATAS + 1}`
  if (ids.length === 0) return null
  // Codex r2 #2: con más de 20 reservas de ese número en la ventana no se puede saber cuántas personas hay: no se adivina.
  if (ids.length > TOPE_CANDIDATAS) throw telefonoAmbiguo()
  const candidatas = await prisma.reservation.findMany({
    where: { ...a.ventana, id: { in: ids.map(r => r.id) } },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    take: TOPE_CANDIDATAS,
    select: {
      ...DISPLAY_SELECT,
      customerId: true,
      guestPhone: true,
      customer: { select: { firstName: true, lastName: true, phone: true } },
    },
  })
  const suyas = candidatas.filter(r => phonesMatch(a.tecleado, r.guestPhone) || phonesMatch(a.tecleado, r.customer?.phone))
  // Codex r1 #1: con más de una PERSONA detrás del número en la ventana (madre e hija, teléfono compartido), el kiosco no adivina:
  // la llegada la marca recepción. Una invitada sin ficha se reconoce por su nombre (la misma invitada en dos clases seguidas sí
  // es una sola persona).
  const persona = (r: (typeof suyas)[number]) => r.customerId ?? `invitada:${(r.guestName ?? '').trim().toLowerCase().replace(/\s+/g, ' ')}`
  if (new Set(suyas.map(persona)).size > 1) throw telefonoAmbiguo()
  // La misma persona con varias en la ventana: la primera, como siempre. Codex r2 #1: «primero la que falta marcar» hacía que un
  // reintento sin `opId` (app vieja, respuesta perdida) marcara también su SIGUIENTE clase.
  return suyas[0] ?? null
}

const TOPE_CANDIDATAS = 20
const telefonoAmbiguo = () =>
  new ConflictError('Hay más de una reservación con ese teléfono. Pide tu llegada en recepción.', CHECK_IN_PHONE_AMBIGUOUS)

/** Codex r1 #1 (D4): dos personas con el mismo teléfono en la misma ventana. */
export const CHECK_IN_PHONE_AMBIGUOUS = 'CHECK_IN_PHONE_AMBIGUOUS'

const DISPLAY_SELECT = {
  id: true,
  status: true,
  startsAt: true,
  guestName: true,
  spotIds: true,
  customer: { select: { firstName: true, lastName: true } },
  classSession: { select: { assignedStaff: { select: { firstName: true } }, product: { select: { layoutConfig: true } } } },
  product: { select: { name: true, layoutConfig: true } },
} satisfies Prisma.ReservationSelect

type ReservaConDisplay = Prisma.ReservationGetPayload<{ select: typeof DISPLAY_SELECT }>

function displayDe(r: ReservaConDisplay): NonNullable<ConsumeChallengeResult['display']> {
  return {
    displayName: r.customer ? shortName(r.customer.firstName, r.customer.lastName) : shortNameFromFull(r.guestName),
    title: r.product?.name ?? 'Tu clase',
    startsAt: r.startsAt,
    staffLabel: r.classSession?.assignedStaff?.firstName ? `con ${r.classSession.assignedStaff.firstName}` : null,
    // Codex r1 #8: la lista ya no trae nombres ni lugares; el lugar viaja aquí, después de demostrar quién es.
    spotLabel: spotLabel(r.spotIds, r.classSession?.product?.layoutConfig ?? r.product?.layoutConfig),
  }
}

/** La respuesta de una operación de la cola que ya tenía recibo: la reserva de la PRIMERA vez, sin escribir nada. */
async function yaRegistrada(venueId: string, reservationId: string): Promise<ConsumeChallengeResult> {
  const r = await prisma.reservation.findFirst({ where: { id: reservationId, venueId }, select: DISPLAY_SELECT })
  return { outcome: 'ALREADY_CHECKED_IN', reservationId, ...(r ? { display: displayDe(r) } : {}) }
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
  /**
   * 🔴 Siempre vacío desde la asistencia verificada (16-nov-2026, decisión del founder del 15-nov: fijo para todos).
   * Tocar un nombre dejaba a cualquiera marcar la llegada de otra (Mindform paga a sus coaches por lugar ocupado). El
   * campo se queda para no romper a las apps viejas: pintan la lista vacía y el respaldo del teléfono.
   */
  people: KioskRosterPerson[]
  /** Lugares de la clase que ya llegaron (suma de `partySize`). «3 de 8 ya llegaron», sin nombres. */
  arrivedCount: number
  /** Lugares reservados en la clase (llegaron o no). */
  expectedCount: number
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
      partySize: true,
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
  const deLaClase = open.filter(r => (r.classSessionId ?? r.id) === key)

  return {
    classTitle: first.classSession?.product?.name ?? first.product?.name ?? 'Tu cita',
    startsAt: first.startsAt,
    staffFirstName: first.classSession?.assignedStaff?.firstName ?? first.assignedStaff?.firstName ?? null,
    people: [],
    arrivedCount: deLaClase.filter(r => r.status === 'CHECKED_IN').reduce((n, r) => n + (r.partySize ?? 1), 0),
    expectedCount: deLaClase.reduce((n, r) => n + (r.partySize ?? 1), 0),
    closesAt,
    closesInMs: closesAt.getTime() - t, // > 0: el filtro de la ventana ya lo garantiza
  }
}

/** Un toque guardado sin red se registra solo hasta 3 días después; más viejo, lo decide una persona. */
export const KIOSK_MAX_OFFLINE_MS = 72 * 60 * 60_000
export const CHECK_IN_TOO_OLD = 'CHECK_IN_TOO_OLD' as const
/** D4 · candado (a): el `closesAt` del aparato vale si cae a ±60 s del que calcula el SERVIDOR (redondeo del aparato). */
const KIOSK_CLOSES_AT_TOLERANCE_MS = 60_000

/**
 * D4 — aviso «revisa si sí llegó» una vez por reserva. La marca durable es la campanita que ya existe para esa reserva
 * (índice `entityType + entityId`): una consulta, sin escribir nada. No filtra por motivo a propósito: `entregar` ya
 * salta a quien tiene CUALQUIER campanita de esa reserva, así que filtrar por motivo nunca mandaría más. Nunca lanza.
 */
async function warnNeedsReviewOnce(venueId: string, reservationId: string, reason: 'KIOSK_TOO_OLD' | 'KIOSK_UNVERIFIED') {
  try {
    const bell = await prisma.notification.findFirst({
      where: { venueId, type: NotificationType.RESERVATION_NEEDS_REVIEW, entityType: 'Reservation', entityId: reservationId },
      select: { id: true },
    })
    if (!bell) await notifyNoShowNeedsReview({ venueId, reservationId, reason })
  } catch (err) {
    logger.error('[KIOSK CHECK-IN] No se pudo revisar el aviso de llegada', { reservationId, reason, err: (err as Error)?.message })
  }
}

export interface KioskCheckInResult {
  reservationId: string
  orderId: string | null
  /** D4: la reserva tiene una corrección de «No asistió» sin resolver (al corregir y en cada repetición). */
  correction?: { id: string; pending: string[] }
}

/**
 * El check-in desde la lista del kiosco. Abre la orden como el toque de hoy, pero con `source: 'KIOSK'`:
 * `checkInReservation` vuelve a checar la ventana con el horario VIGENTE de la reserva.
 *
 * `tapped` (cola sin red): el cierre que vio la persona y cuánto faltaba al tocar. La hora del toque es
 * `closesAt − msBeforeClose` — sin ningún reloj del aparato, así que corregirle la hora no la mueve.
 *
 * D4: si el «No asistió» le ganó a un toque guardado sin red, el SERVIDOR lo corrige solo con tres candados:
 * (a) el `closesAt` es el que hoy calcula para esa reserva (±60 s), (b) el toque cae en la ventana y (c) tiene ≤ 72 h.
 * Si no, queda lo de hoy (409 + rastro); con (a) roto, además se avisa al gerente.
 */
export async function kioskCheckInReservation(args: {
  venueId: string
  reservationId: string
  now: Date
  tapped?: { closesAt: Date; msBeforeClose: number }
  /** La sesión del aparato que tocó (asistencia verificada: la lista queda marcada «lista, app vieja» con quién). */
  byStaffId?: string | null
}): Promise<KioskCheckInResult> {
  const at = args.tapped ? new Date(args.tapped.closesAt.getTime() - args.tapped.msBeforeClose) : args.now

  // Antes de tocar nada. Un minuto de holgura para el redondeo del aparato, no para adelantar llegadas.
  if (at.getTime() > args.now.getTime() + 60_000) {
    throw new ValidationError(
      'El check-in solo esta disponible desde 20 minutos antes de tu clase hasta su inicio',
      CHECK_IN_OUTSIDE_WINDOW,
    )
  }
  if (args.now.getTime() - at.getTime() > KIOSK_MAX_OFFLINE_MS) {
    // D4: el mismo 422, pero si era un «No asistió» el gerente se entera. La lectura nunca cambia la respuesta.
    try {
      const r = await prisma.reservation.findFirst({ where: { id: args.reservationId, venueId: args.venueId }, select: { status: true } })
      if (r?.status === 'NO_SHOW') void warnNeedsReviewOnce(args.venueId, args.reservationId, 'KIOSK_TOO_OLD')
    } catch (readErr) {
      logger.error('[KIOSK CHECK-IN] No se pudo leer la reserva de una llegada vieja', { err: (readErr as Error)?.message })
    }
    throw new ValidationError(
      'Esta llegada se guardó hace más de 3 días y ya no se puede registrar sola. Regístrala en Reservaciones.',
      CHECK_IN_TOO_OLD,
    )
  }

  const actor = { type: 'SERVICE', servicePrincipalId: 'kiosk' } as const
  const checkIn = async (): Promise<KioskCheckInResult> => {
    const result = await checkInReservationAndOpenOrder({
      reservationId: args.reservationId,
      venueId: args.venueId,
      actor,
      source: 'KIOSK',
      now: at,
      method: 'KIOSK_LIST',
      byStaffId: args.byStaffId ?? null,
    })
    // D4 · respuesta perdida: cada éxito sobre una llegada corregida (sin resolver) devuelve su corrección, así el
    // aparato rehace el aviso con el mismo id.
    const correction = await prisma.reservationNoShowCorrection.findFirst({
      where: { reservationId: args.reservationId, venueId: args.venueId, resolvedAt: null },
      select: { id: true, pending: true },
    })
    return { reservationId: args.reservationId, orderId: result.orderId, ...(correction ? { correction } : {}) }
  }

  try {
    return await checkIn()
  } catch (err) {
    // Sólo el toque guardado sin red merece explicación: en vivo, la persona ve el «no» al instante.
    if (!args.tapped || !(err instanceof ConflictError) || err.code !== RESERVATION_NOT_CHECKINABLE) throw err

    const r = await prisma.reservation.findFirst({
      where: { id: args.reservationId, venueId: args.venueId },
      select: {
        status: true,
        startsAt: true,
        guestName: true,
        customer: { select: { firstName: true, lastName: true } },
        venue: { select: { timezone: true } },
      },
    })
    if (r?.status !== 'NO_SHOW') throw err

    // Llegó, pero el «No asistió» le ganó mientras no había red. Los candados se miden con el horario del SERVIDOR.
    const grace = (await getReservationSettings(args.venueId)).scheduling.noShowGraceMin
    const serverClosesAt = r.startsAt.getTime() + grace * 60_000
    const verified = Math.abs(args.tapped.closesAt.getTime() - serverClosesAt) <= KIOSK_CLOSES_AT_TOLERANCE_MS
    let corrected = false
    if (verified && evaluateKioskWindow({ startsAt: r.startsAt, now: at, noShowGraceMin: grace })) {
      try {
        const undone = await prisma.$transaction(tx =>
          undoNoShow(tx, {
            reservationId: args.reservationId,
            venueId: args.venueId,
            actor,
            source: 'KIOSK',
            now: args.now,
            arrivedAt: at,
            method: 'KIOSK_LIST',
            byStaffId: args.byStaffId ?? null,
          }),
        )
        // La hora la midió el aparato: toda corrección del kiosco se avisa (decisión 7). Sin esperar.
        if (undone.outcome === 'UNDONE') void afterNoShowCorrection(undone.correction.id)
        corrected = true
      } catch (undoErr) {
        // Sólo un «no» de negocio de `undoNoShow` (un pase, la reserva cambió) cae a lo de hoy. Una falla de la base
        // (P2024/P2028, conexión) sube como 5xx: el aparato reintenta en vez de dar la llegada por rechazada.
        if (!(undoErr instanceof ConflictError || undoErr instanceof NotFoundError)) throw undoErr
        logger.warn('[KIOSK CHECK-IN] El «No asistió» no se pudo corregir solo; queda para el gerente', {
          reservationId: args.reservationId,
          err: (undoErr as Error)?.message,
        })
      }
    }
    // Fuera del try: si la respuesta falla después de corregir, el aparato reintenta y la repetición devuelve lo mismo.
    if (corrected) return checkIn()
    if (!verified) void warnNeedsReviewOnce(args.venueId, args.reservationId, 'KIOSK_UNVERIFIED')

    // Mismo molde que ORDER_FROM_RESERVATION_FAILED: el rastro nunca tumba la respuesta.
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
    // ANDROID reconoce este rechazo por «No asistió» en el texto (QuarantineViewModel): no lo quites.
    throw new ConflictError(
      `${name} llegó a las ${formatInTimeZone(at, r.venue.timezone, 'HH:mm')} sin conexión, pero su reserva ya estaba como «No asistió». Si sí llegó, corrígelo con «Sí llegó».`,
      RESERVATION_NOT_CHECKINABLE,
    )
  }
}
