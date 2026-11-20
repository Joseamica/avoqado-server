import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'
import { closesAt, isWithinHours } from './hours'
import {
  FOLIO_LAST_CALL_MINUTES,
  MAX_PENDING_PER_VENUE,
  PRESENCE_WINDOW_MS,
  FOLIO_PRESENCE_WINDOW_MS,
  PRESENCE_WRITE_DEBOUNCE_MS,
  awaitingAcceptanceWhere,
  liveCardDraftsWhere,
} from './constants'
import { logAction } from '@/services/dashboard/activity-log.service'
import { getSettings, preloadReservationHours } from './settings.service'
import type { AcceptingReason, AcceptingState, AcceptingStatus } from './types'

// En memoria a propósito (una sola instancia): amortigua la escritura; la verdad es la columna.
const lastWrite = new Map<string, number>()
// R11: llave propia del latido de folios; si compartiera mapa, la Bandeja abierta le «comería» el latido a la TPV.
const lastToPayWrite = new Map<string, number>()

export function __resetPresenceDebounceForTests(): void {
  lastWrite.clear()
  lastToPayWrite.clear()
}

/**
 * La bandeja abierta consultó ahora: eso demuestra que hay alguien mirando. Devuelve `true` si escribió.
 * R13: el debounce se mueve SÓLO si la escritura funcionó; un fallo no puede callar el siguiente latido.
 * Sin fila de ajustes no hay nada que actualizar (la tienda está apagada).
 */
export async function touchInboxPoll(venueId: string, now: Date = new Date()): Promise<boolean> {
  const last = lastWrite.get(venueId) ?? 0
  if (now.getTime() - last < PRESENCE_WRITE_DEBOUNCE_MS) return false
  await prisma.onlineOrderingSettings.updateMany({ where: { venueId }, data: { lastInboxPollAt: now } })
  lastWrite.set(venueId, now.getTime())
  return true
}

/**
 * Tienda híbrida: un aparato que PUEDE cobrar folios (TPV o POS) consultó ahora. Si aún no hay fila de ajustes, el primer latido la
 * crea apagada y en «Mi equipo» (R37), con el horario de reservas precargado, bajo el mismo candado de `updateSettings`.
 */
export async function touchToPayPoll(venueId: string, now: Date = new Date()): Promise<boolean> {
  const last = lastToPayWrite.get(venueId) ?? 0
  if (now.getTime() - last < PRESENCE_WRITE_DEBOUNCE_MS) return false
  const { count } = await prisma.onlineOrderingSettings.updateMany({ where: { venueId }, data: { lastToPayPollAt: now } })
  if (count === 0) {
    await prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'online-ordering-settings:' + venueId}))`
      const hours = await preloadReservationHours(tx, venueId)
      await tx.onlineOrderingSettings.upsert({
        where: { venueId },
        // D662 parte 2: una fila nueva nace con el corte de la pausa sola puesto (sin la gracia del despliegue; Codex p2-r5 #2).
        create: {
          venueId,
          enabled: false,
          requiresAcceptance: true,
          lastToPayPollAt: now,
          autoPauseResumedAt: now,
          ...(hours ? { hours } : {}),
        },
        update: { lastToPayPollAt: now },
      })
    })
  }
  lastToPayWrite.set(venueId, now.getTime())
  return true
}

/**
 * Lo que el panel, la bandeja y el MCP muestran del estado de la tienda: un solo armado. D662 parte 2 (aditivo): `autoPausedAt`, la
 * tienda se pausó sola por 2 pedidos sin atender; un cliente viejo no lo lee y dice «Pausada» por el `reason`.
 */
export function storeView(state: AcceptingState) {
  return {
    status: state.status,
    reason: state.reason,
    pausedUntil: state.config.pausedUntil,
    manualPause: state.config.manualPause,
    autoPausedAt: state.autoPausedAt ?? null,
  }
}

/** D662 parte 2 (v3): cuántas FALLAS mira, como mucho, una vuelta de la lectura (las respuestas no tienen tope: se buscan aparte). */
export const PAUSA_SOLA_TOPE = 1000
/** Cuántas vueltas da, como mucho, una lectura que se llena (cada una sube el corte antes de la siguiente). */
const PAUSA_SOLA_VUELTAS = 5
/**
 * Lo que pasó hace más de esto ya es definitivo: una escritura con su hora tomada se confirma, a lo más, al vencer la transacción
 * (`ORDER_LOCK_WAIT_BUDGET.timeout`, 15 s). Sólo se usa para subir el corte, nunca para decidir la pausa.
 */
export const MARGEN_DEFINITIVO_MS = 30_000
/** Gracia del despliegue: la primera lectura del SERVIDOR nuevo, con el corte vacío, lo pone 20 min adelante (ver `leerPausaSola`). */
export const GRACIA_DESPLIEGUE_MS = 20 * 60_000
/** La lectura sube el corte (sin esperarlo) cuando puede avanzar al menos esto: una escritura cada pocos minutos por negocio activo. */
export const AVANCE_MINIMO_MS = 5 * 60_000

export interface LecturaPausaSola {
  /** La segunda falla de la primera pareja (hora límite y pedido), o `null` si no hay pausa. */
  pausa: { at: Date; onlineOrderId: string } | null
  /** Hasta dónde puede subir el corte sin cambiar ninguna lectura futura, o `null` (hay pausa o no se sabe). */
  corteSeguro: Date | null
}

interface VueltaPausaSola {
  fallas: number
  ultimaFalla: Date | null
  /** La última falla si NO hubo una respuesta a tiempo después de ella (puede formar pareja con la siguiente); si no, `null`. */
  fallaSuelta: Date | null
  pausaId: string | null
  pausaAt: Date | null
}

/**
 * D662 parte 2 (founder, 19-nov, «a»; v3 del 20-nov): la pausa sola se LEE de los pedidos, no se lleva. La decide Postgres en UNA
 * consulta exacta (Codex p2-r5 #3: nada de páginas de pedidos que dejen fuera una respuesta):
 * - FALLA: un pedido de «Mi equipo» llegó a su hora límite (ya pasó) sin que una persona lo contestara a más tardar en ella
 *   (`staffAnsweredAt` vacío o después). No se borra: un rechazo tardío, la clienta que cancela tarde o un cobro no la quitan.
 *   No cuenta lo que terminó solo ANTES de su hora límite (la clienta lo canceló; el sistema lo rechazó por pago sin persona).
 * - RESPUESTA: una persona contestó A TIEMPO un pedido (`staffAnsweredAt <= su hora límite`), a la hora en que lo hizo, aunque su
 *   hora límite sea mucho después. Se busca con `EXISTS` sobre `(venueId, staffAnsweredAt)`, sin tope.
 * - PAUSADA: hay dos fallas seguidas (por hora límite y `id`) sin una respuesta en `(primera, segunda]`: a la misma hora la respuesta
 *   va primero. Se queda así aunque después llegue una respuesta: sólo «Reanudar» sube el corte.
 * Techos aceptados: T1 (quien ya estaba pagando termina) y T2 (una escritura a tiempo que todavía se guarda): sin candados.
 */
async function vueltaPausaSola(venueId: string, now: Date, corte: Date): Promise<VueltaPausaSola> {
  const [fila] = await prisma.$queryRaw<VueltaPausaSola[]>`
    WITH f AS (
      SELECT oo.id, oo."acceptDeadlineAt" AS t
      FROM "OnlineOrder" oo
      WHERE oo."venueId" = ${venueId}
        AND oo."requiresAcceptance" = true
        AND oo."acceptDeadlineAt" > ${utcTs(corte)}
        AND oo."acceptDeadlineAt" <= ${utcTs(now)}
        AND (oo."staffAnsweredAt" IS NULL OR oo."staffAnsweredAt" > oo."acceptDeadlineAt")
        AND NOT COALESCE(oo."cancelledBy" = 'CUSTOMER' AND oo."cancelledAt" <= oo."acceptDeadlineAt", false)
        AND NOT COALESCE(
          oo."rejectReason" = 'PAYMENT_FAILED' AND oo."staffAnsweredAt" IS NULL AND oo."rejectedAt" <= oo."acceptDeadlineAt",
          false
        )
      ORDER BY oo."acceptDeadlineAt" ASC, oo.id ASC
      LIMIT ${PAUSA_SOLA_TOPE}
    ),
    p AS (SELECT f.id, f.t, LAG(f.t) OVER (ORDER BY f.t ASC, f.id ASC) AS prev FROM f)
    SELECT
      (SELECT count(*)::int FROM f) AS "fallas",
      (SELECT max(f.t) FROM f) AS "ultimaFalla",
      CASE
        WHEN (SELECT max(f.t) FROM f) IS NULL THEN NULL
        WHEN EXISTS (
          SELECT 1
          FROM "OnlineOrder" s
          WHERE s."venueId" = ${venueId}
            AND s."requiresAcceptance" = true
            AND s."staffAnsweredAt" > (SELECT max(f.t) FROM f)
            AND s."staffAnsweredAt" <= ${utcTs(now)}
            AND s."staffAnsweredAt" <= s."acceptDeadlineAt"
        ) THEN NULL
        ELSE (SELECT max(f.t) FROM f)
      END AS "fallaSuelta",
      par.id AS "pausaId",
      par.t AS "pausaAt"
    FROM (SELECT 1) AS uno
    LEFT JOIN LATERAL (
      SELECT p.id, p.t
      FROM p
      WHERE p.prev IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM "OnlineOrder" s
          WHERE s."venueId" = ${venueId}
            AND s."requiresAcceptance" = true
            AND s."staffAnsweredAt" > p.prev
            AND s."staffAnsweredAt" <= p.t
            AND s."staffAnsweredAt" <= s."acceptDeadlineAt"
        )
      ORDER BY p.t ASC, p.id ASC
      LIMIT 1
    ) AS par ON true`
  return fila ?? { fallas: 0, ultimaFalla: null, fallaSuelta: null, pausaId: null, pausaAt: null }
}

/**
 * Hasta dónde puede subir el corte tras una vuelta sin pareja: lo de hace más de 30 s es definitivo, y una falla que sigue sin
 * respuesta detrás se queda (puede formar pareja con la siguiente). Lo de antes ya no cambia ninguna lectura futura: toda falla futura
 * tiene hora límite posterior, y toda respuesta que caiga entre esa falla y una futura es de un pedido con hora límite posterior al
 * corte. Con la vuelta llena (tope de fallas), además, no pasa de la última falla leída: las que siguen no se han visto.
 */
function corteTrasVuelta(v: VueltaPausaSola, now: Date, completa: boolean): Date {
  let corte = now.getTime() - MARGEN_DEFINITIVO_MS
  const retiene = completa ? v.fallaSuelta : v.ultimaFalla
  if (retiene) corte = Math.min(corte, retiene.getTime() - 1)
  return new Date(corte)
}

/** Sube el corte a [nuevo] sólo si eso lo sube (nunca lo baja; un corte vacío es la gracia pendiente y no se toca aquí). */
async function subirCorte(venueId: string, nuevo: Date): Promise<boolean> {
  const r = await prisma.onlineOrderingSettings.updateMany({
    where: { venueId, autoPauseResumedAt: { lt: nuevo } },
    data: { autoPauseResumedAt: nuevo },
  })
  return r.count === 1
}

/** Lo mismo, sin esperar ni lanzar: la lectura nunca se frena ni falla por esto. */
function subirCorteSinEsperar(venueId: string, nuevo: Date): void {
  void Promise.resolve()
    .then(() => subirCorte(venueId, nuevo))
    .catch(error =>
      logger.warn('[OnlineOrdering] no se pudo subir el corte de la pausa sola (la lectura sigue exacta)', {
        venueId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
}

/**
 * La pausa sola de un negocio, desde su corte (`vueltaPausaSola`). Si la vuelta trae el tope de fallas sin pareja, sube el corte y da
 * otra (Codex p2-r4 #1). Sin pausa y si el corte puede subir bastante, lo sube sin esperar: así la lectura de mañana es corta.
 * Corte vacío = GRACIA del despliegue (p2-r4 #3): las filas de antes del cambio, o una que el SERVIDOR anterior creó durante el
 * despliegue. La primera lectura del SERVIDOR nuevo lo pone 20 min adelante y, mientras, no hay pausa sola: lo que contestó el
 * servidor anterior (sin `staffAnsweredAt`) nunca cuenta, aunque el despliegue falle y se repita después. Las filas que crea el
 * SERVIDOR nuevo nacen con el corte puesto (Codex p2-r5 #2), así que una tienda nueva no recibe gracia.
 */
async function leerPausaSola(venueId: string, now: Date, corteGuardado: Date | null, avance = AVANCE_MINIMO_MS): Promise<LecturaPausaSola> {
  if (!corteGuardado) {
    const gracia = new Date(now.getTime() + GRACIA_DESPLIEGUE_MS)
    void Promise.resolve()
      .then(() =>
        prisma.onlineOrderingSettings.updateMany({ where: { venueId, autoPauseResumedAt: null }, data: { autoPauseResumedAt: gracia } }),
      )
      .catch(() => undefined)
    return { pausa: null, corteSeguro: null }
  }
  let corte = corteGuardado
  for (let vuelta = 1; ; vuelta++) {
    const v = await vueltaPausaSola(venueId, now, corte)
    if (v.pausaId && v.pausaAt) return { pausa: { at: v.pausaAt, onlineOrderId: v.pausaId }, corteSeguro: null }
    const completa = v.fallas < PAUSA_SOLA_TOPE
    const seguro = corteTrasVuelta(v, now, completa)
    const sube = seguro.getTime() > corte.getTime() ? seguro : null
    if (completa) {
      if (sube && sube.getTime() - corteGuardado.getTime() >= avance) subirCorteSinEsperar(venueId, sube)
      return { pausa: null, corteSeguro: seguro }
    }
    if (!sube || vuelta >= PAUSA_SOLA_VUELTAS) {
      logger.warn('[OnlineOrdering] la lectura de la pausa sola no alcanzó a leer todas las fallas: el corte no está avanzando', {
        venueId,
        tope: PAUSA_SOLA_TOPE,
        vueltas: vuelta,
      })
      return { pausa: null, corteSeguro: null }
    }
    await subirCorte(venueId, sube)
    corte = sube
  }
}

/**
 * D662 parte 2 (v3): sube el corte (`autoPauseResumedAt`) hasta donde la lectura lo permite (`corteSeguro`), SÓLO si la tienda no está
 * pausada sola. Nunca lo baja, nunca lanza: si falla, la lectura sólo sale más larga. La llaman, después del commit, las respuestas de
 * una persona (aceptar, rechazar, aceptar con tarjeta); la lectura de la tienda también lo sube sola cada pocos minutos.
 */
export async function avanzarCortePausaSola(venueId: string, now: Date = new Date()): Promise<boolean> {
  try {
    const fila = await prisma.onlineOrderingSettings.findUnique({
      where: { venueId },
      select: { enabled: true, requiresAcceptance: true, autoPauseResumedAt: true },
    })
    if (!fila || fila.requiresAcceptance === false || !fila.autoPauseResumedAt) return false
    const lectura = await leerPausaSola(venueId, now, fila.autoPauseResumedAt, Infinity)
    if (lectura.pausa || !lectura.corteSeguro || lectura.corteSeguro.getTime() <= fila.autoPauseResumedAt.getTime()) return false
    return await subirCorte(venueId, lectura.corteSeguro)
  } catch (error) {
    logger.warn('[OnlineOrdering] no se pudo avanzar el corte de la pausa sola (la lectura sigue exacta)', {
      venueId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/** `preloaded`: los ajustes que quien llama ya leyó (p. ej. `GET /settings`), para no leerlos dos veces. */
export async function getAcceptingStatus(
  venueId: string,
  now: Date = new Date(),
  preloaded?: Awaited<ReturnType<typeof getSettings>>,
): Promise<AcceptingState> {
  const [settings, venue] = await Promise.all([
    preloaded ?? getSettings(venueId),
    prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } }),
  ])
  const { lastInboxPollAt, lastToPayPollAt, autoPauseResumedAt, ...config } = settings
  const timezone = venue?.timezone || 'America/Mexico_City'
  let autoPausedAt: string | null = null
  const done = (status: AcceptingStatus, reason: AcceptingReason): AcceptingState => ({ status, reason, config, autoPausedAt })

  if (!config.enabled) return done('DISABLED', 'NOT_ENABLED')
  // La pausa del gerente gana con su forma de hoy: el «Reanudar» del piso no la quita (M-8), así que no se anuncia la sola.
  if (config.manualPause) return done('PAUSED', 'MANUAL_PAUSE')
  // D662 parte 2: sólo en «Mi equipo» (`=== false` es «Nadie»). Mismo motivo que la pausa a mano para las apps viejas. Va antes del
  // horario y de la presencia: sólo «Reanudar» la abre. Con una pausa de 15/30/60 vigente también se lee: al vencer, sigue pausada.
  let pausaSola: LecturaPausaSola['pausa'] = null
  if (config.requiresAcceptance !== false) pausaSola = (await leerPausaSola(venueId, now, autoPauseResumedAt ?? null)).pausa
  autoPausedAt = pausaSola?.at.toISOString() ?? null
  if (config.pausedUntil && new Date(config.pausedUntil) > now) return done('PAUSED', 'MANUAL_PAUSE')
  if (autoPausedAt) return done('PAUSED', 'MANUAL_PAUSE')
  if (!isWithinHours(config.hours, now, timezone)) return done('CLOSED', 'OUTSIDE_HOURS')
  // R56: en «Nadie» (`=== false`), el último pedido para pagar en caja es FOLIO_LAST_CALL_MINUTES antes del cierre REAL de la franja
  // (`closesAt` junta las contiguas). Se dice igual que fuera de horario; `/info` sigue anunciando el cierre real.
  if (config.requiresAcceptance === false) {
    const cierre = closesAt(config.hours, now, timezone)
    if (cierre && cierre.getTime() - now.getTime() < FOLIO_LAST_CALL_MINUTES * 60_000) return done('CLOSED', 'OUTSIDE_HOURS')
  }
  // «Nadie» (`=== false`: una fila sin el campo no lo es) cuenta a quien puede cobrar folios; «Mi equipo», al POS a la vista (D662).
  const latido = config.requiresAcceptance === false ? lastToPayPollAt : lastInboxPollAt
  // D659/D660: la caja que cobra folios duerme con la pantalla apagada y late cada 2–11 min; la Bandeja abierta, cada ~10 s.
  const ventana = config.requiresAcceptance === false ? FOLIO_PRESENCE_WINDOW_MS : PRESENCE_WINDOW_MS
  if (!latido || now.getTime() - latido.getTime() > ventana) return done('OFFLINE', 'NO_DEVICE')

  // Fase 2: los borradores de tarjeta vigentes también ocupan lugar (el tope de admisión los cuenta igual).
  const pending =
    (await prisma.onlineOrder.count({ where: awaitingAcceptanceWhere(venueId) })) +
    (await prisma.onlineOrderCharge.count({ where: liveCardDraftsWhere(venueId, now) }))
  if (pending >= MAX_PENDING_PER_VENUE) return done('PAUSED', 'TOO_BUSY')

  return done('OPEN', null)
}

/**
 * D662 parte 2: bitácora `ONLINE_ORDERING_AUTO_PAUSED`, SÓLO como registro (la verdad es la lectura de `getAcceptingStatus`). La llama
 * el vencimiento de un pedido después de su commit: si la tienda quedó pausada sola y ESTE pedido es la segunda falla de la pareja
 * (por `id`, no por hora: dos pedidos pueden vencer en el mismo milisegundo; Codex p2-r2 #8), escribe una fila. El CAS de vencer gana
 * una sola vez por pedido. Si el pedido que la pausó no vence (la clienta lo canceló tarde, un rechazo tardío), no hay fila: aceptado.
 * Nunca lanza.
 */
export async function registrarSiLaPausoSola(venueId: string, onlineOrderId: string, now: Date = new Date()): Promise<boolean> {
  try {
    const fila = await prisma.onlineOrderingSettings.findUnique({
      where: { venueId },
      select: { enabled: true, manualPause: true, requiresAcceptance: true, autoPauseResumedAt: true },
    })
    if (!fila || !fila.enabled || fila.manualPause || fila.requiresAcceptance === false) return false
    const { pausa } = await leerPausaSola(venueId, now, fila.autoPauseResumedAt ?? null)
    if (!pausa || pausa.onlineOrderId !== onlineOrderId) return false
    const pedido = await prisma.onlineOrder.findFirst({
      where: { id: onlineOrderId, venueId },
      select: { order: { select: { orderNumber: true } } },
    })
    void logAction({
      staffId: null,
      venueId,
      action: 'ONLINE_ORDERING_AUTO_PAUSED',
      entity: 'OnlineOrderingSettings',
      entityId: venueId,
      data: {
        autoPausedAt: pausa.at.toISOString(),
        orderNumber: pedido?.order.orderNumber ?? null,
        reason: '2 pedidos seguidos sin aceptar',
      },
    })
    return true
  } catch {
    return false
  }
}
