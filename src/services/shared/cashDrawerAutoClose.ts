// src/services/shared/cashDrawerAutoClose.ts

/**
 * 🔴 AUTO-CIERRE DE CAJA POR DÍA DE NEGOCIO
 *
 * Una `CashDrawerSession` sólo se cierra cuando una persona la cierra
 * (`cash-drawer.mobile.service.closeSession`). Si nadie lo hace, se queda `OPEN`
 * para siempre: en PRODUCCIÓN hay 3 sesiones así, la más vieja abierta desde el
 * 2026-04-28. Un modelo por-cajón que acumula zombis convierte el arqueo en un
 * número sin significado — "efectivo esperado" de un periodo de tres meses no le
 * sirve a nadie.
 *
 * ── Qué hace el mercado (investigado 2026-08-16) ──────────────────────────────
 *
 *   · **Toast** cierra el cajón en el **corte del día de negocio**, por default a
 *     las **04:00** — no a medianoche, porque el día de un restaurante cruza la
 *     medianoche. En ese corte también cierra cuentas pagadas sin cerrar y saca a
 *     los empleados que siguen con reloj corriendo.
 *   · **Square** es mucho más conservador: cierra solo (auto-end) los cajones con
 *     **más de 30 días abiertos y al menos 7 días sin actividad**. O sea, el
 *     criterio no es sólo el reloj: también exige que NADIE lo esté usando.
 *
 * Tomamos el **corte de Toast** (que es el que de verdad limpia; el de Square
 * habría dejado vivas tres semanas cada sesión) con **la salvaguarda de Square**
 * (no tocar una caja con movimientos recientes), en horas en vez de días porque
 * nuestro corte es diario. Tropicalización: el corte se calcula en el **huso del
 * venue** (`Venue.timezone`), no en UTC ni en el del servidor — México tiene
 * varios husos y un corte en UTC cerraría a las 22:00 locales en Tijuana.
 *
 * ⚠️ HOY NO EXISTE un ajuste de inicio/fin de día de negocio por venue. Se buscó:
 * `VenueSettings` tiene `autoClockOutTime` (asistencia, otra cosa) y
 * `reservationSettings.operatingHours` (reservas); `CashCloseout` lleva
 * `periodStart/periodEnd` pero los define quien hace el corte a mano. Por eso el
 * corte vive aquí como constante con el default de Toast. Cuando el ajuste exista
 * en `VenueSettings`, este archivo es el único lugar que hay que tocar.
 *
 * ── Reglas duras (esto toca dinero) ───────────────────────────────────────────
 *
 * 1. 🔴 **JAMÁS inventa un conteo físico.** `actualAmount` y `overShort` NO se
 *    escriben: se quedan en NULL. Un cierre automático con `actualAmount = 0`
 *    diría "alguien contó y había cero" y el arqueo le cobraría al cajero un
 *    faltante del tamaño de las ventas del día. NULL dice la verdad: nadie contó.
 * 2. 🔴 **No borra ni altera movimientos.** No crea ni toca un solo
 *    `CashDrawerEvent` — ni siquiera el `CLOSE` que sí crea el cierre humano,
 *    porque ese evento lleva `amount` y una fila en cero se lee como un conteo.
 *    La sesión sola cuenta toda la historia.
 * 3. 🔴 **Idempotente por construcción.** El `updateMany` lleva `status: 'OPEN'`
 *    en el WHERE (compare-and-swap): la segunda corrida afecta 0 filas. Eso mismo
 *    lo hace seguro contra una carrera con un cierre humano — quien llegue segundo
 *    no pisa nada.
 * 4. 🔴 **Se distingue de un arqueo real.** Ver `isAutoClosedSession`: un cierre
 *    humano SIEMPRE trae `actualAmount` (el controlador devuelve 400 si falta) y
 *    `closedByStaffId`. Un cierre automático no trae ninguno de los dos. Es
 *    imposible confundirlos, y los clientes ya parsean ambos campos como opcionales.
 *
 * Cerrar la caja **no impide vender**: `postCashSaleToDrawer` es fail-open (sin
 * caja abierta el cobro sigue). Lo que sí se pierde mientras no haya caja abierta
 * es el registro del movimiento — por eso existe la salvaguarda de inactividad.
 */

import { startOfDay, setHours, subDays } from 'date-fns'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'

import logger from '../../config/logger'
import { DEFAULT_TIMEZONE, formatInVenueTimezone, isValidTimezone } from '../../utils/datetime'
import defaultPrisma from '../../utils/prismaClient'
import { retry, shouldRetryDbConnectionError } from '../../utils/retry'

// ============================================================================
// CONSTANTES
// ============================================================================

/** Corte del día de negocio, hora local del venue. 04:00 = el default de Toast. */
export const BUSINESS_DAY_START_HOUR = 4

/**
 * Horas sin un solo movimiento que exigimos antes de cerrar. Es la salvaguarda de
 * Square ("al menos N de inactividad"), ajustada a nuestro corte diario: protege
 * al local que sigue cobrando a las 04:05 de que le arranquen la caja a media
 * venta. Una caja zombi de meses la cruza sin esfuerzo.
 */
export const IDLE_GRACE_HOURS = 2

/** Sólo puede haber UNA sesión abierta por venue, así que este techo sobra de más. */
export const MAX_SESSIONS_PER_PASS = 500

/** Va en `closedByName`. `closedByStaffId` queda en NULL: no hubo persona. */
export const AUTO_CLOSED_BY_NAME = 'Cierre automático'

/** Prefijo de `closingNote`. Es la marca legible en el historial. */
export const AUTO_CLOSE_NOTE_PREFIX = '[Sistema] Cerrada automáticamente'

// ============================================================================
// EL CORTE DEL DÍA DE NEGOCIO
// ============================================================================

/**
 * El instante (UTC real, como lo guarda Prisma) del último corte de día de
 * negocio ocurrido en o antes de `now`, en el huso del venue.
 *
 * A las 12:00 del 16-ago en CDMX devuelve el 16-ago 04:00 locales.
 * A las 03:30 del 16-ago devuelve el 15-ago 04:00: a esa hora todavía se está
 * trabajando el día de negocio de ayer, que es justo por lo que el corte NO es a
 * medianoche.
 */
export function businessDayStart(now: Date, timezone: string, startHour: number = BUSINESS_DAY_START_HOUR): Date {
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE

  // `toZonedTime` da la hora de pared del venue en un Date "falso local": basta
  // para comparar y para hacer aritmética de calendario, y `fromZonedTime` lo
  // regresa a UTC real (el mismo patrón que `venueStartOfDay` en utils/datetime).
  const venueNow = toZonedTime(now, tz)
  const cutToday = setHours(startOfDay(venueNow), startHour)
  const cut = cutToday <= venueNow ? cutToday : subDays(cutToday, 1)

  return fromZonedTime(cut, tz)
}

/**
 * ¿Esta sesión la cerró el sistema y no una persona?
 *
 * 🔴 La respuesta NO se adivina de la nota (el texto se puede editar o traducir):
 * son los dos campos que un cierre humano SIEMPRE llena y éste nunca escribe.
 * `closeSession` exige `actualAmount` (400 si falta) y estampa `closedByStaffId`,
 * así que esta combinación es inalcanzable para un arqueo hecho por alguien.
 *
 * Es también el contrato que Android e iOS deben usar para pintarlo distinto:
 * `status === 'CLOSED' && actualAmount == null` — ambos ya reciben los dos campos
 * como opcionales, así que no hace falta ningún campo nuevo en la API.
 */
export function isAutoClosedSession(session: { status?: string | null; actualAmount?: unknown; closedByStaffId?: string | null }): boolean {
  return session.status === 'CLOSED' && session.actualAmount == null && session.closedByStaffId == null
}

// ============================================================================
// TIPOS
// ============================================================================

interface OpenSessionRow {
  id: string
  venueId: string
  openedAt: Date
  openedByName: string | null
  deviceName: string | null
  venue: { name: string; timezone: string | null } | null
  events: { createdAt: Date }[]
}

export interface ClosedSessionReport {
  sessionId: string
  venueId: string
  venueName: string
  openedAt: string
  openedByName: string | null
  deviceName: string | null
  businessDayEndedAt: string
  hoursOpen: number
  hoursIdle: number
  note: string
}

export interface AutoCloseSummary {
  scanned: number
  closed: number
  skipped: number
  errors: number
  dryRun: boolean
  closedSessions: ClosedSessionReport[]
}

export interface AutoCloseOptions {
  prisma?: typeof defaultPrisma
  now?: Date
  retryEntry?: typeof retry
  businessDayStartHour?: number
  idleGraceHours?: number
  maxSessions?: number
  /** Reporta lo que cerraría, sin escribir nada. */
  dryRun?: boolean
  /** Acota el barrido (lo usa el script de producción). */
  venueIds?: string[]
  sessionIds?: string[]
}

// ============================================================================
// EL BARRIDO
// ============================================================================

export async function autoCloseStaleDrawerSessions(options: AutoCloseOptions = {}): Promise<AutoCloseSummary> {
  const prisma = options.prisma ?? defaultPrisma
  const now = options.now ?? new Date()
  const retryEntry = options.retryEntry ?? retry
  const startHour = options.businessDayStartHour ?? BUSINESS_DAY_START_HOUR
  const idleGraceMs = (options.idleGraceHours ?? IDLE_GRACE_HOURS) * 60 * 60 * 1000
  const maxSessions = options.maxSessions ?? MAX_SESSIONS_PER_PASS
  const dryRun = options.dryRun ?? false

  // Lectura de entrada: la ÚNICA envuelta en retry (regla `.claude/rules/cron-jobs.md`).
  // Es una lectura pura, así que repetirla es inofensivo; los `updateMany` de abajo
  // quedan deliberadamente fuera.
  const sessions = (await retryEntry(
    () =>
      prisma.cashDrawerSession.findMany({
        where: {
          status: 'OPEN',
          ...(options.venueIds?.length ? { venueId: { in: options.venueIds } } : {}),
          ...(options.sessionIds?.length ? { id: { in: options.sessionIds } } : {}),
        },
        select: {
          id: true,
          venueId: true,
          openedAt: true,
          openedByName: true,
          deviceName: true,
          venue: { select: { name: true, timezone: true } },
          // El último movimiento es lo que dice si la caja SIGUE en uso.
          events: { select: { createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
        take: maxSessions,
      }),
    {
      retries: 2,
      initialDelay: 1500,
      shouldRetry: shouldRetryDbConnectionError,
      context: 'cash-drawer-auto-close.findOpenSessions',
    },
  )) as OpenSessionRow[]

  const summary: AutoCloseSummary = { scanned: sessions.length, closed: 0, skipped: 0, errors: 0, dryRun, closedSessions: [] }

  for (const session of sessions) {
    try {
      const timezone = session.venue?.timezone || DEFAULT_TIMEZONE
      const boundary = businessDayStart(now, timezone, startHour)

      // Todavía dentro del día de negocio en curso: no es una zombi, es la caja de hoy.
      if (session.openedAt.getTime() >= boundary.getTime()) {
        summary.skipped += 1
        continue
      }

      // Alguien la sigue usando aunque haya cruzado el corte (local de madrugada,
      // 24 h). Cerrarla ahora dejaría sus ventas en efectivo sin movimiento de caja.
      const lastActivity = session.events[0]?.createdAt ?? session.openedAt
      const idleMs = now.getTime() - lastActivity.getTime()
      if (idleMs < idleGraceMs) {
        summary.skipped += 1
        continue
      }

      const hoursOpen = Math.floor((now.getTime() - session.openedAt.getTime()) / 3_600_000)
      const hoursIdle = Math.floor(idleMs / 3_600_000)
      // Hora de pared del VENUE, no del host: en prod/CI Node corre en UTC y el
      // `format(..., { timeZone })` de date-fns-tz no convierte (sólo alimenta `z`).
      const boundaryLocal = formatInVenueTimezone(boundary, timezone, 'yyyy-MM-dd HH:mm')
      const note =
        `${AUTO_CLOSE_NOTE_PREFIX}: nadie la cerró. ` +
        `El día de negocio terminó el ${boundaryLocal} (${timezone}); ` +
        `la caja llevaba ${hoursOpen} h abierta y ${hoursIdle} h sin movimientos. ` +
        `SIN CONTEO FÍSICO: no hay monto real ni diferencia — esto NO es un arqueo hecho por una persona.`

      const report: ClosedSessionReport = {
        sessionId: session.id,
        venueId: session.venueId,
        venueName: session.venue?.name ?? session.venueId,
        openedAt: session.openedAt.toISOString(),
        openedByName: session.openedByName,
        deviceName: session.deviceName,
        businessDayEndedAt: boundary.toISOString(),
        hoursOpen,
        hoursIdle,
        note,
      }

      if (dryRun) {
        summary.closed += 1
        summary.closedSessions.push(report)
        continue
      }

      // 🔴 CAS: `status: 'OPEN'` en el WHERE. Es lo que hace idempotente al barrido
      // y lo que impide pisar a una persona que cerró la caja entre la lectura y
      // esta escritura — quien llegue segundo afecta 0 filas y no cambia nada.
      //
      // 🔴 `actualAmount` y `overShort` NO aparecen en `data` a propósito: se quedan
      // en NULL. Escribir 0 sería inventar que alguien contó y había cero.
      const result = await prisma.cashDrawerSession.updateMany({
        where: { id: session.id, status: 'OPEN' },
        data: {
          status: 'CLOSED',
          closedAt: now,
          closedByStaffId: null,
          closedByName: AUTO_CLOSED_BY_NAME,
          closingNote: note,
        },
      })

      if (result.count === 1) {
        summary.closed += 1
        summary.closedSessions.push(report)
        logger.warn('💵 [CASH-DRAWER] Caja cerrada automáticamente: nadie la cerró', {
          sessionId: session.id,
          venueId: session.venueId,
          venueName: report.venueName,
          openedAt: report.openedAt,
          openedByName: session.openedByName,
          businessDayEndedAt: report.businessDayEndedAt,
          hoursOpen,
          hoursIdle,
          timezone,
        })
      } else {
        // Ya no estaba OPEN: la cerró una persona, o una corrida anterior.
        summary.skipped += 1
      }
    } catch (error) {
      summary.errors += 1
      logger.error('❌ [CASH-DRAWER] No se pudo cerrar automáticamente la caja', {
        sessionId: session.id,
        venueId: session.venueId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return summary
}
